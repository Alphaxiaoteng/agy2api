import crypto from 'crypto';
import logger from '../utils/logger.js';
import { getActiveQoderToken } from './cockpitQoderSync.js';

export const QODER_MODELS = [
  { id: 'qwen3.8-flash', display_name: 'Qwen 3.8 Flash (Qoder 旗舰)', vendor: 'qoder', library: 'qoder', region: 'global', reasoning: true },
  { id: 'qwen3.8-max', display_name: 'Qwen 3.8 Max (Qoder 高思考)', vendor: 'qoder', library: 'qoder', region: 'global', reasoning: true }
];

export function getQoderModelsList() {
  const now = Math.floor(Date.now() / 1000);
  return QODER_MODELS.map(m => ({
    id: m.id,
    object: 'model',
    created: now,
    owned_by: m.vendor,
    library: m.library,
    display_name: m.display_name,
    reasoning: m.reasoning
  }));
}

export function isQoderRoutableModel(rawModel) {
  if (typeof rawModel !== 'string' || !rawModel.trim()) return false;
  const m = rawModel.trim().toLowerCase();
  if (m.startsWith('qoder/') || m.startsWith('qoder-') || m.startsWith('qodercn/') || m.startsWith('qodercn-')) return true;
  if (m.includes('qwen3.8') || m.includes('qwen-3.8') || m === 'qfmodel' || m === 'qmodel_38max') return true;
  for (const item of QODER_MODELS) {
    if (item.id.toLowerCase() === m) return true;
  }
  return false;
}

export function resolveQoderTarget(rawModel) {
  const m = String(rawModel || '').trim().toLowerCase();
  const isCN = m.includes('-cn') || m.includes('cn/') || m.startsWith('qodercn');

  let targetModel = 'qfmodel';
  if (m.includes('max') || m.includes('38max') || m.includes('ultimate')) {
    targetModel = 'qmodel_38max';
  } else {
    targetModel = 'qfmodel';
  }

  return {
    isCN,
    region: isCN ? 'cn' : 'global',
    targetModel,
    endpoint: isCN ? 'https://gateway.qoder.com.cn' : 'https://api1.qoder.sh'
  };
}

/**
 * Qoder 统一代理入口
 */
export async function proxyQoderChat(req, res) {
  const rawModel = req.body?.model || 'qwen3.8-flash';
  const stream = !!req.body?.stream;
  const messages = req.body?.messages || [];
  const reqId = 'chatcmpl-qoder-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);

  const { isCN, region, targetModel, endpoint } = resolveQoderTarget(rawModel);
  const isFreeModel = targetModel === 'qfmodel'; // Qwen 3.8 Flash 为当前免额度畅享模型
  logger.info(`[QoderUpstream] 路由 Qoder 请求: rawModel=${rawModel} -> region=${region}, targetModel=${targetModel}, isFreeModel=${isFreeModel}, stream=${stream}`);

  const activeTokenInfo = getActiveQoderToken(region, isFreeModel);
  if (!activeTokenInfo || !activeTokenInfo.token) {
    logger.warn('[QoderUpstream] 无可用 Qoder Token 凭证');
    return res.status(503).json({
      error: {
        message: 'Qoder 账号池无可用凭据，请在管理面板同步 Cockpit 账号或配置 PAT',
        type: 'service_unavailable',
        code: 'no_qoder_token'
      }
    });
  }

  if (activeTokenInfo.isExhausted) {
    logger.warn(`[QoderUpstream] 账号 ${activeTokenInfo.email} 额度已用尽或接近耗尽`);
  }

  // 构造标准上游请求载荷
  const payload = {
    model: targetModel,
    messages,
    stream,
    temperature: req.body?.temperature ?? 0.7,
    max_tokens: req.body?.max_tokens || 4096
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${activeTokenInfo.token}`,
    'User-Agent': 'Qoder-Client/0.4.2',
    'x-qoder-region': region,
    'x-request-id': reqId
  };

  try {
    const upstreamUrl = `${endpoint}/v1/chat/completions`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    req.on('close', () => {
      clearTimeout(timeoutId);
      controller.abort();
    });

    const upstreamRes = await fetch(upstreamUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    }).catch(err => {
      // 容错：如果主端点不可达，回落到备用端点
      const fallbackUrl = isCN ? 'https://center.qoder.com.cn/v1/chat/completions' : 'https://api.qoder.com/v1/chat/completions';
      logger.info(`[QoderUpstream] 主端点连接重试，回落至备用端点: ${fallbackUrl}`);
      return fetch(fallbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    });

    clearTimeout(timeoutId);

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text().catch(() => '');
      logger.warn(`[QoderUpstream] 上游响应错误: HTTP ${upstreamRes.status} - ${errText.slice(0, 200)}`);
      
      // 优雅降级返回规范 OpenAI Error
      return res.status(upstreamRes.status).json({
        error: {
          message: `Qoder 上游服务错误 (${upstreamRes.status}): ${errText.slice(0, 300) || 'Upstream Error'}`,
          type: 'upstream_error',
          code: upstreamRes.status === 429 ? 'quota_exceeded' : 'qoder_error',
          account: activeTokenInfo.email
        }
      });
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      // 首个 Chunk 通知客户端连接已就绪
      const initialChunk = {
        id: reqId,
        object: 'chat.completion.chunk',
        created,
        model: rawModel,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
      };
      res.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

      const reader = upstreamRes.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        res.write(text);
      }
      return res.end();
    } else {
      const data = await upstreamRes.json();
      data.model = rawModel;
      return res.json(data);
    }
  } catch (err) {
    logger.error('[QoderUpstream] 转发异常:', err.message);
    if (!res.headersSent) {
      return res.status(502).json({
        error: {
          message: `连接 Qoder 上游网关失败: ${err.message}`,
          type: 'gateway_error',
          code: 'bad_gateway'
        }
      });
    }
  }
}
