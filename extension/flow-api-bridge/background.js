/**
 * Background Service Worker - Flow API Bridge (Chrome MV3)
 *
 * Responsibilities:
 * 1. Maintain persistent WebSocket connection & auto-reconnect to Node backend.
 * 2. Send 'hello' handshake on connect (protocolVersion: 1) with extension token and clientId.
 * 3. Handle 'operation_request' allowlist:
 *    - get_credits
 *    - generate_image
 *    - upload_image
 *    - submit_video
 *    - poll_video
 *    - download_image
 *    - download_video
 *    - refresh_auth
 *    - open_flow_tab
 *    - get_status
 * 4. Token & Security discipline:
 *    - Google Flow Bearer tokens are kept in session memory only (never written to chrome.storage.local, never logged).
 *    - Local bridge options (FLOW_EXTENSION_TOKEN, bridgeUrl, clientId) stored in chrome.storage.local.
 *    - Target endpoints and paths strictly allowlisted (aisandbox-pa.googleapis.com, labs.google, storage.googleapis.com).
 *    - Injects recaptcha tokens into request payloads before transmission.
 *    - Download sizes strictly bounded to prevent memory exhaustion.
 *    - 401 unauthenticated errors refresh Flow page state and return clean errors (no blind resubmit).
 *    - NO telemetry, NO remote callbacks, NO cookies written, NO mouse/keyboard emulation.
 */

import { DEFAULT_CONFIG, validateBridgeWsUrl } from './config.js';

// ─── State Management (In-Memory) ───────────────────────────
let ws = null;
let flowBearerToken = null; // Stored in-memory & chrome.storage.session only; cleared on expiration or 401
let flowBearerTokenCapturedAt = null;
let flowApiKey = null; // Stored in-memory & chrome.storage.session only; NEVER written to local/log/bridge
let flowApiKeyCapturedAt = null;
let currentProjectId = null;
let currentTier = 'PAYGATE_TIER_ONE';
let currentCredits = null;
let extensionState = 'idle'; // idle | running | off
let manualDisconnect = false;
let workTabId = null;

// Multi-project tab mappings (in-memory)
const projectTabMap = new Map(); // projectId -> { tabId, lastSeenAt }
const tabProjectMap = new Map(); // tabId -> projectId

// Tab removal listener to clean up mappings
if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    const pId = tabProjectMap.get(tabId);
    if (pId) {
      tabProjectMap.delete(tabId);
      const existing = projectTabMap.get(pId);
      if (existing && existing.tabId === tabId) {
        projectTabMap.delete(pId);
      }
    }
    if (workTabId === tabId) {
      workTabId = null;
    }
  });
}

// Metrics (non-sensitive counts only)
let metrics = {
  requestCount: 0,
  successCount: 0,
  failedCount: 0,
  lastError: null,
};

// ─── Target Domain & Path Allowlists ────────────────────────
const ALLOWED_API_HOSTS = new Set([
  'aisandbox-pa.googleapis.com',
]);

const ALLOWED_API_PATHS = [
  /^\/v1\/projects\/[0-9a-zA-Z_-]+\/flowMedia:batchGenerateImages$/,
  /^\/v1\/video:batchAsyncGenerateVideoText$/,
  /^\/v1\/video:batchAsyncGenerateVideoStartImage$/,
  /^\/v1\/video:batchAsyncGenerateVideoStartAndEndImage$/,
  /^\/v1\/video:batchAsyncGenerateVideoReferenceImages$/,
  /^\/v1\/video:batchAsyncGenerateVideoEditVideo$/,
  /^\/v1\/video:batchCheckAsyncVideoGenerationStatus$/,
  /^\/v1\/flow\/uploadImage$/,
  /^\/v1\/media\/[0-9a-zA-Z_-]+$/,
  /^\/v1\/credits$/,
];

