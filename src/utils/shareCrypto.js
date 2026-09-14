import { randomHex, sha256HexString } from './helpers.js';

const ITERATIONS = 100000;

export async function createPasswordDigest(password) {
  if (!password) return { passwordSalt: null, passwordHash: null };
  const passwordSalt = randomHex(16);
  return { passwordSalt, passwordHash: await derive(password, passwordSalt) };
}

export async function verifyPassword(password, salt, expected) {
  if (!salt || !expected) return false;
  const actual = await derive(password, salt);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

export async function hashShareToken(token) {
  return sha256HexString(token);
}

async function derive(password, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: ITERATIONS,
  }, key, 256);
  return Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('');
}
