import { HuggingFaceAPI } from '../huggingfaceAPI.js';
import { withAuth } from '../middleware/auth.js';
import { errorResponse, successResponse } from '../utils/response.js';
import { sanitizePath } from '../utils/helpers.js';

async function handleTrash(context) {
  const { request } = context;
  const path = new URL(request.url).pathname;
  if (path === '/api/trash/list' && request.method === 'GET') return listTrash(context);
  if (path === '/api/trash/restore' && request.method === 'POST') return restoreTrash(context);
  if (path === '/api/trash/purge' && request.method === 'POST') return purgeTrash(context);
  if (path === '/api/trash/empty' && request.method === 'POST') return emptyTrash(context);
  return errorResponse('Not found', 404, null, 'NOT_FOUND');
}

function apiFor(context) {
  return new HuggingFaceAPI(context.hfToken, context.hfRepo, context.hfIsPrivate, context.env);
}

async function listTrash(context) {
  const api = apiFor(context);
  const requestedPage = Math.max(1, parseInt(new URL(context.request.url).searchParams.get('page'), 10) || 1);
  const limit = 20;
  const tree = await api.listDirectoryAllPages('.trash', true, { serverRecursive: true, expand: true });
  const metadataFiles = tree.files
    .filter(file => file.path.endsWith('/.metadata.json'))
    .sort((left, right) => {
      const leftTime = Date.parse(left.lastModified || '');
      const rightTime = Date.parse(right.lastModified || '');
      if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
      if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) return Number.isFinite(leftTime) ? -1 : 1;
      return right.path.localeCompare(left.path);
    });
  const totalEntries = metadataFiles.length;
  const totalPages = Math.max(1, Math.ceil(totalEntries / limit));
  const page = Math.min(requestedPage, totalPages);
  const pageFiles = metadataFiles.slice((page - 1) * limit, page * limit);
  const entries = await mapConcurrent(pageFiles, 10, async file => {
    try {
      const response = await api.getFileContent(file.path);
      return response.ok ? await response.json() : null;
    } catch { return null; }
  });
  const validEntries = entries.filter(Boolean);
  validEntries.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)));
  return successResponse({ entries: validEntries, pagination:{ page, limit, totalEntries, totalPages } });
}

async function mapConcurrent(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function restoreTrash(context) {
  const body = await context.request.json().catch(() => ({}));
  if (!/^[a-f0-9-]{20,64}$/.test(body.batchId || '')) return errorResponse('Invalid trash batch', 400, null, 'INVALID_TRASH_BATCH');
  const api = apiFor(context);
  const metadataPath = `.trash/${body.batchId}/.metadata.json`;
  const metadataResponse = await api.getFileContent(metadataPath);
  if (!metadataResponse.ok) return errorResponse('Trash entry not found', 404, null, 'TRASH_NOT_FOUND');
  const metadata = await metadataResponse.json();
  const isDirectory = metadata.type === 'directory';
  let targetPath = sanitizePath(body.targetPath || metadata.originalPath);
  if (!targetPath) return errorResponse('Invalid restore path', 400, null, 'INVALID_PATH');
  const existing = isDirectory ? await directoryExists(api, targetPath) : await api._getFileInfo(targetPath);
  const policy = body.conflictPolicy || 'reject';
  if (existing && policy === 'reject') return errorResponse('Restore target already exists', 409, null, 'FILE_CONFLICT');
  if (existing && policy === 'rename') targetPath = isDirectory ? await allocateDirectoryName(api, targetPath) : await allocateName(api, targetPath);
  if (existing && policy !== 'overwrite' && policy !== 'rename') return errorResponse('Invalid conflict policy', 400, null, 'INVALID_CONFLICT_POLICY');
  const extra = [{ key:'deletedFile', value:{ path:metadataPath } }];
  const result = isDirectory
    ? await api.moveDirectoryAtomic(metadata.trashPath, targetPath, `Restore directory ${metadata.originalPath}`, extra)
    : await api.moveFileAtomic(metadata.trashPath, targetPath, `Restore ${metadata.originalPath}`, extra);
  return successResponse({ batchId:body.batchId, filePath:targetPath, type:isDirectory?'directory':'file', fileCount:result.fileCount || 1 }, 'Restored');
}

async function purgeTrash(context) {
  const body = await context.request.json().catch(() => ({}));
  if (!/^[a-f0-9-]{20,64}$/.test(body.batchId || '')) return errorResponse('Invalid trash batch', 400, null, 'INVALID_TRASH_BATCH');
  const api = apiFor(context);
  const metadataPath = `.trash/${body.batchId}/.metadata.json`;
  const response = await api.getFileContent(metadataPath);
  if (!response.ok) return errorResponse('Trash entry not found', 404, null, 'TRASH_NOT_FOUND');
  const metadata = await response.json();
  if (metadata.type === 'directory') {
    await api.deleteDirectoryAtomic(metadata.trashPath, `Purge directory ${metadata.originalPath}`, [{ key:'deletedFile', value:{ path:metadataPath } }]);
  } else {
    await api.commitOperations(`Purge ${metadata.originalPath}`, [
      { key:'deletedFile', value:{ path:metadata.trashPath } },
      { key:'deletedFile', value:{ path:metadataPath } },
    ]);
  }
  return successResponse({ batchId:body.batchId }, 'Trash entry purged');
}

async function emptyTrash(context) {
  const api = apiFor(context);
  const tree = await api.listDirectoryRecursive('.trash');
  const paths = [...new Set(tree.files.map(file => file.path).filter(path => path.startsWith('.trash/')))];
  const chunkSize = 200;
  let commits = 0;
  for (let index = 0; index < paths.length; index += chunkSize) {
    const chunk = paths.slice(index, index + chunkSize);
    await api.commitOperations(`Empty trash (${index + 1}-${index + chunk.length})`, chunk.map(path => ({ key:'deletedFile', value:{ path } })));
    commits += 1;
  }
  return successResponse({ deletedFiles:paths.length, commits }, paths.length ? 'Trash emptied' : 'Trash already empty');
}

async function allocateName(api, path) {
  const slash=path.lastIndexOf('/'), dot=path.lastIndexOf('.'), insertAt=dot>slash?dot:path.length;
  for(let index=1;index<=9999;index++){
    const candidate=`${path.slice(0,insertAt)} (${index})${path.slice(insertAt)}`;
    if(!await api._getFileInfo(candidate)) return candidate;
  }
  throw new Error('Unable to allocate restore path');
}

async function directoryExists(api, path) {
  const slash = path.lastIndexOf('/');
  const parent = slash >= 0 ? path.slice(0, slash) : '';
  const result = await api.listDirectory(parent, false);
  return result.directories.some(directory => directory.path === path);
}

async function allocateDirectoryName(api, path) {
  for (let index = 1; index <= 9999; index++) {
    const candidate = `${path} (${index})`;
    if (!await directoryExists(api, candidate)) return candidate;
  }
  throw new Error('Unable to allocate restore directory path');
}

export const trashHandler = withAuth(handleTrash);
