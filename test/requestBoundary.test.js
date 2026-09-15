import { describe, expect, it } from 'vitest';
import worker from '../src/index.js';

describe('request boundary', () => {
  it('serves the app shell when a frontend route is refreshed directly', async () => {
    const requestedPaths = [];
    const env = {
      ASSETS: {
        fetch: async request => {
          requestedPaths.push(new URL(request.url).pathname);
          return new Response('<!doctype html><title>HF HUB</title>', { headers: { 'Content-Type':'text/html' } });
        },
      },
    };
    const response = await worker.fetch(new Request('https://disk.example/recent'), env);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
    expect(await response.text()).toContain('HF HUB');
    expect(requestedPaths).toEqual(['/']);
  });

  it('serves the public share shell for an eight-character share route', async () => {
    const requestedPaths = [];
    const env = {
      ASSETS: {
        fetch: async request => {
          requestedPaths.push(new URL(request.url).pathname);
          return new Response('<!doctype html><title>Shared file</title>', { headers: { 'Content-Type':'text/html' } });
        },
      },
    };
    const response = await worker.fetch(new Request('https://disk.example/s/aB3dE5g7'), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Shared file');
    expect(requestedPaths).toEqual(['/share']);
  });

  it('reports binding readiness without exposing configuration values', async () => {
    const env = { SESSIONS: {}, UPLOADS: {}, SHARES: {}, HF_REPO: 'owner/repo', HF_TOKEN: 'secret', APP_PASSWORD: 'secret' };
    const response = await worker.fetch(new Request('https://disk.example/api/health'), env);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'ok', checks: { sessions: true, uploads: true, shares: true, repository: true, authentication: true } });
    expect(JSON.stringify(body)).not.toContain('owner/repo');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  it('adds the same request id to error headers and bodies', async () => {
    const response = await worker.fetch(new Request('https://disk.example/api/missing'), {});
    const body = await response.json();
    expect(response.status).toBe(404);
    expect(body.code).toBe('NOT_FOUND');
    expect(body.requestId).toBe(response.headers.get('X-Request-Id'));
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('rejects cross-origin writes', async () => {
    const response = await worker.fetch(new Request('https://disk.example/api/auth/logout', {
      method: 'POST', headers: { Origin: 'https://evil.example' },
    }), {});
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body.code).toBe('INVALID_ORIGIN');
    expect(body.requestId).toBeTruthy();
  });
});
