import fs from 'fs';
import os from 'os';
import path from 'path';
import axios from 'axios';
import http from 'http';
import https from 'https';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import { getRequestSessionKey } from '../utils/requestSession.js';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const AGY_ONLY_GPT = new Set(['gpt-oss-120b-medium']);
const SESSION_HEADERS = [
  'x-session-id',
  'x-conversation-id',
  'x-opencode-session',
  'x-client-session-id'
];

let cachedKey = { value: null, mtime: 0, path: null };
let cachedCodexModels = { at: 0, list: [], ids: new Set() };
let cachedMergedModels = { at: 0, key: '', payload: null };

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64 });

function codexConfig() {
  return config.codexUpstream || {};
}

function isEnabled() {
  return codexConfig().enabled !== false;
}

function resolveConfigPath() {
  const raw = codexConfig().configPath
    || path.join(os.homedir(), '.antigravity_cockpit/codex_local_access.json');
  return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
}

function assertLocalBaseUrl(baseURL) {
  const url = new URL(baseURL);
  if (!LOCAL_HOSTS.has(url.hostname)) {
    throw new Error(`Codex upstream 仅允许 localhost，当前: ${url.hostname}`);
  }
}

function getBaseURL() {
  const baseURL = (codexConfig().baseURL || 'http://127.0.0.1:61175/v1').replace(/\/$/, '');
  assertLocalBaseUrl(baseURL);
  return baseURL;
}

function loadApiKey() {
  if (process.env.CODEX_LOCAL_API_KEY?.trim()) {
    return process.env.CODEX_LOCAL_API_KEY.trim();
  }
  const configPath = resolveConfigPath();
  if (!fs.existsSync(configPath)) {
    return codexConfig().apiKey || '';
  }
  const stat = fs.statSync(configPath);
  if (cachedKey.path === configPath && cachedKey.mtime === stat.mtimeMs && cachedKey.value) {
    return cachedKey.value;
  }
  const doc = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const key = doc.apiKeys?.[0]?.key || doc.apiKey || '';
  cachedKey = { value: key, mtime: stat.mtimeMs, path: configPath };
  return key;
}

export function isCodexRoutableModel(model) {
  if (!isEnabled() || typeof model !== 'string' || !model.trim()) return false;
  const id = model.trim();
  const lower = id.toLowerCase();
  if (AGY_ONLY_GPT.has(lower)) return false;
  if (lower.startsWith('gpt-')) return true;
  if (lower.startsWith('o3') || lower.startsWith('o4')) return true;
  if (lower.includes('codex')) return true;
  return false;
}

function getModelListTtlMs() {
  const value = Number(codexConfig().modelListTtlMs);
  return Number.isFinite(value) && value > 0 ? value : 300_000;
}

function shouldValidateModelOnChat() {
  return codexConfig().validateModelOnChat === true;
}

function hasClientSessionHeader(req) {
  if (!req?.headers) return false;
  for (const name of SESSION_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string' && value.trim()) return true;
  }
  return false;
}

function resolveCodexSessionId(req, body = {}) {
  if (hasClientSessionHeader(req)) return null;
  return getRequestSessionKey(req, 'openai', body?.model, body);
}

function buildForwardHeaders(req, apiKey, body = {}) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': req.headers['content-type'] || 'application/json',
    Accept: req.headers.accept || 'application/json'
  };
  for (const name of [
    'x-session-id',
    'x-conversation-id',
    'x-opencode-session',
    'x-client-session-id',
    'x-session-affinity',
    'openai-beta'
  ]) {
    if (req.headers[name]) headers[name] = req.headers[name];
  }
  const sessionId = resolveCodexSessionId(req, body);
  if (sessionId) {
    headers['x-session-id'] = sessionId;
    headers['X-Session-ID'] = sessionId;
  }
  return headers;
}

