import { errorResponse, successResponse } from '../utils/response.js';
import { getSessionId, getSessionStub, verifySession } from '../utils/session.js';

export async function authHandler(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (url.pathname === '/api/auth/status' && request.method === 'GET') {
    return successResponse({ authenticated: await verifySession(request, env) });
  }
  if (url.pathname === '/api/auth/login' && request.method === 'POST') {
    return login(request, env);
  }
  if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
    return logout(request, env);
  }
  return errorResponse('Method not allowed', 405, null, 'METHOD_NOT_ALLOWED');
}

async function login(request, env) {
  if (!env.APP_PASSWORD) {
    return errorResponse('Application password is not configured', 503, null, 'AUTH_NOT_CONFIGURED');
  }
  const contentLength = Number(request.headers.get('Content-Length') || 0);
  if (contentLength > 4096) return errorResponse('Request body too large', 413, null, 'BODY_TOO_LARGE');

  const body = await request.json().catch(() => null);
  if (!body || typeof body.password !== 'string') {
    return errorResponse('Password is required', 400, null, 'INVALID_REQUEST');
  }

  const clientKey = request.headers.get('CF-Connecting-IP') || 'local';
  const stub = getSessionStub(env);
  const limit = await stub.fetch('https://session/login/check', {
    method: 'POST', body: JSON.stringify({ key: clientKey }),
  }).then(response => response.json());
  if (!limit.allowed) {
    const response = errorResponse('Too many login attempts', 429, null, 'LOGIN_RATE_LIMITED');
    response.headers.set('Retry-After', String(limit.retryAfter || 60));
    return response;
  }

  const valid = await timingSafePasswordEqual(body.password, env.APP_PASSWORD);
  await stub.fetch('https://session/login/result', {
    method: 'POST', body: JSON.stringify({ key: clientKey, success: valid }),
  });
  if (!valid) return errorResponse('Invalid password', 401, null, 'INVALID_CREDENTIALS');

  const session = await stub.fetch('https://session/session/create', {
    method: 'POST', body: JSON.stringify({ remember: Boolean(body.remember) }),
  }).then(response => response.json());
  const response = successResponse({ authenticated: true }, 'Login successful');
  response.headers.append('Set-Cookie', buildSessionCookie(session.sessionId, session.ttl));
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

async function logout(request, env) {
  const sessionId = getSessionId(request);
  if (sessionId) {
    await getSessionStub(env).fetch('https://session/session/delete', {
      method: 'POST', body: JSON.stringify({ sessionId }),
    });
  }
  const response = successResponse({}, 'Logged out');
  response.headers.append('Set-Cookie', 'hf_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0');
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

async function timingSafePasswordEqual(provided, expected) {
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function buildSessionCookie(sessionId, ttl) {
  return `hf_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${ttl}`;
}
