import { describe, expect, it } from 'vitest';
import { filesHandler } from '../src/routes/files.js';

function authenticatedEnv() {
  return {
    HF_TOKEN: 'test-token',
    HF_REPO: 'owner/repo',
    HF_PRIVATE: 'true',
    SESSIONS: {
      idFromName: () => 'global',
      get: () => ({
        fetch: async () => Response.json({ valid: true }),
      }),
    },
  };
}

describe('upload security', () => {
  it('rejects remote URL uploads', async () => {
    const env = authenticatedEnv();
    const request = new Request('https://example.com/api/files/upload', {
      method: 'POST',
      headers: {
        Cookie: 'hf_session=test-session',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: 'https://example.net/file' }),
    });
    const response = await filesHandler({ request, env });
    const body = await response.json();
    expect(response.status).toBe(415);
    expect(body.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('requires an authenticated session', async () => {
    const env = authenticatedEnv();
    const request = new Request('https://example.com/api/files/upload', {
      method: 'PUT',
      headers: { 'Content-Type': 'multipart/form-data' },
    });
    const response = await filesHandler({ request, env });
    expect(response.status).toBe(401);
  });
});
