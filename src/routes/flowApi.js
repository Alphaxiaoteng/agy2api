/**
 * Google Flow Unified REST API Router
 * 挂载于 /v1/flow
 * 
 * 包含端点：
 * - GET  /v1/flow/models
 * - GET  /v1/flow/capabilities
 * - GET  /v1/flow/queue/status
 * - POST /v1/flow/images/generations
 * - POST /v1/flow/videos/generations
 * - GET  /v1/flow/jobs/:jobId
 * - GET  /v1/flow/files/:mediaId
 */

import express from 'express';
import fs from 'fs';
import { listModels, getCapabilities, validateParams } from '../config/flowCapabilities.js';
import { defaultFlowStorage } from '../utils/flowStorage.js';
import { FlowQueue } from '../services/flowQueue.js';
import { runFlowApiWorker } from '../services/flowApiWorker.js';
import { flowExtensionBridge } from '../services/flowExtensionBridge.js';
import { flowApiProvider } from '../services/flowApiProvider.js';
import { alphaNexusFlowBridge } from '../services/alphaNexusFlowBridge.js';

export const flowQueue = new FlowQueue({
  concurrency: 1,
  maxQueue: 10,
  storage: defaultFlowStorage,
  workerRunner: runFlowApiWorker
});

export const flowApiRouter = express.Router();

/**
 * 格式化输出 manifest 为 API 规范响应
 */
function formatJobResponse(manifest, req) {
  const host = req.get('host') || '127.0.0.1:8045';
  const protocol = req.protocol || 'http';
  const baseUrl = `${protocol}://${host}`;

  const data = (manifest.outputs || []).map(out => ({
    media_id: out.mediaId,
    url: `${baseUrl}/v1/flow/files/${out.mediaId}`,
    mime_type: out.mimeType || (out.filename?.endsWith('.mp4') ? 'video/mp4' : 'image/png'),
    filename: out.filename,
    size_bytes: out.sizeBytes || null
  }));

  return {
    job_id: manifest.jobId,
    status: manifest.status,
    type: manifest.type,
    model: manifest.params?.model || manifest.model,
    created_at: manifest.createdAt,
    completed_at: manifest.completedAt || null,
    data,
    params: manifest.params || null,
    error: manifest.error || null
  };
}

// 1. GET /models
flowApiRouter.get('/models', (req, res) => {
  res.json({
    object: 'list',
    data: listModels()
  });
});

// 2. GET /capabilities
flowApiRouter.get('/capabilities', (req, res) => {
  res.json({
    object: 'capabilities',
    ...getCapabilities()
  });
});

// 3. GET /queue/status
flowApiRouter.get('/queue/status', (req, res) => {
  res.json({
    object: 'queue_status',
    ...flowQueue.getQueueStatus()
  });
});

// GET /status (Bridge and Queue runtime status)
flowApiRouter.get('/status', (req, res) => {
  res.json({
    object: 'status',
    bridge: flowExtensionBridge.getStatus(),
    queue: flowQueue.getQueueStatus(),
  });
});

// GET /clients (Connected extension clients summary)
flowApiRouter.get('/clients', (req, res) => {
  res.json({
    object: 'list',
    data: flowExtensionBridge.listClients(),
  });
});

// GET /credits (Aggregated/active client credits)
flowApiRouter.get('/credits', async (req, res) => {
  try {
    const clients = flowExtensionBridge.listClients().filter(c => c.connected && c.tokenPresent);
    if (clients.length === 0) {
      return res.status(503).json({
        error: {
          message: 'No active connected extension clients available',
          type: 'NO_EXTENSION_CLIENTS',
          code: 503,
        }
      });
    }

    const clientId = req.query.client_id || req.query.clientId || undefined;
    const creditsInfo = await flowApiProvider.getCredits({ clientId });
    res.json({
      object: 'credits',
      credits: creditsInfo.credits,
      tier: creditsInfo.tier,
    });
  } catch (err) {
    const status = err.status || (err.code === 'NO_EXTENSION_CLIENTS' ? 503 : 500);
    res.status(status).json({
      error: {
        message: err.message,
        type: err.code || 'credits_error',
        code: status,
      }
    });
  }
});

