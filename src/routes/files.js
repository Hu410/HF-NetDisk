/**
 * 文件操作路由
 * GET    /api/files/{path}               - 下载文件
 * PUT    /api/files/upload               - 上传文件（小文件代理上传）
 * POST   /api/files/getUploadUrl         - 获取大文件 LFS 上传信息
 * POST   /api/files/lfsUpload            - LFS 分片/整体代理上传到 S3
 * POST   /api/files/completeMultipart    - 完成分片上传
 * POST   /api/files/commit               - 提交 LFS 文件引用
 * DELETE /api/files/{path}               - 删除文件
 * POST   /api/files/rename               - 重命名/移动文件
 */

import { HuggingFaceAPI } from '../huggingfaceAPI.js';
import { contentDisposition, errorResponse, successResponse, fileResponse } from '../utils/response.js';
import { withAuth } from '../middleware/auth.js';
import { sanitizePath } from '../utils/helpers.js';
import { getUploadStub, newUploadId, sessionOwnerHash } from '../utils/uploadSession.js';

/**
 * 主路由分发
 */
async function handleFilesRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // 特殊路由：必须在通用 /{path} 之前匹配
  if (pathname === '/api/files/upload' || pathname.endsWith('/files/upload')) {
    if (request.method !== 'PUT' && request.method !== 'POST') {
      return errorResponse('Method not allowed. Use PUT or POST.', 405);
    }
    return handleUpload(context);
  }

  if (pathname.endsWith('/getUploadUrl')) {
    return handleGetUploadUrl(context);
  }

  if (pathname.endsWith('/lfsUpload')) {
    return handleLfsUpload(context);
  }

  if (pathname.endsWith('/completeMultipart')) {
    return handleCompleteMultipart(context);
  }

  if (pathname.endsWith('/commit')) {
    return handleCommit(context);
  }

  if (pathname.endsWith('/batchDelete')) {
    return handleBatchDelete(context);
  }

  if (pathname.endsWith('/rename')) {
    return handleRename(context);
  }

  // 通用路径匹配：/api/files/{path}
  const filesPrefix = '/api/files/';
  if (pathname.startsWith(filesPrefix)) {
    const filePath = pathname.substring(filesPrefix.length);

    switch (request.method) {
      case 'GET':
      case 'HEAD':
        return handleDownload(context, filePath);
      case 'DELETE':
        return handleDelete(context, filePath);
      default:
        return errorResponse('Method not allowed', 405);
    }
  }

  return errorResponse('Not found', 404);
}

/**
 * 上传文件（小文件代理上传）
 * PUT /api/files/upload
 * Content-Type: multipart/form-data
 */
async function handleUpload(context) {
  const { request, hfToken, hfRepo, hfIsPrivate } = context;

  let formData, file, fileName, filePath, fileType, precomputedSha256, conflictPolicy;
  let commitMessage = 'Upload via HF Netdisk';

  const contentType = request.headers.get('Content-Type') || '';

  if (contentType.includes('multipart/form-data')) {
    formData = await request.formData();
    file = formData.get('file');
    if (!file) {
      return errorResponse('No file provided. Use form field "file".', 400);
    }
    fileName = formData.get('fileName') || file.name || 'untitled';
    filePath = formData.get('filePath') || sanitizePath(fileName);
    // 允许前端指定路径（目录结构）
    const dir = formData.get('dir') || '';
    if (dir) {
      filePath = sanitizePath(`${dir}/${filePath}`);
    }
    fileType = formData.get('fileType') || file.type || 'application/octet-stream';
    precomputedSha256 = formData.get('sha256') || null;
    commitMessage = formData.get('commitMessage') || `Upload ${fileName}`;
    conflictPolicy = formData.get('conflictPolicy') || 'reject';
  } else {
    return errorResponse('Unsupported Content-Type. Use multipart/form-data.', 415, null, 'UNSUPPORTED_MEDIA_TYPE');
  }

  if (!file) {
    return errorResponse('No file data', 400);
  }

  // 在扩展名前添加时间戳后缀，避免冲突
  const api = new HuggingFaceAPI(hfToken, hfRepo, hfIsPrivate, context.env);
  const targetPath = await resolveConflictPath(api, sanitizePath(filePath), conflictPolicy);
  if (!targetPath) return errorResponse('A file already exists at the target path', 409, null, 'FILE_CONFLICT');
  const result = await api.uploadFile(file, targetPath, commitMessage, precomputedSha256);

  return successResponse({
    ...result,
    originalFileName: fileName,
    fileType,
  }, 'Upload successful');
}

