const DEFAULT_ALPHA_NEXUS_BASE_URL = 'http://127.0.0.1:17421';
const TRANSPORT_HEADER = 'X-Alpha-Transport-Token';
const REQUEST_TIMEOUT_MS = 8000;

function bridgeError(message, code = 'alpha_nexus_bridge_error', status = 502) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

export function validateAlphaNexusBaseUrl(value) {
  let url;
  try {
    url = new URL(value || DEFAULT_ALPHA_NEXUS_BASE_URL);
  } catch {
    throw bridgeError('Alpha Nexus base URL is invalid', 'alpha_nexus_invalid_base_url', 400);
  }
  const allowedHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'http:' || !allowedHost || url.username || url.password) {
    throw bridgeError('Alpha Nexus base URL must be a credential-free loopback HTTP URL', 'alpha_nexus_invalid_base_url', 400);
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export class AlphaNexusFlowBridge {
  constructor({
    baseUrl = process.env.ALPHA_NEXUS_BASE_URL || DEFAULT_ALPHA_NEXUS_BASE_URL,
    transportToken = process.env.ALPHA_NEXUS_TRANSPORT_TOKEN || '',
    fetchImpl = globalThis.fetch
  } = {}) {
    this.baseUrl = validateAlphaNexusBaseUrl(baseUrl);
    this.transportToken = typeof transportToken === 'string' ? transportToken.trim() : '';
    this.fetchImpl = fetchImpl;
  }

  isConfigured() {
    return Boolean(this.transportToken && typeof this.fetchImpl === 'function');
  }

  async _request(pathname, options = {}) {
    if (!this.isConfigured()) {
      throw bridgeError('Alpha Nexus Flow bridge is not configured', 'alpha_nexus_not_configured', 503);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        ...options,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          [TRANSPORT_HEADER]: this.transportToken,
          ...(options.headers || {})
        },
        signal: controller.signal
      });
      if (!response.ok) {
        throw bridgeError(`Alpha Nexus request failed with HTTP ${response.status}`, 'alpha_nexus_request_failed', 502);
      }
      return await response.json();
    } catch (err) {
      if (err?.code?.startsWith?.('alpha_nexus_')) throw err;
      if (err?.name === 'AbortError') {
        throw bridgeError('Alpha Nexus request timed out', 'alpha_nexus_timeout', 504);
      }
      throw bridgeError('Alpha Nexus request failed', 'alpha_nexus_request_failed', 502);
    } finally {
      clearTimeout(timer);
    }
  }

  async listFlowAccounts() {
    if (!this.isConfigured()) return [];
    const rows = await this._request('/api/accounts?includeDisabled=true');
    if (!Array.isArray(rows)) return [];

    const byIdentity = new Map();
    for (const row of rows) {
      const accountId = Number(row?.id);
      const identityId = Number(row?.identityId);
      if (!Number.isInteger(accountId) || accountId <= 0 || !Number.isInteger(identityId) || identityId <= 0) continue;
      if (row.enabled !== true || row.loginState !== 'logged_in') continue;

      const existing = byIdentity.get(identityId);
      const safeAccount = {
        account_id: accountId,
        identity_id: identityId,
        name: String(row.name || `Account ${accountId}`).slice(0, 120),
        login_state: 'logged_in',
        enabled: true,
        space_id: Number.isInteger(Number(row.spaceId)) && Number(row.spaceId) > 0 ? Number(row.spaceId) : null,
        account_ids: [accountId]
      };
      if (!existing) {
        byIdentity.set(identityId, safeAccount);
      } else {
        existing.account_ids.push(accountId);
        if (!existing.space_id && safeAccount.space_id) existing.space_id = safeAccount.space_id;
      }
    }
    return Array.from(byIdentity.values()).sort((a, b) => a.identity_id - b.identity_id);
  }

  async ensureAccountSpace(accountId) {
    const id = Number(accountId);
    if (!Number.isInteger(id) || id <= 0) {
      throw bridgeError('account_id must be a positive integer', 'invalid_account_id', 400);
    }
    const space = await this._request(`/api/accounts/${id}/space/ensure`, {
      method: 'POST',
      body: '{}'
    });
    const spaceId = Number(space?.space_id);
    if (!Number.isInteger(spaceId) || spaceId <= 0) {
      throw bridgeError('Alpha Nexus returned an invalid account space', 'alpha_nexus_invalid_space', 502);
    }
    return {
      accountId: id,
      identityId: Number.isInteger(Number(space.identity_id)) ? Number(space.identity_id) : null,
      spaceId,
      taskId: typeof space.task_id === 'string' ? space.task_id : '',
      name: typeof space.name === 'string' ? space.name.slice(0, 120) : '',
      ownership: typeof space.ownership === 'string' ? space.ownership : '',
      state: typeof space.state === 'string' ? space.state : ''
    };
  }
}

export const alphaNexusFlowBridge = new AlphaNexusFlowBridge();