flowApiRouter.get('/accounts', async (req, res) => {
  try {
    const configured = alphaNexusFlowBridge.isConfigured();
    if (configured) {
      const accounts = await alphaNexusFlowBridge.listFlowAccounts();
      return res.json({ object: 'list', configured, data: accounts });
    }

    // Return connected extension clients as accounts data
    const clients = flowExtensionBridge.listClients();
    res.json({
      object: 'list',
      configured: false,
      data: clients.map(c => ({
        account_id: c.clientId,
        client_id: c.clientId,
        account_label: c.accountLabel || null,
        profile_hint: c.profileHint || null,
        connected: c.connected,
        credits: c.credits,
        available_credits: c.availableCredits,
        reserved_credits: c.reservedCredits,
        tier: c.tier,
        token_present: c.tokenPresent,
        api_key_present: c.apiKeyPresent,
        active_project_count: c.activeProjectCount,
        project_id_present: c.projectIdPresent,
        project_hint: c.projectHint || null,
        last_seen_at: c.lastSeenAt,
      })),
    });
  } catch (err) {
    res.status(err.status || 502).json({
      error: { message: err.message, type: err.code || 'alpha_nexus_bridge_error', code: err.status || 502 }
    });
  }
});

// POST /accounts/verify (Verify credentials/status of a specific or all accounts)
flowApiRouter.post('/accounts/verify', async (req, res) => {
  try {
    const { client_id: reqClientId, account_label: reqLabel } = req.body || {};
    const pool = flowExtensionBridge.clientPool;

    if (!pool || pool.clients.size === 0) {
      return res.status(503).json({
        error: {
          message: 'No connected extension clients available to verify',
          type: 'NO_EXTENSION_CLIENTS',
          code: 503,
        }
      });
    }

    let targetClient = null;
    if (reqClientId) {
      targetClient = pool.getClient(reqClientId);
      if (!targetClient) {
        return res.status(404).json({
          error: {
            message: `Client '${reqClientId}' not found or not connected`,
            type: 'CLIENT_NOT_FOUND',
            code: 404,
          }
        });
      }
    } else if (reqLabel) {
      const { match, duplicate } = pool.findClientByLabel(reqLabel);
      if (duplicate) {
        return res.status(409).json({
          error: {
            message: `Multiple connected clients share the account label '${reqLabel}'. Please disambiguate by client_id.`,
            type: 'DUPLICATE_ACCOUNT_LABEL',
            code: 409,
          }
        });
      }
      if (!match) {
        return res.status(404).json({
          error: {
            message: `Client with label '${reqLabel}' not found or not connected`,
            type: 'CLIENT_NOT_FOUND',
            code: 404,
          }
        });
      }
      targetClient = match;
    }

    const clientsToVerify = targetClient ? [targetClient] : Array.from(pool.clients.values());
    const results = [];

    for (const client of clientsToVerify) {
      const isConnected = Boolean(client.ws && client.ws.readyState === 1);
      const authOk = Boolean(client.tokenPresent && client.apiKeyPresent !== false);
      const isHealthy = authOk && isConnected;
      const statusReason = !isConnected
        ? 'DISCONNECTED'
        : !client.tokenPresent
          ? 'MISSING_BEARER_TOKEN'
          : client.apiKeyPresent === false
            ? 'MISSING_API_KEY'
            : 'OK';

      results.push({
        clientId: client.clientId || client.id,
        accountLabel: client.accountLabel || null,
        profileHint: client.profileHint || null,
        status: isHealthy ? 'healthy' : 'degraded',
        reason: statusReason,
        authenticated: authOk,
        credits: client.credits ?? null,
        availableCredits: (typeof client.credits === 'number')
          ? Math.max(0, client.credits - (client.reservedCredits || 0))
          : null,
        reservedCredits: client.reservedCredits || 0,
        activeProjectCount: client.activeProjectCount || 0,
        currentProjectId: client.projectId || null,
      });
    }

    res.json({
      object: 'verification_results',
      total: results.length,
      healthy: results.filter(r => r.status === 'healthy').length,
      data: results,
    });
  } catch (err) {
    res.status(500).json({
      error: {
        message: err.message || 'Verification failed',
        type: 'VERIFICATION_ERROR',
        code: 500,
      }
    });
  }
});

