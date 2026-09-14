import process from 'node:process';

try { process.loadEnvFile('.integration.vars'); } catch { /* Optional local secret file. */ }

const baseUrl = process.env.HF_NETDISK_BASE_URL;
const password = process.env.HF_NETDISK_PASSWORD;
if (process.env.HF_NETDISK_RUN_INTEGRATION !== '1' || !baseUrl || !password) {
  console.error('Refusing to run. Set HF_NETDISK_RUN_INTEGRATION=1, HF_NETDISK_BASE_URL and HF_NETDISK_PASSWORD.');
  process.exit(2);
}

const origin = new URL(baseUrl).origin;
const runId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
const originalPath = `.integration-tests/${runId}.txt`;
const movedPath = `.integration-tests/${runId}-moved.txt`;
const directoryPath = `.integration-tests/${runId}-directory`;
const batchFilePath = `.integration-tests/${runId}-batch.txt`;
const batchDirectoryPath = `.integration-tests/${runId}-batch-directory`;
const payload = `HF NetDisk integration ${runId}\n`;
let cookie = '';
let trashBatchId = null;

async function request(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Origin', origin);
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(new URL(path, baseUrl), { ...init, headers, redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';', 1)[0];
  return response;
}

async function api(path, init = {}) {
  const response = await request(path, init);
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${data.error || response.statusText} requestId=${data.requestId || '-'}`);
  return data;
}

const json = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function uploadSmall(path, content) {
  const form = new FormData();
  form.set('file', new Blob([content], { type: 'text/plain' }), path.split('/').pop());
  form.set('filePath', path);
  form.set('conflictPolicy', 'reject');
  await api('/api/files/upload', { method: 'PUT', body: form });
}

async function download(path, headers = {}) {
  const response = await request(`/api/files/${encodeURIComponent(path)}`, { headers });
  if (response.status < 300 || response.status > 399) return response;
  const location = response.headers.get('location');
  if (!location) throw new Error('Download redirect did not include a location');
  const target = new URL(location);
  if (target.protocol !== 'https:') throw new Error('Download redirect was not HTTPS');
  // Deliberately use a fresh fetch so the netdisk session cookie never reaches the upstream host.
  return fetch(target, { headers, redirect: 'follow' });
}

async function verifyDownload(path) {
  const full = await download(path);
  if (!full.ok || await full.text() !== payload) throw new Error(`Full download verification failed (${full.status})`);
  const partial = await download(path, { Range: 'bytes=0-7' });
  if (partial.status !== 206 || (await partial.arrayBuffer()).byteLength !== 8) {
    throw new Error(`Range download verification failed (${partial.status})`);
  }
}

async function purgeFromTrash(path) {
  const trash = await api('/api/trash/list');
  const entry = (trash.entries || []).find(item => item.originalPath === path);
  if (!entry) return false;
  trashBatchId = entry.batchId;
  await api('/api/trash/purge', json('POST', { batchId: entry.batchId }));
  trashBatchId = null;
  return true;
}

try {
  await api('/api/auth/login', json('POST', { password, remember: false }));
  await uploadSmall(originalPath, payload);
  await verifyDownload(originalPath);

  await api('/api/files/rename', json('POST', { oldPath: originalPath, newPath: movedPath, conflictPolicy: 'reject' }));
  await verifyDownload(movedPath);
  await api(`/api/files/${encodeURIComponent(movedPath)}`, { method: 'DELETE' });

  const trash = await api('/api/trash/list');
  const entry = (trash.entries || []).find(item => item.originalPath === movedPath);
  if (!entry) throw new Error('Deleted integration file was not found in trash');
  trashBatchId = entry.batchId;
  await api('/api/trash/restore', json('POST', { batchId: entry.batchId, conflictPolicy: 'reject' }));
  trashBatchId = null;
  await verifyDownload(movedPath);
  await api(`/api/files/${encodeURIComponent(movedPath)}`, { method: 'DELETE' });
  await purgeFromTrash(movedPath);

  await uploadSmall(`${directoryPath}/one.txt`, 'directory file one');
  await uploadSmall(`${directoryPath}/nested/two.txt`, 'directory file two');
  await api(`/api/files/${encodeURIComponent(directoryPath)}?type=directory`, { method: 'DELETE' });
  let directoryTrash = await api('/api/trash/list');
  const directoryEntry = (directoryTrash.entries || []).find(item => item.originalPath === directoryPath);
  if (!directoryEntry || directoryEntry.type !== 'directory') throw new Error('Deleted directory was not found in trash');
  await api('/api/trash/restore', json('POST', { batchId: directoryEntry.batchId, conflictPolicy: 'reject' }));
  const restored = await api(`/api/directory/list?dir=${encodeURIComponent(directoryPath)}&recursive=true`);
  if ((restored.files || []).length !== 2) throw new Error('Restored directory contents did not match');
  await api(`/api/files/${encodeURIComponent(directoryPath)}?type=directory`, { method: 'DELETE' });
  await purgeFromTrash(directoryPath);

  await uploadSmall(batchFilePath, 'batch file');
  await uploadSmall(`${batchDirectoryPath}/nested.txt`, 'batch directory file');
  const batch = await api('/api/files/batchDelete', json('POST', { items:[
    { path:batchFilePath, type:'file' }, { path:batchDirectoryPath, type:'directory' },
  ] }));
  if (batch.deleted !== 2 || batch.failed !== 0) throw new Error(`Batch delete result was ${batch.deleted}/${batch.failed}`);
  const batchTrash = await api('/api/trash/list');
  const batchEntries = (batchTrash.entries || []).filter(item => [batchFilePath,batchDirectoryPath].includes(item.originalPath));
  if (batchEntries.length !== 2) throw new Error('Batch trash entries were incomplete');
  for (const entry of batchEntries) await api('/api/trash/purge', json('POST', { batchId:entry.batchId }));
  console.log(JSON.stringify({ status: 'passed', runId, checks: ['login', 'upload', 'download', 'range', 'rename', 'trash', 'restore', 'purge', 'directory-delete', 'directory-restore', 'directory-purge', 'batch-delete', 'batch-purge'] }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try {
    if (trashBatchId) await api('/api/trash/purge', json('POST', { batchId: trashBatchId }));
    for (const path of [originalPath, movedPath]) {
      const deletion = await request(`/api/files/${encodeURIComponent(path)}`, { method: 'DELETE' });
      if (deletion.ok || deletion.status === 404) await purgeFromTrash(path);
    }
    const directoryDeletion = await request(`/api/files/${encodeURIComponent(directoryPath)}?type=directory`, { method: 'DELETE' });
    if (directoryDeletion.ok || directoryDeletion.status === 404) await purgeFromTrash(directoryPath);
    const batchFileDeletion = await request(`/api/files/${encodeURIComponent(batchFilePath)}`, { method:'DELETE' });
    if (batchFileDeletion.ok || batchFileDeletion.status === 404) await purgeFromTrash(batchFilePath);
    const batchDirectoryDeletion = await request(`/api/files/${encodeURIComponent(batchDirectoryPath)}?type=directory`, { method:'DELETE' });
    if (batchDirectoryDeletion.ok || batchDirectoryDeletion.status === 404) await purgeFromTrash(batchDirectoryPath);
  } catch (cleanupError) {
    console.error(`Cleanup warning: ${cleanupError.message}`);
  }
}