const ALLOWED_OPERATIONS = new Set([
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

const REQ_ID_REGEX = /^[0-9a-zA-Z_-]{1,128}$/;
const API_KEY_REGEX = /^[0-9a-zA-Z_-]{10,128}$/;

/**
 * Pure helper to validate API endpoint path strictly against allowlist:
 * - Must not be an absolute URL or scheme-relative (cannot start with // or contain ://)
 * - Must not contain query string (?) or hash fragment (#)
 * - Must not contain dot segments (/../ or /./)
 * - Percent decoding must not alter path structure
 * - Must match ALLOWED_API_PATHS regex allowlist
 *
 * @param {string} endpoint
 * @param {string} [apiKey]
 * @returns {string} full aisandbox-pa URL
 */
function validateAndBuildUrl(endpoint, apiKey) {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error('Endpoint string is required');
  }

  const raw = endpoint.trim();

  // Reject absolute URLs, scheme-relative, query strings, and hashes
  if (raw.includes('://') || raw.startsWith('//')) {
    throw new Error('Absolute or scheme-relative URLs are rejected');
  }
  if (raw.includes('?') || raw.includes('#')) {
    throw new Error('Query strings and hash fragments are not allowed in endpoint path');
  }

  // Check percent encoding manipulation
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (_) {
    throw new Error('Malformed URL encoding');
  }

  // Reject dot segments (/../ or /./)
  const segments = decoded.split('/');
  if (segments.some(s => s === '..' || s === '.')) {
    throw new Error('Path traversal dot segments are rejected');
  }

  const cleanEndpoint = decoded.startsWith('/') ? decoded : `/${decoded}`;
  const isAllowedPath = ALLOWED_API_PATHS.some((regex) => regex.test(cleanEndpoint));

  if (!isAllowedPath) {
    throw new Error(`Endpoint path '${cleanEndpoint}' is not allowlisted`);
  }

  const urlObj = new URL(`https://aisandbox-pa.googleapis.com${cleanEndpoint}`);
  if (apiKey && typeof apiKey === 'string' && API_KEY_REGEX.test(apiKey.trim())) {
    urlObj.searchParams.set('key', apiKey.trim());
  }

  return urlObj.toString();
}

const ALLOWED_IMAGE_HOSTS = new Set([
  'storage.googleapis.com',
  'lh3.googleusercontent.com',
  'aisandbox-pa.googleapis.com',
]);

/**
 * Pure helper to verify if a download URL should receive Authorization Bearer header.
 * Strictly requires protocol === 'https:' and hostname === 'aisandbox-pa.googleapis.com'.
 * All other hosts (storage.googleapis.com, *.googleusercontent.com, etc.) MUST NEVER receive Bearer.
 *
 * @param {string} urlString
 * @returns {boolean}
 */
function shouldAttachAuthBearer(urlString) {
  if (!urlString || typeof urlString !== 'string') return false;
  try {
    const parsed = new URL(urlString);
    return parsed.protocol === 'https:' && parsed.hostname === 'aisandbox-pa.googleapis.com';
  } catch (_) {
    return false;
  }
}

/**
 * Pure helper to validate image download hosts.
 *
 * @param {string} urlString
 * @returns {boolean}
 */
function isAllowedImageDownloadHost(urlString) {
  if (!urlString || typeof urlString !== 'string') return false;
  try {
    const parsed = new URL(urlString);
    if (parsed.protocol !== 'https:') return false;
    if (ALLOWED_IMAGE_HOSTS.has(parsed.hostname)) return true;
    if (parsed.hostname.endsWith('.googleusercontent.com')) return true;
    return false;
  } catch (_) {
    return false;
  }
}

/**
 * Safe stream-based fetch & download helper.
 * Reads response.body via ReadableStream reader in chunks.
 * Cancels stream immediately if cumulative bytes exceed maxSizeBytes.
 * Avoids spread operator on large byte arrays to prevent stack overflow.
 *
 * @param {string} fullUrl
 * @param {object} [options]
 * @returns {Promise<{ base64: string, mimeType: string, sizeBytes: number }>}
 */
async function fetchAndStreamDownload(fullUrl, options = {}) {
  const { headers = {}, maxSizeBytes = (DEFAULT_CONFIG.MAX_DOWNLOAD_SIZE_BYTES || 100 * 1024 * 1024) } = options;

  const resp = await fetch(fullUrl, {
    method: 'GET',
    headers,
    credentials: 'include',
  });

  if (!resp.ok) {
    const err = new Error(`DOWNLOAD_HTTP_${resp.status}`);
    err.status = resp.status;
    throw err;
  }

  if (!resp.body || typeof resp.body.getReader !== 'function') {
    throw new Error('NO_READABLE_STREAM_BODY');
  }

  const reader = resp.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      if (value && value.byteLength > 0) {
        totalBytes += value.byteLength;
        if (totalBytes > maxSizeBytes) {
          try {
            await reader.cancel('MAX_DOWNLOAD_SIZE_EXCEEDED');
          } catch (_) {}
          const err = new Error('DOWNLOAD_EXCEEDS_MAX_SIZE');
          err.status = 413;
          throw err;
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (_) {}
  }

  // Combine chunks safely into single Uint8Array
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  // Chunked binary to base64 conversion (avoids stack overflow from String.fromCharCode(...spread))
  let binary = '';
  const step = 8192;
  for (let i = 0; i < combined.length; i += step) {
    const end = Math.min(i + step, combined.length);
    let sub = '';
    for (let j = i; j < end; j++) {
      sub += String.fromCharCode(combined[j]);
    }
    binary += sub;
  }
  const base64 = btoa(binary);

  return {
    base64,
    mimeType: resp.headers.get('content-type') || 'application/octet-stream',
    sizeBytes: totalBytes,
  };
}

// ─── Initialization ──────────────────────────────────────���──
let initializationPromise = null;
function ensureInitialized() {
  if (typeof chrome === 'undefined' || !chrome.runtime) return;
  if (!initializationPromise) {
    initializationPromise = initExtension().catch((err) => {
      initializationPromise = null;
      console.error('[FlowBridge] Extension initialization failed:', err);
    });
  }
  return initializationPromise;
}

if (typeof chrome !== 'undefined' && chrome.runtime) {
  chrome.runtime.onInstalled.addListener(ensureInitialized);
  chrome.runtime.onStartup.addListener(ensureInitialized);
}

if (typeof chrome !== 'undefined' && chrome.alarms) {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'flowBridgeReconnect') {
      connectToBridge();
    } else if (alarm.name === 'flowBridgeKeepAlive') {
      pingBridge();
    }
  });
}

