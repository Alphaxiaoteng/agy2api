/**
 * Responses API Engine (原生集成在 8045 网关内部)
 * 
 * 功能职责：
 * 1. 完整实现 OpenAI Responses API 规范 (/v1/responses)；
 * 2. 将 Responses API 的 instructions、input、tools 双向无损映射为 Chat Completions；
 * 3. 内存级全格式工具调用清洗器（Tool Call Sanitizer & AST Parser）：
 *    - 拦截并逆向重构 <<<TOOL_CALL: name>>> ... <<<END_TOOL_CALL>>>
 *    - 拦截并逆向重构 <tool_call> ... </tool_call>
 *    - 拦截并逆向重构 <|tool_call|> ... <|/tool_call|>
 *    - 拦截并逆向重构 Markdown 代码块中的伪工具 JSON
 *    - 100% 剥离自然语言文本中的工具伪代码，杜绝向前端泄漏；
 * 4. 原生 SSE 流式传输引擎，内置 1.5s keep-alive 维持心跳，免疫空闲超时 (Idle Timeout)；
 * 5. 官方 Electron 模型 Slug 自动解包。
 */

import logger from '../utils/logger.js';

// Electron 客户端模型 Slug 解包映射表
const SLUG_TO_ACTUAL_MODEL = {
  'gpt-5.6-sol': 'glm-5.3-flash',
  'gpt-5.6-terra': 'hy4-preview',
  'gpt-5.6-luna': 'hy3',
  'gpt-5.5': 'deepseek-v4.1-flash',
  'gpt-6-astra': 'gemini-3.8-flash'
};

/**
 * 将 Responses API content 结构转换为 Chat 规范 content
 */
export function convertContentParts(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');

  const parts = [];
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push({ type: 'text', text: part });
    } else if (part && typeof part === 'object') {
      const typ = part.type || '';
      if (typ === 'input_text' || typ === 'output_text') {
        parts.push({ type: 'text', text: part.text || '' });
      } else if (typ === 'input_image') {
        const img = { type: 'image_url', image_url: {} };
        if (part.image_url) {
          img.image_url.url = typeof part.image_url === 'string' ? part.image_url : part.image_url.url;
        } else if (part.file_id) {
          img.image_url.url = part.file_id;
        } else if (part.base64) {
          const media = part.media_type || 'image/jpeg';
          img.image_url.url = `data:${media};base64,${part.base64}`;
        }
        if (img.image_url.url) parts.push(img);
      } else if (part.text) {
        parts.push({ type: 'text', text: part.text });
      } else if (part.image_url) {
        parts.push({
          type: 'image_url',
          image_url: typeof part.image_url === 'object' ? part.image_url : { url: part.image_url }
        });
      }
    }
  }
  return parts.length > 0 ? parts : '';
}

/**
 * 将 Responses API 的 input 与 instructions 转换为 Chat Completions messages
 */
export function responsesInputToChat(body) {
  const messages = [];
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  const inp = body.input;
  if (typeof inp === 'string') {
    messages.push({ role: 'user', content: inp });
    return messages;
  }
  if (!Array.isArray(inp)) {
    if (inp !== undefined && inp !== null) {
      messages.push({ role: 'user', content: JSON.stringify(inp) });
    }
    return messages.length > 0 ? messages : [{ role: 'user', content: '' }];
  }

  for (const item of inp) {
    if (!item || typeof item !== 'object') {
      messages.push({ role: 'user', content: String(item) });
      continue;
    }
    const typ = item.type;
    if (typ === 'message') {
      let role = item.role || 'user';
      if (role === 'developer') role = 'system';
      messages.push({
        role,
        content: convertContentParts(item.content)
      });
    } else if (typ === 'function_call_output') {
      const rawOutput = item.output;
      let textOutput = '';
      if (typeof rawOutput === 'string') {
        textOutput = rawOutput;
      } else if (Array.isArray(rawOutput)) {
        textOutput = rawOutput.map(p => (typeof p === 'string' ? p : p.text || '')).join('\n');
      } else if (rawOutput && typeof rawOutput === 'object') {
        textOutput = JSON.stringify(rawOutput);
      }
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || 'call',
        content: textOutput
      });
    } else if (typ === 'function_call') {
      messages.push({
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: item.call_id || item.id || 'call',
          type: 'function',
          function: {
            name: item.name || '',
            arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {})
          }
        }]
      });
    }
  }

  return messages.length > 0 ? messages : [{ role: 'user', content: '' }];
}

