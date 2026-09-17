import express from 'express';
import { verifyToken } from '../auth/jwt.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';
import { listModels, getCapabilities } from '../config/flowCapabilities.js';
import { flowQueue } from './flowApi.js';
import { flowExtensionBridge } from '../services/flowExtensionBridge.js';
import { alphaNexusFlowBridge } from '../services/alphaNexusFlowBridge.js';
import { isLocalPeer } from '../utils/peerIp.js';

const router = express.Router();

// 本地 IP 豁免仅信任底层的直接 TCP 连接 (req.socket.remoteAddress)，防止 X-Forwarded-For 伪造攻击。
// 该判定原先内联在 getDirectSocketIP 里，现已统一到 utils/peerIp.js，
// 避免 admin.js / flowSiteProxy.js 各写一份导致修一处漏一处。
function cookieAuthMiddleware(req, res, next) {
  let token = req.cookies?.authToken;
  if (!token) {
    const h = req.headers.authorization;
    token = h?.startsWith('Bearer ') ? h.slice(7) : null;
  }
  if (!token && isLocalPeer(req)) {
    req.user = { username: config.admin.username, role: 'admin' };
    return next();
  }
  if (!token) return res.status(401).json({ success: false, message: 'Token required' });
  try {
    req.user = verifyToken(token);
    next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

router.use(cookieAuthMiddleware);

/**
 * GET /admin/flow/status
 * 轻量管理只读状态聚合：队列信息、模型能力矩阵、WebSocket Extension Bridge 脱敏状态
 */
router.get('/status', async (req, res) => {
  try {
    const queueStatus = flowQueue ? flowQueue.getQueueStatus() : {
      activeCount: 0,
      queuedCount: 0,
      maxQueue: 10,
      concurrency: 1,
      totalCompleted: 0
    };
    const capabilities = getCapabilities();
    const models = listModels();
    const alphaConfigured = alphaNexusFlowBridge.isConfigured();
    let accounts = [];
    if (alphaConfigured) {
      try {
        accounts = await alphaNexusFlowBridge.listFlowAccounts();
      } catch (err) {
        logger.warn(`[FlowAdmin] Alpha Nexus 账号状态不可用: ${err.code || err.message}`);
      }
    }

    const extensionBridgeStatus = flowExtensionBridge ? flowExtensionBridge.getStatus() : null;

    res.json({
      success: true,
      data: {
        officialAuth: {
          status: 'not_checked',
          description: '官方 Flow 登录态由宿主浏览器 / 扩展 / ego-browser 独立维护'
        },
        extensionBridge: extensionBridgeStatus,
        accountBridge: {
          configured: alphaConfigured,
          mode: alphaConfigured ? 'alpha-nexus-space' : 'default-ego-profile',
          accounts
        },
        queue: queueStatus,
        capabilities,
        models
      }
    });
  } catch (err) {
    logger.error(`[FlowAdmin] 获取状态异常: ${err.message}`);
    res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * 已废弃的旧管理端点，明确返回 410 Gone
 */
const deprecatedHandler = (req, res) => {
  res.status(410).json({
    success: false,
    error: 'Endpoint deprecated. Use /v1/flow REST API endpoints instead.'
  });
};

router.all('/assets', deprecatedHandler);
router.all('/file', deprecatedHandler);
router.all('/generate', deprecatedHandler);
router.all('/session', deprecatedHandler);
router.all('/session/sync', deprecatedHandler);

/**
 * 安全空实现，兼容 server 优雅停机调用
 */
export function shutdownFlowJobs() {
  // worker 生命周期由 flowQueue 管理
}

export default router;
