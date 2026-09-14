// OpenAI 格式转换工具
import config from '../../config/config.js';
import { extractSystemInstruction } from '../utils.js';
import { convertOpenAIToolsToAntigravity } from '../toolConverter.js';
import {
  getSignatureContext,
  pushUserMessage,
  findFunctionNameById,
  pushFunctionResponse,
  createThoughtPart,
  createFunctionCallPart,
  processToolName,
  pushModelMessage,
  buildRequestBody,
  modelMapping,
  isEnableThinking,
  generateGenerationConfig,
  getThoughtSignatureForModel,
  getToolSignatureForModel,
  GEMINI_TOOL_SIGNATURE
} from './common.js';

function extractImagesFromContent(content) {
  const result = { text: '', images: [] };
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        const imageUrl = item.image_url?.url || '';
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          result.images.push({
            inlineData: {
              mimeType: `image/${match[1]}`,
              data: match[2]
            }
          });
        }
      }
    }
  }
  return result;
}

function handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId, hasTools) {
  // 安全提取文本与思考内容（支持 string, Array, 及其嵌套格式）
  let textContent = '';
  let reasoningFromContent = '';
  if (typeof message.content === 'string') {
    textContent = message.content;
  } else if (Array.isArray(message.content)) {
    for (const item of message.content) {
      if (item && item.type === 'text' && typeof item.text === 'string') {
        textContent += item.text;
      } else if (item && (item.type === 'reasoning' || item.type === 'thought') && typeof item.text === 'string') {
        reasoningFromContent += item.text;
      }
    }
  }

  const rawToolCalls = message.tool_calls || message.toolCalls;
  const hasToolCalls = Array.isArray(rawToolCalls) && rawToolCalls.length > 0;
  const hasContent = typeof textContent === 'string' && textContent.trim() !== '';
  const { reasoningSignature, reasoningContent, toolSignature, toolContent } = getSignatureContext(sessionId, actualModelName, hasTools);
  const msgSignature = message.thoughtSignature || message.thought_signature || message.signature;
  
  const toolCalls = hasToolCalls
    ? rawToolCalls.map(toolCall => {
      const toolName = toolCall.function?.name || toolCall.name;
      const safeName = processToolName(toolName, sessionId, actualModelName);
      const tcSignature = toolCall.thoughtSignature || toolCall.thought_signature || toolCall.signature || (toolCall.function && (toolCall.function.thoughtSignature || toolCall.function.thought_signature)) || (toolCall.extra_content && toolCall.extra_content.thought_signature);
      let signature = tcSignature || (typeof toolSignature !== 'undefined' ? toolSignature : null) || msgSignature || (typeof reasoningSignature !== 'undefined' ? reasoningSignature : null);
      
      // 避免跨模型伪造签名导致 Gemini API 报 "Corrupted thought signature" (400)
      if (signature && (signature.length < 16 || signature === 'bWVzc2FnZV9pZA==')) {
        signature = null;
      }
      const args = toolCall.function?.arguments || toolCall.arguments || toolCall.input || {};
      return createFunctionCallPart(toolCall.id, safeName, args, signature, actualModelName);
    })
    : [];

  const parts = [];
  if (enableThinking) {
    let reasoningText = reasoningFromContent || '';
    let signature = null;
    
    if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
      reasoningText = message.reasoning_content;
      signature = msgSignature || reasoningSignature || toolSignature;
    } else if (reasoningText) {
      signature = msgSignature || reasoningSignature || toolSignature;
    } else {
      signature = msgSignature || reasoningSignature || toolSignature;
      if (signature === reasoningSignature) {
        reasoningText = reasoningContent || ' ';
      } else if (signature === toolSignature) {
        reasoningText = toolContent || ' ';
      }
    }
    
    // 只有合法非伪造签名才添加 thought part，避免 API 报错
    if (signature && signature.length >= 16 && signature !== 'bWVzc2FnZV9pZA==') {
      parts.push(createThoughtPart(reasoningText, signature));
    }
  }
  if (hasContent) {
    const part = { text: textContent.trimEnd() };
    parts.push(part);
  }
  if (!enableThinking && parts[0]) delete parts[0].thoughtSignature;

  pushModelMessage({ parts, toolCalls, hasContent }, antigravityMessages);
}

function handleToolCall(message, antigravityMessages) {
  const toolCallId = message.tool_call_id || message.toolCallId || message.id;
  const toolName = message.name || message.toolName;
  const functionName = findFunctionNameById(toolCallId, antigravityMessages) || toolName || 'tool';
  let content = message.content;
  if (typeof content !== 'string') {
    try {
      content = JSON.stringify(content);
    } catch {
      content = String(content);
    }
  }
  pushFunctionResponse(toolCallId, functionName, content, antigravityMessages);
}

function openaiMessageToAntigravity(openaiMessages, enableThinking, actualModelName, sessionId, hasTools) {
  const antigravityMessages = [];
  for (const message of openaiMessages) {
    if (message.role === 'user' || message.role === 'system') {
      const extracted = extractImagesFromContent(message.content);
      pushUserMessage(extracted, antigravityMessages);
    } else if (message.role === 'assistant') {
      handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId, hasTools);
    } else if (message.role === 'tool') {
      handleToolCall(message, antigravityMessages);
    }
  }

  //console.log(JSON.stringify(antigravityMessages,null,2));
  return antigravityMessages;
}

export function generateRequestBody(openaiMessages, modelName, parameters, openaiTools, token) {
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);
  const signatureSessionId = token.signatureSessionId || token.sessionId;
  const mergedSystemInstruction = extractSystemInstruction(openaiMessages);

  let filteredMessages = openaiMessages;
  let startIndex = 0;
  if (config.useContextSystemPrompt) {
    for (let i = 0; i < openaiMessages.length; i++) {
      if (openaiMessages[i].role === 'system') {
        startIndex = i + 1;
      } else {
        filteredMessages = openaiMessages.slice(startIndex);
        break;
      }
    }
  }

  const tools = convertOpenAIToolsToAntigravity(openaiTools, signatureSessionId, actualModelName);
  const hasTools = tools && tools.length > 0;
  //console.log(JSON.stringify(tools, null, 2))
  const requestBody = buildRequestBody({
    contents: openaiMessageToAntigravity(filteredMessages, enableThinking, actualModelName, signatureSessionId, hasTools),
    tools: tools,
    generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
    sessionId: token.sessionId,
    systemInstruction: mergedSystemInstruction
  }, token, actualModelName);
  Object.defineProperty(requestBody, '_signatureSessionId', { value: signatureSessionId });
  return requestBody;
}
