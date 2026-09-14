const KEEP_INFO = /失败|错误|过期|耗尽|封禁|拒绝|超时|timeout|ECONN|启动|关闭|清空|热重载|没有可用|Invalid API Key/i;

export function requestStoreLevel(status) {
  const code = Number(status) || 0;
  if (code >= 500) return 'error';
  if (code >= 400) return 'warn';
  return null;
}

export function shouldPersistUiLog(level, message) {
  if (level === 'error' || level === 'warn') return true;
  if (level === 'debug' || level === 'request') return false;
  if (level === 'info') return KEEP_INFO.test(String(message || ''));
  return false;
}

export function matchesLogLevel(entry, level) {
  const lv = entry?.level;
  if (!level || level === 'all') return true;
  if (level === 'core') return lv === 'warn' || lv === 'error';
  return lv === level;
}

export function filterLogEntries(entries, { level = 'all', search = '' } = {}) {
  const q = String(search || '').trim().toLowerCase();
  return (entries || []).filter((entry) => {
    if (!matchesLogLevel(entry, level)) return false;
    if (q && !String(entry.message || '').toLowerCase().includes(q)) return false;
    return true;
  });
}
