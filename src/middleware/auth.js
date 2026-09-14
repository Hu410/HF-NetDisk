/**
 * Token 鉴权中间件
 * 验证请求中的 HuggingFace Access Token
 */

import { errorResponse } from '../utils/response.js';
import { verifySession } from '../utils/session.js';

/**
 * 鉴权中间件包装器
 * @param {Function} handler - 路由处理函数
 * @param {object} [options] - 鉴权选项
 * @param {boolean} [options.requireToken=true] - 是否必须提供 Token
 * @returns {Function} 包装后的处理函数
 */
export function withAuth(handler, options = {}) {
  const { requireToken = true } = options;

  return async (context) => {
    const { request, env } = context;

    if (!await verifySession(request, env)) {
      return errorResponse('Authentication required', 401, null, 'AUTH_REQUIRED');
    }
    if (requireToken && !env.HF_TOKEN) {
      return errorResponse('Hugging Face token is not configured', 503, null, 'HF_TOKEN_NOT_CONFIGURED');
    }
    const repo = env.HF_REPO;
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
      return errorResponse('Hugging Face repository is not configured', 503, null, 'HF_REPO_NOT_CONFIGURED');
    }

    // 将解析后的凭据注入 context
    context.hfToken = env.HF_TOKEN || null;
    context.hfRepo = repo;
    context.hfIsPrivate = env.HF_PRIVATE !== 'false';

    return handler(context);
  };
}