/**
 * 获取 LFS 上传信息（大文件前端直传）
 * POST /api/files/getUploadUrl
 */
async function handleGetUploadUrl(context) {
  const { request, hfToken, hfRepo, hfIsPrivate } = context;

  const body = await request.json();
  const { fileSize, fileName, filePath, sha256: sha256Val, fileSample, conflictPolicy = 'reject' } = body;

  if (!Number.isSafeInteger(Number(fileSize)) || Number(fileSize) <= 0 || !/^[a-f0-9]{64}$/i.test(sha256Val || '') || typeof fileSample !== 'string' || fileSample.length > 1024) {
    return errorResponse('Missing required fields: fileSize, sha256, fileSample', 400);
  }

  const sanitizedPath = filePath ? sanitizePath(filePath) : sanitizePath(fileName || 'file');
  if (!sanitizedPath) {
    return errorResponse('Invalid file path', 400);
  }

  // 在扩展名前添加时间戳后缀
  const api = new HuggingFaceAPI(hfToken, hfRepo, hfIsPrivate, context.env);
  const targetPath = await resolveConflictPath(api, sanitizedPath, conflictPolicy);
  if (!targetPath) return errorResponse('A file already exists at the target path', 409, null, 'FILE_CONFLICT');
  const uploadInfo = await api.getLfsUploadInfo(fileSize, targetPath, sha256Val, fileSample);
  if (!uploadInfo.needsLfs) {
    return successResponse({ filePath: targetPath, needsLfs: false });
  }

  const uploadId = newUploadId();
  const ownerHash = await sessionOwnerHash(request);
  const action = uploadInfo.uploadAction || {};
  const rawHeaders = action.header || {};
  const partUrls = Object.fromEntries(
    Object.entries(rawHeaders)
      .filter(([key]) => /^\d+$/.test(key))
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([, target], index) => [String(index + 1), target]),
  );
  const uploadHeaders = Object.fromEntries(Object.entries(rawHeaders).filter(([key]) => !/^\d+$/.test(key) && key !== 'chunk_size'));
  const mode = uploadInfo.alreadyExists ? 'existing' : rawHeaders.chunk_size ? 'multipart' : 'whole';
  const totalParts = mode === 'multipart' ? Object.keys(partUrls).length : mode === 'whole' ? 1 : 0;
  const maxParts = Math.max(1, Number(context.env.MAX_UPLOAD_PARTS || 10000));
  if (totalParts > maxParts) return errorResponse('Upload has too many parts', 413, null, 'TOO_MANY_PARTS');
  const record = {
    ownerHash,
    repo: hfRepo,
    filePath: targetPath,
    fileSize: Number(fileSize),
    oid: sha256Val,
    mode,
    chunkSize: Number(rawHeaders.chunk_size || fileSize),
    partUrls,
    target: mode === 'whole' ? action.href : null,
    completionUrl: mode === 'multipart' ? action.href : null,
    uploadHeaders,
  };
  const createResponse = await getUploadStub(context.env, uploadId).fetch('https://upload/create', {
    method: 'POST', body: JSON.stringify(record),
  });
  if (!createResponse.ok) return errorResponse('Failed to create upload session', 500, null, 'UPLOAD_SESSION_FAILED');

  return successResponse({
    filePath: targetPath,
    needsLfs: true,
    alreadyExists: uploadInfo.alreadyExists,
    uploadId,
    oid: sha256Val,
    mode,
    chunkSize: record.chunkSize,
    totalParts,
  });
}

/**
 * LFS 代理上传（分片或整体）
 * POST /api/files/lfsUpload
 *
 * 分片模式 Body: { mode: "chunk", partUrl, data(base64), partNumber }
 * 整体模式 Body: { mode: "whole", uploadAction: {href, header}, data(base64) }
 */
