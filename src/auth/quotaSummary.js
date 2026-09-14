const WEEKLY_HORIZON_MS = 36 * 60 * 60 * 1000;

function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function coerceString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function quotaSummaryUrlFromModelsUrl(modelsUrl) {
  return String(modelsUrl || '').replace('fetchAvailableModels', 'retrieveUserQuotaSummary');
}

export function extractQuotaGroups(raw) {
  if (!raw || typeof raw !== 'object') return [];
  if (Array.isArray(raw.groups)) {
    return raw.groups.filter((group) => group && typeof group === 'object');
  }
  for (const key of ['response', 'summary']) {
    const wrapper = raw[key];
    if (wrapper && typeof wrapper === 'object' && Array.isArray(wrapper.groups)) {
      return wrapper.groups.filter((group) => group && typeof group === 'object');
    }
  }
  return [];
}

export function remainingFractionFromBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const direct = coerceNumber(bucket.remainingFraction) ?? coerceNumber(bucket.remaining_fraction);
  if (direct !== null) return direct;
  const remaining = bucket.remaining;
  if (!remaining || typeof remaining !== 'object') return null;
  const nested = coerceNumber(remaining.remainingFraction) ?? coerceNumber(remaining.remaining_fraction);
  if (nested !== null) return nested;
  if (String(remaining.case || '') === 'remainingFraction') {
    return coerceNumber(remaining.value);
  }
  return null;
}

export function resetTimeFromBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  for (const key of ['resetTime', 'reset_time', 'resetAt', 'reset_at']) {
    const value = coerceString(bucket[key]);
    if (value) return value;
  }
  return null;
}

function mapSummaryGroupKey(name) {
  const lower = String(name || '').toLowerCase();
  if (lower.includes('gemini')) return 'gemini';
  if (lower.includes('claude') || lower.includes('gpt')) return 'claude';
  return null;
}

export function classifyQuotaWindow(bucket, now = Date.now()) {
  const label = [
    coerceString(bucket?.bucketId),
    coerceString(bucket?.id),
    coerceString(bucket?.displayName),
    coerceString(bucket?.name),
    coerceString(bucket?.window)
  ].join(' ').toLowerCase();

  if (label.includes('week') || label.includes('7d') || label.includes('seven')) {
    return 'weekly';
  }
  if (
    label.includes('session')
    || label.includes('hour')
    || label.includes('five')
    || /\b5h\b/.test(label)
  ) {
    return 'session';
  }

  const resetMs = Date.parse(resetTimeFromBucket(bucket) || '');
  if (Number.isFinite(resetMs) && resetMs - now > WEEKLY_HORIZON_MS) {
    return 'weekly';
  }
  return 'session';
}

function recordFromBucket(bucket) {
  return {
    r: remainingFractionFromBucket(bucket),
    t: resetTimeFromBucket(bucket)
  };
}

/**
 * 解析 retrieveUserQuotaSummary。weekly 按模型组折叠；Gemini 周桶同时给 banana，Claude 周桶同时给 other。
 * @param {object} raw
 * @param {number} [now]
 * @returns {{weekly: Object, session: Object}}
 */
export function parseQuotaSummary(raw, now = Date.now()) {
  const weekly = {};
  const session = {};

  for (const group of extractQuotaGroups(raw)) {
    const groupKey = mapSummaryGroupKey(group.displayName || group.name);
    if (!groupKey) continue;
    const buckets = Array.isArray(group.buckets) ? group.buckets : [];
    for (const bucket of buckets) {
      if (!bucket || typeof bucket !== 'object' || bucket.disabled === true) continue;
      const period = classifyQuotaWindow(bucket, now);
      const target = period === 'weekly' ? weekly : session;
      if (!target[groupKey]) target[groupKey] = recordFromBucket(bucket);
    }
  }

  if (weekly.gemini && !weekly.banana) weekly.banana = { ...weekly.gemini };
  if (session.gemini && !session.banana) session.banana = { ...session.gemini };
  if (weekly.claude && !weekly.other) weekly.other = { ...weekly.claude };
  if (session.claude && !session.other) session.other = { ...session.claude };

  return { weekly, session };
}
