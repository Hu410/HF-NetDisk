import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/durableObjects/sessionStore.js';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.get(key); }
  async put(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async deleteAll() { this.values.clear(); }
}

function createStore() {
  return new SessionStore({ storage: new MemoryStorage() });
}

async function call(store, path, body = {}) {
  return store.fetch(new Request(`https://session${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })).then(response => response.json());
}

describe('SessionStore', () => {
  it('creates, verifies, and revokes a session', async () => {
    const store = createStore();
    const created = await call(store, '/session/create', { remember: false });
    expect(created.sessionId).toMatch(/^[a-f0-9]{64}$/);
    expect((await call(store, '/session/verify', { sessionId: created.sessionId })).valid).toBe(true);
    await call(store, '/session/delete', { sessionId: created.sessionId });
    expect((await call(store, '/session/verify', { sessionId: created.sessionId })).valid).toBe(false);
  });

  it('blocks a client after five failed logins', async () => {
    const store = createStore();
    for (let index = 0; index < 5; index++) {
      await call(store, '/login/result', { key: 'client', success: false });
    }
    const result = await call(store, '/login/check', { key: 'client' });
    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('clears the failure counter after a successful login', async () => {
    const store = createStore();
    await call(store, '/login/result', { key: 'client', success: false });
    await call(store, '/login/result', { key: 'client', success: true });
    expect((await call(store, '/login/check', { key: 'client' })).allowed).toBe(true);
  });
});