async function handleLfsUpload(context) {
  const { request } = context;
  if (request.method !== 'PUT') return errorResponse('Method not allowed', 405, null, 'METHOD_NOT_ALLOWED');
  if (!request.body) return errorResponse('Missing binary request body', 400, null, 'MISSING_BODY');
  const url = new URL(request.url);
  const uploadId = url.searchParams.get('uploadId');
  const partNumber = Number(url.searchParams.get('partNumber') || 0);
  const ownerHash = await sessionOwnerHash(request);
  let stub;
  try { stub = getUploadStub(context.env, uploadId); } catch { return errorResponse('Invalid upload session', 400, null, 'INVALID_UPLOAD_SESSION'); }
  const targetResponse = await stub.fetch('https://upload/target', {
    method: 'POST', body: JSON.stringify({ ownerHash, partNumber }),
  });
  if (!targetResponse.ok) return errorResponse('Upload session is invalid or expired', targetResponse.status, null, 'UPLOAD_SESSION_INVALID');
  const target = await targetResponse.json();
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (!contentLength || contentLength !== target.expectedSize) {
    return errorResponse('Chunk size does not match upload session', 400, null, 'CHUNK_SIZE_MISMATCH');
  }
  const upstream = await fetch(target.target, { method: 'PUT', headers: target.headers, body: request.body });
  if (!upstream.ok) return errorResponse(`LFS upload failed: ${upstream.status}`, 502, null, 'LFS_UPLOAD_FAILED');
  const etag = upstream.headers.get('ETag') || '';
  if (target.mode === 'multipart' && !etag) return errorResponse('LFS storage did not return an ETag', 502, null, 'MISSING_ETAG');
  await stub.fetch('https://upload/part', {
    method: 'POST', body: JSON.stringify({ ownerHash, partNumber, etag }),
  });
  return successResponse({ partNumber, etag }, 'Chunk uploaded');
}

/**
 * 完成分片上传
 * POST /api/files/completeMultipart
 */
