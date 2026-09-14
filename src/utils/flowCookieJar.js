function keyOf(rec) {
  return `${rec.domain}\n${rec.path}\n${rec.name}`;
}

export function isGoogleCookieDomain(domain) {
  const d = String(domain || '').replace(/^\./, '').toLowerCase();
  if (!d) return false;
  return (
    d === 'google.com' || d.endsWith('.google.com') ||
    d === 'googleapis.com' || d.endsWith('.googleapis.com') ||
    d === 'googleusercontent.com' || d.endsWith('.googleusercontent.com') ||
    d === 'labs.google' || d.endsWith('.labs.google') ||
    d === 'gstatic.com' || d.endsWith('.gstatic.com')
  );
}

function domainMatches(cookieDomain, host) {
  const d = String(cookieDomain || '').replace(/^\./, '').toLowerCase();
  const h = String(host || '').toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

function pathMatches(cookiePath, urlPath) {
  const p = cookiePath || '/';
  const path = urlPath || '/';
  if (p === '/') return true;
  if (path === p) return true;
  if (path.startsWith(p.endsWith('/') ? p : `${p}/`)) return true;
  return false;
}

function normalizeExpires(expires) {
  if (expires == null || expires === -1 || expires === 0) return null;
  const n = Number(expires);
  if (!Number.isFinite(n) || n < 0) return null;
  return n < 1e11 ? n * 1000 : n;
}

function parseSetCookie(raw, fallbackHost) {
  const parts = String(raw).split(';').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const nv = parts[0];
  const eq = nv.indexOf('=');
  if (eq < 0) return null;
  const name = nv.slice(0, eq).trim();
  const value = nv.slice(eq + 1);
  if (!name) return null;
  const rec = {
    name,
    value,
    domain: String(fallbackHost || '').toLowerCase(),
    path: '/',
    secure: false,
    expires: null
  };
  for (const attr of parts.slice(1)) {
    const idx = attr.indexOf('=');
    const key = (idx < 0 ? attr : attr.slice(0, idx)).trim().toLowerCase();
    const val = idx < 0 ? '' : attr.slice(idx + 1).trim();
    if (key === 'domain') rec.domain = val.replace(/^\./, '').toLowerCase();
    else if (key === 'path') rec.path = val || '/';
    else if (key === 'secure') rec.secure = true;
    else if (key === 'expires') {
      const t = Date.parse(val);
      if (Number.isFinite(t)) rec.expires = t;
    } else if (key === 'max-age') {
      const n = Number(val);
      if (Number.isFinite(n)) rec.expires = Date.now() + n * 1000;
    }
  }
  if (name.startsWith('__Host-')) {
    rec.domain = String(fallbackHost || rec.domain).toLowerCase();
    rec.path = '/';
    rec.secure = true;
  }
  if (!isGoogleCookieDomain(rec.domain)) return null;
  return rec;
}

export class CookieJar {
  constructor() {
    this.items = new Map();
  }

  ingest(setCookieHeaders, requestUrl) {
    let host = 'labs.google';
    try {
      host = new URL(requestUrl).hostname;
    } catch { /* keep default */ }
    for (const raw of setCookieHeaders || []) {
      const parsed = parseSetCookie(raw, host);
      if (parsed) this.items.set(keyOf(parsed), parsed);
    }
  }

  ingestCdpCookies(list) {
    for (const cookie of list || []) {
      if (!cookie || !cookie.name) continue;
      const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
      if (!isGoogleCookieDomain(domain)) continue;
      const expires = normalizeExpires(cookie.expires);
      if (expires && expires < Date.now()) continue;
      const rec = {
        name: cookie.name,
        value: cookie.value || '',
        domain,
        path: cookie.path || '/',
        secure: !!cookie.secure,
        expires
      };
      this.items.set(keyOf(rec), rec);
    }
  }

  headerFor(urlString) {
    let host = '';
    let path = '/';
    try {
      const url = new URL(urlString);
      host = url.hostname.toLowerCase();
      path = url.pathname || '/';
    } catch {
      return '';
    }
    const parts = [];
    for (const rec of this.items.values()) {
      if (rec.expires && rec.expires < Date.now()) continue;
      if (!domainMatches(rec.domain, host)) continue;
      if (!pathMatches(rec.path, path)) continue;
      parts.push(`${rec.name}=${rec.value}`);
    }
    return parts.join('; ');
  }

  stats() {
    const names = [];
    const hosts = new Set();
    for (const rec of this.items.values()) {
      names.push(rec.name);
      hosts.add(rec.domain);
    }
    names.sort();
    return { count: this.items.size, names, hosts: [...hosts].sort() };
  }
}
