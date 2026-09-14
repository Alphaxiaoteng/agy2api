import { writeStreamData } from '../../stream.js';
import { createOpenAIStreamChunk } from '../../formatters/openai.js';
import { createGeminiStreamChunk } from '../../formatters/gemini.js';
import { ClaudeStreamState } from './claudeStreamState.js';

function safeParseJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * 创建 GeminiCLI 的流式输出 writer：把上游事件写成目标协议（OpenAI/Gemini/Claude）
 * @param {{format: 'openai'|'gemini'|'claude', res: any, id: string, created: number, responseModel: string}} args
 */
export function createGeminiCliStreamWriter({ format, res, id, created, responseModel }) {
  let hasToolCall = false;
  let usageData = null;

  // OpenAI
  let isFirstChunk = true;

  // Claude
  let claudeState = null;
  let claudeThinkingSignature = null;
  if (format === 'claude') {
    claudeState = new ClaudeStreamState(responseModel);
  }

  return {
    onEvent(data) {
      if (!data) return;

      if (format === 'gemini') {
        if (data.type === 'usage') {
          usageData = data.usage;
          return;
        }

        if (data.type === 'reasoning') {
          const parts = [{ thought: true, text: data.reasoning_content }];
          writeStreamData(res, createGeminiStreamChunk(parts));
          return;
        }

        if (data.type === 'tool_calls') {
          hasToolCall = true;
          const parts = (data.tool_calls || []).map(toolCall => {
            const { thoughtSignature, ...rest } = toolCall;
            const args = safeParseJson(rest?.function?.arguments) || {};
            return {
              functionCall: {
                name: rest.function.name,
                args
              },
              ...(thoughtSignature ? { thoughtSignature } : {})
            };
          });
          writeStreamData(res, createGeminiStreamChunk(parts));
          return;
        }

        if (data.content) {
          const parts = [{ text: data.content }];
          writeStreamData(res, createGeminiStreamChunk(parts));
        }

        return;
      }

      if (format === 'claude') {
        if (!claudeState.hasStarted) {
          writeStreamData(res, claudeState.createMessageStart());
        }

        if (data.type === 'usage') {
          usageData = data.usage;
          return;
        }

        if (data.type === 'reasoning') {
          if (!claudeState.hasThinkingBlock) {
            claudeThinkingSignature = data.thoughtSignature || null;
            writeStreamData(res, claudeState.createThinkingBlockStart(claudeThinkingSignature));
          }
          writeStreamData(res, claudeState.createThinkingDelta(data.reasoning_content));
          return;
        }

        if (data.type === 'tool_calls') {
          hasToolCall = true;

          if (claudeState.hasThinkingBlock && !claudeState.hasTextBlock) {
            writeStreamData(res, claudeState.createBlockStop());
            claudeState.hasThinkingBlock = false;
          }
          if (claudeState.hasTextBlock) {
            writeStreamData(res, claudeState.createBlockStop());
            claudeState.hasTextBlock = false;
          }

          for (const toolCall of (data.tool_calls || [])) {
            const { thoughtSignature, ...rest } = toolCall;
            void thoughtSignature;
            writeStreamData(res, claudeState.createToolUseBlockStart(rest.id, rest.function.name));
            writeStreamData(res, claudeState.createToolUseInputDelta(rest.function.arguments));
            writeStreamData(res, claudeState.createBlockStop());
          }
          return;
        }

        if (data.content) {
          if (claudeState.hasThinkingBlock && !claudeState.hasTextBlock) {
            writeStreamData(res, claudeState.createBlockStop());
            claudeState.hasThinkingBlock = false;
          }
          if (!claudeState.hasTextBlock) {
            writeStreamData(res, claudeState.createTextBlockStart());
          }
          writeStreamData(res, claudeState.createTextDelta(data.content));
        }

        return;
      }

      // OpenAI
      if (isFirstChunk) {
        isFirstChunk = false;
        writeStreamData(res, createOpenAIStreamChunk(id, created, responseModel, { role: 'assistant' }));
      }

      if (data.type === 'usage') {
        usageData = data.usage;
        return;
      }

      if (data.type === 'reasoning') {
        const delta = { reasoning_content: data.reasoning_content };
        writeStreamData(res, createOpenAIStreamChunk(id, created, responseModel, delta));
        return;
      }

      if (data.type === 'tool_calls') {
        hasToolCall = true;
        const toolCallsWithIndex = (data.tool_calls || []).map((toolCall, index) => {
          const { thoughtSignature, ...rest } = toolCall;
          void thoughtSignature;
          return { index, ...rest };
        });
        const delta = { tool_calls: toolCallsWithIndex };
        writeStreamData(res, createOpenAIStreamChunk(id, created, responseModel, delta));
        return;
      }

      const delta = { content: data.content };
      writeStreamData(res, createOpenAIStreamChunk(id, created, responseModel, delta));
    },

    finalize() {
      if (format === 'gemini') {
        const finalChunk = createGeminiStreamChunk([], 'STOP');
        if (usageData) {
          finalChunk.usageMetadata = {
            promptTokenCount: usageData.prompt_tokens,
            candidatesTokenCount: usageData.completion_tokens,
            totalTokenCount: usageData.total_tokens
          };
        }
        writeStreamData(res, finalChunk);
        return;
      }

      if (format === 'claude') {
        if (claudeState.hasTextBlock || claudeState.hasThinkingBlock) {
          writeStreamData(res, claudeState.createBlockStop());
        }
        const stopReason = hasToolCall ? 'tool_use' : 'end_turn';
        const outputTokens = usageData ? usageData.completion_tokens : 0;
        writeStreamData(res, claudeState.createMessageDelta(stopReason, outputTokens));
        writeStreamData(res, claudeState.createMessageStop());
        return;
      }

      writeStreamData(
        res,
        {
          ...createOpenAIStreamChunk(id, created, responseModel, {}, hasToolCall ? 'tool_calls' : 'stop'),
          usage: usageData
        }
      );
    },

    getUsageData() {
      return usageData;
    },

    getHasToolCall() {
      return hasToolCall;
    }
  };
}