async function handleCompleteMultipart(context) {
  const { request } = context;

  const body = await request.json();
  const ownerHash = await sessionOwnerHash(request);
  let stub;
  try { stub = getUploadStub(context.env, body.uploadId); } catch { return errorResponse('Invalid upload session', 400, null, 'INVALID_UPLOAD_SESSION'); }
  const stateResponse = await stub.fetch('https://upload/complete', {
    method: 'POST', body: JSON.stringify({ ownerHash }),
  });
  if (!stateResponse.ok) return errorResponse('Upload is incomplete or expired', stateResponse.status, null, 'UPLOAD_INCOMPLETE');
  const state = await stateResponse.json();
  if (state.mode === 'multipart') {
    const completeResponse = await fetch(state.completionUrl, {
      method: 'POST',
      headers: { 'Accept': 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
      body: JSON.stringify({ oid: state.oid, parts: state.parts }),
    });
    if (!completeResponse.ok) return errorResponse(`Multipart complete failed: ${completeResponse.status}`, 502, null, 'MULTIPART_COMPLETE_FAILED');
  }
  return successResponse({ filePath: state.filePath, oid: state.oid, fileSize: state.fileSize }, 'Upload completed');
}

/**
 * 提交 LFS 文件引用（前端直传后调用）
 * POST /api/files/commit
 */
async function handleCommit(context) {
  const { request, hfToken, hfRepo, hfIsPrivate } = context;

  const body = await request.json();
  const ownerHash = await sessionOwnerHash(request);
  let stub;
  try { stub = getUploadStub(context.env, body.uploadId); } catch { return errorResponse('Invalid upload session', 400, null, 'INVALID_UPLOAD_SESSION'); }
  const stateResponse = await stub.fetch('https://upload/ready', { method: 'POST', body: JSON.stringify({ ownerHash }) });
  if (!stateResponse.ok) return errorResponse('Upload is not ready to commit', stateResponse.status, null, 'UPLOAD_NOT_READY');
  const { filePath: sanitizedPath, oid, fileSize } = await stateResponse.json();

  const api = new HuggingFaceAPI(hfToken, hfRepo, hfIsPrivate, context.env);
  await api.commitLfsFile(sanitizedPath, oid, fileSize, body.commitMessage || 'Commit via HF Netdisk');
  await stub.fetch('https://upload/committed', { method: 'POST', body: JSON.stringify({ ownerHash }) });

  const fileUrl = api.getFileURL(sanitizedPath);

  return successResponse({
    filePath: sanitizedPath,
    fileUrl,
    oid,
    fileSize,
  }, 'Commit successful');
}

/**
 * 下载文件
 * GET /api/files/{path}
 */
async function handleDownload(context, filePath) {
  const { request, hfToken, hfRepo, hfIsPrivate } = context;

  const decodedPath = sanitizePath(decodeURIComponent(filePath));
  if (!decodedPath) {
    return errorResponse('Invalid file path', 400);
  }

  const api = new HuggingFaceAPI(hfToken, hfRepo, hfIsPrivate, context.env);
  const isDownload = new URL(request.url).searchParams.get('download') === '1';

  if (!hfIsPrivate && !isDownload) {
    return Response.redirect(api.getFileURL(decodedPath), 302);
  }

  // 处理 HEAD 请求（获取文件信息）
  if (request.method === 'HEAD') {
    const headResponse = await api.getFileContent(decodedPath, false, request.headers, 'HEAD');
    const headers = new Headers();
    if (headResponse.headers.get('Content-Length')) {
      headers.set('Content-Length', headResponse.headers.get('Content-Length'));
    }
    if (headResponse.headers.get('Content-Type')) {
      headers.set('Content-Type', headResponse.headers.get('Content-Type'));
    }
    return new Response(null, { status: 200, headers });
  }

  // 下载使用镜像源加速
  const response = await api.getFileContent(decodedPath, false, request.headers, 'GET');

  if (!response.ok && response.status !== 206) {
    if (response.status === 404) {
      return errorResponse('File not found', 404);
    }
    return errorResponse(`Failed to fetch file: ${response.status}`, response.status);
  }

  // 构建响应头
  const responseHeaders = new Headers();
  responseHeaders.set('Content-Type', response.headers.get('Content-Type') || 'application/octet-stream');

  if (response.headers.get('Content-Length')) {
    responseHeaders.set('Content-Length', response.headers.get('Content-Length'));
  }
  if (response.headers.get('Content-Range')) {
    responseHeaders.set('Content-Range', response.headers.get('Content-Range'));
  }
  if (response.headers.get('Accept-Ranges')) {
    responseHeaders.set('Accept-Ranges', response.headers.get('Accept-Ranges'));
  }
  for (const header of ['ETag', 'Last-Modified', 'Cache-Control']) {
    if (response.headers.get(header)) responseHeaders.set(header, response.headers.get(header));
  }
  responseHeaders.set('Cache-Control', 'private, no-store');

  // 添加 Content-Disposition 触发浏览器下载
  const fileName = decodedPath.split('/').pop();
  responseHeaders.set('Content-Disposition', contentDisposition(isDownload ? 'attachment' : 'inline', fileName));

  return fileResponse(response.body, {
    status: response.status,
    headers: responseHeaders,
  });
}

/**
 * 删除文件
 * DELETE /api/files/{path}
 */
async function handleDelete(context, filePath) {
  const decodedPath = sanitizePath(decodeURIComponent(filePath));
  if (!decodedPath) {
    return errorResponse('Invalid file path', 400);
  }

  const isDirectory = new URL(context.request.url).searchParams.get('type') === 'directory';
  const result = await movePathToTrash(context, decodedPath, isDirectory);
  return successResponse(result, 'Moved to trash');
}

async function handleBatchDelete(context) {
  if (context.request.method !== 'POST') return errorResponse('Method not allowed', 405, null, 'METHOD_NOT_ALLOWED');
  const body = await context.request.json().catch(() => ({}));
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 50) {
    return errorResponse('Batch must contain between 1 and 50 items', 400, null, 'INVALID_BATCH');
  }
  const seen = new Set();
  const items = [];
  for (const item of body.items) {
    const path = sanitizePath(item?.path || '');
    const type = item?.type === 'directory' ? 'directory' : item?.type === 'file' ? 'file' : '';
    if (!path || !type || seen.has(path) || path.startsWith('.trash/') || path === '.trash') {
      return errorResponse('Batch contains an invalid or duplicate item', 400, null, 'INVALID_BATCH_ITEM');
    }
    seen.add(path);
    items.push({ path, type });
  }
  const results = [];
  for (const item of items) {
    try {
      results.push({ path:item.path, success:true, ...await movePathToTrash(context, item.path, item.type === 'directory') });
    } catch (error) {
      results.push({ path:item.path, success:false, error:error instanceof Error ? error.message : String(error) });
    }
  }
  const failed = results.filter(result => !result.success).length;
  return successResponse({ results, deleted:results.length-failed, failed }, failed ? 'Batch completed with errors' : 'Batch moved to trash');
}