async function initExtension() {
  // Load session storage if available for surviving worker reloads during active browsing session
  if (chrome.storage.session) {
    try {
      const sessionData = await chrome.storage.session.get([
        'flowBearerToken',
        'tokenCapturedAt',
        'flowApiKey',
        'apiKeyCapturedAt',
        'projectId',
      ]);
      if (sessionData.flowBearerToken) {
        flowBearerToken = sessionData.flowBearerToken;
        flowBearerTokenCapturedAt = sessionData.tokenCapturedAt || Date.now();
      }
      if (sessionData.flowApiKey) {
        flowApiKey = sessionData.flowApiKey;
        flowApiKeyCapturedAt = sessionData.apiKeyCapturedAt || Date.now();
      }
      if (sessionData.projectId) {
        currentProjectId = sessionData.projectId;
      }
    } catch (_) {}
  }

  // Ensure stable profile UUID and stable client ID in local storage
  const localData = await chrome.storage.local.get(['profileUuid', 'clientId']);
  let profileUuid = localData.profileUuid;
  if (!profileUuid || typeof profileUuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(profileUuid.trim())) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      profileUuid = crypto.randomUUID();
    } else {
      profileUuid = '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, c =>
        (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4)).toString(16)
      );
    }
    await chrome.storage.local.set({ profileUuid });
  }

  if (!localData.clientId) {
    const cleanHex = profileUuid.replace(/-/g, '');
    const newClientId = `${DEFAULT_CONFIG.DEFAULT_CLIENT_ID_PREFIX}_${cleanHex}`;
    await chrome.storage.local.set({ clientId: newClientId });
  }

  // Schedule keepAlive alarm
  chrome.alarms.create('flowBridgeKeepAlive', {
    periodInMinutes: DEFAULT_CONFIG.KEEPALIVE_INTERVAL_MINUTES || 0.5,
  });

  // Connect to Node WebSocket bridge
  connectToBridge();
}

ensureInitialized();

// ─── Bearer Token, API Key & Project ID Capture (webRequest on exact aisandbox) ───
if (typeof chrome !== 'undefined' && chrome.webRequest) {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      if (!details?.requestHeaders?.length || !details.url) return;

      let parsedUrl;
      try {
        parsedUrl = new URL(details.url);
      } catch (_) {
        return;
      }

      // Strict origin isolation: only capture from exact https://aisandbox-pa.googleapis.com
      if (parsedUrl.protocol !== 'https:' || parsedUrl.hostname !== 'aisandbox-pa.googleapis.com') {
        return;
      }

      let stateChanged = false;

      // 1. Check Authorization header: ONLY capture Bearer ya29.*
      const authHeader = details.requestHeaders.find(
        (h) => h.name?.toLowerCase() === 'authorization'
      );
      const authValue = authHeader?.value || '';

      if (authValue.startsWith('Bearer ya29.')) {
        const token = authValue.replace(/^Bearer\s+/i, '').trim();
        if (token && token !== flowBearerToken) {
          flowBearerToken = token;
          flowBearerTokenCapturedAt = Date.now();
          stateChanged = true;

          // Save ONLY to session storage (cleared when browser closes, NEVER local storage)
          if (chrome.storage?.session) {
            chrome.storage.session.set({
              flowBearerToken: token,
              tokenCapturedAt: flowBearerTokenCapturedAt,
            }).catch(() => {});
          }
        }
      }

      // 2. Check for public API Key from query parameter 'key' or 'x-goog-api-key' header
      let capturedKey = parsedUrl.searchParams.get('key');
      if (!capturedKey) {
        const apiKeyHeader = details.requestHeaders.find(
          (h) => h.name?.toLowerCase() === 'x-goog-api-key'
        );
        if (apiKeyHeader?.value) {
          capturedKey = apiKeyHeader.value.trim();
        }
      }

      if (capturedKey && typeof capturedKey === 'string' && API_KEY_REGEX.test(capturedKey.trim())) {
        const cleanKey = capturedKey.trim();
        if (cleanKey !== flowApiKey) {
          flowApiKey = cleanKey;
          flowApiKeyCapturedAt = Date.now();
          stateChanged = true;

          if (chrome.storage?.session) {
            chrome.storage.session.set({
              flowApiKey: cleanKey,
              apiKeyCapturedAt: flowApiKeyCapturedAt,
            }).catch(() => {});
          }
        }
      }

      // 3. Check for projectId in URL
      const match = parsedUrl.pathname.match(/\/projects\/([0-9a-zA-Z_-]{8,64})/i);
      if (match && match[1] && match[1] !== currentProjectId) {
        currentProjectId = match[1];
        stateChanged = true;
        if (chrome.storage?.session) {
          chrome.storage.session.set({ projectId: currentProjectId }).catch(() => {});
        }
      }

      if (stateChanged) {
        sendStatusUpdate();
      }
    },
    { urls: ['https://aisandbox-pa.googleapis.com/*'] },
    ['requestHeaders', 'extraHeaders']
  );
}

// Helper to check if a URL is a valid labs.google Flow page
function isValidFlowTabUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'labs.google') return false;
    return parsed.pathname.startsWith('/fx/tools/flow') || /^\/fx\/[^/]+\/tools\/flow/.test(parsed.pathname);
  } catch (_) {
    return false;
  }
}

