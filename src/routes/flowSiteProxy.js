import config from '../config/config.js';
import { verifyToken } from '../auth/jwt.js';
import logger from '../utils/logger.js';
import { CookieJar } from '../utils/flowCookieJar.js';
import { fetchEgoGoogleCookies } from '../utils/flowEgoCookies.js';
import { rewriteHtml, rewriteLocation, parseUpstreamPath } from '../utils/flowProxyRewrite.js';
import { isLocalPeer } from '../utils/peerIp.js';

const flowCookieJar = new CookieJar();
let syncing = null;
let lastSync = { at: 0, ok: false, error: null };

const DROP_REQ = new Set([
  'host', 'connection', 'content-length', 'cookie', 'origin', 'referer',
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'transfer-encoding', 'keep-alive', 'te', 'trailer', 'upgrade',
  'accept-encoding'
]);

const DROP_RES = new Set([
  'content-security-policy', 'content-security-policy-report-only',
  'x-frame-options', 'strict-transport-security', 'alt-svc',
  'content-encoding', 'content-length', 'transfer-encoding',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'set-cookie'
]);

// 本地豁免必须基于真实 TCP 对端，不能基于客户端可控的 XFF/X-Real-IP，
// 否则任意外部请求带 `X-Forwarded-For: 127.0.0.1` 即可获得 admin 身份。
export function localFlowAuth(req, res, next) {
  let token = req.cookies?.authToken;
  if (!token) {
    const header = req.headers.authorization;
    token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  }
  if (!token && isLocalPeer(req)) {
    req.user = { username: config.admin.username, role: 'admin' };
    return next();
  }
  if (!token) return res.status(401).json({ success: false, message: 'Token required' });
  try {
    req.user = verifyToken(token);
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid token' });
  }
}

export function getFlowProxyStatus() {
  const stats = flowCookieJar.stats();
  const loggedIn = stats.names.some((name) =>
    /session-token|SID|SAPISID|__Secure-1PSID|__Secure-3PSID/i.test(name)
  );
  return {
    at: lastSync.at,
    ok: lastSync.ok,
    error: lastSync.error,
    cookieCount: stats.count,
    loggedIn,
    iframePath: '/fx/zh/tools/flow'
  };
}

export async function syncFlowCookies({ force = false } = {}) {
  if (syncing) return syncing;
  const age = Date.now() - lastSync.at;
  if (!force && lastSync.at) {
    if (lastSync.ok && age < 5 * 60 * 1000) return getFlowProxyStatus();
    if (!lastSync.ok && age < 60 * 1000) return getFlowProxyStatus();
  }
  syncing = (async () => {
    try {
      const cookies = await fetchEgoGoogleCookies();
      flowCookieJar.ingestCdpCookies(cookies);
      lastSync = { at: Date.now(), ok: true, error: null };
      logger.info(`[FlowProxy] Google cookie 已同步: ${flowCookieJar.stats().count} 个`);
    } catch (error) {
      lastSync = { at: Date.now(), ok: false, error: error.message };
      logger.warn(`[FlowProxy] cookie 同步失败: ${error.message}`);
    } finally {
      syncing = null;
    }
    return getFlowProxyStatus();
  })();
  return syncing;
}

function rewriteReferer(referer) {
  if (!referer) return 'https://labs.google/fx/zh/tools/flow';
  try {
    const u = new URL(referer);
    if (u.pathname.startsWith('/__flow/u/')) {
      return 'https://labs.google/fx/zh/tools/flow';
    }
    return `https://labs.google${u.pathname}${u.search}`;
  } catch {
    return 'https://labs.google/fx/zh/tools/flow';
  }
}

function buildUpstreamHeaders(req, upstreamHost) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (DROP_REQ.has(key.toLowerCase())) continue;
    if (value == null) continue;
    headers[key] = value;
  }
  headers.origin = 'https://labs.google';
  headers.referer = rewriteReferer(req.headers.referer);
  headers['sec-fetch-site'] = upstreamHost === 'labs.google' ? 'same-origin' : 'cross-site';
  const cookie = flowCookieJar.headerFor(`https://${upstreamHost}/`);
  if (cookie) headers.cookie = cookie;
  return headers;
}

async function fetchUpstream(target, options) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fetch(target, options);
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function readRequestBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 80 * 1024 * 1024) {
      throw new Error('request body too large');
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return undefined;
  return Buffer.concat(chunks);
}

function shouldRewrite(contentType) {
  const type = String(contentType || '').toLowerCase();
  return type.includes('text/html') || type.includes('application/json') || type.includes('text/plain');
}

async function proxyRequest(req, res, target, upstreamHost) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  req.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  try {
    const isDoc = !String(req.originalUrl || '').includes('/_next/static/');
    if (isDoc) await syncFlowCookies();
    const body = await readRequestBody(req);
    const upstream = await fetchUpstream(target, {
      method: req.method,
      headers: buildUpstreamHeaders(req, upstreamHost),
      body,
      redirect: 'manual',
      signal: controller.signal
    });
    const setCookies = typeof upstream.headers.getSetCookie === 'function'
      ? upstream.headers.getSetCookie()
      : [];
    if (setCookies.length) flowCookieJar.ingest(setCookies, target);

    const type = upstream.headers.get('content-type') || '';
    const location = upstream.headers.get('location');
    for (const [key, value] of upstream.headers) {
      if (DROP_RES.has(key.toLowerCase())) continue;
      if (key.toLowerCase() === 'location' && location) {
        res.setHeader('location', rewriteLocation(location, 'https://labs.google'));
        continue;
      }
      res.setHeader(key, value);
    }
    res.status(upstream.status);
    if (req.method === 'HEAD' || upstream.status === 204 || upstream.status === 304) {
      return res.end();
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    let out = buf;
    if (type.includes('text/html')) {
      out = Buffer.from(rewriteHtml(buf.toString('utf8')), 'utf8');
    } else if (shouldRewrite(type) && !type.includes('text/html')) {
      out = Buffer.from(buf.toString('utf8').replace(/https:\/\/labs\.google\//g, '/'), 'utf8');
    }
    res.setHeader('content-length', String(out.length));
    res.end(out);
    if (!target.includes('/_next/static/')) {
      logger.info(`[FlowProxy] ${req.method} ${upstream.status} ${upstreamHost}${new URL(target).pathname}`);
    }
  } catch (error) {
    if (res.headersSent) return;
    const message = error.name === 'AbortError' ? 'upstream timeout' : (error.message || 'proxy failed');
    logger.warn(`[FlowProxy] 失败 ${req.method} ${target}: ${message}`);
    if (String(req.headers.accept || '').includes('text/html')) {
      res.status(502).type('html').send(
        `<!doctype html><meta charset="utf-8"><body style="background:#111;color:#ddd;font:14px sans-serif;padding:24px">Google Flow 反代失败：${escapeHtml(message)}</body>`
      );
      return;
    }
    res.status(502).json({ success: false, message });
  } finally {
    clearTimeout(timer);
  }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

export async function proxyLabsGoogle(req, res) {
  const target = `https://labs.google${req.originalUrl || '/fx/tools/flow'}`;
  return proxyRequest(req, res, target, 'labs.google');
}

export async function proxyUpstream(req, res) {
  const parsed = parseUpstreamPath(req.originalUrl || '');
  if (!parsed) {
    return res.status(403).json({ success: false, message: 'host not allowed' });
  }
  const target = `https://${parsed.host}${parsed.path.startsWith('/') ? parsed.path : `/${parsed.path}`}`;
  return proxyRequest(req, res, target, parsed.host);
}
