/**
 * 服务器主入口
 * Express 应用配置、中间件、路由挂载、服务器启动和关闭
 */

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import requesterManager from '../utils/requesterManager.js';
import logger from '../utils/logger.js';
import logWsServer from '../utils/logWsServer.js';
import config, { checkAndUpdateVersion } from '../config/config.js';
import memoryManager from '../utils/memoryManager.js';
import { getPublicDir, getRelativePath } from '../utils/paths.js';
import { errorHandler } from '../utils/errors.js';
import { getChunkPoolSize, clearChunkPool } from './stream.js';
import ipBlockManager from '../utils/ipBlockManager.js';

// 路由模块
import adminRouter from '../routes/admin.js';
import sdRouter from '../routes/sd.js';
import openaiRouter from '../routes/openai.js';
import geminiRouter from '../routes/gemini.js';
import claudeRouter from '../routes/claude.js';
import cliRouter from '../routes/cli.js';
import flowRouter, { shutdownFlowJobs } from '../routes/flow.js';
import { flowApiRouter } from '../routes/flowApi.js';
import { flowExtensionBridge } from '../services/flowExtensionBridge.js';
import imageRouter from '../routes/image.js';
import weeklyActivationManager from '../auth/weekly_activation_manager.js';

const publicDir = getPublicDir();

const app = express();

// 信任反向代理，以便正确获取 HTTPS 协议状态 (req.secure) 和客户端 IP
app.set('trust proxy', true);

// 初始化 IP 封禁管理器
ipBlockManager.init();

// 全局 IP 封禁检查中间件
app.use((req, res, next) => {
  const ip = req.ip;
  const status = ipBlockManager.check(ip);
  if (status.blocked) {
    if (status.reason === 'permanent') {
      return res.status(403).json({ error: 'Access Denied: Your IP has been permanently blocked.' });
    }
    const remainingMinutes = Math.ceil((status.expiresAt - Date.now()) / 60000);
    return res.status(429).json({ error: `Access Denied: Temporarily blocked for ${remainingMinutes} minutes.` });
  }
  next();
});

// ==================== 内存管理 ====================
memoryManager.start(config.server.memoryCleanupInterval);

