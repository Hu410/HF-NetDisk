import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

async function hashWithWorker(value, chunkSize) {
  const messages = [];
  const self = { postMessage: message => messages.push(message) };
  vm.runInNewContext(readFileSync(new URL('../frontend/js/sha256-worker.js', import.meta.url), 'utf8'), { self, Uint8Array, Uint32Array, BigInt, Number, Array, Math });
  await self.onmessage({ data:{ file:new Blob([value]), chunkSize } });
  const error = messages.find(message => message.type === 'error');
  if (error) throw new Error(error.message);
  return messages.find(message => message.type === 'done').hash;
}

describe('incremental SHA-256 worker', () => {
  it('matches standard test vectors across chunk boundaries', async () => {
    expect(await hashWithWorker('', 2)).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(await hashWithWorker('abc', 1)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hashWithWorker('a'.repeat(1000), 17)).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
  });
});
