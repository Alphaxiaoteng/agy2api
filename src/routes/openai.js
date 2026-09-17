/**
 * OpenAI API 路由
 * 处理 /v1/chat/completions 和 /v1/models 端点
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Router } from 'express';
import { getAvailableModels, getDefaultModelList } from '../api/client.js';
import { handleOpenAIRequest } from '../server/handlers/openai.js';
import { isCodexRoutableModel, mergeCodexModels, proxyOpenAIChat } from '../services/codexUpstream.js';
import { isFreeRoutableModel, mergeDualLibraryModels, proxyFreeChat, getAutoPoolStatus, getFreeModelsList } from '../services/freeModelUpstream.js';
import { 
  isLocalAppRoutableModel, 
  proxyLocalAppChat, 
  getLocalAppModelsList,
  getWorkBuddyModelsList,
  getZCodeModelsList,
  getQwenWorkModelsList
} from '../services/localAppUpstream.js';
import { handleResponsesRequest } from '../services/responsesEngine.js';
import logger from '../utils/logger.js';

const router = Router();

/**
 * GET /v1/workbuddy/models
 * 便捷端点：获取 WorkBuddy 专区模型列表 (DeepSeek V4.1 Flash 300K, DeepSeek V4 Pro, 混元, Kimi 等)
 */
router.get('/workbuddy/models', (req, res) => {
  const models = getWorkBuddyModelsList();
  res.json({
    object: 'list',
    library: 'workbuddy',
    total: models.length,
    data: models
  });
});

/**
 * GET /v1/zcode/models
 * 便捷端点：获取 ZCode 专区模型列表 (GLM-5.3 Flash 智谱高思考, GLM-5.3, GLM-5.2 等)
 */
router.get('/zcode/models', (req, res) => {
  const models = getZCodeModelsList();
  res.json({
    object: 'list',
    library: 'zcode',
    total: models.length,
    data: models
  });
});

router.get(['/qwen/models', '/qwenwork/models'], (req, res) => {
  res.status(404).json({ error: 'Qwen models have been disabled by user configuration' });
});

/**
 * GET /v1/free/status
 * 获取 Free 模型库与 Auto 聚合路由池健康度及实时汇总
 */
