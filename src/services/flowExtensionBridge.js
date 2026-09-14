/**
 * Flow Extension Bridge
 *
 * Provides WebSocket server bridge on `/internal/flow/ws` to interface with Chrome extensions.
 * Strictly checks FLOW_EXTENSION_TOKEN or restricts to loopback.
 * DOES NOT accept, print, or persist any Google bearer tokens or secrets.
 * Supports stable client_id, ping/pong, pending requests, duplicate deduplication, and orphan response handler.
 */

import { WebSocketServer } from 'ws';
import crypto from 'crypto';
import logger from '../utils/logger.js';
import { FlowClientPool } from './flowClientPool.js';

// Operation Allowlist
export const ALLOWED_OPERATIONS = new Set([
  'get_credits',
  'generate_image',
  'upload_image',
  'submit_video',
  'poll_video',
  'download_video',
  'download_image',
  'refresh_auth',
  'open_flow_tab',
  'get_status',
]);

export class FlowExtensionBridge {
  constructor(options = {}) {
    this.wss = null;
    this.clientPool = options.clientPool || new FlowClientPool();
    this.pending = new Map(); // reqId -> { resolve, reject, timeoutId, clientId, operation, meta, createdAt }
    this.reqMeta = new Map();  // reqId -> meta
    this.seenIds = new Map();  // reqId -> timestamp
    this.orphanHandler = null;

    this.token = options.token || process.env.FLOW_EXTENSION_TOKEN || '';
    this.defaultTimeoutMs = options.defaultTimeoutMs || 120000;
    this.maxSeenIds = options.maxSeenIds || 512;
    this.maxReqMeta = options.maxReqMeta || 128;
  }

  /**
   * Check if a remote IP address is a loopback address
   * @param {string} ip
   * @returns {boolean}
   */
  static isLoopback(ip) {
    if (!ip || typeof ip !== 'string') return false;
    const clean = ip.replace(/^.*:/, ''); // strip ::ffff: IPv4-mapped IPv6 prefix
    return clean === '127.0.0.1' || clean === 'localhost' || ip === '::1';
  }

  /**
   * Register orphan handler for late responses
   * @param {(data: object, meta: object) => Promise<void>|void} handler
   */
  setOrphanHandler(handler) {
    this.orphanHandler = handler;
  }