// ==================== 基础中间件 ====================
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
app.use(cors({
  origin(origin, callback) {
    if (!origin || LOCAL_ORIGIN.test(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS blocked for non-local origin'));
  },
  credentials: true
}));
app.use(cookieParser());
app.use(express.json({ limit: config.security.maxRequestSize }));

// 静态文件服务
app.use('/images', express.static(path.join(publicDir, 'images')));
app.use(express.static(publicDir));

// 管理路由
app.use('/admin', adminRouter);
app.use('/admin/flow', flowRouter);

// 使用统一错误处理中间件
app.use(errorHandler);

// ==================== 请求日志中间件 ====================
app.use((req, res, next) => {
  const ignorePaths = [
    '/images', '/favicon.ico', '/.well-known', '/health',
    '/admin/logs', '/ws/logs',
    '/sdapi/v1/options', '/sdapi/v1/samplers', '/sdapi/v1/schedulers',
    '/sdapi/v1/upscalers', '/sdapi/v1/latent-upscale-modes',
    '/sdapi/v1/sd-vae', '/sdapi/v1/sd-modules'
  ];
  // 提前获取完整路径，避免在路由处理后 req.path 被修改为相对路径
  const fullPath = req.originalUrl.split('?')[0];
  if (!ignorePaths.some(p => fullPath.startsWith(p))) {
    const start = Date.now();
    res.on('finish', () => {
      logger.request(req.method, fullPath, res.statusCode, Date.now() - start);
    });
  }
  next();
});

// SD API 路由
app.use('/sdapi/v1', sdRouter);

// ==================== API Key 验证中间件 ====================
app.use((req, res, next) => {
  if ((req.path.startsWith('/v1/') || req.path.startsWith('/api/v1/') || req.path.startsWith('/cli/v1/')) && !req.path.endsWith('/props')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const authHeader = req.headers.authorization || req.headers['x-api-key'];
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (providedKey !== apiKey) {
        ipBlockManager.recordViolation(req.ip, 'auth_fail');
        logger.warn(`API Key 验证失败: ${req.method} ${req.path} (提供的Key: ${providedKey ? providedKey.substring(0, 10) + '...' : '无'})`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }
    }
  } else if (req.path.startsWith('/v1beta/')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const providedKey = req.query.key || req.headers['x-goog-api-key'];
      if (providedKey !== apiKey) {
        ipBlockManager.recordViolation(req.ip, 'auth_fail');
        logger.warn(`API Key 验证失败: ${req.method} ${req.path} (提供的Key: ${providedKey ? providedKey.substring(0, 10) + '...' : '无'})`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }
    }
  }
  next();
});

// ==================== API 路由 ====================

// 图片生成独立路由
app.use('/v1/images', imageRouter);

// Google Flow 独立同步 API
app.use('/v1/flow', flowApiRouter);

// OpenAI 兼容 API (同时支持 /v1 和 /api/v1)
app.use(['/v1', '/api/v1'], openaiRouter);

// 兼容直接请求根路径 /models (例如 Codex Desktop / Responses client 直接请求)
app.get('/models', (req, res, next) => {
  req.url = '/models' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  openaiRouter(req, res, next);
});

// 兼容直接请求根路径 /responses
app.all('/responses', (req, res, next) => {
  req.url = '/responses' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
  openaiRouter(req, res, next);
});

// Gemini 兼容 API
app.use('/v1beta', geminiRouter);

// Claude 兼容 API（/v1/messages 由 claudeRouter 处理）
app.use(['/v1', '/api/v1'], claudeRouter);

// Gemini CLI 兼容 API
app.use('/cli', cliRouter);

// 客户端适配端点 (ZCode / Ollama / Continue / Chatbox 探测)
app.get(['/version', '/api/version'], (req, res) => res.json({ version: '2.11.0' }));
app.get(['/props', '/v1/props', '/api/props', '/api/v1/props'], (req, res) => res.json({ ok: true, status: 'ok' }));
app.get(['/api/tags', '/tags'], (req, res) => res.json({
  models: [
    { name: 'gemini-3.7-flash-tiered', model: 'gemini-3.7-flash-tiered' },
    { name: 'gemini-3.1-pro-high', model: 'gemini-3.1-pro-high' },
    { name: 'gemini-3.8-flash', model: 'gemini-3.8-flash' },
    { name: 'auto', model: 'auto' }
  ]
}));

// ==================== 系统端点 ====================

// 内存监控端点
app.get('/v1/memory', (req, res) => {
  const usage = process.memoryUsage();
  res.json({
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    rss: usage.rss,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    poolSizes: memoryManager.getPoolSizes(),
    chunkPoolSize: getChunkPoolSize()
  });
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// 404 处理 (未匹配到任何路由)
app.use((req, res, next) => {
  // 白名单路径：这些路径的 404 不触发 IP 封禁
  // 包含客户端（如 Claude Code）可能请求但我们未实现的端点
  const whitelistPaths = [
    '/favicon.ico',
    '/robots.txt',
    '/.well-known',
    // 管理后台和日志
    '/ws/logs',
    // Claude API 相关端点
    '/api/event_logging',
    '/v1/complete',
    '/v1/models',
    // Flow API 相关端点
    '/v1/flow',
    // OpenAI API 相关端点
    '/v1/files',
    '/v1/fine-tunes',
    '/v1/fine_tuning',
    '/v1/assistants',
    '/v1/threads',
    '/v1/batches',
    '/v1/uploads',
    '/v1/organization',
    '/v1/usage',
    // Gemini API 相关端点
    '/v1beta/models'
  ];

  const path = req.path;
  const isWhitelisted = whitelistPaths.some(p => path === p || path.startsWith(p + '/'));

  if (isWhitelisted) {
    return res.status(404).json({ error: 'Not Found' });
  }

  ipBlockManager.recordViolation(req.ip, '404');
  res.status(404).json({ error: 'Not Found' });
});

// ==================== 服务器启动 ====================
const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务器已启动: ${config.server.host}:${config.server.port}`);

  // 启动时检查版本更新
  checkAndUpdateVersion();

  // 初始化 WebSocket 日志服务
  logWsServer.initialize(server);
  logWsServer.updateConfig({
    logMaxSizeMB: config.log?.maxSizeMB,
    logMaxFiles: config.log?.maxFiles,
    logMaxMemory: config.log?.maxMemory
  });
  logger.info('WebSocket 日志服务已启动: /ws/logs');

  // 初始化 Flow Extension WebSocket Bridge
  flowExtensionBridge.initialize(server);
  logger.info('WebSocket Flow Extension Bridge 已挂载: /internal/flow/ws');

  // 启动周额度重置自动激活守护
  weeklyActivationManager.start();
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;
server.maxRequestsPerSocket = 1000;

const activeSockets = new Set();
server.on('connection', socket => {
  activeSockets.add(socket);
  socket.on('close', () => activeSockets.delete(socket));
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

// ==================== 优雅关闭 ====================
let shuttingDown = false;
const shutdown = (signal = 'unknown') => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`正在关闭服务器... signal=${signal} pid=${process.pid} ppid=${process.ppid} sockets=${activeSockets.size}`);

  // 停止内存管理器
  memoryManager.stop();
  logger.info('已停止内存管理器');

  // 停止周额度自动激活守护
  weeklyActivationManager.stop();

  // 关闭子进程请求器
  requesterManager.close();
  logger.info('已关闭子进程请求器');

  shutdownFlowJobs();
  logger.info('已关闭 Flow 子进程');

  // 清理对象池
  clearChunkPool();
  logger.info('已清理对象池');

  // 关闭 WebSocket 日志服务
  logWsServer.close();
  logger.info('已关闭 WebSocket 日志服务');

  // 关闭 Flow Extension WebSocket Bridge
  flowExtensionBridge.close();
  logger.info('已关闭 Flow Extension Bridge');

  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });

  // 5秒超时强制退出
  const forceTimer = setTimeout(() => {
    logger.warn('服务器关闭超时，强制退出');
    for (const socket of activeSockets) socket.destroy();
    process.exit(0);
  }, 30000);
  forceTimer.unref();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ==================== 异常处理 ====================
process.on('uncaughtException', (error) => {
  logger.error('未捕获异常:', error.message);
  // 不立即退出，让当前请求完成
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的 Promise 拒绝:', reason);
});
