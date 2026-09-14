/**
 * Flow Client Pool
 *
 * Manages client metadata, health state, tier, credits, reservations, and selection strategies.
 * NEVER stores, prints, or exposes auth tokens or secrets.
 */

import crypto from 'crypto';

export class FlowClientPool {
  constructor() {
    this.clients = new Map(); // clientId -> { ws, state, tier, credits, projectId, capabilities, tokenPresent, tokenAgeMs, lastSeenAt, profileUuid, profileHint, accountLabel, activeProjectCount, reservedCredits }
    this.reservations = new Map(); // reservationId -> { clientId, cost, createdAt }
  }

  /**
   * Helper to compute short profileHint (first 8 chars of sha256 or truncated uuid)
   */
  static getProfileHint(profileUuid) {
    if (!profileUuid || typeof profileUuid !== 'string') return null;
    const clean = profileUuid.trim().toLowerCase();
    if (!clean) return null;
    return crypto.createHash('sha256').update(clean).digest('hex').slice(0, 8);
  }

  /**
   * Register or update client
   */
  upsertClient(clientId, ws, initialInfo = {}) {
    const existing = this.clients.get(clientId) || {};
    const rawProfileUuid = typeof initialInfo.profileUuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(initialInfo.profileUuid.trim())
      ? initialInfo.profileUuid.trim().toLowerCase()
      : (existing.profileUuid || null);

    const accountLabel = typeof initialInfo.accountLabel === 'string'
      ? initialInfo.accountLabel.trim().slice(0, 64)
      : (existing.accountLabel || null);

    const activeProjectCount = typeof initialInfo.activeProjectCount === 'number'
      ? Math.max(0, initialInfo.activeProjectCount)
      : (existing.activeProjectCount !== undefined ? existing.activeProjectCount : (initialInfo.projectId ? 1 : 0));

    const updated = {
      ...existing,
      clientId,
      ws,
      state: initialInfo.state || existing.state || 'idle',
      tier: initialInfo.tier || existing.tier || 'G1_FREEMIUM',
      credits: initialInfo.credits !== undefined ? initialInfo.credits : existing.credits,
      projectId: initialInfo.projectId !== undefined ? initialInfo.projectId : (existing.projectId || null),
      capabilities: Array.isArray(initialInfo.capabilities) ? initialInfo.capabilities : (existing.capabilities || []),
      tokenPresent: Boolean(initialInfo.tokenPresent ?? existing.tokenPresent),
      apiKeyPresent: Boolean(initialInfo.apiKeyPresent ?? existing.apiKeyPresent ?? true),
      tokenAgeMs: initialInfo.tokenAgeMs !== undefined ? initialInfo.tokenAgeMs : (existing.tokenAgeMs ?? null),
      profileUuid: rawProfileUuid,
      profileHint: FlowClientPool.getProfileHint(rawProfileUuid),
      accountLabel,
      activeProjectCount,
      reservedCredits: existing.reservedCredits || 0,
      activeRequests: existing.activeRequests || 0,
      lastSuccessAt: existing.lastSuccessAt || null,
      lastSeenAt: Date.now(),
    };
    this.clients.set(clientId, updated);
    return updated;
  }