async function attachAccountSpace(validated) {
  const configured = alphaNexusFlowBridge.isConfigured();
  if (!configured) {
    if (validated.accountId) {
      const err = new Error('account_id requires ALPHA_NEXUS_TRANSPORT_TOKEN configuration');
      err.status = 400;
      err.code = 'alpha_nexus_not_configured';
      throw err;
    }
    return validated;
  }
  if (!validated.accountId) {
    const err = new Error('account_id is required when Alpha Nexus Flow bridge is configured');
    err.status = 400;
    err.code = 'account_id_required';
    throw err;
  }
  const space = await alphaNexusFlowBridge.ensureAccountSpace(validated.accountId);
  return {
    ...validated,
    accountId: space.accountId,
    identityId: space.identityId,
    spaceId: space.spaceId,
    taskId: space.taskId
  };
}

// Preflight extension connection availability check
function preflightExtensionCheck(validated) {
  if (alphaNexusFlowBridge.isConfigured() && validated.accountId) {
    return;
  }
  const clientPool = flowExtensionBridge.clientPool;
  const connectedCount = clientPool ? (clientPool.clients?.size || clientPool.size || 0) : 0;
  if (connectedCount === 0) {
    const preferred = validated.clientId || validated.preferredClientId;
    const err = new Error(preferred
      ? `Extension client '${preferred}' is offline`
      : 'No connected extension clients available (extension offline)');
    err.status = 503;
    err.code = 'NO_EXTENSION_CLIENTS';
    throw err;
  }
}

// 4. POST /images/generations (异步优先或同步图像生成)
flowApiRouter.post('/images/generations', async (req, res) => {
  try {
    const validated = await attachAccountSpace(validateParams('image', req.body));
    preflightExtensionCheck(validated);
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotency_key || null;
    const wait = req.query.wait === 'true' || req.body.wait === true;
    const host = req.get('host') || '127.0.0.1:8045';
    const protocol = req.protocol || 'http';
    const baseUrl = `${protocol}://${host}`;

    if (!wait) {
      // 默认异步模式：快速入队返回 202
      const enqueued = await flowQueue.enqueueJob({
        type: 'image',
        params: validated,
        idempotencyKey,
        baseUrl
      });

      if (enqueued.isIdempotentReplay && enqueued.status === 'completed') {
        return res.json(formatJobResponse(enqueued.manifest, req));
      }

      return res.status(202).json({
        job_id: enqueued.jobId,
        status: enqueued.status,
        created_at: enqueued.createdAt,
        poll_url: `${baseUrl}/v1/flow/jobs/${enqueued.jobId}`
      });
    }

    // wait=true 同步兼容模式
    const abortCtrl = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) {
        abortCtrl.abort();
      }
    });

    const result = await flowQueue.submitJob({
      type: 'image',
      params: validated,
      idempotencyKey,
      signal: abortCtrl.signal,
      baseUrl
    });

    const responsePayload = formatJobResponse(result.manifest, req);
    res.json(responsePayload);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: {
        message: err.message || 'Internal server error',
        type: err.code || 'api_error',
        code: status
      }
    });
  }
});

// 5. POST /videos/generations (异步优先或同步视频生成)
flowApiRouter.post('/videos/generations', async (req, res) => {
  try {
    const validated = await attachAccountSpace(validateParams('video', req.body));
    preflightExtensionCheck(validated);
    const idempotencyKey = req.headers['idempotency-key'] || req.body.idempotency_key || null;
    const wait = req.query.wait === 'true' || req.body.wait === true;
    const host = req.get('host') || '127.0.0.1:8045';
    const protocol = req.protocol || 'http';
    const baseUrl = `${protocol}://${host}`;

    if (!wait) {
      // 默认异步模式：快速入队返回 202
      const enqueued = await flowQueue.enqueueJob({
        type: 'video',
        params: validated,
        idempotencyKey,
        baseUrl
      });

      if (enqueued.isIdempotentReplay && enqueued.status === 'completed') {
        return res.json(formatJobResponse(enqueued.manifest, req));
      }

      return res.status(202).json({
        job_id: enqueued.jobId,
        status: enqueued.status,
        created_at: enqueued.createdAt,
        poll_url: `${baseUrl}/v1/flow/jobs/${enqueued.jobId}`
      });
    }

    const abortCtrl = new AbortController();
    req.on('close', () => {
      if (!res.writableEnded) {
        abortCtrl.abort();
      }
    });

    const result = await flowQueue.submitJob({
      type: 'video',
      params: validated,
      idempotencyKey,
      signal: abortCtrl.signal,
      baseUrl
    });

    const responsePayload = formatJobResponse(result.manifest, req);
    res.json(responsePayload);
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: {
        message: err.message || 'Internal server error',
        type: err.code || 'api_error',
        code: status
      }
    });
  }
});

