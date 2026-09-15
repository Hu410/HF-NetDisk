import { repoHandler } from './routes/repo.js';
import { filesHandler } from './routes/files.js';
import { directoryHandler } from './routes/directory.js';
import { metadataHandler } from './routes/metadata.js';
import { authHandler } from './routes/auth.js';
import { trashHandler } from './routes/trash.js';
import { sharesHandler } from './routes/shares.js';
import { jsonResponse } from './utils/response.js';

export { SessionStore } from './durableObjects/sessionStore.js';
export { UploadSession } from './durableObjects/uploadSession.js';
export { ShareStore } from './durableObjects/shareStore.js';

const FRONTEND_ROUTES = new Set(['/', '/files', '/recent', '/shares', '/trash', '/dashboard', '/settings', '/upload']);
const PUBLIC_SHARE_ROUTE = /^\/s\/(?:[A-Za-z0-9]{8}|[a-f0-9]{32})\/?$/;

function logError(requestId, request, error) {
  const url = new URL(request.url);
  console.error(JSON.stringify({
    level: 'error', event: 'request_failed', requestId,
    method: request.method, path: url.pathname,
    error: error instanceof Error ? error.message : String(error),
  }));
}

async function attachRequestId(response, requestId) {
  const headers = new Headers(response.headers);
  headers.set('X-Request-Id', requestId);
  if (response.status < 400 || !headers.get('Content-Type')?.includes('application/json')) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  const body = await response.json().catch(() => ({ success: false, error: 'Request failed', code: 'REQUEST_FAILED' }));
  return jsonResponse({ ...body, requestId }, response.status, headers);
}

async function router(context) {
  const { request } = context;
  const url = new URL(request.url);
  const pathname = url.pathname.toLowerCase();

  if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('Origin');
    if (!origin || origin !== url.origin) {
      return jsonResponse({ success: false, error: 'Invalid request origin', code: 'INVALID_ORIGIN' }, 403);
    }
  }
  if (request.method === 'OPTIONS') {
    return jsonResponse({ success: false, error: 'Cross-origin requests are not supported', code: 'CORS_DISABLED' }, 405);
  }

  if (pathname === '/api/health' && request.method === 'GET') {
    const checks = {
      sessions: Boolean(context.env.SESSIONS),
      uploads: Boolean(context.env.UPLOADS),
      shares: Boolean(context.env.SHARES),
      repository: Boolean(context.env.HF_REPO && context.env.HF_TOKEN),
      authentication: Boolean(context.env.APP_PASSWORD),
    };
    const healthy = Object.values(checks).every(Boolean);
    return jsonResponse({ status: healthy ? 'ok' : 'degraded', checks }, healthy ? 200 : 503, { 'Cache-Control': 'no-store' });
  }

  if (pathname.startsWith('/api/auth/')) return authHandler(context);
  if (pathname.startsWith('/api/shares') || pathname.startsWith('/api/public/shares/')) return sharesHandler(context);
  if (pathname.startsWith('/api/trash/')) return trashHandler(context);
  if (pathname === '/api/repo' || pathname === '/api/repo/info') return repoHandler(context);
  if (pathname.startsWith('/api/files/')) return filesHandler(context);
  if (pathname.startsWith('/api/directory/') || pathname.startsWith('/api/dir/')) return directoryHandler(context);
  if (pathname.startsWith('/api/meta/')) return metadataHandler(context);
  if (pathname === '/api') {
    return jsonResponse({ name: 'Cloudflare HF Netdisk', version: '1.0.0', documentation: '/openapi.yaml', authentication: 'HttpOnly session cookie' });
  }
  if (PUBLIC_SHARE_ROUTE.test(url.pathname) && ['GET', 'HEAD'].includes(request.method) && context.env.ASSETS?.fetch) {
    // Cloudflare Assets canonicalizes /share.html to /share with a redirect.
    // Request the canonical asset path internally so the browser keeps /s/{id}.
    const shareUrl = new URL('/share', url);
    return context.env.ASSETS.fetch(new Request(shareUrl, request));
  }
  if (FRONTEND_ROUTES.has(pathname) && ['GET', 'HEAD'].includes(request.method) && context.env.ASSETS?.fetch) {
    const indexUrl = new URL('/', url);
    return context.env.ASSETS.fetch(new Request(indexUrl, request));
  }
  return jsonResponse({ success: false, error: 'Not found', code: 'NOT_FOUND', path: pathname }, 404);
}

export default {
  async fetch(request, env) {
    const requestId = crypto.randomUUID();
    let response;
    try {
      response = await router({ request, env, requestId });
    } catch (error) {
      logError(requestId, request, error);
      response = jsonResponse({ success: false, error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500);
    }
    return attachRequestId(response, requestId);
  },
};