  /**
   * Update client status fields
   */
  updateClient(clientId, fields = {}) {
    const client = this.clients.get(clientId);
    if (!client) return null;

    if (fields.state !== undefined) client.state = fields.state;
    if (fields.tier !== undefined) client.tier = fields.tier;
    if (fields.credits !== undefined) {
      client.credits = fields.credits;
    }
    if (fields.projectId !== undefined) client.projectId = fields.projectId;
    if (fields.capabilities !== undefined) client.capabilities = fields.capabilities;
    if (fields.tokenPresent !== undefined) client.tokenPresent = fields.tokenPresent;
    if (fields.apiKeyPresent !== undefined) client.apiKeyPresent = fields.apiKeyPresent;
    if (fields.tokenAgeMs !== undefined) client.tokenAgeMs = fields.tokenAgeMs;
    if (fields.activeRequests !== undefined) client.activeRequests = fields.activeRequests;
    if (fields.lastSuccessAt !== undefined) client.lastSuccessAt = fields.lastSuccessAt;

    if (fields.profileUuid !== undefined && typeof fields.profileUuid === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fields.profileUuid.trim())) {
      client.profileUuid = fields.profileUuid.trim().toLowerCase();
      client.profileHint = FlowClientPool.getProfileHint(client.profileUuid);
    }
    if (fields.accountLabel !== undefined) {
      client.accountLabel = typeof fields.accountLabel === 'string' ? fields.accountLabel.trim().slice(0, 64) : null;
    }
    if (fields.activeProjectCount !== undefined && typeof fields.activeProjectCount === 'number') {
      client.activeProjectCount = Math.max(0, fields.activeProjectCount);
    }

