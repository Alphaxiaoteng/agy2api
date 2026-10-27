/**
 * Codex Native Direct Upstream Service
 *
 * 直连 OpenAI ChatGPT Codex 核心服务 (https://chatgpt.com/backend-api/codex/responses)
 * 1. 独家原生支持 Luna 6 (GPT-5.6 Luna) 旗舰模型，支持思考链与流式响应；
 * 2. 毫秒级内存 Token 缓存与自动刷新（基于 Cockpit AES-GCM 主密钥与 OpenAI OAuth 认证中心）；
 * 3. 完整支持流式 (SSE) 与非流式 (JSON) 输出，原生转发 reasoning_content 深度思考流；
 * 4. 完美兼容标准 OpenAI /v1/chat/completions 接口规范。
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import axios from 'axios';
import http from 'http';
import https from 'https';
import logger from '../utils/logger.js';
import { ConnectTunnelHttpsAgent, parseAxiosProxyConfig } from '../utils/proxyResolver.js';

const KEY_CANDIDATES = [
  path.join(os.homedir(), '.antigravity_cockpit/secure-account-storage.key'),
  path.join(os.homedir(), '.antigravity_cockpit/account-token.key')
];
const COCKPIT_CODEX_DIR = path.join(os.homedir(), '.antigravity_cockpit/codex_accounts');
const SIDECAR_AUTHS_DIR = path.join(os.homedir(), '.cockpit_tools/codex_local_access_sidecar/auths');

const OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_USER_AGENT = 'codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)';
const CODEX_ORIGINATOR = 'codex-tui';
const DEFAULT_PROXY = 'http://127.0.0.1:7897';

export const CODEX_MODELS = [
  { id: 'luna6', display_name: 'Luna 6 (六代)', vendor: 'openai', library: 'codex', reasoning: true },
  { id: 'gpt-5.6-luna', display_name: 'Luna 6 (六代)', vendor: 'openai', library: 'codex', reasoning: true },
  { id: 'codex/luna6', display_name: 'Luna 6 (六代)', vendor: 'openai', library: 'codex', reasoning: true },
  { id: 'gpt-6-luna', display_name: 'Luna 6 (六代)', vendor: 'openai', library: 'codex', reasoning: true }
];

export function getCodexModelsList() {
  const now = Math.floor(Date.now() / 1000);
  return CODEX_MODELS.map(m => ({
    id: m.id,
    object: 'model',
    created: now,
    owned_by: m.vendor,
    library: m.library,
    display_name: m.display_name,
    reasoning: m.reasoning
  }));
}

export function isCodexRoutableModel(model) {
  if (typeof model !== 'string' || !model.trim()) return false;
  const m = model.trim().toLowerCase();
  if (m === 'luna6' || m === 'luna' || m === 'gpt-5.6-luna' || m === 'gpt-6-luna') return true;
  if (m === 'codex/luna6' || m === 'codex/gpt-5.6-luna' || m === 'codex/luna') return true;
  if (m.startsWith('codex/')) return true;
  if (m.includes('luna6') || m.includes('luna')) return true;
  return false;
}

let authCache = {
  accessToken: null,
  refreshToken: null,
  accountId: null,
  email: null,
  expiresAt: 0
};

function readMasterKey() {
  for (const p of KEY_CANDIDATES) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8').trim();
      return Buffer.from(raw, 'base64');
    }
  }
  return null;
}

function decryptEnvelope(envelope, key32) {
  const nonce = Buffer.from(envelope.nonce, 'base64');
  const raw = Buffer.from(envelope.ciphertext, 'base64');
  const authTag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key32, nonce);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

function getHttpsAgent() {
  const proxyInfo = parseAxiosProxyConfig(DEFAULT_PROXY);
  if (proxyInfo) {
    return new ConnectTunnelHttpsAgent(proxyInfo, { timeout: 60000 });
  }
  return new https.Agent({ keepAlive: true, keepAliveMsecs: 30000 });
}

export async function getValidCodexToken({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && authCache.accessToken && now < authCache.expiresAt - 60000) {
    return authCache;
  }

  const key32 = readMasterKey();
  if (!key32) {
    throw new Error('未找到 Cockpit 主密钥，无法解密 Codex 凭据');
  }

  // 首选已知可用账号 codex_f355d2ca4828ce8251e3f7c446932e53.json
  const targetFile = path.join(COCKPIT_CODEX_DIR, 'codex_f355d2ca4828ce8251e3f7c446932e53.json');
  if (!fs.existsSync(targetFile)) {
    throw new Error('未在 Cockpit 目录中找到 Codex 账号文件');
  }

  const envelope = JSON.parse(fs.readFileSync(targetFile, 'utf8'));
  const decrypted = decryptEnvelope(envelope, key32);
  const accountId = decrypted.account_id || 'b3734f32-59d3-4440-9657-bb358d0e79f4';
  const email = decrypted.email || 'bejeje92@gmail.com';
  const storedAt = decrypted.tokens?.access_token;

  // 1. 如果已持久化的 access_token 仍在有效期内（未强制刷新），优先直接复用
  if (!forceRefresh && storedAt) {
    try {
      const parts = storedAt.split('.');
      if (parts.length >= 2) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        const expMs = (payload.exp || 0) * 1000;
        if (expMs > now + 60000) {
          authCache = {
            accessToken: storedAt,
            refreshToken: decrypted.tokens?.refresh_token || authCache.refreshToken,
            accountId,
            email,
            expiresAt: expMs
          };
          logger.info(`[codex-upstream] 复用有效 Access Token (${email})，有效期至: ${new Date(expMs).toISOString()}`);
          return authCache;
        }
      }
    } catch (parseErr) {
      logger.warn('[codex-upstream] 解析已存 Token 异常，转入 OAuth 刷新:', parseErr.message);
    }
  }

  const rt = authCache.refreshToken || decrypted.tokens?.refresh_token;
  if (!rt) {
    throw new Error('Codex 账号未包含有效 refresh_token');
  }

  const httpsAgent = getHttpsAgent();
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: CODEX_CLIENT_ID,
    refresh_token: rt,
    scope: 'openid profile email'
  });

  const res = await axios.post(OAUTH_TOKEN_URL, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json'
    },
    httpsAgent,
    timeout: 12000
  });

  if (res.status !== 200 || !res.data?.access_token) {
    throw new Error(`Codex OAuth Token 刷新失败: HTTP ${res.status}`);
  }

  const newRt = res.data.refresh_token || rt;
  const expiresIn = Number(res.data.expires_in) || 864000;

  authCache = {
    accessToken: res.data.access_token,
    refreshToken: newRt,
    accountId,
    email,
    expiresAt: now + expiresIn * 1000
  };

  logger.info(`[codex-upstream] 成功更新 Token (${email}), 有效期至 ${new Date(authCache.expiresAt).toISOString()}`);

  // 尝试同步到 sidecar auths 目录，保持全局一致
  try {
    const sidecarFile = path.join(SIDECAR_AUTHS_DIR, 'codex_f355d2ca4828ce8251e3f7c446932e53.json');
    if (fs.existsSync(sidecarFile)) {
      const sidecarData = JSON.parse(fs.readFileSync(sidecarFile, 'utf8'));
      sidecarData.access_token = res.data.access_token;
      sidecarData.refresh_token = newRt;
      sidecarData.expired = Math.floor(authCache.expiresAt / 1000);
      fs.writeFileSync(sidecarFile, JSON.stringify(sidecarData, null, 2), 'utf8');
    }
  } catch (syncErr) {
    logger.warn('[codex-upstream] 同步 sidecar auth 文件忽略:', syncErr.message);
  }

  return authCache;
}

/**
 * 转换客户端请求为 Codex Responses API 规范载荷
 */
