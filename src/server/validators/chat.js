/**
 * 统一的请求必填字段校验（不绑定具体响应格式）
 * 返回结构化结果，避免在各 handler 里重复写 if/return。
 */

/**
 * @typedef {'openai'|'gemini'|'claude'} ChatFormat
 */

/**
 * @param {ChatFormat} format
 * @param {any} body
 * @returns {{ok: true} | {ok: false, status: number, message: string, field: string}}
 */
export function validateIncomingChatRequest(format, body) {
  if (!body || typeof body !== 'object') {
    return { ok: false, status: 400, message: 'request body is required', field: 'body' };
  }

  if (format === 'openai' || format === 'claude') {
    if (!Array.isArray(body.messages)) {
      return { ok: false, status: 400, message: 'messages is required', field: 'messages' };
    }
    return { ok: true };
  }

  if (format === 'gemini') {
    if (!Array.isArray(body.contents)) {
      return { ok: false, status: 400, message: 'contents is required', field: 'contents' };
    }
    return { ok: true };
  }

  return { ok: false, status: 400, message: 'unsupported format', field: 'format' };
}