    client.lastSeenAt = Date.now();
    return client;
  }

  /**
   * Atomically reserve credits on a client
   * @param {string} clientId
   * @param {number} cost
   * @returns {string|null} reservationId or null if insufficient credits
   */
  reserveCredits(clientId, cost = 0) {
    const client = this.clients.get(clientId);
    if (!client) return null;

    const safeCost = Math.max(0, Number(cost) || 0);
    const currentCredits = typeof client.credits === 'number' ? client.credits : null;
    const reserved = client.reservedCredits || 0;

    if (safeCost > 0 && currentCredits !== null) {
      const available = currentCredits - reserved;
      if (available < safeCost) {
        return null;
      }
    }

    client.reservedCredits = reserved + safeCost;
    const reservationId = `res_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    this.reservations.set(reservationId, {
      clientId,
      cost: safeCost,
      createdAt: Date.now(),
    });
    return reservationId;
  }

  /**
   * Release or reconcile credits reservation
   * Accepts either reservationId (string) or (clientId, cost) for direct release
   * @param {string} reservationIdOrClientId
   * @param {number} [costOrReconcileActualCredits]
   */
  releaseReservation(reservationIdOrClientId, costOrReconcileActualCredits) {
    if (!reservationIdOrClientId) return false;

    // Check if it's a known reservationId
    const res = this.reservations.get(reservationIdOrClientId);
    if (res) {
      this.reservations.delete(reservationIdOrClientId);
      const client = this.clients.get(res.clientId);
      if (client) {
        client.reservedCredits = Math.max(0, (client.reservedCredits || 0) - res.cost);
        if (typeof costOrReconcileActualCredits === 'number') {
          client.credits = costOrReconcileActualCredits;
        }
      }
      return true;
    }

    // Direct release by (clientId, cost)
    const client = this.clients.get(reservationIdOrClientId);
    if (client) {
      const costToRelease = Math.max(0, Number(costOrReconcileActualCredits) || 0);
      client.reservedCredits = Math.max(0, (client.reservedCredits || 0) - costToRelease);
      return true;
    }

    return false;
  }

  /**
   * Increment active requests counter for client
   */
  incrementActiveRequests(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      client.activeRequests = (client.activeRequests || 0) + 1;
    }
  }

  /**
   * Decrement active requests counter for client (never below 0)
   */
  decrementActiveRequests(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      client.activeRequests = Math.max(0, (client.activeRequests || 0) - 1);
    }
  }

  /**
   * Record successful operation on client
   */
  recordSuccess(clientId) {
    const client = this.clients.get(clientId);
    if (client) {
      client.lastSuccessAt = Date.now();
      client.lastSeenAt = Date.now();
    }
  }

  /**
   * Get raw projectId for internal backend routing
   * @param {string} clientId
   * @returns {string|null}
   */
  getClientProjectId(clientId) {
    const client = this.clients.get(clientId);
    return client?.projectId || null;
  }

  /**
   * Get client by id
   */
  getClient(clientId) {
    return this.clients.get(clientId) || null;
  }

  /**
   * Find client by accountLabel
   * @param {string} label
   * @returns {{ match: object|null, duplicate: boolean }}
   */
  findClientByLabel(label) {
    if (!label || typeof label !== 'string') return { match: null, duplicate: false };
    const target = label.trim().toLowerCase();
    const matches = [];
    for (const c of this.clients.values()) {
      if (c.accountLabel && c.accountLabel.trim().toLowerCase() === target) {
        matches.push(c);
      }
    }
    if (matches.length > 1) {
      return { match: null, duplicate: true };
    }
    return { match: matches[0] || null, duplicate: false };
  }

  /**
   * Remove client
   */
  removeClient(clientId) {
    return this.clients.delete(clientId);
  }

  /**
   * Remove client by WebSocket reference
   */
  removeByWs(ws) {
    for (const [clientId, info] of this.clients.entries()) {
      if (info.ws === ws) {
        this.clients.delete(clientId);
        return clientId;
      }
    }
    return null;
  }

  /**
   * Get client by WebSocket instance
   */
  getClientByWs(ws) {
    for (const info of this.clients.values()) {
      if (info.ws === ws) return info;
    }
    return null;
  }

  /**
   * Check if a client is considered free tier
   */
  isFreeTier(clientId) {
    const client = this.clients.get(clientId);
    if (!client) return true;
    return client.tier !== 'G1_TIER1';
  }

  /**
   * Select best client to handle a request
   * 
   * Strict Filtering:
   * - Must be connected (ws.readyState === 1)
   * - Must have tokenPresent === true
   * - Must have apiKeyPresent !== false
   * - If cost specified and credits known, available credits (credits - reservedCredits) must be >= cost
   * - If strictPreferred is true, returns preferredClientId if valid, otherwise null (never fallbacks)
   *
   * Deterministic Ranking:
   * 1. state === 'idle' (idle first, then busy)
   * 2. activeRequests (fewer active requests first)
   * 3. available credits adequacy / amount (sufficient credits with higher balance first)
   * 4. lastSuccessAt (most recently successful first)
   * 5. clientId string comparison (stable tie-breaker)
   *
   * @param {object} [options]
   * @param {string} [options.preferredClientId]
   * @param {boolean} [options.strictPreferred=false]
   * @param {boolean} [options.requireApiKey=true]
   * @param {number} [options.cost]
   * @param {string} [options.excludeClientId]
   * @returns {string|null}
   */
  selectClient(options = {}) {
    const { preferredClientId, preferredAccountLabel, strictPreferred = false, requireApiKey = true, cost, minCredits, excludeClientId } = options;
    const requiredCost = cost !== undefined ? cost : minCredits;

    // 1. If preferredAccountLabel is specified, try resolving client by label first
    let resolvedPreferredId = preferredClientId;
    if (!resolvedPreferredId && preferredAccountLabel) {
      const { match, duplicate } = this.findClientByLabel(preferredAccountLabel);
      if (duplicate && strictPreferred) {
        return null;
      }
      if (match) {
        resolvedPreferredId = match.clientId;
      } else if (strictPreferred) {
        return null;
      }
    }

    if (resolvedPreferredId && this.clients.has(resolvedPreferredId)) {
      const c = this.clients.get(resolvedPreferredId);
      const isConnected = Boolean(c.ws && c.ws.readyState === 1);
      const hasToken = Boolean(c.tokenPresent);
      const hasApiKey = requireApiKey ? Boolean(c.apiKeyPresent !== false) : true;
      const notExcluded = !excludeClientId || resolvedPreferredId !== excludeClientId;
      const reserved = c.reservedCredits || 0;
      const availableCredits = typeof c.credits === 'number' ? c.credits - reserved : null;
      const hasCredits = !requiredCost || availableCredits === null || availableCredits >= requiredCost;

      if (isConnected && hasToken && hasApiKey && notExcluded && hasCredits) {
        return resolvedPreferredId;
      }

      if (strictPreferred) {
        return null;
      }
    } else if (resolvedPreferredId && strictPreferred) {
      return null;
    }

    const available = [];
    for (const [cid, info] of this.clients.entries()) {
      if (excludeClientId && cid === excludeClientId) continue;
      // Only select connected clients with valid token and apiKey
      if (info.ws && info.ws.readyState === 1 && info.tokenPresent) {
        if (requireApiKey && info.apiKeyPresent === false) {
          continue;
        }
        const reserved = info.reservedCredits || 0;
        const availableCredits = typeof info.credits === 'number' ? info.credits - reserved : null;
        if (requiredCost && availableCredits !== null && availableCredits < requiredCost) {
          continue;
        }
        available.push(info);
      }
    }

    if (available.length === 0) {
      return null;
    }

    // Deterministic sorting comparator
    available.sort((a, b) => {
      // 1. Idle state first
      const aIdle = a.state === 'idle' ? 1 : 0;
      const bIdle = b.state === 'idle' ? 1 : 0;
      if (aIdle !== bIdle) return bIdle - aIdle;

      // 2. Active requests (fewer is better)
      const aActive = a.activeRequests || 0;
      const bActive = b.activeRequests || 0;
      if (aActive !== bActive) return aActive - bActive;

      // 3. Available Credits (higher is better; unknown credits treated as 0 for sorting)
      const aReserved = a.reservedCredits || 0;
      const bReserved = b.reservedCredits || 0;
      const aCredits = typeof a.credits === 'number' ? a.credits - aReserved : -1;
      const bCredits = typeof b.credits === 'number' ? b.credits - bReserved : -1;
      if (aCredits !== bCredits) return bCredits - aCredits;

      // 4. lastSuccessAt (most recent first)
      const aSuccess = a.lastSuccessAt || 0;
      const bSuccess = b.lastSuccessAt || 0;
      if (aSuccess !== bSuccess) return bSuccess - aSuccess;

      // 5. Stable tie-breaker: clientId alphanumeric
      return String(a.clientId).localeCompare(String(b.clientId));
    });

    return available[0].clientId;
  }

  /**
   * Return client status list (sanitized, hides raw project_id, profileUuid and secrets)
   */
  listClients() {
    const list = [];
    for (const info of this.clients.values()) {
      const rawPid = info.projectId || '';
      let projectHint = null;
      if (rawPid && typeof rawPid === 'string' && rawPid.trim()) {
        const trimmed = rawPid.trim();
        projectHint = trimmed.length > 8
          ? `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`
          : `${trimmed.slice(0, 2)}...`;
      }

      const reserved = info.reservedCredits || 0;
      const availableCredits = typeof info.credits === 'number' ? Math.max(0, info.credits - reserved) : null;

      list.push({
        clientId: info.clientId,
        accountLabel: info.accountLabel || null,
        profileHint: info.profileHint || null,
        state: info.state,
        tier: info.tier,
        credits: info.credits ?? null,
        availableCredits,
        reservedCredits: reserved,
        projectIdPresent: Boolean(rawPid && rawPid.trim()),
        projectHint,
        activeProjectCount: info.activeProjectCount !== undefined ? info.activeProjectCount : (rawPid ? 1 : 0),
        capabilities: info.capabilities || [],
        tokenPresent: Boolean(info.tokenPresent),
        apiKeyPresent: Boolean(info.apiKeyPresent !== false),
        tokenAgeMs: info.tokenAgeMs ?? null,
        activeRequests: info.activeRequests || 0,
        lastSuccessAt: info.lastSuccessAt || null,
        connected: Boolean(info.ws && info.ws.readyState === 1),
        lastSeenAt: info.lastSeenAt,
      });
    }
    return list;
  }

  /**
   * Clear all clients and reservations
   */
  clear() {
    this.clients.clear();
    this.reservations.clear();
  }
}

export default FlowClientPool;
