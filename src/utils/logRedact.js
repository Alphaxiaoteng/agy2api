/**
 * 日志敏感信息脱敏
 */
const SECRET_PATTERNS = [
  /ya29\.[A-Za-z0-9._-]+/g,
  /1\/\/[A-Za-z0-9._-]+/g,
  /"(refresh_token|access_token|id_token|api_key|apiKey)"\s*:\s*"[^"]+"/gi,
  /Bearer\s+[A-Za-z0-9._-]+/gi,
  /sk-[A-Za-z0-9._-]{8,}/g
];

export function redactSecrets(text) {
  if (text === null || text === undefined) return '';
  let out = typeof text === 'string' ? text : String(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      if (/^Bearer\s+/i.test(match)) return 'Bearer ***';
      if (/^"[^"]+"\s*:/.test(match)) return match.replace(/:\s*"[^"]+"/, ': "***"');
      if (match.startsWith('sk-')) return 'sk-***';
      if (match.startsWith('ya29.')) return 'ya29.***';
      if (match.startsWith('1//')) return '1//***';
      return '***';
    });
  }
  return out;
}

export function redactArgs(args) {
  return args.map((arg) => {
    if (typeof arg === 'string') return redactSecrets(arg);
    if (typeof arg === 'object' && arg !== null) {
      try {
        return redactSecrets(JSON.stringify(arg));
      } catch {
        return '[object]';
      }
    }
    return arg;
  });
}
