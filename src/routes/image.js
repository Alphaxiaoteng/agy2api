import express from 'express';
import axios from 'axios';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import tokenManager from '../auth/token_manager.js';
import { generateImageForSD } from '../api/client.js';
import { saveBase64Image } from '../utils/imageStorage.js';
import { resolveImageUpstream } from '../services/modelCatalog.js';

const router = express.Router();

/**
 * 图像生成独立路由 /v1/images/generations
 * 不经过 thoughtSignatureCache 与 thinking 注入
 */
router.post('/generations', async (req, res) => {
  const {
    prompt,
    model = 'gemini-3.1-flash-image-preview',
    n = 1,
    size = '1024x1024',
    response_format = 'url' // 'url' | 'b64_json'
  } = req.body || {};

  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: { message: 'prompt is required', type: 'invalid_request_error' } });
  }

  const modelLower = String(model).toLowerCase();

  try {
    const upstream = resolveImageUpstream();

    // 1. gpt-image-* 走 Codex 图片上游（URL/Key 来自 config/env/OpenCode，不写死端口）
    if (modelLower.startsWith('gpt-image')) {
      const codexConfig = upstream.codex;
      if (!codexConfig.url) {
        return res.status(502).json({
          error: {
            message: 'Codex image upstream 未配置：请在 config.imageUpstream.codex.url、CODEX_IMAGE_URL 或 OpenCode provider.codex.baseURL 中设置',
            type: 'upstream_error'
          }
        });
      }

      try {
        const response = await axios.post(
          codexConfig.url,
          req.body,
          {
            headers: {
              'Content-Type': 'application/json',
              ...(codexConfig.apiKey ? { Authorization: `Bearer ${codexConfig.apiKey}` } : {})
            },
            timeout: config.timeout || 120000
          }
        );
        return res.status(response.status).json(response.data);
      } catch (err) {
        logger.error('Codex 图片生成请求失败:', err.message);
        const status = err.response?.status || 502;
        const errData = err.response?.data || { error: { message: err.message, type: 'upstream_error' } };
        return res.status(status).json(errData);
      }
    }

    // 2. doubao-seedream / doubao-5-pro 走 Doubao API
    if (modelLower.includes('doubao') || modelLower.includes('seedream')) {
      const doubaoConfig = upstream.doubao;
      if (!doubaoConfig.url) {
        return res.status(502).json({
          error: {
            message: 'Doubao image upstream 未配置',
            type: 'upstream_error'
          }
        });
      }

      try {
        const response = await axios.post(
          doubaoConfig.url,
          req.body,
          {
            headers: {
              'Content-Type': 'application/json',
              ...(doubaoConfig.apiKey ? { Authorization: `Bearer ${doubaoConfig.apiKey}` } : {})
            },
            timeout: config.timeout || 120000
          }
        );
        return res.status(response.status).json(response.data);
      } catch (err) {
        logger.error('Doubao 图片生成请求失败:', err.message);
        const status = err.response?.status || 502;
        const errData = err.response?.data || { error: { message: err.message, type: 'upstream_error' } };
        return res.status(status).json(errData);
      }
    }

    // 3. 默认 / gemini-3.1-flash-image-preview 等走 Gemini 图片生成 (Antigravity upstream)
    const token = await tokenManager.getNextToken();
    if (!token) {
      return res.status(500).json({ error: { message: '没有可用的 token', type: 'server_error' } });
    }

    let imageSize = '1K';
    if (size.includes('2048') || size.includes('2K') || size.includes('2k')) {
      imageSize = '2K';
    } else if (size.includes('4096') || size.includes('4K') || size.includes('4k')) {
      imageSize = '4K';
    }

    // 构造纯净的 Gemini 生图请求体，严格不注入 thoughtSignature
    const requestBody = {
      project: token.projectId,
      requestId: `agent-req-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      request: {
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          candidateCount: Math.min(Math.max(1, Number(n) || 1), 4),
          imageConfig: {
            imageSize
          }
        }
      },
      model: modelLower.replace(/-(?:1k|2k|4k|8k)$/i, ''),
      userAgent: 'antigravity',
      requestType: 'image_gen'
    };

    const b64Images = await generateImageForSD(requestBody, token);
    if (!b64Images || b64Images.length === 0) {
      return res.status(500).json({ error: { message: '未生成图片', type: 'server_error' } });
    }

    const data = b64Images.map(b64 => {
      if (response_format === 'b64_json') {
        return { b64_json: b64 };
      }
      const url = saveBase64Image(b64, 'image/png');
      return { url };
    });

    return res.json({
      created: Math.floor(Date.now() / 1000),
      data
    });
  } catch (error) {
    logger.error('图片生成失败:', error.message);
    return res.status(500).json({
      error: {
        message: error.message || 'Image generation failed',
        type: 'server_error'
      }
    });
  }
});

export default router;