// Listen for messages from content.js & options page
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Security Guard: Verify message sender
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ error: 'UNAUTHORIZED_SENDER' });
    return false;
  }

  const isInternalExtensionPage = !sender.tab;
  const isAuthorizedFlowTab = Boolean(sender.tab && isValidFlowTabUrl(sender.tab.url));

  // Content script messages: must originate from a valid labs.google Flow tab
  if (msg?.type === 'FLOW_PROJECT_DISCOVERED') {
    if (!isAuthorizedFlowTab) {
      sendResponse({ error: 'DISALLOWED_TAB_ORIGIN' });
      return false;
    }
    const tabId = sender.tab?.id;
    if (msg.projectId && typeof msg.projectId === 'string') {
      const pid = msg.projectId.trim();
      if (tabId) {
        tabProjectMap.set(tabId, pid);
        projectTabMap.set(pid, { tabId, lastSeenAt: Date.now() });
      }
      if (pid !== currentProjectId) {
        currentProjectId = pid;
        if (chrome.storage?.session) {
          chrome.storage.session.set({ projectId: pid }).catch(() => {});
        }
      }
      sendStatusUpdate();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === 'CONTENT_READY') {
    if (!isAuthorizedFlowTab) {
      sendResponse({ error: 'DISALLOWED_TAB_ORIGIN' });
      return false;
    }
    sendResponse({ ok: true });
    return true;
  }

  // Extension management messages: must originate from internal extension pages (e.g. options page), NOT web tabs
  if (msg?.type === 'GET_EXTENSION_STATUS') {
    if (!isInternalExtensionPage) {
      sendResponse({ error: 'DISALLOWED_CALLER' });
      return false;
    }
    const ageMs = flowBearerTokenCapturedAt ? Date.now() - flowBearerTokenCapturedAt : null;
    sendResponse({
      connected: ws?.readyState === WebSocket.OPEN,
      state: extensionState,
      tokenPresent: Boolean(flowBearerToken),
      tokenAgeMs: ageMs,
      apiKeyPresent: Boolean(flowApiKey),
      projectId: currentProjectId,
      tier: currentTier,
      credits: currentCredits,
      metrics,
    });
    return true;
  }

  if (msg?.type === 'SETTINGS_UPDATED') {
    if (!isInternalExtensionPage) {
      sendResponse({ error: 'DISALLOWED_CALLER' });
      return false;
    }
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    connectToBridge();
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === 'RECONNECT_BRIDGE') {
    if (!isInternalExtensionPage) {
      sendResponse({ error: 'DISALLOWED_CALLER' });
      return false;
    }
    manualDisconnect = false;
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    connectToBridge();
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === 'DISCONNECT_BRIDGE') {
    if (!isInternalExtensionPage) {
      sendResponse({ error: 'DISALLOWED_CALLER' });
      return false;
    }
    manualDisconnect = true;
    if (ws) {
      try { ws.close(); } catch (_) {}
    }
    sendResponse({ ok: true });
    return true;
  }

  // Reject any unknown message type or unauthorized origin
  sendResponse({ error: 'UNKNOWN_MESSAGE_TYPE' });
  return false;
  });
}

// ─── WebSocket Connection to Local Node Server ───────────────
async function getBridgeSettings() {
  const data = await chrome.storage.local.get(['bridgeWsUrl', 'flowExtensionToken', 'clientId', 'profileUuid', 'accountLabel']);
  return {
    wsUrl: data.bridgeWsUrl || DEFAULT_CONFIG.BRIDGE_WS_URL,
    token: data.flowExtensionToken || DEFAULT_CONFIG.FLOW_EXTENSION_TOKEN,
    clientId: data.clientId || 'client-default',
    profileUuid: data.profileUuid || undefined,
    accountLabel: data.accountLabel || undefined,
  };
}

async function connectToBridge() {
  if (manualDisconnect) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;

  const settings = await getBridgeSettings();

  try {
    ws = new WebSocket(settings.wsUrl);
  } catch (err) {
    scheduleReconnect();
    return;
  }

  ws.onopen = async () => {
    chrome.alarms.clear('flowBridgeReconnect');
    setExtensionState('idle');

    // Count distinct active projects
    const activeProjectCount = Math.max(projectTabMap.size, currentProjectId ? 1 : 0);

    // Send Hello message (protocolVersion 1)
    const helloPayload = {
      type: 'hello',
      protocolVersion: 1,
      clientId: settings.clientId,
      profileUuid: settings.profileUuid,
      accountLabel: settings.accountLabel,
      token: settings.token || '',
      state: extensionState,
      tier: currentTier,
      credits: typeof currentCredits === 'number' ? currentCredits : undefined,
      projectId: currentProjectId || null,
      activeProjectCount,
      capabilities: ['image', 'video', 'credits', 'upload_image', 'download'],
      tokenPresent: Boolean(flowBearerToken),
      tokenAgeMs: flowBearerTokenCapturedAt ? Date.now() - flowBearerTokenCapturedAt : null,
      apiKeyPresent: Boolean(flowApiKey),
    };

    try {
      ws.send(JSON.stringify(helloPayload));
    } catch (_) {}
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (_) {
      return;
    }

    if (msg.type === 'hello_ack') {
      // Handshake acknowledged
      return;
    }

    if (msg.type === 'ping') {
      try {
        ws.send(JSON.stringify({ type: 'pong' }));
      } catch (_) {}
      return;
    }

    if (msg.type === 'pong') {
      return;
    }

    if (msg.type === 'operation_request') {
      await handleOperationRequest(msg);
    }
  };

  ws.onclose = () => {
    setExtensionState('off');
    if (!manualDisconnect) {
      scheduleReconnect();
    }
  };

  ws.onerror = () => {
    metrics.lastError = 'WS_CONNECTION_ERROR';
  };
}