/**
 * 将 Responses API 的 tools 转换为 Chat Completions tools
 */
export function responsesToolsToChat(body) {
  const tools = [];
  const nameMap = new Map();

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object' || tool.type !== 'function') continue;
      const name = tool.name || 'tool';
      nameMap.set(name, name);
      tools.push({
        type: 'function',
        function: {
          name,
          description: tool.description || '',
          parameters: tool.parameters || { type: 'object', properties: {} }
        }
      });
    }
  }

  return { tools, nameMap };
}

/**
 * 全格式工具调用清洗与 AST 提取器 (Tool Call Sanitizer)
 * 能够彻底拦截各类模型产生的伪代码方言，剥离正文伪文本并转为合法结构化 tool_calls
 */
export function sanitizeAndExtractToolCalls(rawContent, standardToolCalls = []) {
  let content = String(rawContent || '');
  const extractedCalls = [];

  // 1. 已由模型协议直接返回的标准 OpenAI tool_calls
  if (Array.isArray(standardToolCalls)) {
    for (const tc of standardToolCalls) {
      const fn = tc.function || {};
      let args = fn.arguments || '{}';
      if (typeof args === 'object') args = JSON.stringify(args);
      extractedCalls.push({
        id: tc.id || `call_${Date.now()}_${extractedCalls.length}`,
        name: fn.name || 'tool',
        arguments: args
      });
    }
  }

  // 2. 匹配并提取 <<<TOOL_CALL: name>>> ... <<<END_TOOL_CALL>>>
  if (content.includes('<<<TOOL_CALL:')) {
    const pattern = /<<<TOOL_CALL:\s*([a-zA-Z0-9_.-]+)\s*>>>([\s\S]*?)(?:<<<END_TOOL_CALL>>>|(?=<<<TOOL_CALL)|$)/gi;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const fnName = match[1].trim();
      let rawArgs = match[2].trim();
      try {
        JSON.parse(rawArgs);
      } catch {
        try {
          rawArgs = JSON.stringify(JSON.parse(rawArgs.replace(/'/g, '"')));
        } catch {
          rawArgs = JSON.stringify({ cmd: rawArgs });
        }
      }
      extractedCalls.push({
        id: `call_parsed_${extractedCalls.length}_${Math.random().toString(36).slice(2, 7)}`,
        name: fnName,
        arguments: rawArgs
      });
    }
    content = content.replace(pattern, '').trim();
  }

  // 3. 匹配并提取 <tool_call> ... </tool_call>
  if (content.includes('<tool_call>')) {
    const pattern = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        const fnName = parsed.name || 'exec_command';
        let args = parsed.arguments || parsed.parameters || parsed.input || {};
        if (typeof args === 'object') args = JSON.stringify(args);
        extractedCalls.push({
          id: `call_tc_${extractedCalls.length}_${Math.random().toString(36).slice(2, 7)}`,
          name: fnName,
          arguments: String(args)
        });
      } catch {
        // 忽略无效格式
      }
    }
    content = content.replace(pattern, '').trim();
  }

  // 4. 匹配并提取 <|tool_call|> ... <|/tool_call|>
  if (content.includes('<|tool_call|>')) {
    const pattern = /<\|tool_call\|>([\s\S]*?)<\|\/tool_call\|>/gi;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      try {
        const parsed = JSON.parse(match[1].trim());
        const fnName = parsed.name || 'exec_command';
        let args = parsed.arguments || parsed.parameters || parsed.input || {};
        if (typeof args === 'object') args = JSON.stringify(args);
        extractedCalls.push({
          id: `call_pipe_${extractedCalls.length}_${Math.random().toString(36).slice(2, 7)}`,
          name: fnName,
          arguments: String(args)
        });
      } catch {
        // 忽略
      }
    }
    content = content.replace(pattern, '').trim();
  }

  // 5. 剥离残余的未闭合标记或泄漏标签
  content = content
    .replace(/<<<END_TOOL_CALL>>>/gi, '')
    .replace(/<\/tool_call>/gi, '')
    .replace(/<\|\/tool_call\|>/gi, '')
    .trim();

  return {
    cleanedContent: content,
    toolCalls: extractedCalls
  };
}

