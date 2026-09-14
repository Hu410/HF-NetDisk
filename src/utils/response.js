/**
 * 统一响应工具
 * 提供标准化的 HTTP 响应生成函数
 */

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-Frame-Options': 'DENY',
};

/**
 * 创建 JSON 成功响应
 * @param {object} data - 响应数据
 * @param {number} status - HTTP 状态码
 * @returns {Response}
 */
export function jsonResponse(data, status = 200, extraHeaders = undefined) {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json');
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => headers.set(name, value));
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

/**
 * 创建错误响应
 * @param {string} message - 错误消息
 * @param {number} status - HTTP 状态码
 * @param {*} [details] - 可选的详细错误信息
 * @returns {Response}
 */
export function errorResponse(message, status = 400, details = null, code = 'REQUEST_FAILED') {
  const body = { success: false, error: message, code };
  if (details !== null) {
    body.details = details;
  }
  return jsonResponse(body, status);
}

/**
 * 创建成功响应
 * @param {object} data - 额外数据
 * @param {string} [message] - 可选的提示消息
 * @returns {Response}
 */
export function successResponse(data = {}, message = 'OK') {
  return jsonResponse({
    success: true,
    message,
    ...data,
  });
}

export function contentDisposition(disposition, fileName) {
  const fallback = fileName
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * 创建文件流响应
 * @param {ReadableStream} body - 文件流
 * @param {object} options - 响应选项
 * @param {number} options.status - HTTP 状态码
 * @param {object} options.headers - 自定义响应头
 * @returns {Response}
 */
export function fileResponse(body, options = {}) {
  const headers = new Headers(options.headers || {});
  Object.entries(SECURITY_HEADERS).forEach(([name, value]) => headers.set(name, value));
  return new Response(body, {
    status: options.status || 200,
    headers,
  });
}