async function movePathToTrash(context, decodedPath, isDirectory) {
  const { hfToken, hfRepo, hfIsPrivate } = context;
  const api = new HuggingFaceAPI(hfToken, hfRepo, hfIsPrivate, context.env);
  const batchId = crypto.randomUUID();
  const trashPath = `.trash/${batchId}/${decodedPath}`;
  const metadataPath = `.trash/${batchId}/.metadata.json`;
  const metadata = { batchId, originalPath:decodedPath, trashPath, type:isDirectory?'directory':'file', deletedAt:new Date().toISOString() };
  const content = textToBase64(JSON.stringify(metadata));
  const metadataOperation = { key:'file', value:{ path:metadataPath, content, encoding:'base64' } };
  const result = isDirectory
    ? await api.moveDirectoryAtomic(decodedPath, trashPath, `Move directory ${decodedPath} to trash`, [metadataOperation])
    : await api.moveFileAtomic(decodedPath, trashPath, `Move ${decodedPath} to trash`, [metadataOperation]);
  return { filePath:decodedPath, batchId, trashPath, type:metadata.type, fileCount:result.fileCount || 1 };
}

/**
 * 重命名/移动文件
 * POST /api/files/rename
 * Body: { oldPath, newPath, commitMessage? }
 */
async function handleRename(context) {
  const { request, hfToken, hfRepo, hfIsPrivate } = context;

  const body = await request.json();
  const { oldPath, newPath, commitMessage, conflictPolicy = 'reject' } = body;

  if (!oldPath || !newPath) {
    return errorResponse('Missing required fields: oldPath, newPath', 400);
  }

  const sanitizedOldPath = sanitizePath(oldPath);
  const sanitizedNewPath = sanitizePath(newPath);

  if (!sanitizedOldPath || !sanitizedNewPath) {
    return errorResponse('Invalid file path', 400);
  }
  if (sanitizedOldPath === sanitizedNewPath) return successResponse({ oldPath:sanitizedOldPath, newPath:sanitizedNewPath }, 'No changes');

  const api = new HuggingFaceAPI(hfToken, hfRepo, hfIsPrivate, context.env);
  const targetPath = await resolveConflictPath(api, sanitizedNewPath, conflictPolicy);
  if (!targetPath) return errorResponse('A file already exists at the target path', 409, null, 'FILE_CONFLICT');
  await api.renameFile(sanitizedOldPath, targetPath, commitMessage || `Rename ${sanitizedOldPath} to ${targetPath}`);

  return successResponse({
    oldPath: sanitizedOldPath,
    newPath: targetPath,
    fileUrl: api.getFileURL(targetPath),
  }, 'Rename successful');
}

/**
 * 路由入口
 */
export const filesHandler = withAuth(handleFilesRequest);

async function resolveConflictPath(api, filePath, policy) {
  if (!filePath || !['reject', 'overwrite', 'rename'].includes(policy)) return null;
  if (!await api._getFileInfo(filePath)) return filePath;
  if (policy === 'overwrite') return filePath;
  if (policy === 'reject') return null;
  for (let index = 1; index <= 9999; index++) {
    const candidate = appendNumber(filePath, index);
    if (!await api._getFileInfo(candidate)) return candidate;
  }
  throw new Error('Unable to allocate a unique file name');
}

function appendNumber(filePath, index) {
  const slash = filePath.lastIndexOf('/');
  const dot = filePath.lastIndexOf('.');
  const insertAt = dot > slash ? dot : filePath.length;
  return `${filePath.slice(0, insertAt)} (${index})${filePath.slice(insertAt)}`;
}

function textToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
