/**
 * Claude API 路由
 * 处理 /v1/messages 端点
 */

import { Router } from 'express';
import { handleClaudeRequest } from '../server/handlers/claude.js';

const router = Router();

/**
 * POST /v1/messages
 * 处理 Claude 消息请求
 */
router.post('/messages', (req, res) => {
  const isStream = req.body.stream === true;
  handleClaudeRequest(req, res, isStream);
});

/**
 * POST /v1/messages/count_tokens
 * 估算请求的 token 数量
 * Claude Code 在 /init 时会频繁调用此端点
 */
router.post('/messages/count_tokens', (req, res) => {
  try {
    const { messages, system } = req.body;

    // 简单的 token 估算：大约 4 个字符 = 1 个 token
    let totalChars = 0;

    // 计算 system 提示词
    if (system) {
      if (typeof system === 'string') {
        totalChars += system.length;
      } else if (Array.isArray(system)) {
        for (const item of system) {
          if (item.text) totalChars += item.text.length;
        }
      }
    }

    // 计算消息内容
    if (messages && Array.isArray(messages)) {
      for (const msg of messages) {
        if (typeof msg.content === 'string') {
          totalChars += msg.content.length;
        } else if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text' && part.text) {
              totalChars += part.text.length;
            }
          }
        }
      }
    }

    // 估算 token 数量（中文约 2 字符/token，英文约 4 字符/token，取平均 3）
    const estimatedTokens = Math.ceil(totalChars / 3);

    res.json({
      input_tokens: estimatedTokens
    });
  } catch (error) {
    res.status(400).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: error.message || 'Failed to count tokens'
      }
    });
  }
});

export default router;