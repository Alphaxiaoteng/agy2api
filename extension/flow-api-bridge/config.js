export const DEFAULT_CONFIG = {
  BRIDGE_WS_URL: 'ws://127.0.0.1:8045/internal/flow/ws',
  FLOW_EXTENSION_TOKEN: '',
  DEFAULT_CLIENT_ID_PREFIX: 'flow',
  RECONNECT_INTERVAL_MS: 3000,
  KEEPALIVE_INTERVAL_MINUTES: 0.5,
  MAX_DOWNLOAD_SIZE_BYTES: 100 * 1024 * 1024, // 100 MB max download size limit
  RECAPTCHA_SITE_KEY: '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV',
};

/**
 * Validate Bridge WebSocket URL according to strict security rules:
 * - Loopback addresses (127.0.0.1, localhost, [::1]) may use ws:// or wss://
 * - Any non-loopback address MUST use wss://
 * - No user credentials (user:pass)
 * - No query parameters or hash fragments
 * - Path must be exactly /internal/flow/ws
 *
 * @param {string} urlString
 * @returns {{ valid: boolean, error?: string, parsed?: URL }}
 */
export function validateBridgeWsUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return { valid: false, error: 'Bridge WebSocket URL cannot be empty' };
  }

  let parsed;
  try {
    parsed = new URL(urlString.trim());
  } catch (_) {
    return { valid: false, error: 'Invalid URL format' };
  }

  // Check credentials
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'Credentials (username/password) are not allowed in Bridge URL' };
  }

  // Check query / hash
  if (parsed.search) {
    return { valid: false, error: 'Query parameters are not allowed in Bridge URL' };
  }
  if (parsed.hash) {
    return { valid: false, error: 'Hash fragments are not allowed in Bridge URL' };
  }

  // Path must be exactly /internal/flow/ws
  if (parsed.pathname !== '/internal/flow/ws') {
    return { valid: false, error: "Bridge URL path must be exactly '/internal/flow/ws'" };
  }

  // Check loopback vs non-loopback protocol
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';

  if (isLoopback) {
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return { valid: false, error: "Loopback Bridge URL protocol must be 'ws:' or 'wss:'" };
    }
  } else {
    if (parsed.protocol !== 'wss:') {
      return { valid: false, error: "Non-loopback Bridge URL must strictly use secure 'wss://' protocol" };
    }
  }

  return { valid: true, parsed };
}