function scheduleReconnect() {
  chrome.alarms.create('flowBridgeReconnect', { delayInMinutes: 0.1 });
}

function pingBridge() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch (_) {}
  } else if (!manualDisconnect) {
    connectToBridge();
  }
}

function sendStatusUpdate() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    const ageMs = flowBearerTokenCapturedAt ? Date.now() - flowBearerTokenCapturedAt : null;
    const activeProjectCount = Math.max(projectTabMap.size, currentProjectId ? 1 : 0);
    const msg = {
      type: 'status_update',
      state: extensionState,
      tier: currentTier,
      credits: typeof currentCredits === 'number' ? currentCredits : undefined,
      projectId: currentProjectId || null,
      activeProjectCount,
      tokenPresent: Boolean(flowBearerToken),
      tokenAgeMs: ageMs,
      apiKeyPresent: Boolean(flowApiKey),
    };
    try {
      ws.send(JSON.stringify(msg));
    } catch (_) {}
  }
}

function setExtensionState(newState) {
  extensionState = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors = { idle: '#22c55e', running: '#f59e0b', off: '#6b7280' };
  try {
    chrome.action.setBadgeText({ text: badges[newState] || '' });
    chrome.action.setBadgeBackgroundColor({ color: colors[newState] || '#000' });
  } catch (_) {}
}

function sendResponseToBridge(responseMsg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(responseMsg));
    } catch (_) {}
  }
}

// ─── Flow Tab Automation Helpers ─────────────────────────────
async function findFlowTab(targetProjectId = null) {
  const tabs = await chrome.tabs.query({
    url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
  });

  if (tabs.length === 0) return null;

  if (targetProjectId) {
    // 1. Try projectTabMap
    const mapped = projectTabMap.get(targetProjectId);
    if (mapped && mapped.tabId) {
      const found = tabs.find(t => t.id === mapped.tabId);
      if (found) {
        workTabId = found.id;
        return found;
      }
    }

    // 2. Try match by tab URL
    const matchingUrlTab = tabs.find(t => isValidFlowTabUrl(t.url) && t.url.includes(targetProjectId));
    if (matchingUrlTab) {
      workTabId = matchingUrlTab.id;
      tabProjectMap.set(matchingUrlTab.id, targetProjectId);
      projectTabMap.set(targetProjectId, { tabId: matchingUrlTab.id, lastSeenAt: Date.now() });
      return matchingUrlTab;
    }

    // Explicit targetProjectId required, but no tab matches -> return null
    return null;
  }

  // Fallback for general operations without specific targetProjectId
  workTabId = tabs[0].id;
  return tabs[0];
}

async function getOrOpenFlowTab(active = false, targetProjectId = null) {
  let tab = await findFlowTab(targetProjectId);
  if (tab) {
    if (active) {
      await chrome.tabs.update(tab.id, { active: true });
    }
    return tab;
  }

  if (targetProjectId) {
    // If a specific project was requested but not found in open tabs, do NOT blind fallback to tabs[0]
    return null;
  }

  const created = await chrome.tabs.create({
    url: 'https://labs.google/fx/tools/flow',
    active: Boolean(active),
  });
  workTabId = created.id;

  // Wait 3 seconds for document_start content scripts to load
  await new Promise((r) => setTimeout(r, 3000));
  const tabs = await chrome.tabs.query({
    url: ['https://labs.google/fx/tools/flow*', 'https://labs.google/fx/*/tools/flow*'],
  });
  return tabs.length > 0 ? tabs[0] : created;
}

// ─── reCAPTCHA Solving ───────────────────────────────────────
async function solveRecaptcha(requestId, pageAction, targetProjectId = null) {
  const tab = await getOrOpenFlowTab(false, targetProjectId);
  if (!tab || !tab.id) {
    if (targetProjectId) {
      return { error: 'FLOW_PROJECT_TAB_NOT_FOUND' };
    }
    return { error: 'NO_FLOW_TAB' };
  }

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: 'SOLVE_CAPTCHA',
      requestId: requestId || `req-${Date.now()}`,
      pageAction: pageAction || 'IMAGE_GENERATION',
    });
    return resp || { error: 'EMPTY_CAPTCHA_RESPONSE' };
  } catch (err) {
    // Try re-injecting content script and retrying once
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
      });
      await new Promise((r) => setTimeout(r, 300));
      const retryResp = await chrome.tabs.sendMessage(tab.id, {
        type: 'SOLVE_CAPTCHA',
        requestId: requestId || `req-${Date.now()}`,
        pageAction: pageAction || 'IMAGE_GENERATION',
      });
      return retryResp || { error: 'EMPTY_CAPTCHA_RESPONSE_ON_RETRY' };
    } catch (injectErr) {
      return { error: `CAPTCHA_ERROR: ${err.message}` };
    }
  }
}

