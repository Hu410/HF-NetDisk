/**
 * 仓库管理路由
 * GET    /api/repo           - 检查仓库是否存在
 * POST   /api/repo           - 创建仓库
 * GET    /api/repo/info      - 获取仓库信息
 */

import { HuggingFaceAPI } from '../huggingfaceAPI.js';
import { errorResponse, successResponse } from '../utils/response.js';
import { withAuth } from '../middleware/auth.js';

/**
 * 处理仓库管理请求
 */
async function handleRepoRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  // GET /api/repo/info - 获取仓库信息
  if (pathname.endsWith('/info') || pathname.endsWith('/repo/info')) {
    return handleGetRepoInfo(context);
  }

  // POST /api/repo - 创建仓库
  if (request.method === 'POST') {
    return handleCreateRepo(context);
  }

  // GET /api/repo - 检查仓库是否存在
  if (request.method === 'GET') {
    return handleCheckRepo(context);
  }

  return errorResponse('Method not allowed', 405);
}

/**
 * 检查仓库是否存在
 */
async function handleCheckRepo(context) {
  const { hfToken, hfRepo, hfIsPrivate } = context;

  const api = new HuggingFaceAPI(hfToken, hfRepo, hfIsPrivate, context.env);
  const exists = await api.repoExists();

  return successResponse({
    repo: hfRepo,
    exists,
  });
}

/**
 * 创建仓库
 */
async function handleCreateRepo(context) {
  const { hfToken, hfRepo, hfIsPrivate } = context;

  const api = new HuggingFaceAPI(hfToken, hfRepo, hfIsPrivate, context.env);
  // 允许从请求体覆盖私有属性
  try {
    const body = await context.request.json();
    if (body && typeof body.private === 'boolean') {
      api.isPrivate = body.private;
    }
  } catch { /* 忽略，使用 context 中的值 */ }

  const success = await api.createRepoIfNotExists();
  if (!success) {
    return errorResponse('Failed to create or access repository', 500);
  }

  return successResponse({
    repo: hfRepo,
    created: true,
  }, 'Repository ready');
}

/**
 * 获取仓库信息
 */
async function handleGetRepoInfo(context) {
  const { hfToken, hfRepo, hfIsPrivate } = context;
  const compactSummary = new URL(context.request.url).searchParams.get('summary') === 'true';

  const api = new HuggingFaceAPI(hfToken, hfRepo, hfIsPrivate, context.env);
  const info = await api.getRepoInfo();

  if (!info) {
    return errorResponse('Failed to get repo info', 500);
  }

  // HF 仓库信息的实际占用量位于顶层 usedStorage，同时兼容旧格式。
  const rawSize = info.size || {};
  let sizeInBytes = firstNonNegativeNumber(
    info.usedStorage,
    info.used_storage,
    info.mainSize,
    info.main_size,
    rawSize.sizeInBytes,
    rawSize.size_in_bytes,
  );
  const nbFiles = rawSize.nbFiles || rawSize.nb_files || (info.siblings ? info.siblings.length : 0);

  // 部分仓库信息响应不包含容量字段，此时按主分支文件大小回退统计。
  if (sizeInBytes === null) {
    try {
      const tree = await api.listDirectoryAllPages('', true, {
        serverRecursive: true,
        expand: true,
      });
      sizeInBytes = tree.files.reduce((total, file) => (
        total + (firstNonNegativeNumber(file.size, file.lfs?.size) || 0)
      ), 0);
    } catch (error) {
      console.warn('Failed to calculate repository storage:', error.message);
      sizeInBytes = 0;
    }
  }

  const summary = {
    id: info.id,
    name: info.name,
    private: info.private,
    author: info.author,
    createdAt: info.createdAt,
    description: info.description,
    size: {
      sizeInBytes,
      nbFiles,
    },
    downloads: info.downloads || 0,
    likes: info.likes || 0,
    tags: info.tags || [],
  };

  if (!compactSummary) {
    summary.siblings = (info.siblings || []).map(s => ({
      rfilename: s.rfilename,
      size: s.size,
      type: s.type,
    }));
  }

  return successResponse({ info: summary });
}

function firstNonNegativeNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

/**
 * 路由入口
 */
export const repoHandler = withAuth(handleRepoRequest);
