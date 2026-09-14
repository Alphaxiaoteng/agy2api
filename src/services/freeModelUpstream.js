/**
 * Free / Community Model Upstream Manager (免费及外部社区模型库管理与 Auto 智能路由)
 * 管理 8045 的第二个模型库：聚合 火山引擎 (Doubao/ARK)、魔搭社区 (ModelScope)、OpenCode Free 三大免费渠道
 * 内置 auto 智能路由：自动健康探测、429/超时自动熔断冷却、全链路无感故障转移 (Failover)
 */

import fs from "fs";
import os from "os";
import path from "path";
import axios from "axios";
import http from "http";
import https from "https";
import config from "../config/config.js";
import logger from "../utils/logger.js";

const httpAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 64 });

// 精选保留的 AGY 旗舰模型列表（过滤掉几十个内部测试与废弃预览模型）
const CURATED_AGY_MODELS = [
  { id: "gemini-3.1-pro-high", display_name: "Gemini 3.1 Pro (深度思考/250k)", reasoning: true },
  { id: "claude-sonnet-4-6-thinking", display_name: "Claude Sonnet 4.6 (思考流/编程)", reasoning: true },
  { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6 (标准流)", reasoning: false },
  { id: "gemini-3.8-flash", display_name: "Gemini 3.8 Flash (毫秒极速)", reasoning: false },
  { id: "claude-opus-4-7-thinking", display_name: "Claude Opus 4.7 (旗舰思考)", reasoning: true },
  { id: "gemini-3.1-flash-image", display_name: "Gemini 3.1 Flash Image (视觉/绘图)", reasoning: false }
];

// 三大免费渠道精选模型（严格排除 tokenplan）
const PROVIDER_DEFINITIONS = {
  doubao: {
    id: "doubao",
    name: "火山引擎 (Doubao)",
    baseURL: "https://ark.cn-beijing.volces.com/api/v3",
    models: [
      { id: "deepseek-v4-flash-ga-260731", name: "DeepSeek V4 Flash (火山)", reasoning: true, priority: 1 },
      { id: "doubao-seed-evolving", name: "Doubao Seed Evolving (火山)", reasoning: false, priority: 3 },
      { id: "deepseek-v4-pro-ga-260813", name: "DeepSeek V4 Pro (火山)", reasoning: true, priority: 4 }
    ]
  },
  modelscope: {
    id: "modelscope",
    name: "魔搭社区 (ModelScope)",
    baseURL: "https://api-inference.modelscope.cn/v1",
    models: [
      { id: "deepseek-ai/DeepSeek-V4-Pro", name: "DeepSeek V4 Pro (魔搭)", reasoning: true, priority: 1 },
      { id: "Qwen/Qwen3.5-397B-A17B", name: "Qwen 3.5 397B (魔搭)", reasoning: true, priority: 2 },
      { id: "Qwen/Qwen3.8-27B", name: "Qwen 3.8 27B (魔搭)", reasoning: false, priority: 3 },
      { id: "Shanghai_AI_Laboratory/Intern-S2-Preview", name: "Intern S2 Preview (魔搭)", reasoning: true, priority: 4 }
    ]
  },
  "opencode-free": {
    id: "opencode-free",
    name: "OpenCode Free",
    baseURL: "https://opencode.ai/zen/v1",
    keyless: true,
    models: [
      { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning (Free)", reasoning: true, priority: 3 },
      { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra (Free)", reasoning: true, priority: 4 }
    ]
  }
};

// Auto 候选池按优先级调度
const AUTO_POOL_CANDIDATES = [
  { providerId: "modelscope", model: "deepseek-ai/DeepSeek-V4-Pro", label: "魔搭 DeepSeek V4 Pro", priority: 1 },
  { providerId: "doubao", model: "deepseek-v4-flash-ga-260731", label: "火山 DeepSeek V4 Flash", priority: 2 },
  { providerId: "modelscope", model: "Qwen/Qwen3.5-397B-A17B", label: "魔搭 Qwen 3.5 397B", priority: 3 },
  { providerId: "opencode-free", model: "nemotron-3.5-lightning-free", label: "OpenCode Nemotron 3.5", priority: 4 },
  { providerId: "doubao", model: "doubao-seed-evolving", label: "火山 Doubao Seed Evolving", priority: 5 },
  { providerId: "doubao", model: "deepseek-v4-pro-ga-260813", label: "火山 DeepSeek V4 Pro", priority: 6 },
  { providerId: "opencode-free", model: "nemotron-3-ultra-free", label: "OpenCode Nemotron 3 Ultra", priority: 7 }
];

const candidateStats = new Map();
for (const c of AUTO_POOL_CANDIDATES) {
  const key = `${c.providerId}:${c.model}`;
  candidateStats.set(key, {
    key,
    providerId: c.providerId,
    model: c.model,
    label: c.label,
    consecutiveFailures: 0,
    cooldownUntil: 0,
    totalRequests: 0,
    successRequests: 0,
    failedRequests: 0,
    lastError: null,
    lastUsedAt: 0
  });
}

let cachedDynamicKeys = { at: 0, keys: {} };

export function loadProviderKeys() {
  const now = Date.now();
  if (now - cachedDynamicKeys.at < 60000 && Object.keys(cachedDynamicKeys.keys).length > 0) {
    return cachedDynamicKeys.keys;
  }

  const keys = {};
  try {
    const opencodePath = path.join(os.homedir(), ".config", "opencode", "opencode.json");
    if (fs.existsSync(opencodePath)) {
      const doc = JSON.parse(fs.readFileSync(opencodePath, "utf8"));
      for (const [p, conf] of Object.entries(doc.provider || {})) {
        const k = conf.options?.apiKey || conf.apiKey;
        if (k) keys[p] = k;
      }
    }
  } catch (err) {
    logger.debug("[FreeUpstream] opencode.json 读取跳过:", err.message);
  }

  try {
    const hermesPath = path.join(os.homedir(), ".hermes", "config.yaml");
    if (fs.existsSync(hermesPath)) {
      const content = fs.readFileSync(hermesPath, "utf8");
      const match = content.match(/modelscope:[\s\S]*?api_key:\s*([^\s\n]+)/);
      if (match && match[1]) {
        keys["modelscope"] = match[1];
      }
    }
  } catch (err) {
    logger.debug("[FreeUpstream] hermes config.yaml 读取跳过:", err.message);
  }

  if (process.env.MODELSCOPE_API_KEY) keys["modelscope"] = process.env.MODELSCOPE_API_KEY;
  if (process.env.DOUBAO_API_KEY || process.env.VOLC_API_KEY) keys["doubao"] = process.env.DOUBAO_API_KEY || process.env.VOLC_API_KEY;

  cachedDynamicKeys = { at: now, keys };
  return keys;
}

export function isFreeRoutableModel(model) {
  if (typeof model !== "string" || !model.trim()) return false;
  const id = model.trim().toLowerCase();

  if (id === "auto" || id === "free/auto" || id === "free-auto" || id === "free") {
    return true;
  }
  if (id.startsWith("free/")) {
    return true;
  }
  if (id.includes("gemini") || id.includes("claude-") || id.startsWith("agy/")) {
    return false;
  }

  for (const prov of Object.values(PROVIDER_DEFINITIONS)) {
    for (const m of prov.models) {
      if (m.id.toLowerCase() === id) return true;
    }
  }

  if (id.includes("seedream") || id.includes("seed-evolving") || id.includes("-ga-")) return true;
  if (id.includes("modelscope") || id.startsWith("deepseek-ai/") || id.startsWith("qwen/") || id.startsWith("shanghai_ai_laboratory/") || id.startsWith("stepfun-ai/")) return true;
  if (id.endsWith("-free")) return true;

  return false;
}

export function isAutoModel(model) {
  if (typeof model !== "string" || !model.trim()) return false;
  const id = model.trim().toLowerCase();
  return id === "auto" || id === "free/auto" || id === "free-auto" || id === "free";
}

export function resolveFreeProvider(rawModel) {
  let model = String(rawModel || "").trim();
  if (model.startsWith("free/")) {
    model = model.slice(5);
  }

  const keys = loadProviderKeys();

  for (const [provId, def] of Object.entries(PROVIDER_DEFINITIONS)) {
    for (const m of def.models) {
      if (m.id === model) {
        return {
          providerId: provId,
          model,
          baseURL: def.baseURL,
          apiKey: keys[provId] || "",
          keyless: def.keyless === true,
          name: def.name
        };
      }
    }
  }

  if (model.includes("seedream") || model.includes("doubao") || model.includes("-ga-")) {
    return {
      providerId: "doubao",
      model,
      baseURL: PROVIDER_DEFINITIONS.doubao.baseURL,
      apiKey: keys["doubao"] || "",
      name: PROVIDER_DEFINITIONS.doubao.name
    };
  }

  if (model.includes("modelscope") || model.startsWith("deepseek-ai/") || model.startsWith("qwen/") || model.startsWith("shanghai_ai_laboratory/") || model.startsWith("stepfun-ai/")) {
    return {
      providerId: "modelscope",
      model: model.replace(/^modelscope\//i, ""),
      baseURL: PROVIDER_DEFINITIONS.modelscope.baseURL,
      apiKey: keys["modelscope"] || "",
      name: PROVIDER_DEFINITIONS.modelscope.name
    };
  }

  if (model.endsWith("-free")) {
    return {
      providerId: "opencode-free",
      model,
      baseURL: PROVIDER_DEFINITIONS["opencode-free"].baseURL,
      apiKey: "",
      keyless: true,
      name: PROVIDER_DEFINITIONS["opencode-free"].name
    };
  }

  return null;
}

function getOrderedAutoCandidates() {
  const now = Date.now();
  const available = [];
  const cooling = [];

  for (const c of AUTO_POOL_CANDIDATES) {
    const key = `${c.providerId}:${c.model}`;
    const st = candidateStats.get(key);
    const inCooldown = st && st.cooldownUntil > now;
    if (!inCooldown) {
      available.push(c);
    } else {
      cooling.push(c);
    }
  }

  return available.length > 0 ? available : cooling.sort((a, b) => {
    const stA = candidateStats.get(`${a.providerId}:${a.model}`);
    const stB = candidateStats.get(`${b.providerId}:${b.model}`);
    return (stA?.cooldownUntil || 0) - (stB?.cooldownUntil || 0);
  });
}

function recordCandidateResult(providerId, model, { success, error, statusCode }) {
  const key = `${providerId}:${model}`;
  const st = candidateStats.get(key);
  if (!st) return;

  const now = Date.now();
  st.totalRequests++;
  st.lastUsedAt = now;

  if (success) {
    st.consecutiveFailures = 0;
    st.cooldownUntil = 0;
    st.successRequests++;
    st.lastError = null;
  } else {
    st.consecutiveFailures++;
    st.failedRequests++;
    st.lastError = `${statusCode || "ERR"}: ${error || "unknown"}`;

    let cooldownMs = 30000;
    if (statusCode === 429) cooldownMs = 60000;
    else if (statusCode >= 500) cooldownMs = 45000;
    st.cooldownUntil = now + cooldownMs;

    logger.warn(`[FreeAuto] 节点 ${st.label} 触发冷却 ${cooldownMs / 1000}s, 累计连续失败: ${st.consecutiveFailures}`);
  }
}

export function getFreeModelsList() {
  const list = [];

  // Auto 智能路由置顶
  list.push({
    id: "auto",
    object: "model",
    created: 1788720000,
    owned_by: "free",
    library: "free",
    display_name: "⚡ auto (火山+魔搭+OpenCode 智能路由)",
    description: "自动在火山引擎、魔搭社区与 OpenCode 之间负载均衡，遇限流无感自动切换",
    channels: ["doubao", "modelscope", "opencode-free"],
    reasoning: true
  });

  // 三大渠道精简清单（无多余前缀污染）
  for (const [provId, def] of Object.entries(PROVIDER_DEFINITIONS)) {
    for (const m of def.models) {
      list.push({
        id: m.id,
        object: "model",
        created: 1788720000,
        owned_by: "free",
        library: "free",
        provider: provId,
        provider_name: def.name,
        display_name: m.name,
        reasoning: !!m.reasoning
      });
    }
  }

  return list;
}

export function getAutoPoolStatus() {
  const now = Date.now();
  const summary = [];
  for (const [key, st] of candidateStats.entries()) {
    summary.push({
      key,
      provider: st.providerId,
      model: st.model,
      label: st.label,
      healthy: st.cooldownUntil <= now,
      cooldownRemainingSec: Math.max(0, Math.round((st.cooldownUntil - now) / 1000)),
      total: st.totalRequests,
      success: st.successRequests,
      failed: st.failedRequests,
      lastError: st.lastError
    });
  }
  return {
    channels: ["火山引擎 (Doubao)", "魔搭社区 (ModelScope)", "OpenCode Free"],
    totalCandidates: AUTO_POOL_CANDIDATES.length,
    activeCandidates: summary.filter((s) => s.healthy).length,
    pool: summary
  };
}

/**
 * 合并精选模型：只输出高价值旗舰与智能路由，杜绝内部调试模型刷屏
 */
export async function mergeDualLibraryModels(agyPayload, query = {}) {
  const libraryFilter = (query?.library || query?.lib || "").toLowerCase();

  // 1. 精简 AGY 库：从上游返回的模型中仅保留旗舰模型
  const availableAgyIds = new Set((agyPayload?.data || []).map((m) => m.id));
  const curatedAgy = CURATED_AGY_MODELS
    .filter((m) => availableAgyIds.has(m.id))
    .map((m) => ({
      id: m.id,
      object: "model",
      created: 1788720000,
      owned_by: "agy",
      library: "agy",
      display_name: m.display_name,
      reasoning: m.reasoning
    }));

  // 2. 精简 Free 库
  const freeModels = getFreeModelsList();

  if (libraryFilter === "agy") {
    return {
      object: "list",
      library: "agy",
      total: curatedAgy.length,
      data: curatedAgy
    };
  }

  if (libraryFilter === "free") {
    return {
      object: "list",
      library: "free",
      total: freeModels.length,
      auto_pool: getAutoPoolStatus(),
      data: freeModels
    };
  }

  // 默认合并全集：Auto 置顶，其次为 Gemini 3.1 Pro、Claude 4.6，最后为精简 Free 渠道
  const combined = [
    freeModels.find((m) => m.id === "auto"),
    ...curatedAgy,
    ...freeModels.filter((m) => m.id !== "auto")
  ].filter(Boolean);

  return {
    object: "list",
    libraries: ["agy", "free"],
    total: combined.length,
    data: combined
  };
}

async function executeUpstreamCall(resolved, reqBody, stream, timeoutMs = 120000) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json"
  };

  if (resolved.apiKey) {
    headers["Authorization"] = `Bearer ${resolved.apiKey}`;
  } else if (resolved.keyless) {
    headers["Authorization"] = "";
    headers["User-Agent"] = "HermesAgent/0.9.0";
  }

  const url = `${resolved.baseURL.replace(/\/$/, "")}/chat/completions`;
  const forwardBody = {
    ...reqBody,
    model: resolved.model
  };

  return axios.post(url, forwardBody, {
    headers,
    timeout: timeoutMs,
    responseType: stream ? "stream" : "json",
    httpAgent,
    httpsAgent,
    validateStatus: () => true,
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
}

export async function proxyFreeChat(req, res) {
  const rawModel = req.body?.model;
  const stream = !!req.body?.stream;
  const isAuto = isAutoModel(rawModel);

  if (!isAuto) {
    const resolved = resolveFreeProvider(rawModel);
    if (!resolved) {
      return res.status(404).json({
        error: {
          message: `模型 ${rawModel} 未在 Free 免费模型库中找到可用配置`,
          type: "invalid_request_error",
          code: "model_not_found"
        }
      });
    }

    logger.info(`[FreeUpstream] 直接调度 ${resolved.name} [${resolved.model}] stream=${stream}`);
    try {
      const upstream = await executeUpstreamCall(resolved, req.body, stream);
      if (upstream.status < 200 || upstream.status >= 300) {
        recordCandidateResult(resolved.providerId, resolved.model, {
          success: false,
          statusCode: upstream.status,
          error: `HTTP ${upstream.status}`
        });

        if (stream && upstream.data && typeof upstream.data.on === "function") {
          let errData = "";
          upstream.data.on("data", (chunk) => (errData += chunk));
          upstream.data.on("end", () => {
            try {
              res.status(upstream.status).json(JSON.parse(errData));
            } catch {
              res.status(upstream.status).send(errData);
            }
          });
          return;
        }
        return res.status(upstream.status).json(upstream.data);
      }

      recordCandidateResult(resolved.providerId, resolved.model, { success: true });

      if (stream) {
        res.status(upstream.status);
        for (const [key, value] of Object.entries(upstream.headers || {})) {
          if (key.toLowerCase() === "transfer-encoding") continue;
          if (value !== undefined) res.setHeader(key, value);
        }
        upstream.data.on("error", (err) => {
          logger.error(`[FreeUpstream] 流式传输中断 (${resolved.name}):`, err.message);
          if (!res.headersSent) res.status(502);
          res.end();
        });
        upstream.data.pipe(res);
        return;
      }

      return res.status(upstream.status).json(upstream.data);
    } catch (error) {
      recordCandidateResult(resolved.providerId, resolved.model, {
        success: false,
        error: error.message
      });
      return res.status(502).json({
        error: {
          message: `Free Upstream 转发失败 [${resolved.name}]: ${error.message}`,
          type: "upstream_error",
          code: error.code || "UPSTREAM_ERROR"
        }
      });
    }
  }

  // Auto 智能模式
  const candidates = getOrderedAutoCandidates();
  const keys = loadProviderKeys();
  const attempted = [];

  logger.info(`[FreeAuto] 收到 Auto 路由请求，候选池共 ${candidates.length} 个节点，开始按序探测`);

  for (const candidate of candidates) {
    const provDef = PROVIDER_DEFINITIONS[candidate.providerId];
    if (!provDef) continue;

    const resolved = {
      providerId: candidate.providerId,
      model: candidate.model,
      baseURL: provDef.baseURL,
      apiKey: keys[candidate.providerId] || "",
      keyless: provDef.keyless === true,
      name: provDef.name,
      label: candidate.label
    };

    attempted.push(resolved.label);

    try {
      logger.info(`[FreeAuto] 正在尝试节点: ${resolved.label} (${resolved.baseURL})`);
      const upstream = await executeUpstreamCall(resolved, req.body, stream, 20000);

      if (upstream.status >= 200 && upstream.status < 300) {
        recordCandidateResult(resolved.providerId, resolved.model, { success: true });
        logger.info(`[FreeAuto] ✓ 节点 ${resolved.label} 调用成功！`);

        if (stream) {
          res.status(upstream.status);
          for (const [k, v] of Object.entries(upstream.headers || {})) {
            if (k.toLowerCase() === "transfer-encoding") continue;
            if (v !== undefined) res.setHeader(k, v);
          }
          upstream.data.on("error", (err) => {
            logger.error(`[FreeAuto] 流传输异常 (${resolved.label}):`, err.message);
            if (!res.headersSent) res.status(502);
            res.end();
          });
          upstream.data.pipe(res);
          return;
        }

        return res.status(upstream.status).json(upstream.data);
      }

      logger.warn(`[FreeAuto] 节点 ${resolved.label} 返回 HTTP ${upstream.status}，自动尝试下一节点...`);
      recordCandidateResult(resolved.providerId, resolved.model, {
        success: false,
        statusCode: upstream.status,
        error: `HTTP ${upstream.status}`
      });
    } catch (err) {
      logger.warn(`[FreeAuto] 节点 ${resolved.label} 异常: ${err.message}，自动尝试下一节点...`);
      recordCandidateResult(resolved.providerId, resolved.model, {
        success: false,
        error: err.message
      });
    }
  }

  logger.error(`[FreeAuto] 所有候选节点均失败，尝试列表: ${attempted.join(" -> ")}`);
  return res.status(503).json({
    error: {
      message: `Free Auto 候选池全部节点不可用 (已尝试: ${attempted.join(", ")})，请检查各平台额度或稍后重试`,
      type: "service_unavailable",
      code: "free_pool_exhausted"
    }
  });
}
