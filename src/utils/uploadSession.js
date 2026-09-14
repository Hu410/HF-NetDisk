import { getSessionId } from './session.js';
import { randomHex, sha256HexString } from './helpers.js';

export async function sessionOwnerHash(request) {
  const sessionId = getSessionId(request) || '';
  return sha256HexString(sessionId);
}

export function newUploadId() {
  return randomHex(24);
}

export function getUploadStub(env, uploadId) {
  if (!env.UPLOADS || !/^[a-f0-9]{48}$/.test(uploadId || '')) throw new Error('Invalid upload session');
  return env.UPLOADS.get(env.UPLOADS.idFromName(uploadId));
}