async function fetchCodexModelList(apiKey, { force = false } = {}) {
  const ttlMs = getModelListTtlMs();
  const now = Date.now();
  if (!force && now - cachedCodexModels.at < ttlMs && cachedCodexModels.list.length > 0) {
    return cachedCodexModels.list;
  }
  const baseURL = getBaseURL();
  const res = await axios.get(`${baseURL}/models`, {
    timeout: 8000,
    headers: { Authorization: `Bearer ${apiKey}` },
    httpAgent,
    httpsAgent,
    validateStatus: () => true
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Codex models HTTP ${res.status}`);
  }
  const list = Array.isArray(res.data?.data) ? res.data.data : [];
  cachedCodexModels = {
    at: now,
    list,
    ids: new Set(list.map((m) => m?.id).filter(Boolean))
  };
  return list;
}

function buildMergedModelsPayload(agyPayload, codexList) {
  const existing = new Set((agyPayload?.data || []).map((m) => m.id));
  const merged = [...(agyPayload?.data || [])];
  for (const model of codexList) {
    if (!model?.id || existing.has(model.id)) continue;
    merged.push({
      ...model,
      owned_by: model.owned_by || 'codex-local',
      object: model.object || 'model'
    });
  }
  return { ...agyPayload, data: merged };
}

export async function mergeCodexModels(agyPayload) {
  if (!isEnabled()) return agyPayload;
  try {
    const apiKey = loadApiKey();
    if (!apiKey) return agyPayload;
    const cacheKey = `${(agyPayload?.data || []).length}:${(agyPayload?.data || []).map((m) => m.id).join(',')}`;
    const ttlMs = getModelListTtlMs();
    const now = Date.now();
    if (
      cachedMergedModels.payload &&
      cachedMergedModels.key === cacheKey &&
      now - cachedMergedModels.at < ttlMs
    ) {
      return cachedMergedModels.payload;
    }
    const codexList = await fetchCodexModelList(apiKey);
    const payload = buildMergedModelsPayload(agyPayload, codexList);
    cachedMergedModels = { at: now, key: cacheKey, payload };
    return payload;
  } catch (error) {
    logger.warn('[codex-upstream] 合并模型列表失败:', error.message);
    return agyPayload;
  }
}

export async function proxyOpenAIChat(req, res) {
  const apiKey = loadApiKey();
  if (!apiKey) {
    return res.status(503).json({
      error: {
        message: 'Codex 本地 API 未配置：请启动 Cockpit API 服务或设置 CODEX_LOCAL_API_KEY',
        type: 'service_unavailable',
        code: 'codex_upstream_unconfigured'
      }
    });
  }

  const model = req.body?.model;
  if (shouldValidateModelOnChat() && isCodexRoutableModel(model)) {
    try {
      await fetchCodexModelList(apiKey);
      if (cachedCodexModels.ids.size > 0 && !cachedCodexModels.ids.has(model)) {
        return res.status(404).json({
          error: {
            message: `模型 ${model} 不在 Codex 本地 API 可用范围内`,
            type: 'invalid_request_error',
            code: 'model_not_found'
          }
        });
      }
    } catch (error) {
      logger.warn('[codex-upstream] 模型校验跳过:', error.message);
    }
  }

  const baseURL = getBaseURL();
  const url = `${baseURL}/chat/completions`;
  const headers = buildForwardHeaders(req, apiKey, req.body);
  const stream = !!req.body?.stream;

  try {
    const upstream = await axios.post(url, req.body, {
      headers,
      timeout: config.timeout || 300000,
      responseType: stream ? 'stream' : 'json',
      httpAgent,
      httpsAgent,
      validateStatus: () => true,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    if (stream) {
      res.status(upstream.status);
      for (const [key, value] of Object.entries(upstream.headers || {})) {
        if (key.toLowerCase() === 'transfer-encoding') continue;
        if (value !== undefined) res.setHeader(key, value);
      }
      upstream.data.on('error', (err) => {
        logger.error('[codex-upstream] 流式传输错误:', err.message);
        if (!res.headersSent) res.status(502);
        res.end();
      });
      upstream.data.pipe(res);
      return;
    }

    res.status(upstream.status).json(upstream.data);
  } catch (error) {
    logger.error('[codex-upstream] 转发失败:', error.message);
    res.status(502).json({
      error: {
        message: `Codex upstream 不可用: ${error.message}`,
        type: 'upstream_error',
        code: 'codex_upstream_failed'
      }
    });
  }
}

export async function probeCodexUpstream() {
  if (!isEnabled()) return { ok: false, error: 'disabled' };
  try {
    const apiKey = loadApiKey();
    if (!apiKey) return { ok: false, error: 'missing_api_key' };
    const list = await fetchCodexModelList(apiKey, { force: true });
    const started = Date.now();
    return {
      ok: list.length > 0,
      status: 200,
      modelCount: list.length,
      ms: Date.now() - started,
      baseURL: getBaseURL()
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