/**
 * 假流式输出：使用非流式结果模拟流式
 */
export function writeGeminiCliFakeStreamResponse({
  format,
  res,
  id,
  created,
  responseModel,
  content,
  reasoningContent,
  reasoningSignature,
  toolCalls,
  usage
}) {
  if (format === 'gemini') {
    if (reasoningContent) {
      const parts = [{ thought: true, text: reasoningContent }];
      writeStreamData(res, createGeminiStreamChunk(parts));
    }

    if (toolCalls && toolCalls.length > 0) {
      const parts = toolCalls.map(toolCall => {
        const { thoughtSignature, ...rest } = toolCall;
        const args = safeParseJson(rest?.function?.arguments) || {};
        return {
          functionCall: {
            name: rest.function.name,
            args
          },
          ...(thoughtSignature ? { thoughtSignature } : {})
        };
      });
      writeStreamData(res, createGeminiStreamChunk(parts));
    }

    if (content) {
      const parts = [{ text: content }];
      writeStreamData(res, createGeminiStreamChunk(parts));
    }

    const finalChunk = createGeminiStreamChunk([], 'STOP');
    if (usage) {
      finalChunk.usageMetadata = {
        promptTokenCount: usage.prompt_tokens,
        candidatesTokenCount: usage.completion_tokens,
        totalTokenCount: usage.total_tokens
      };
    }
    writeStreamData(res, finalChunk);
    return;
  }

  if (format === 'claude') {
    const claudeState = new ClaudeStreamState(responseModel);

    writeStreamData(res, claudeState.createMessageStart());

    if (reasoningContent) {
      writeStreamData(res, claudeState.createThinkingBlockStart(reasoningSignature));
      writeStreamData(res, claudeState.createThinkingDelta(reasoningContent));
      writeStreamData(res, claudeState.createBlockStop());
    }

    if (toolCalls && toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        const { thoughtSignature, ...rest } = toolCall;
        void thoughtSignature;
        writeStreamData(res, claudeState.createToolUseBlockStart(rest.id, rest.function.name));
        writeStreamData(res, claudeState.createToolUseInputDelta(rest.function.arguments));
        writeStreamData(res, claudeState.createBlockStop());
      }
    }

    if (content) {
      writeStreamData(res, claudeState.createTextBlockStart());
      writeStreamData(res, claudeState.createTextDelta(content));
      writeStreamData(res, claudeState.createBlockStop());
    }

    const stopReason = (toolCalls && toolCalls.length > 0) ? 'tool_use' : 'end_turn';
    const outputTokens = usage ? usage.completion_tokens : 0;
    writeStreamData(res, claudeState.createMessageDelta(stopReason, outputTokens));
    writeStreamData(res, claudeState.createMessageStop());
    return;
  }

  // OpenAI
  if (reasoningContent) {
    const delta = { reasoning_content: reasoningContent };
    writeStreamData(res, createOpenAIStreamChunk(id, created, responseModel, delta));
  }

  if (toolCalls && toolCalls.length > 0) {
    const toolCallsWithIndex = toolCalls.map((toolCall, index) => {
      const { thoughtSignature, ...rest } = toolCall;
      void thoughtSignature;
      return { index, ...rest };
    });
    const delta = { tool_calls: toolCallsWithIndex };
    writeStreamData(res, createOpenAIStreamChunk(id, created, responseModel, delta));
  }

  if (content) {
    const delta = { content };
    writeStreamData(res, createOpenAIStreamChunk(id, created, responseModel, delta));
  }

  const finishReason = (toolCalls && toolCalls.length > 0) ? 'tool_calls' : 'stop';
  writeStreamData(res, { ...createOpenAIStreamChunk(id, created, responseModel, {}, finishReason), usage });
}