// 5.1 POST /uploads (安全上传图片，返回 opaque media_id)
flowApiRouter.post('/uploads', async (req, res) => {
  try {
    const { image, data, image_base64, mime_type = 'image/png' } = req.body || {};
    const rawData = image || data || image_base64;
    if (!rawData || typeof rawData !== 'string') {
      return res.status(400).json({
        error: {
          message: 'Image data is required in base64 format (fields: image, data, or image_base64)',
          type: 'invalid_request_error',
          code: 400
        }
      });
    }

    const base64Clean = rawData.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
    const buffer = Buffer.from(base64Clean, 'base64');
    if (buffer.length === 0) {
      return res.status(400).json({
        error: {
          message: 'Invalid base64 payload',
          type: 'invalid_request_error',
          code: 400
        }
      });
    }

    if (buffer.length > 10 * 1024 * 1024) {
      return res.status(413).json({
        error: {
          message: 'Image payload exceeds 10MB limit',
          type: 'payload_too_large',
          code: 413
        }
      });
    }

    const saved = defaultFlowStorage.saveUploadedImage(buffer, mime_type);
    const host = req.get('host') || '127.0.0.1:8045';
    const protocol = req.protocol || 'http';
    const baseUrl = `${protocol}://${host}`;

    res.status(201).json({
      media_id: saved.mediaId,
      url: `${baseUrl}/v1/flow/files/${saved.mediaId}`,
      filename: saved.filename,
      mime_type: saved.mimeType,
      size_bytes: saved.sizeBytes
    });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({
      error: {
        message: err.message || 'Image upload failed',
        type: err.code || 'upload_error',
        code: status
      }
    });
  }
});

// 6. GET /jobs/:jobId (查询任务状态与结果)
flowApiRouter.get('/jobs/:jobId', (req, res) => {
  const { jobId } = req.params;
  if (!jobId || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    return res.status(400).json({
      error: {
        message: 'Invalid jobId format',
        type: 'invalid_request_error',
        code: 400
      }
    });
  }

  const manifest = defaultFlowStorage.readManifest(jobId);
  if (!manifest) {
    return res.status(404).json({
      error: {
        message: `Job '${jobId}' not found`,
        type: 'not_found',
        code: 404
      }
    });
  }

  res.json(formatJobResponse(manifest, req));
});

// 7. GET /files/:mediaId (安全流式下载/展示媒体文件)
flowApiRouter.get('/files/:mediaId', (req, res) => {
  const { mediaId } = req.params;
  const media = defaultFlowStorage.resolveMedia(mediaId);

  if (!media) {
    return res.status(404).json({
      error: {
        message: `Media '${mediaId}' not found or has been deleted`,
        type: 'not_found',
        code: 404
      }
    });
  }

  // 严格设置安全头部防止 MIME 混淆与 XSS
  res.setHeader('Content-Type', media.mimeType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const safeFilename = encodeURIComponent(media.filename || 'media-output');
  res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"; filename*=UTF-8''${safeFilename}`);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  
  const stream = fs.createReadStream(media.absolutePath);
  stream.on('error', (err) => {
    console.error(`[FlowApi] File stream error for ${mediaId}:`, err);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: 'Error streaming media file',
          type: 'api_error',
          code: 500
        }
      });
    }
  });
  stream.pipe(res);
});