// ─── Operation Request Dispatcher ───────────────────────────
async function handleOperationRequest(msg) {
  const { id: reqId, operation, payload, protocolVersion } = msg;

  // Security Guard: Check protocolVersion === 1
  if (protocolVersion !== 1) {
    if (reqId) {
      sendResponseToBridge({
        id: reqId,
        status: 400,
        error: 'UNSUPPORTED_PROTOCOL_VERSION',
      });
    }
    return;
  }

  // Security Guard: Check reqId is safe format
  if (!reqId || typeof reqId !== 'string' || !REQ_ID_REGEX.test(reqId.trim())) {
    return;
  }

  // Security Guard: Check operation in fixed allowlist
  if (!operation || typeof operation !== 'string' || !ALLOWED_OPERATIONS.has(operation.trim())) {
    sendResponseToBridge({
      id: reqId,
      status: 400,
      error: `UNKNOWN_OPERATION: ${operation}`,
    });
    return;
  }

  setExtensionState('running');
  metrics.requestCount++;

  try {
    switch (operation) {
      case 'get_status': {
        const ageMs = flowBearerTokenCapturedAt ? Date.now() - flowBearerTokenCapturedAt : null;
        sendResponseToBridge({
          id: reqId,
          status: 200,
          data: {
            state: extensionState,
            tokenPresent: Boolean(flowBearerToken),
            tokenAgeMs: ageMs,
            apiKeyPresent: Boolean(flowApiKey),
            projectId: currentProjectId,
            tier: currentTier,
            credits: currentCredits,
            metrics,
          },
        });
        break;
      }

      case 'open_flow_tab': {
        const tab = await getOrOpenFlowTab(true);
        sendResponseToBridge({
          id: reqId,
          status: 200,
          data: { ok: true, tabId: tab?.id || null },
        });
        break;
      }

      case 'refresh_auth': {
        // Drop existing cached Bearer token to force fresh capture (keep API key)
        flowBearerToken = null;
        flowBearerTokenCapturedAt = null;
        if (chrome.storage.session) {
          chrome.storage.session.remove(['flowBearerToken', 'tokenCapturedAt']).catch(() => {});
        }

        const tab = await getOrOpenFlowTab(false);
        if (tab && tab.id) {
          await chrome.tabs.reload(tab.id);
        }

        // Wait up to 10 seconds for both Bearer and API key to become available
        let attempts = 0;
        while ((!flowBearerToken || !flowApiKey) && attempts < 20) {
          await new Promise((r) => setTimeout(r, 500));
          attempts++;
        }

        if (flowBearerToken && flowApiKey) {
          sendResponseToBridge({
            id: reqId,
            status: 200,
            data: { ok: true, refreshed: true, tokenPresent: true, apiKeyPresent: true },
          });
        } else if (flowBearerToken && !flowApiKey) {
          sendResponseToBridge({
            id: reqId,
            status: 503,
            error: 'FLOW_API_KEY_NOT_CAPTURED',
          });
        } else {
          sendResponseToBridge({
            id: reqId,
            status: 503,
            error: 'AUTH_REFRESH_FAILED_NO_TOKEN',
          });
        }
        break;
      }

      case 'get_credits': {
        await handleGetCredits(reqId, payload);
        break;
      }

      case 'generate_image': {
        await handleGenerateImage(reqId, payload);
        break;
      }

      case 'upload_image': {
        await handleUploadImage(reqId, payload);
        break;
      }

      case 'submit_video': {
        await handleSubmitVideo(reqId, payload);
        break;
      }

      case 'poll_video': {
        await handlePollVideo(reqId, payload);
        break;
      }

      case 'download_image': {
        await handleDownloadImage(reqId, payload);
        break;
      }

      case 'download_video': {
        await handleDownloadVideo(reqId, payload);
        break;
      }

      default: {
        sendResponseToBridge({
          id: reqId,
          status: 400,
          error: `UNKNOWN_OPERATION: ${operation}`,
        });
        break;
      }
    }
  } catch (err) {
    metrics.failedCount++;
    metrics.lastError = err.message;
    sendResponseToBridge({
      id: reqId,
      status: 500,
      error: err.message || 'INTERNAL_OPERATION_ERROR',
    });
  } finally {
    setExtensionState('idle');
  }
}

