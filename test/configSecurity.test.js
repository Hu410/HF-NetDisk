import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('deployment configuration', () => {
  it('never stores runtime secrets in wrangler.toml', async () => {
    const config = await readFile(new URL('../wrangler.toml', import.meta.url), 'utf8');
    expect(config).not.toMatch(/^\s*HF_TOKEN\s*=/m);
    expect(config).not.toMatch(/^\s*APP_PASSWORD\s*=/m);
  });
});
