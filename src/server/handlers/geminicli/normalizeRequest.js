import { detectRequestFormat } from '../../../utils/converters/geminicli.js';
import { validateIncomingChatRequest } from '../../validators/chat.js';

/**
 * 规范化 GeminiCLI 入口请求：
 * - 检测格式（OpenAI/Gemini/Claude）
 * - 判定 stream（Gemini 由路由 _isStream 标记决定）
 * - 校验必填字段
 * - 清理内部标记
 *
 * @param {any} requestBody
 * @param {('openai'|'gemini'|'claude'|null)} forceFormat
 * @returns {{ok: true, format: 'openai'|'gemini'|'claude', stream: boolean, cleanedBody: any} | {ok:false, status:number, message:string}}
 */
export function normalizeGeminiCliRequest(requestBody, forceFormat = null) {
  const format = forceFormat || detectRequestFormat(requestBody);

  let stream = false;
  if (format === 'openai' || format === 'claude') {
    stream = requestBody?.stream || false;
  } else if (format === 'gemini') {
    stream = requestBody?._isStream || false;
  }

  const validation = validateIncomingChatRequest(format, requestBody);
  if (!validation.ok) {
    return { ok: false, status: validation.status, message: validation.message };
  }

  const cleanedBody = { ...requestBody };
  delete cleanedBody._isStream;

  return { ok: true, format, stream, cleanedBody };
}