// ─── API Fetch & Request Helpers ─────────────────────────────
async function performAuthorizedApiFetch(fullUrl, options = {}) {
  if (!flowBearerToken) {
    return {
      status: 401,
      error: 'NO_FLOW_BEARER_TOKEN',
      data: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Flow Bearer token not present in memory. Please open Flow web page.' } },
    };
  }

  if (!flowApiKey) {
    return {
      status: 401,
      error: 'FLOW_API_KEY_NOT_CAPTURED',
      data: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Flow web public API key not captured yet. Please open or refresh Flow web page.' } },
    };
  }

  const { method = 'POST', body, headers = {} } = options;

  // Build fullUrl ensuring apiKey is present in query params
  let targetUrl = fullUrl;
  try {
    const urlObj = new URL(fullUrl);
    if (!urlObj.searchParams.has('key') && flowApiKey) {
      urlObj.searchParams.set('key', flowApiKey);
      targetUrl = urlObj.toString();
    }
  } catch (_) {}

  const reqHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${flowBearerToken}`,
    ...headers,
  };

  const resp = await fetch(targetUrl, {
    method,
    headers: reqHeaders,
    credentials: 'include',
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });

  const text = await resp.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = text;
  }

  // If 401, invalidate cached Bearer token (conservative: keep API key)
  if (resp.status === 401) {
    flowBearerToken = null;
    flowBearerTokenCapturedAt = null;
    if (chrome.storage?.session) {
      chrome.storage.session.remove(['flowBearerToken', 'tokenCapturedAt']).catch(() => {});
    }
    sendStatusUpdate();
  }

  return {
    status: resp.status,
    data,
  };
}

// ─── Operation Handlers ─────────────────────────────────────

async function handleGetCredits(reqId, payload) {
  const pId = payload?.projectId || currentProjectId;
  let endpoint = '/v1/credits';
  if (pId) {
    endpoint = `/v1/projects/${pId}/credits`;
  }

  let fullUrl;
  // If custom project credits not in path regex, use /v1/credits
  try {
    fullUrl = validateAndBuildUrl(endpoint);
  } catch (_) {
    fullUrl = 'https://aisandbox-pa.googleapis.com/v1/credits';
  }

  const result = await performAuthorizedApiFetch(fullUrl, { method: 'GET' });

  if (result.status === 200 && result.data) {
    if (typeof result.data.credits === 'number') {
      currentCredits = result.data.credits;
    } else if (typeof result.data.remainingCredits === 'number') {
      currentCredits = result.data.remainingCredits;
    }
    metrics.successCount++;
  } else {
    metrics.failedCount++;
  }

  sendResponseToBridge({
    id: reqId,
    status: result.status,
    data: result.data,
    error: result.error,
  });
}

async function handleGenerateImage(reqId, payload) {
  const { endpoint, body, captchaAction, projectId: explicitProjectId } = payload;
  const targetProjectId = explicitProjectId || body?.clientContext?.projectId || currentProjectId;
  const fullUrl = validateAndBuildUrl(endpoint);

  // Solve captcha if required
  let solvedToken = '';
  if (captchaAction) {
    const captchaRes = await solveRecaptcha(reqId, captchaAction || 'IMAGE_GENERATION', targetProjectId);
    if (captchaRes.error || !captchaRes.token) {
      sendResponseToBridge({
        id: reqId,
        status: captchaRes.error === 'FLOW_PROJECT_TAB_NOT_FOUND' ? 404 : 403,
        error: captchaRes.error === 'FLOW_PROJECT_TAB_NOT_FOUND'
          ? 'FLOW_PROJECT_TAB_NOT_FOUND'
          : `CAPTCHA_SOLVE_FAILED: ${captchaRes.error || 'NO_CAPTCHA_TOKEN'}`,
      });
      metrics.failedCount++;
      return;
    }
    solvedToken = captchaRes.token;
  }

  // Inject solved captcha token into payload
  const finalBody = JSON.parse(JSON.stringify(body || {}));
  if (solvedToken) {
    if (finalBody.clientContext?.recaptchaContext) {
      finalBody.clientContext.recaptchaContext.token = solvedToken;
    }
    if (Array.isArray(finalBody.requests)) {
      for (const req of finalBody.requests) {
        if (req.clientContext?.recaptchaContext) {
          req.clientContext.recaptchaContext.token = solvedToken;
        }
      }
    }
  }

  const result = await performAuthorizedApiFetch(fullUrl, {
    method: 'POST',
    body: finalBody,
  });

  if (result.status === 200) {
    metrics.successCount++;
  } else {
    metrics.failedCount++;
  }

  sendResponseToBridge({
    id: reqId,
    status: result.status,
    data: result.data,
    error: result.error,
  });
}

async function handleUploadImage(reqId, payload) {
  const { projectId, imageBase64, mimeType = 'image/png' } = payload;
  if (!imageBase64) {
    sendResponseToBridge({
      id: reqId,
      status: 400,
      error: 'MISSING_IMAGE_BASE64',
    });
    return;
  }

  const fullUrl = 'https://aisandbox-pa.googleapis.com/v1/flow/uploadImage';
  const requestBody = {
    clientContext: {
      projectId: projectId || currentProjectId || 'default',
      tool: 'PINHOLE',
    },
    imageBytes: imageBase64,
  };

  const result = await performAuthorizedApiFetch(fullUrl, {
    method: 'POST',
    body: requestBody,
  });

  if (result.status === 200) {
    metrics.successCount++;
  } else {
    metrics.failedCount++;
  }

  sendResponseToBridge({
    id: reqId,
    status: result.status,
    data: result.data,
    error: result.error,
  });
}

async function handleSubmitVideo(reqId, payload) {
  const { endpoint, body, captchaAction, projectId: explicitProjectId } = payload;
  const targetProjectId = explicitProjectId || body?.clientContext?.projectId || currentProjectId;
  const fullUrl = validateAndBuildUrl(endpoint);

  // Solve captcha
  let solvedToken = '';
  if (captchaAction) {
    const captchaRes = await solveRecaptcha(reqId, captchaAction || 'VIDEO_GENERATION', targetProjectId);
    if (captchaRes.error || !captchaRes.token) {
      sendResponseToBridge({
        id: reqId,
        status: captchaRes.error === 'FLOW_PROJECT_TAB_NOT_FOUND' ? 404 : 403,
        error: captchaRes.error === 'FLOW_PROJECT_TAB_NOT_FOUND'
          ? 'FLOW_PROJECT_TAB_NOT_FOUND'
          : `CAPTCHA_SOLVE_FAILED: ${captchaRes.error || 'NO_CAPTCHA_TOKEN'}`,
      });
      metrics.failedCount++;
      return;
    }
    solvedToken = captchaRes.token;
  }

  // Inject captcha token
  const finalBody = JSON.parse(JSON.stringify(body || {}));
  if (solvedToken) {
    if (finalBody.clientContext?.recaptchaContext) {
      finalBody.clientContext.recaptchaContext.token = solvedToken;
    }
    if (Array.isArray(finalBody.requests)) {
      for (const req of finalBody.requests) {
        if (req.clientContext?.recaptchaContext) {
          req.clientContext.recaptchaContext.token = solvedToken;
        }
      }
    }
  }

  const result = await performAuthorizedApiFetch(fullUrl, {
    method: 'POST',
    body: finalBody,
  });

  if (result.status === 200) {
    metrics.successCount++;
  } else {
    metrics.failedCount++;
  }

  sendResponseToBridge({
    id: reqId,
    status: result.status,
    data: result.data,
    error: result.error,
  });
}

async function handlePollVideo(reqId, payload) {
  const { endpoint = '/v1/video:batchCheckAsyncVideoGenerationStatus', body } = payload;
  const fullUrl = validateAndBuildUrl(endpoint);

  const result = await performAuthorizedApiFetch(fullUrl, {
    method: 'POST',
    body: body || {},
  });

  if (result.status === 200) {
    metrics.successCount++;
  } else {
    metrics.failedCount++;
  }

  sendResponseToBridge({
    id: reqId,
    status: result.status,
    data: result.data,
    error: result.error,
  });
}

async function handleDownloadImage(reqId, payload) {
  const { url, mediaId, projectId } = payload;

  let fetchUrl = '';
  if (url && typeof url === 'string') {
    if (!isAllowedImageDownloadHost(url)) {
      sendResponseToBridge({
        id: reqId,
        status: 400,
        error: `DISALLOWED_IMAGE_HOST`,
      });
      return;
    }
    fetchUrl = url;
  } else if (mediaId) {
    const pId = projectId || currentProjectId;
    fetchUrl = `https://aisandbox-pa.googleapis.com/v1/media/${encodeURIComponent(mediaId)}${pId ? `?projectId=${encodeURIComponent(pId)}` : ''}`;
  } else {
    sendResponseToBridge({
      id: reqId,
      status: 400,
      error: 'MISSING_IMAGE_URL_OR_MEDIA_ID',
    });
    return;
  }

  const fetchHeaders = {};
  // Strictly only attach Authorization Bearer if shouldAttachAuthBearer evaluates to true
  if (shouldAttachAuthBearer(fetchUrl) && flowBearerToken) {
    fetchHeaders['Authorization'] = `Bearer ${flowBearerToken}`;
  }

  try {
    const downloadRes = await fetchAndStreamDownload(fetchUrl, {
      headers: fetchHeaders,
      maxSizeBytes: DEFAULT_CONFIG.MAX_DOWNLOAD_SIZE_BYTES,
    });

    metrics.successCount++;
    sendResponseToBridge({
      id: reqId,
      status: 200,
      data: {
        imageBase64: downloadRes.base64,
        mimeType: downloadRes.mimeType || 'image/png',
        sizeBytes: downloadRes.sizeBytes,
      },
    });
  } catch (err) {
    metrics.failedCount++;
    metrics.lastError = err.message;
    sendResponseToBridge({
      id: reqId,
      status: err.status || 500,
      error: `IMAGE_DOWNLOAD_FAILED: ${err.message}`,
    });
  }
}

