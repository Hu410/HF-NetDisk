/**
 * 辅助函数
 * 提供通用的工具函数
 */

/**
 * 获取文件前 N 字节的 base64 编码（样本）
 * @param {Blob} blob - 文件 Blob
 * @param {number} size - 样本大小（默认 512 字节）
 * @returns {Promise<string>} base64 编码的样本数据
 */
export async function getFileSample(blob, size = 512) {
  const slice = blob.slice(0, Math.min(size, blob.size));
  const bytes = new Uint8Array(await slice.arrayBuffer());
  return btoa(String.fromCharCode(...bytes));
}

export function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function randomAlphanumeric(length) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const limit = 256 - (256 % alphabet.length);
  let result = '';
  while (result.length < length) {
    const bytes = new Uint8Array(Math.ceil((length - result.length) * 1.1));
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= limit) continue;
      result += alphabet[byte % alphabet.length];
      if (result.length === length) break;
    }
  }
  return result;
}

export async function sha256HexString(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * 路径安全处理：防止路径穿越
 * @param {string} path - 原始路径
 * @returns {string} 安全路径
 */
export function sanitizePath(path) {
  if (typeof path !== 'string') return '';
  const normalized = path.normalize('NFC').replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.length > 1024 || normalized.includes('\\') || /[\u0000-\u001f\u007f]/.test(normalized)) return '';
  const segments = normalized.split('/');
  if (segments.length > 64 || segments.some(segment => !segment || segment === '.' || segment === '..' || segment.length > 255)) return '';
  return segments.join('/');
}

export function encodeRepoPath(repo) {
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('Invalid repository name');
  return repo.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

export function encodeFilePath(path) {
  const safe = sanitizePath(path);
  if (!safe) throw new Error('Invalid file path');
  return safe.split('/').map(segment => encodeURIComponent(segment)).join('/');
}
