import { randomHex as randomToken, sha256HexString as hashToken } from '../utils/helpers.js';

const SESSION_TTL_SECONDS = 12 * 60 * 60;
const REMEMBER_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;

export class SessionStore {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};

    switch (url.pathname) {
      case '/login/check':
        return this.checkLogin(body.key || 'unknown');
      case '/login/result':
        return this.recordLogin(body);
      case '/session/create':
        return this.createSession(Boolean(body.remember));
      case '/session/verify':
        return this.verifySession(body.sessionId);
      case '/session/delete':
        return this.deleteSession(body.sessionId);
      case '/session/delete-all':
        await this.state.storage.deleteAll();
        return Response.json({ success: true });
      default:
        return Response.json({ error: 'Not found' }, { status: 404 });
    }
  }

  async checkLogin(key) {
    const record = await this.state.storage.get(`login:${key}`);
    const now = Date.now();
    if (!record || now - record.startedAt >= LOGIN_WINDOW_MS) {
      return Response.json({ allowed: true });
    }
    const retryAfter = Math.max(1, Math.ceil((LOGIN_WINDOW_MS - (now - record.startedAt)) / 1000));
    return Response.json({ allowed: record.failures < MAX_LOGIN_FAILURES, retryAfter });
  }

  async recordLogin({ key = 'unknown', success = false }) {
    const storageKey = `login:${key}`;
    if (success) {
      await this.state.storage.delete(storageKey);
      return Response.json({ success: true });
    }

    const now = Date.now();
    const existing = await this.state.storage.get(storageKey);
    const record = !existing || now - existing.startedAt >= LOGIN_WINDOW_MS
      ? { failures: 1, startedAt: now }
      : { failures: existing.failures + 1, startedAt: existing.startedAt };
    await this.state.storage.put(storageKey, record, { expirationTtl: Math.ceil(LOGIN_WINDOW_MS / 1000) });
    return Response.json({ success: true, failures: record.failures });
  }

  async createSession(remember) {
    const sessionId = randomToken(32);
    const ttl = remember ? REMEMBER_TTL_SECONDS : SESSION_TTL_SECONDS;
    const now = Date.now();
    await this.state.storage.put(`session:${await hashToken(sessionId)}`, {
      createdAt: now,
      expiresAt: now + ttl * 1000,
      lastSeenAt: now,
    }, { expirationTtl: ttl });
    return Response.json({ sessionId, ttl });
  }

  async verifySession(sessionId) {
    if (!sessionId) return Response.json({ valid: false });
    const key = `session:${await hashToken(sessionId)}`;
    const session = await this.state.storage.get(key);
    if (!session || session.expiresAt <= Date.now()) {
      if (session) await this.state.storage.delete(key);
      return Response.json({ valid: false });
    }
    return Response.json({ valid: true, expiresAt: session.expiresAt });
  }

  async deleteSession(sessionId) {
    if (sessionId) await this.state.storage.delete(`session:${await hashToken(sessionId)}`);
    return Response.json({ success: true });
  }
}