  /**
   * Initialize WebSocket server mounted on HTTP server
   * Path: /internal/flow/ws
   * Does not conflict with /ws/logs
   *
   * @param {import('http').Server} server
   */
  initialize(server) {
    if (!server) {
      throw new Error('HTTP server instance is required to initialize FlowExtensionBridge');
    }

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: 160 * 1024 * 1024, // 160 MiB to accommodate 100 MB binary in base64 + JSON envelope
    });

    server.on('upgrade', (req, socket, head) => {
      if (socket.destroyed) return;
      let pathname = '';
      let remoteIp = '';
      try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        pathname = url.pathname;
        remoteIp = req.socket.remoteAddress;
      } catch (_) {
        return;
      }

      if (pathname === '/internal/flow/ws') {
        // Security Check: Upgrade stage NEVER reads Authorization / X-Extension-Token.
        // If FLOW_EXTENSION_TOKEN is not configured, restrict upgrade strictly to loopback sockets.
        // If FLOW_EXTENSION_TOKEN is configured, allow upgrade from any IP, but first 'hello' MUST pass timingSafeEqual.
        const tokenConfigured = Boolean(this.token && this.token.trim());

        if (!tokenConfigured && !FlowExtensionBridge.isLoopback(remoteIp)) {
          logger.warn(`[FlowExtensionBridge] Non-loopback upgrade rejected when FLOW_EXTENSION_TOKEN is unset (${remoteIp})`);
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req);
        });
      }
    });

    this.wss.on('connection', (ws, req) => {
      this._handleConnection(ws, req);
    });

    logger.info('[FlowExtensionBridge] Initialized on /internal/flow/ws');
  }

  /**
   * Handle incoming WebSocket connection
   */
  _handleConnection(ws, req) {
    let clientId = null;
    let authenticated = false;

    // First message must be 'hello'
    const helloTimeout = setTimeout(() => {
      if (!authenticated) {
        logger.warn('[FlowExtensionBridge] Handshake timed out waiting for hello');
        ws.close(1008, 'Handshake timeout');
      }
    }, 10000);

    ws.on('message', (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString('utf8'));
      } catch (err) {
        logger.warn('[FlowExtensionBridge] Invalid JSON received from client');
        return;
      }

      if (!authenticated) {
        if (data.type === 'hello') {
          clearTimeout(helloTimeout);
          const tokenConfigured = Boolean(this.token && this.token.trim());
          if (tokenConfigured) {
            const expectedBuffer = Buffer.from(this.token);
            const providedBuffer = Buffer.from(typeof data.token === 'string' ? data.token : '');
            const isTokenMatch = expectedBuffer.length === providedBuffer.length &&
              crypto.timingSafeEqual(expectedBuffer, providedBuffer);

            if (!isTokenMatch) {
              logger.warn('[FlowExtensionBridge] Hello token mismatch');
              ws.close(1008, 'Authentication failed');
              return;
            }
          }

          const rawClientId = data.clientId || data.client_id;
          if (!rawClientId || typeof rawClientId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(rawClientId.trim())) {
            logger.warn('[FlowExtensionBridge] Hello message rejected: invalid clientId');
            ws.close(1008, 'Invalid clientId format');
            return;
          }
          clientId = rawClientId.trim();
          authenticated = true;

          // If a client with the same clientId already exists:
          // Check if old connection is actively busy with activeRequests > 0 or has pending requests
          const existingClient = this.clientPool.getClient(clientId);
          if (existingClient && existingClient.ws && existingClient.ws !== ws) {
            let hasActivePending = (existingClient.activeRequests || 0) > 0;
            if (!hasActivePending) {
              for (const p of this.pending.values()) {
                if (p.clientId === clientId) {
                  hasActivePending = true;
                  break;
                }
              }
            }

            if (hasActivePending) {
              logger.warn(`[FlowExtensionBridge] Duplicate connection for '${clientId}' rejected (old connection has active/pending requests)`);
              ws.close(1008, 'Client ID already connected with active requests');
              return;
            }

            // Old connection is idle, safely replace it
            try {
              existingClient.ws.close(1000, 'Replaced by new connection');
            } catch (_) {}
          }

          // Extract non-secret status fields only (strictly whitelist UUID and sanitize accountLabel)
          const rawProfileUuid = typeof (data.profileUuid || data.profile_uuid) === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((data.profileUuid || data.profile_uuid).trim())
            ? (data.profileUuid || data.profile_uuid).trim().toLowerCase()
            : null;

          const rawAccountLabel = typeof (data.accountLabel || data.account_label) === 'string'
            ? (data.accountLabel || data.account_label).trim().slice(0, 64)
            : null;

          const activeProjectCount = typeof (data.activeProjectCount ?? data.active_project_count) === 'number'
            ? Math.max(0, (data.activeProjectCount ?? data.active_project_count))
            : undefined;

          const initialInfo = {
            state: data.state || 'idle',
            tier: data.tier || data.sku || 'G1_FREEMIUM',
            credits: typeof data.credits === 'number' ? data.credits : undefined,
            projectId: (typeof (data.projectId || data.project_id) === 'string' && (data.projectId || data.project_id).trim())
              ? (data.projectId || data.project_id).trim()
              : null,
            capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
            tokenPresent: Boolean(data.tokenPresent ?? data.token_present ?? data.flowKeyPresent),
            apiKeyPresent: (data.apiKeyPresent !== undefined || data.api_key_present !== undefined)
              ? Boolean(data.apiKeyPresent ?? data.api_key_present)
              : undefined,
            tokenAgeMs: typeof (data.tokenAgeMs ?? data.token_age_ms ?? data.tokenAge) === 'number'
              ? (data.tokenAgeMs ?? data.token_age_ms ?? data.tokenAge)
              : null,
            profileUuid: rawProfileUuid,
            accountLabel: rawAccountLabel,
            activeProjectCount,
          };

          this.clientPool.upsertClient(clientId, ws, initialInfo);
          logger.info(`[FlowExtensionBridge] Client registered: ${clientId} (tokenPresent=${initialInfo.tokenPresent})`);

          ws.send(JSON.stringify({
            type: 'hello_ack',
            clientId,
            status: 'ok',
            protocolVersion: 1,
          }));
          return;
        } else {
          logger.warn('[FlowExtensionBridge] First message was not hello');
          ws.close(1008, 'First message must be hello');
          return;
        }
      }

      // Handle normal authenticated messages
      this._handleClientMessage(clientId, data, ws);
    });

    ws.on('close', () => {
      clearTimeout(helloTimeout);
      if (clientId) {
        // Only remove from clientPool if the current client's WebSocket is this ws
        const currentClient = this.clientPool.getClient(clientId);
        if (currentClient && currentClient.ws === ws) {
          this.clientPool.removeClient(clientId);
          logger.info(`[FlowExtensionBridge] Client disconnected: ${clientId}`);
        }
        // Reject all pending requests belonging to this disconnected clientId
        for (const [reqId, pending] of this.pending.entries()) {
          if (pending.clientId === clientId) {
            clearTimeout(pending.timeoutId);
            this.pending.delete(reqId);
            this.clientPool.decrementActiveRequests(clientId);
            const err = new Error(`Extension client '${clientId}' disconnected while request '${pending.operation}' was pending`);
            err.code = 'CLIENT_DISCONNECTED';
            err.clientId = clientId;
            err.reqId = reqId;
            err.dispatched = Boolean(pending.dispatched);
            pending.reject(err);
          }
        }
      }
    });

    ws.on('error', (err) => {
      logger.warn(`[FlowExtensionBridge] Client socket error (${clientId}): ${err.message}`);
    });
  }

  /**
   * Handle messages from authenticated clients
   */
  _handleClientMessage(clientId, data, ws) {
    const msgType = data.type || data.method;

    if (msgType === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong' }));
      } catch (_) {}
      return;
    }

    if (msgType === 'pong') {
      return;
    }

    if (msgType === 'status_update') {
      const rawProjectId = typeof (data.projectId || data.project_id) === 'string'
        ? (data.projectId || data.project_id).trim()
        : null;

      const rawProfileUuid = typeof (data.profileUuid || data.profile_uuid) === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((data.profileUuid || data.profile_uuid).trim())
        ? (data.profileUuid || data.profile_uuid).trim().toLowerCase()
        : undefined;

      const rawAccountLabel = typeof (data.accountLabel || data.account_label) === 'string'
        ? (data.accountLabel || data.account_label).trim().slice(0, 64)
        : undefined;

      const activeProjectCount = typeof (data.activeProjectCount ?? data.active_project_count) === 'number'
        ? Math.max(0, (data.activeProjectCount ?? data.active_project_count))
        : undefined;

      this.clientPool.updateClient(clientId, {
        state: typeof data.state === 'string' ? data.state : undefined,
        tier: typeof data.tier === 'string' ? data.tier : undefined,
        credits: typeof data.credits === 'number' ? data.credits : undefined,
        projectId: rawProjectId || undefined,
        capabilities: Array.isArray(data.capabilities) ? data.capabilities : undefined,
        tokenPresent: (data.tokenPresent !== undefined || data.token_present !== undefined)
          ? Boolean(data.tokenPresent ?? data.token_present)
          : undefined,
        apiKeyPresent: (data.apiKeyPresent !== undefined || data.api_key_present !== undefined)
          ? Boolean(data.apiKeyPresent ?? data.api_key_present)
          : undefined,
        tokenAgeMs: typeof (data.tokenAgeMs ?? data.token_age_ms) === 'number'
          ? (data.tokenAgeMs ?? data.token_age_ms)
          : undefined,
        profileUuid: rawProfileUuid,
        accountLabel: rawAccountLabel,
        activeProjectCount,
      });
      return;
    }

    // Handle request response
    const reqId = data.id || data.requestId || data.req_id;
    if (reqId) {
      this._routeResponse(reqId, data);
    }
  }

  /**
   * Route response back to waiting request or orphan handler with deduplication
   */
  _routeResponse(reqId, data) {
    if (!reqId) return;

    // Check if already seen (duplicate from retrying client)
    if (this.seenIds.has(reqId)) {
      return;
    }

    const pending = this.pending.get(reqId);
    if (pending) {
      this._markSeen(reqId);
      clearTimeout(pending.timeoutId);
      this.pending.delete(reqId);
      this.reqMeta.delete(reqId);

      // Decrement active requests
      if (pending.clientId) {
        this.clientPool.decrementActiveRequests(pending.clientId);
        this.clientPool.updateClient(pending.clientId, { state: 'idle' });
        if (!data.error && (!data.status || data.status === 200)) {
          this.clientPool.recordSuccess(pending.clientId);
        }
      }

      pending.resolve(data);
      return;
    }

    // No pending future found — caller already timed out
    this._markSeen(reqId);
    const meta = this.reqMeta.get(reqId);
    this.reqMeta.delete(reqId);

    if (this.orphanHandler) {
      try {
        const result = this.orphanHandler(data, meta || {});
        if (result && typeof result.then === 'function') {
          result.catch(err => {
            logger.warn(`[FlowExtensionBridge] Orphan handler error: ${err.message}`);
          });
        }
      } catch (err) {
        logger.warn(`[FlowExtensionBridge] Orphan handler threw: ${err.message}`);
      }
    }
  }

  _markSeen(reqId) {
    this.seenIds.set(reqId, Date.now());
    if (this.seenIds.size > this.maxSeenIds) {
      const oldest = this.seenIds.keys().next().value;
      this.seenIds.delete(oldest);
    }
  }

  _rememberMeta(reqId, meta) {
    if (!meta) return;
    this.reqMeta.set(reqId, meta);
    if (this.reqMeta.size > this.maxReqMeta) {
      const oldest = this.reqMeta.keys().next().value;
      this.reqMeta.delete(oldest);
    }
  }

  /**
   * Execute an operation via Chrome extension bridge
   *
   * @param {string} operation - Allowlisted operation name
   * @param {object} payload - Structured payload for the operation
   * @param {object} [options]
   * @param {string} [options.clientId]
   * @param {number} [options.timeout]
   * @param {object} [options.meta]
   * @returns {Promise<object>}
   */
  async request(operation, payload = {}, options = {}) {
    if (!ALLOWED_OPERATIONS.has(operation)) {
      const err = new Error(`Operation '${operation}' is not in allowlist`);
      err.code = 'OPERATION_NOT_ALLOWED';
      throw err;
    }

    const { clientId: preferredClientId, timeout, meta } = options;
    const strictPreferred = Boolean(preferredClientId);
    const targetClientId = this.clientPool.selectClient({
      preferredClientId,
      strictPreferred,
      cost: meta?.cost,
    });

    if (!targetClientId) {
      if (preferredClientId) {
        const err = new Error(`Extension client '${preferredClientId}' is not connected or not available`);
        err.code = 'CLIENT_DISCONNECTED';
        throw err;
      }
      const err = new Error('No available connected extension clients');
      err.code = 'NO_EXTENSION_CLIENTS';
      throw err;
    }

    const client = this.clientPool.getClient(targetClientId);
    if (!client || !client.ws || client.ws.readyState !== 1) {
      const err = new Error(`Extension client '${targetClientId}' is not connected`);
      err.code = 'CLIENT_DISCONNECTED';
      throw err;
    }

    const reqId = crypto.randomUUID();
    const timeoutMs = timeout || this.defaultTimeoutMs;

    this._rememberMeta(reqId, {
      operation,
      clientId: targetClientId,
      ...(meta || {}),
    });

    return new Promise((resolve, reject) => {
      let timeoutId = null;

      const pendingEntry = {
        resolve,
        reject,
        timeoutId: null,
        clientId: targetClientId,
        operation,
        meta,
        createdAt: Date.now(),
        dispatched: false,
      };

      timeoutId = setTimeout(() => {
        this.pending.delete(reqId);
        this.clientPool.decrementActiveRequests(targetClientId);
        this.clientPool.updateClient(targetClientId, { state: 'idle' });
        const err = new Error(`Extension request timeout (${operation}, ${timeoutMs}ms)`);
        err.code = 'TIMEOUT';
        err.clientId = targetClientId;
        err.reqId = reqId;
        err.dispatched = Boolean(pendingEntry.dispatched);
        reject(err);
      }, timeoutMs);

      pendingEntry.timeoutId = timeoutId;
      this.pending.set(reqId, pendingEntry);

      this.clientPool.incrementActiveRequests(targetClientId);
      this.clientPool.updateClient(targetClientId, { state: 'running' });

      const msg = {
        id: reqId,
        type: 'operation_request',
        operation,
        protocolVersion: 1,
        payload,
        meta: meta || undefined,
      };

      try {
        pendingEntry.dispatched = true;
        client.ws.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timeoutId);
        this.pending.delete(reqId);
        this.clientPool.decrementActiveRequests(targetClientId);
        this.clientPool.updateClient(targetClientId, { state: 'idle' });
        err.dispatched = false;
        reject(err);
      }
    });
  }

  /**
   * Get status summary of bridge and connected clients (sanitized)
   */
  getStatus() {
    const clients = this.clientPool.listClients();
    return {
      connected: clients.some(c => c.connected),
      clientCount: clients.length,
      activeClients: clients.filter(c => c.connected).length,
      clients,
    };
  }

  /**
   * List all clients metadata
   */
  listClients() {
    return this.clientPool.listClients();
  }

  /**
   * Close bridge and disconnect all sockets
   */
  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      if (pending.clientId) {
        this.clientPool.decrementActiveRequests(pending.clientId);
      }
      const err = new Error('Bridge closed');
      err.code = 'BRIDGE_CLOSED';
      err.dispatched = Boolean(pending.dispatched);
      pending.reject(err);
    }
    this.pending.clear();
    this.seenIds.clear();
    this.reqMeta.clear();

    if (this.wss) {
      for (const client of this.wss.clients) {
        try {
          client.close(1001, 'Server shutting down');
        } catch (_) {}
      }
      this.wss.close();
      this.wss = null;
    }
    this.clientPool.clear();
  }
}

export const flowExtensionBridge = new FlowExtensionBridge();
export default flowExtensionBridge;
