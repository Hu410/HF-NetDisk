/**
 * 目录操作路由
 * GET /api/directory/list?dir=&recursive=false  - 列出目录内容
 * GET /api/directory/tree                       - 列出完整文件树
 */

import { HuggingFaceAPI } from '../huggingfaceAPI.js';
import { errorResponse, successResponse } from '../utils/response.js';
import { withAuth } from '../middleware/auth.js';
import { sanitizePath } from '../utils/helpers.js';

const RECENT_CACHE_TTL = 30_000;
const recentFilesCache = new Map();

/**
 * 处理目录相关请求
 */
async function handleDirectoryRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method !== 'GET') {
    return errorResponse('Method not allowed', 405);
  }

  if (pathname.endsWith('/directory/tree') || pathname.endsWith('/dir/tree')) {
    return handleListAll(context);
  }

  if (pathname.endsWith('/directory/recent') || pathname.endsWith('/dir/recent')) {
    return handleListRecent(context);
  }

  if (pathname.endsWith('/directory/list') || pathname.endsWith('/dir/list')) {
    return handleListDirectory(context);
  }

  return errorResponse('Not found', 404);
}

async function handleListRecent(context) {
  const { hfToken, hfRepo, hfIsPrivate } = context;
  const url = new URL(context.request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const limit = 20;
  const cacheKey = `${hfRepo}:${hfIsPrivate}`;
  let cached = recentFilesCache.get(cacheKey);

  if (!cached || Date.now() - cached.createdAt >= RECENT_CACHE_TTL) {
    const api = new HuggingFaceAPI(hfToken, hfRepo, hfIsPrivate, context.env);
    const result = await api.listDirectoryAllPages('', true, { expand: true, serverRecursive: true });
    const files = result.files
      .filter(item => !isSystemPath(item.path))
      .sort((a, b) => {
        const time = new Date(b.lastModified || 0) - new Date(a.lastModified || 0);
        return time || a.path.localeCompare(b.path);
      });
    cached = { createdAt: Date.now(), files };
    recentFilesCache.set(cacheKey, cached);
  }

  const totalFiles = cached.files.length;
  const totalPages = Math.max(1, Math.ceil(totalFiles / limit));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * limit;
  return successResponse({
    files: cached.files.slice(start, start + limit),
    pagination: { page: currentPage, limit, totalFiles, totalPages },
  });
}

/**
 * 列出目录内容
 * GET /api/directory/list?dir=xxx&recursive=false&page=1&limit=100
 */
async function handleListDirectory(context) {
  const { hfToken, hfRepo, hfIsPrivate } = context;
  const url = new URL(context.request.url);

  const dir = sanitizePath(url.searchParams.get('dir') || '');
  const recursive = url.searchParams.get('recursive') === 'true';
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 100));
  const cursor = url.searchParams.get('cursor') || null;
  const search = url.searchParams.get('search') || '';
  const expand = url.searchParams.get('expand') === 'true';

  const api = new HuggingFaceAPI(hfToken, hfRepo, hfIsPrivate, context.env);
  const result = recursive && search
    ? await api.listDirectoryAllPages(dir, true, { serverRecursive:true, ...(expand ? { expand:true } : {}) })
    : await api.listDirectory(dir, recursive, recursive ? (expand ? { expand:true } : {}) : { limit, cursor, ...(expand ? { expand:true } : {}) });

  // 搜索过滤
  let { files, directories } = result;
  files = files.filter(item => !isSystemPath(item.path));
  directories = directories.filter(item => !isSystemPath(item.path));
  if (search) {
    const lowerSearch = search.toLowerCase();
    files = files.filter(f =>
      f.name.toLowerCase().includes(lowerSearch) ||
      f.path.toLowerCase().includes(lowerSearch)
    );
  }

  // 分页
  const totalFiles = files.length;
  const totalDirs = directories.length;
  const start = (page - 1) * limit;
  const pagedFiles = cursor || result.nextCursor ? files : files.slice(start, start + limit);

  return successResponse({
    directory: dir || '/',
    files: pagedFiles,
    directories,
    pagination: {
      page,
      limit,
      totalFiles,
      totalDirs,
      totalPages: Math.ceil(totalFiles / limit) || 1,
      nextCursor: result.nextCursor || null,
    },
  });
}

/**
 * 列出完整文件树（递归）
 * GET /api/directory/tree
 */
async function handleListAll(context) {
  const { hfToken, hfRepo, hfIsPrivate } = context;
  const directoriesOnly = new URL(context.request.url).searchParams.get('directoriesOnly') === 'true';

  const api = new HuggingFaceAPI(hfToken, hfRepo, hfIsPrivate, context.env);
  const result = directoriesOnly
    ? await api.listDirectoryAllPages('', true, { serverRecursive: true })
    : await api.listAllFiles();
  result.files = result.files.filter(item => !isSystemPath(item.path));
  result.directories = result.directories.filter(item => !isSystemPath(item.path));

  if (directoriesOnly) {
    const paths = new Set(result.directories.map(item => item.path).filter(Boolean));
    for (const file of result.files) {
      const parts = (file.path || '').split('/');
      parts.pop();
      let path = '';
      for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        if (!isSystemPath(path)) paths.add(path);
      }
    }
    return successResponse({
      totalDirectories: paths.size,
      directories: [...paths].sort((a, b) => a.localeCompare(b)).map(path => ({ path, name: path.split('/').pop(), type: 'directory' })),
    });
  }

  return successResponse({
    totalFiles: result.files.length,
    totalDirectories: result.directories.length,
    files: result.files,
    directories: result.directories,
  });
}

/**
 * 路由入口
 */
export const directoryHandler = withAuth(handleDirectoryRequest);

function isSystemPath(path) {
  return path === '.trash' || path.startsWith('.trash/') || path === '.hftags' || path.startsWith('.hftags/');
}