function buildCodexPayload(reqBody) {
  const messages = Array.isArray(reqBody?.messages) ? reqBody.messages : [];
  let instructions = '';
  const input = [];

  for (const msg of messages) {
    if (!msg) continue;
    const role = (msg.role || '').toLowerCase();
    let text = '';
    const images = [];
    if (typeof msg.content === 'string') {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (typeof p === 'string') { text += p; continue; }
        if (!p) continue;
        // 保留图片部件，转发为 Responses API 的 input_image（此前被整体丢弃导致视觉失效）
        if ((p.type === 'image_url' || p.type === 'input_image') && p.image_url) {
          const url = typeof p.image_url === 'string' ? p.image_url : p.image_url.url;
          if (url) images.push(url);
        } else {
          text += (p.text || '');
        }
      }
    } else {
      text = String(msg.content || '');
    }

    if (role === 'system' || role === 'developer') {
      instructions = instructions ? `${instructions}\n\n${text}` : text;
    } else if (role === 'user') {
      const content = [];
      if (text) content.push({ type: 'input_text', text });
      for (const url of images) content.push({ type: 'input_image', image_url: url });
      if (content.length === 0) content.push({ type: 'input_text', text: '' });
      input.push({ type: 'message', role: 'user', content });
    } else if (role === 'assistant') {
      input.push({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }]
      });
    }
  }

  const payload = {
    model: 'gpt-5.6-luna',
    stream: true,
    store: false,
    instructions: instructions || '',
    include: ['reasoning.encrypted_content'],
    input
  };

  if (Array.isArray(reqBody.tools) && reqBody.tools.length > 0) {
    payload.tools = reqBody.tools.map(t => {
      if (t.type === 'function' && t.function) {
        return {
          type: 'function',
          name: t.function.name,
          description: t.function.description || '',
          parameters: t.function.parameters || { type: 'object', properties: {} }
        };
      }
      return t;
    });
    payload.parallel_tool_calls = true;
  }

  if (reqBody.reasoning_effort) {
    let effort = String(reqBody.reasoning_effort).toLowerCase();
    if (effort === 'auto' || effort === 'default') {
      effort = 'medium';
    }
    payload.reasoning = { effort };
  }

  return payload;
}