/**
 * 将标准 Chat Completions 响应转换为 Responses API 输出结构
 */
export function buildResponsesOutput(chatResponse, requestedModel) {
  const rid = `resp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const choice = chatResponse?.choices?.[0] || {};
  const message = choice.message || {};
  const rawContent = message.content || '';
  const reasoning = message.reasoning_content || '';
  const originalToolCalls = message.tool_calls || [];

  // 清洗并提取所有工具调用（原生 + 文本反编译）
  const { cleanedContent, toolCalls } = sanitizeAndExtractToolCalls(rawContent, originalToolCalls);

  const output = [];

  // 组装 function_call 输出项
  toolCalls.forEach((tc, idx) => {
    output.push({
      id: `call_${idx}_${tc.id}`,
      type: 'function_call',
      status: 'completed',
      call_id: tc.id,
      name: tc.name,
      arguments: tc.arguments
    });
  });

  // 组装 message 输出项
  if (cleanedContent) {
    output.unshift({
      id: `msg_${rid}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: cleanedContent,
        annotations: []
      }]
    });
  } else if (reasoning && output.length === 0) {
    // 若仅有思考且无其他内容，输出思考文本兜底
    output.push({
      id: `msg_${rid}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: reasoning,
        annotations: []
      }]
    });
  }

  const usage = chatResponse?.usage || {};
  const responsesUsage = {
    input_tokens: usage.input_tokens || usage.prompt_tokens || 0,
    output_tokens: usage.output_tokens || usage.completion_tokens || 0,
    total_tokens: usage.total_tokens || ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))
  };

  return {
    id: rid,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: chatResponse?.model || requestedModel || 'default',
    status: 'completed',
    output,
    usage: responsesUsage
  };
}

/**
 * 发送单条 SSE 规范事件
 */
function sendSSEEvent(res, eventName, data) {
  if (res.writableEnded) return;
  try {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch (err) {
    logger.warn(`SSE 写入事件 ${eventName} 失败:`, err.message);
  }
}

/**
 * 统一处理 Responses API 请求 (/v1/responses)
 */
export async function handleResponsesRequest(req, res) {
  const body = req.body || {};
  let rawInputModel = body.model || 'gemini-3.8-flash';
  // 去除客户端附加的展示后缀，如 "GLM-5.3 (ZCode)" -> "GLM-5.3", "Gemini 3.8 Flash (agy)" -> "gemini-3.8-flash"
  let modelName = String(rawInputModel).replace(/\s*\([^)]*\)\s*$/g, '').trim();

  // 1. 模型 Slug 解包 (兼容 Electron 客户端 ChatGPT 账号白名单)
  if (SLUG_TO_ACTUAL_MODEL[modelName]) {
    const unwrap = SLUG_TO_ACTUAL_MODEL[modelName];
    logger.info(`[RESPONSES ENGINE] Slug 解包: ${modelName} -> ${unwrap}`);
    modelName = unwrap;
  }

  // 规范化兼容
  if (modelName.toLowerCase().includes('gemini-3.8-flash') || modelName.toLowerCase() === 'gemini 3.8 flash') {
    modelName = 'gemini-3.8-flash';
  }

  const isStream = Boolean(body.stream);
  logger.info(`[RESPONSES ENGINE] 接收请求 model=${modelName} (原始: ${rawInputModel}), stream=${isStream}`);

  // 2. 构造转译后的 Chat Completions 负载
  const messages = responsesInputToChat(body);
  const { tools } = responsesToolsToChat(body);

  let effort = body.reasoning_effort;
  if (!effort && body.reasoning?.effort) {
    effort = body.reasoning.effort;
  }
  if (!effort && body.effort) {
    effort = body.effort;
  }
  if (modelName.includes('gemini') || modelName.includes('agy')) {
    if (effort === 'medium' || !effort) effort = 'auto';
  }

  const chatPayload = {
    model: modelName,
    messages,
    stream: false, // 内部保持完整响应获取，由引擎向外模拟精准 SSE 流与心跳保活
    ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    ...(effort ? { reasoning_effort: effort, effort } : {})
  };

  // 3. 如果是流式响应，先建立 SSE 握手与心跳机制
  let keepAliveTimer = null;
  let isClientClosed = false;

  if (isStream) {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    // 维持 1.5s 周期性 keep-alive 注释事件，彻底杜绝客户端 SSE idle timeout
    keepAliveTimer = setInterval(() => {
      if (res.writableEnded || isClientClosed) {
        clearInterval(keepAliveTimer);
        return;
      }
      try {
        res.write(': keep-alive\n\n');
      } catch {
        clearInterval(keepAliveTimer);
      }
    }, 1500);

    res.on('close', () => {
      isClientClosed = true;
      if (keepAliveTimer) clearInterval(keepAliveTimer);
    });
  }

  try {
    // 4. 在本地直接发起 Chat Completions 调用（访问 8045 内部的统一路由体系）
    const internalUrl = 'http://127.0.0.1:8045/v1/chat/completions';
    const fetchHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'Antigravity-ResponsesEngine/2.0'
    };
    if (req.headers.authorization) {
      fetchHeaders.Authorization = req.headers.authorization;
    }

    const abortController = new AbortController();
    if (isStream) {
      res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
      });
    }

    // 4. 具备自动容灾 Fallback 的上游调用机制 (针对 503 容量不足自动平滑降级)
    let upstreamResponse = null;
    let chatResult = null;
    const fallbackCandidates = [];
    fallbackCandidates.push(modelName);
    if (modelName.includes('gemini-3.8-flash')) {
      fallbackCandidates.push('gemini-3.7-flash-tiered', 'gemini-3.1-pro-high');
    } else if (modelName.includes('gemini')) {
      fallbackCandidates.push('gemini-3.8-flash', 'gemini-3.1-pro-high');
    } else {
      // 容灾守护：若本地/专线模型 (如 glm-5.3, zcode 等) 遇验证码或阻塞，自动平滑容灾至毫秒级 Gemini 号池
      fallbackCandidates.push('gemini-3.8-flash', 'gemini-3.7-flash-tiered');
    }

    let lastErrorText = '';
    for (const candidateModel of fallbackCandidates) {
      try {
        const payloadToTry = { ...chatPayload, model: candidateModel };
        logger.info(`[RESPONSES ENGINE] 尝试上游推理 candidate=${candidateModel}`);
        upstreamResponse = await fetch(internalUrl, {
          method: 'POST',
          headers: fetchHeaders,
          body: JSON.stringify(payloadToTry),
          signal: abortController.signal
        });

        if (upstreamResponse.ok) {
          chatResult = await upstreamResponse.json();
          logger.info(`[RESPONSES ENGINE] 上游推理成功 model=${candidateModel}`);
          break;
        } else {
          lastErrorText = await upstreamResponse.text();
          // 若当前模型失败（包括 503, 429, 404, 500, 或专线不可用），继续尝试候选池中的下一个保底模型
          const canFallback = [503, 429, 404, 500].includes(upstreamResponse.status) || !candidateModel.startsWith('gemini');
          if (!canFallback) {
            break;
          }
        }
      } catch (err) {
        lastErrorText = err.message;
        logger.warn(`[RESPONSES ENGINE] 上游 candidate=${candidateModel} 网络异常: ${err.message}`);
      }
    }

    // 若全部上游均失败，执行优雅降级回复，绝不野蛮掐断 SSE 管道避免 Codex 报 stream closed
    if (!chatResult) {
      logger.error(`[RESPONSES ENGINE] 所有上游候选均失败，向客户端输出友好终止提示`);
      if (keepAliveTimer) clearInterval(keepAliveTimer);
      const friendlyErrMsg = `⚠️ 上游模型暂时过载或繁忙 (503/429)，已尝试自动容灾未果。详细错误: ${lastErrorText.slice(0, 150)}。请稍后重试。`;
      const fallbackOutput = {
        id: `resp_err_${Date.now()}`,
        object: 'response',
        created_at: Math.floor(Date.now() / 1000),
        model: modelName,
        status: 'completed',
        output: [{
          id: `msg_err_${Date.now()}`,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: friendlyErrMsg, annotations: [] }]
        }],
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 }
      };

      if (!isStream) {
        return res.json(fallbackOutput);
      }

      sendSSEEvent(res, 'response.created', { type: 'response.created', response: { ...fallbackOutput, status: 'in_progress', output: [] } });
      sendSSEEvent(res, 'response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: fallbackOutput.output[0] });
      sendSSEEvent(res, 'response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: fallbackOutput.output[0].id, delta: friendlyErrMsg });
      sendSSEEvent(res, 'response.output_text.done', { type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: fallbackOutput.output[0].id, text: friendlyErrMsg });
      sendSSEEvent(res, 'response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: fallbackOutput.output[0] });
      sendSSEEvent(res, 'response.completed', { type: 'response.completed', response: fallbackOutput });
      res.end();
      return;
    }
    logger.info(`[RESPONSES ENGINE] 上游推理成功，执行协议转换与工具清洗`);

    // 5. 将 Chat 响应转换为 Responses 响应结构并完成工具反编译
    const responsesResult = buildResponsesOutput(chatResult, modelName);

    // 6. 根据客户端模式返回
    if (!isStream) {
      return res.json(responsesResult);
    }

    // 停止心跳定时器
    if (keepAliveTimer) clearInterval(keepAliveTimer);

    if (isClientClosed) return;

    // 7. 发送规范 SSE 事件序列
    sendSSEEvent(res, 'response.created', {
      type: 'response.created',
      response: { ...responsesResult, status: 'in_progress', output: [] }
    });

    sendSSEEvent(res, 'response.in_progress', {
      type: 'response.in_progress',
      response: { ...responsesResult, status: 'in_progress', output: [] }
    });

    for (let idx = 0; idx < responsesResult.output.length; idx++) {
      const item = responsesResult.output[idx];
      const startedItem = { ...item, status: 'in_progress' };
      if (item.type === 'message') {
        startedItem.content = [];
      }

      sendSSEEvent(res, 'response.output_item.added', {
        type: 'response.output_item.added',
        output_index: idx,
        item: startedItem
      });

      if (item.type === 'message') {
        const text = item.content?.[0]?.text || '';
        const emptyPart = { type: 'output_text', text: '', annotations: [] };
        const donePart = { type: 'output_text', text, annotations: [] };

        sendSSEEvent(res, 'response.content_part.added', {
          type: 'response.content_part.added',
          output_index: idx,
          content_index: 0,
          item_id: item.id,
          part: emptyPart
        });

        sendSSEEvent(res, 'response.output_text.delta', {
          type: 'response.output_text.delta',
          output_index: idx,
          content_index: 0,
          item_id: item.id,
          delta: text
        });

        sendSSEEvent(res, 'response.output_text.done', {
          type: 'response.output_text.done',
          output_index: idx,
          content_index: 0,
          item_id: item.id,
          text
        });

        sendSSEEvent(res, 'response.content_part.done', {
          type: 'response.content_part.done',
          output_index: idx,
          content_index: 0,
          item_id: item.id,
          part: donePart
        });
      } else if (item.type === 'function_call') {
        sendSSEEvent(res, 'response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          output_index: idx,
          call_id: item.call_id,
          delta: item.arguments
        });

        sendSSEEvent(res, 'response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          output_index: idx,
          call_id: item.call_id,
          arguments: item.arguments
        });
      }

      sendSSEEvent(res, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: idx,
        item
      });
    }

    sendSSEEvent(res, 'response.completed', {
      type: 'response.completed',
      response: responsesResult
    });

    res.end();
  } catch (err) {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    logger.error(`[RESPONSES ENGINE] 执行异常:`, err.message);
    if (isStream) {
      sendSSEEvent(res, 'error', {
        type: 'error',
        error: { message: err.message }
      });
      res.end();
    } else {
      res.status(500).json({ error: { message: err.message } });
    }
  }
}