router.get('/free/status', (req, res) => {
  try {
    res.json(getAutoPoolStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /v1/free/models
 * 便捷端点：获取 Free 模型库完整列表
 */
router.get('/free/models', (req, res) => {
  res.json({
    object: 'list',
    library: 'free',
    data: getFreeModelsList()
  });
});

/**
 * GET /v1/models
 * 获取可用模型列表 (清晰划分 workbuddy, zcode, qwenwork, free, agy，支持 ?library=workbuddy 或 ?library=zcode 等过滤)
 */
router.get('/models', async (req, res) => {
  try {
    const libFilter = (req.query?.library || req.query?.lib || '').toLowerCase();

    // 1. 单独请求 WorkBuddy 专区
    if (libFilter === 'workbuddy' || libFilter === 'wb') {
      const wbModels = getWorkBuddyModelsList();
      return res.json({
        object: 'list',
        library: 'workbuddy',
        total: wbModels.length,
        data: wbModels
      });
    }

    // 2. 单独请求 ZCode 专区
    if (libFilter === 'zcode') {
      const zcModels = getZCodeModelsList();
      return res.json({
        object: 'list',
        library: 'zcode',
        total: zcModels.length,
        data: zcModels
      });
    }

    // 3. 单独请求千问办公专区
    if (libFilter === 'qwen' || libFilter === 'qwenwork') {
      const qwModels = getQwenWorkModelsList();
      return res.json({
        object: 'list',
        library: 'qwenwork',
        total: qwModels.length,
        data: qwModels
      });
    }

    let rawModels;
    try {
      rawModels = await getAvailableModels();
    } catch (err) {
      logger.warn('获取可用模型列表异常，自动降级为精选 AGY 默认模型:', err.message);
      rawModels = getDefaultModelList();
    }
    const withCodex = await mergeCodexModels(rawModels);
    const dualLibrary = await mergeDualLibraryModels(withCodex, req.query);

    if (libFilter === 'local' || libFilter === 'all') {
      const localModels = getLocalAppModelsList();
      if (Array.isArray(dualLibrary.data)) {
        // 将本地旗舰应用置于首部以方便调用与区分
        dualLibrary.data = [...localModels, ...dualLibrary.data];
        dualLibrary.libraries = ['workbuddy', 'zcode', 'qwenwork', 'agy', 'free'];
      }
    }

    // 严格全局去重与代际收敛：过滤老旧 Gemini (有 3.8 绝不保留 3.7/3.6)，模型 id 唯一去重
    if (Array.isArray(dualLibrary.data)) {
      const filtered = dualLibrary.data.filter((m) => {
        const id = (m.id || '').toLowerCase();
        if (id.includes('gemini-3.7') || id.includes('gemini-3.6') || id.includes('gemini-3.5') || id.includes('gemini-2.')) {
          return false;
        }
        return true;
      });

      const seen = new Set();
      const deduped = [];
      for (const item of filtered) {
        if (!item || !item.id) continue;
        const normId = item.id.trim();
        if (seen.has(normId)) continue;
        seen.add(normId);
        deduped.push(item);
      }

      dualLibrary.data = deduped;
      dualLibrary.total = deduped.length;
    }

    // 重点：同时挂载 Responses API 规范的 models 数组，确保 Codex Desktop 与 Responses API client 解析成功
    const customPayloadPath = path.join(os.homedir(), '.codex/custom_models_payload.json');
    try {
      if (fs.existsSync(customPayloadPath)) {
        const payloadData = JSON.parse(fs.readFileSync(customPayloadPath, 'utf8'));
        if (Array.isArray(payloadData.models)) {
          dualLibrary.models = payloadData.models;
        }
      }
    } catch (e) {
      logger.warn('加载 custom_models_payload.json 失败:', e.message);
    }

    res.json(dualLibrary);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /v1/chat/completions
 * 1. 本地应用引擎 (WorkBuddy / ZCode / GLM-5.3 / 混元 / DeepSeek-V4-Pro 等) -> 路由本地代理
 * 2. 免费/社区模型库 (火山/魔搭/OpenCodeFree/百炼等，含 free/ 前缀) -> 转发对应 Upstream
 * 3. GPT/Codex 模型 -> 转发 Cockpit
 * 4. AGY 模型 (Gemini / Claude 等，支持 agy/ 前缀) -> 走 Antigravity 原生执行器
 */
router.post('/chat/completions', async (req, res) => {
  const model = req.body?.model;

  // 1. 优先路由本地已认证的 WorkBuddy & ZCode 引擎
  if (isLocalAppRoutableModel(model)) {
    return proxyLocalAppChat(req, res);
  }

  // 2. 路由免费/社区模型库
  if (isFreeRoutableModel(model)) {
    return proxyFreeChat(req, res);
  }

  // 3. 路由本地 Codex/GPT 模型
  if (isCodexRoutableModel(model)) {
    return proxyOpenAIChat(req, res);
  }

  // 4. 归一化 AGY 模型别名前缀
  if (typeof model === 'string' && model.startsWith('agy/')) {
    req.body.model = model.slice(4);
  }

  return handleOpenAIRequest(req, res);
});

/**
 * ALL /v1/responses
 * 8045 原生 Responses API 引擎
 * 完整支持 SSE 流式事件序列、AST 级工具清洗反编译与 1.5s keep-alive 维持心跳
 */
router.post('/responses', async (req, res) => {
  return handleResponsesRequest(req, res);
});

router.get('/responses', (req, res) => {
  res.json({
    status: 'online',
    engine: 'Antigravity-Native-ResponsesEngine/2.0',
    port: 8045
  });
});

export default router;