/**
 * Codex 统一代理入口 (OpenAI Chat Completions 协议转接)
 */
export async function proxyCodexChat(req, res) {
  const reqModel = req.body?.model || 'luna6';
  const isStream = !!req.body?.stream;
  const requestId = `chatcmpl-luna6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);

  logger.info(`[codex-upstream] 调度 Luna 6 (六代) 直连: model=${reqModel}, stream=${isStream}`);

  let tokenData;
  try {
    tokenData = await getValidCodexToken();
  } catch (err) {
    logger.error('[codex-upstream] 获取 Token 失败:', err.message);
    return res.status(503).json({
      error: {
        message: `Codex 认证凭据不可用: ${err.message}`,
        type: 'service_unavailable',
        code: 'codex_token_error'
      }
    });
  }

  const payload = buildCodexPayload(req.body);
  const httpsAgent = getHttpsAgent();

  async function executeRequest(isRetry = false) {
    return axios.post(CODEX_RESPONSES_URL, payload, {
      headers: {
        'Authorization': `Bearer ${tokenData.accessToken}`,
        'Chatgpt-Account-Id': tokenData.accountId,
        'Originator': CODEX_ORIGINATOR,
        'User-Agent': CODEX_USER_AGENT,
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'X-Codex-Routing-Hint': 'model=gpt-5.6-luna'
      },
      httpsAgent,
      responseType: 'stream',
      timeout: 120000,
      validateStatus: () => true
    });
  }

  let upstream;
  try {
    upstream = await executeRequest();
    if (upstream.status === 401) {
      logger.warn('[codex-upstream] 收到 HTTP 401，强制刷新 Token 并重试一次');
      tokenData = await getValidCodexToken({ forceRefresh: true });
      upstream = await executeRequest(true);
    }
  } catch (netErr) {
    logger.error('[codex-upstream] 上游网络连接异常:', netErr.message);
    return res.status(502).json({
      error: {
        message: `Codex 上游连接失败: ${netErr.message}`,
        type: 'upstream_error',
        code: 'codex_upstream_unreachable'
      }
    });
  }

  if (upstream.status >= 300) {
    let errBody = '';
    upstream.data.on('data', chunk => { errBody += chunk.toString(); });
    upstream.data.on('end', () => {
      logger.error(`[codex-upstream] 上游返回 HTTP ${upstream.status}: ${errBody}`);
      res.status(upstream.status).json({
        error: {
          message: `Codex 上游响应错误 (HTTP ${upstream.status}): ${errBody}`,
          type: 'upstream_error',
          code: 'codex_upstream_error'
        }
      });
    });
    return;
  }

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.status(200);

    // 发送起始 chunk (包含 role: assistant)
    const initChunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model: reqModel,
      choices: [{
        index: 0,
        delta: { role: 'assistant', content: '' },
        finish_reason: null
      }]
    };
    res.write(`data: ${JSON.stringify(initChunk)}\n\n`);

    let buffer = '';
    upstream.data.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6).trim();
        if (!dataStr || dataStr === '[DONE]') continue;

        try {
          const parsed = JSON.parse(dataStr);
          const typ = parsed.type;

          if (typ === 'response.output_text.delta' && typeof parsed.delta === 'string') {
            const chunkData = {
              id: requestId,
              object: 'chat.completion.chunk',
              created,
              model: reqModel,
              choices: [{
                index: 0,
                delta: { content: parsed.delta },
                finish_reason: null
              }]
            };
            res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
          } else if ((typ === 'response.reasoning_text.delta' || typ === 'response.reasoning_summary_text.delta') && typeof parsed.delta === 'string') {
            const chunkData = {
              id: requestId,
              object: 'chat.completion.chunk',
              created,
              model: reqModel,
              choices: [{
                index: 0,
                delta: { reasoning_content: parsed.delta },
                finish_reason: null
              }]
            };
            res.write(`data: ${JSON.stringify(chunkData)}\n\n`);
          } else if (typ === 'response.completed' || typ === 'response.incomplete') {
            const finishReason = typ === 'response.incomplete' ? 'length' : 'stop';
            const finishChunk = {
              id: requestId,
              object: 'chat.completion.chunk',
              created,
              model: reqModel,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: finishReason
              }]
            };
            res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
          }
        } catch (e) {
          // ignore unparseable chunk
        }
      }
    });

    upstream.data.on('end', () => {
      res.write('data: [DONE]\n\n');
      res.end();
    });

    upstream.data.on('error', err => {
      logger.error('[codex-upstream] 流式传输中断:', err.message);
      if (!res.headersSent) res.status(502);
      res.end();
    });

    return;
  }

  // 非流式响应：汇聚全部输出后一次性返回标准 JSON
  let fullContent = '';
  let fullReasoning = '';
  let finishReason = 'stop';
  let buffer = '';

  upstream.data.on('data', chunk => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.slice(6).trim();
      if (!dataStr || dataStr === '[DONE]') continue;

      try {
        const parsed = JSON.parse(dataStr);
        const typ = parsed.type;
        if (typ === 'response.output_text.delta' && typeof parsed.delta === 'string') {
          fullContent += parsed.delta;
        } else if ((typ === 'response.reasoning_text.delta' || typ === 'response.reasoning_summary_text.delta') && typeof parsed.delta === 'string') {
          fullReasoning += parsed.delta;
        } else if (typ === 'response.incomplete') {
          finishReason = 'length';
        }
      } catch (e) {
        // ignore
      }
    }
  });

  upstream.data.on('end', () => {
    const message = {
      role: 'assistant',
      content: fullContent
    };
    if (fullReasoning) {
      message.reasoning_content = fullReasoning;
    }

    res.status(200).json({
      id: requestId,
      object: 'chat.completion',
      created,
      model: reqModel,
      choices: [{
        index: 0,
        message,
        finish_reason: finishReason
      }],
      usage: {
        prompt_tokens: Math.ceil(fullContent.length / 4) + 20,
        completion_tokens: Math.ceil(fullContent.length / 4),
        total_tokens: Math.ceil(fullContent.length / 2) + 20
      }
    });
  });

  upstream.data.on('error', err => {
    logger.error('[codex-upstream] 汇聚响应失败:', err.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: {
          message: `Codex 传输异常: ${err.message}`,
          type: 'upstream_error',
          code: 'codex_stream_failed'
        }
      });
    }
  });
}

// 保持历史导出兼容
export const proxyOpenAIChat = proxyCodexChat;
export async function mergeCodexModels(agyPayload) {
  return agyPayload;
}
export async function probeCodexUpstream() {
  try {
    const t = await getValidCodexToken();
    return { ok: true, status: 200, email: t.email, model: 'gpt-5.6-luna' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