async function handleDownloadVideo(reqId, payload) {
  const { mediaId, projectId } = payload;
  if (!mediaId) {
    sendResponseToBridge({
      id: reqId,
      status: 400,
      error: 'MISSING_MEDIA_ID',
    });
    return;
  }

  const pId = projectId || currentProjectId;
  const endpoint = `/v1/media/${encodeURIComponent(mediaId)}`;
  const fullUrl = `https://aisandbox-pa.googleapis.com${endpoint}${pId ? `?projectId=${encodeURIComponent(pId)}` : ''}`;

  const fetchHeaders = {};
  if (shouldAttachAuthBearer(fullUrl) && flowBearerToken) {
    fetchHeaders['Authorization'] = `Bearer ${flowBearerToken}`;
  }

  try {
    const downloadRes = await fetchAndStreamDownload(fullUrl, {
      headers: fetchHeaders,
      maxSizeBytes: DEFAULT_CONFIG.MAX_DOWNLOAD_SIZE_BYTES,
    });

    metrics.successCount++;
    sendResponseToBridge({
      id: reqId,
      status: 200,
      data: {
        videoBase64: downloadRes.base64,
        mimeType: downloadRes.mimeType || 'video/mp4',
        sizeBytes: downloadRes.sizeBytes,
      },
    });
  } catch (err) {
    metrics.failedCount++;
    metrics.lastError = err.message;
    sendResponseToBridge({
      id: reqId,
      status: err.status || 500,
      error: `VIDEO_DOWNLOAD_FAILED: ${err.message}`,
    });
  }
}

// Export pure functions for testing in Node environment
export {
  shouldAttachAuthBearer,
  isAllowedImageDownloadHost,
  isValidFlowTabUrl,
  validateAndBuildUrl,
  ALLOWED_API_PATHS,
  ALLOWED_IMAGE_HOSTS,
  ALLOWED_OPERATIONS,
  REQ_ID_REGEX,
  API_KEY_REGEX,
};
