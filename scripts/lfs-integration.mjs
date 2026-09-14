import { createHash, randomUUID } from 'node:crypto';
import process from 'node:process';

try { process.loadEnvFile('.integration.vars'); } catch { /* Optional local secret file. */ }
const baseUrl = process.env.HF_NETDISK_BASE_URL;
const password = process.env.HF_NETDISK_PASSWORD;
const sizeMiB = Math.max(96, Math.min(256, Number(process.env.HF_NETDISK_LFS_MB || 96)));
if (process.env.HF_NETDISK_RUN_INTEGRATION !== '1' || !baseUrl || !password) process.exit(2);

const origin = new URL(baseUrl).origin;
const runId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const filePath = `.integration-tests/${runId}-lfs.bin`;
const data = Buffer.alloc(sizeMiB * 1024 * 1024, 0x5a);
data.write(`HF NetDisk LFS ${runId}`);
const oid = createHash('sha256').update(data).digest('hex');
const sample = data.subarray(0, 512).toString('base64');
let cookie = '';

async function raw(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('Origin', origin);
  if (cookie) headers.set('Cookie', cookie);
  const response = await fetch(new URL(path, baseUrl), { ...init, headers, redirect: 'manual' });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';', 1)[0];
  return response;
}
async function api(path, init = {}) {
  const response = await raw(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${body.error || response.statusText} requestId=${body.requestId || '-'}`);
  return body;
}
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function purge() {
  const deletion = await raw(`/api/files/${encodeURIComponent(filePath)}`, { method: 'DELETE' });
  const trash = await api('/api/trash/list');
  const entry = (trash.entries || []).find(item => item.originalPath === filePath);
  if (entry) await api('/api/trash/purge', json({ batchId: entry.batchId }));
  return deletion.status;
}

try {
  await api('/api/auth/login', json({ password, remember: false }));
  const info = await api('/api/files/getUploadUrl', json({
    fileSize: data.length, sha256: oid, fileSample: sample,
    fileName: `${runId}-lfs.bin`, filePath, conflictPolicy: 'reject',
  }));
  if (!info.needsLfs) throw new Error('Hugging Face did not select LFS mode');
  if (!info.alreadyExists) {
    const count = info.mode === 'multipart' ? info.totalParts : 1;
    for (let index = 0; index < count; index += 1) {
      const partNumber = info.mode === 'multipart' ? index + 1 : 0;
      const start = info.mode === 'multipart' ? index * info.chunkSize : 0;
      const end = info.mode === 'multipart' ? Math.min(start + info.chunkSize, data.length) : data.length;
      await api(`/api/files/lfsUpload?uploadId=${encodeURIComponent(info.uploadId)}&partNumber=${partNumber}`, {
        method: 'PUT', headers: { 'Content-Length': String(end - start) }, body: data.subarray(start, end),
      });
    }
  }
  await api('/api/files/completeMultipart', json({ uploadId: info.uploadId }));
  await api('/api/files/commit', json({ uploadId: info.uploadId }));
  const range = await raw(`/api/files/${encodeURIComponent(filePath)}`, { headers: { Range: 'bytes=0-511' } });
  let downloaded = range;
  if (range.status >= 300 && range.status < 400) downloaded = await fetch(range.headers.get('location'), { headers: { Range: 'bytes=0-511' } });
  if (downloaded.status !== 206 || Buffer.from(await downloaded.arrayBuffer()).compare(data.subarray(0, 512)) !== 0) {
    throw new Error(`LFS Range verification failed (${downloaded.status})`);
  }
  console.log(JSON.stringify({ status: 'passed', runId, sizeMiB, mode: info.mode, parts: info.totalParts || 1, oid }));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { await purge(); } catch (error) { console.error(`Cleanup warning: ${error.message}`); }
}
