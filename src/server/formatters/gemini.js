/**
 * Gemini 响应格式化工具
 */

/**
 * 创建 Gemini 格式流式数据块
 * @param {Array} parts
 * @param {string|null} finishReason
 * @returns {Object}
 */
export const createGeminiStreamChunk = (parts, finishReason = null) => ({
  candidates: [{
    content: { parts, role: 'model' },
    finishReason,
    index: 0
  }]
});

/**
 * 创建 Gemini 非流式响应
 * @param {string|null} content
 * @param {string|null} reasoning
 * @param {string|null} reasoningSignature
 * @param {Array|null} toolCalls
 * @param {string|null} finishReason
 * @param {Object|null} usage
 * @param {{passSignatureToClient?: boolean}} options
 * @returns {Object}
 */
export const createGeminiResponse = (
  content,
  reasoning,
  reasoningSignature,
  toolCalls,
  finishReason,
  usage,
  options = {}
) => {
  const passSignatureToClient = options.passSignatureToClient === true;
  const fallbackThoughtSignature = options.fallbackThoughtSignature || null;

  const parts = [];

  if (reasoning) {
    const thoughtPart = { text: reasoning, thought: true };
    if (reasoningSignature && passSignatureToClient) {
      thoughtPart.thoughtSignature = reasoningSignature;
    }
    parts.push(thoughtPart);
  }

  if (content) {
    const textPart = { text: content };
    // 生图模型没有 thought part，但上游仍可能返回 thoughtSignature；透传时挂在文本 part 上
    if (!reasoning && reasoningSignature && passSignatureToClient) {
      textPart.thoughtSignature = reasoningSignature;
    }
    parts.push(textPart);
  }

  if (toolCalls && toolCalls.length > 0) {
    toolCalls.forEach(tc => {
      try {
        const functionCallPart = {
          functionCall: {
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments)
          }
        };
        const sig = tc.thoughtSignature || fallbackThoughtSignature;
        if (sig && passSignatureToClient) {
          functionCallPart.thoughtSignature = sig;
        }
        parts.push(functionCallPart);
      } catch {
        // 忽略解析错误
      }
    });
  }

  const response = {
    candidates: [{
      content: {
        parts: parts,
        role: 'model'
      },
      finishReason: finishReason || 'STOP',
      index: 0
    }]
  };

  if (usage) {
    response.usageMetadata = {
      promptTokenCount: usage.prompt_tokens,
      candidatesTokenCount: usage.completion_tokens,
      totalTokenCount: usage.total_tokens
    };
  }

  return response;
};
