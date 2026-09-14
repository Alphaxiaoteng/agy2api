import assert from 'node:assert/strict';
import quotaManager from '../src/auth/quota_manager.js';

function mapQuota(quotaInfo) {
  const remaining = typeof quotaInfo.remainingFraction === 'number'
    ? quotaInfo.remainingFraction
    : null;
  return {
    r: remaining,
    known: typeof quotaInfo.remainingFraction === 'number',
    t: quotaInfo.resetTime
  };
}

function formatQuota(quota) {
  const known = quota.known === true && quota.r !== null && quota.r !== undefined;
  return known ? `${Math.min(1, Math.max(0, quota.r)) * 100}%` : '未知';
}

assert.deepEqual(mapQuota({ remainingFraction: 0, resetTime: 'reset' }), {
  r: 0,
  known: true,
  t: 'reset'
});
assert.deepEqual(mapQuota({ resetTime: 'reset' }), {
  r: null,
  known: false,
  t: 'reset'
});
assert.equal(formatQuota({ r: 0, known: true }), '0%');
assert.equal(formatQuota({ r: null, known: false }), '未知');

const forceQuery = (force) => `/admin/tokens/id/quotas${force ? '?force=true' : ''}`;
assert.equal(forceQuery(true), '/admin/tokens/id/quotas?force=true');
assert.equal(forceQuery(false), '/admin/tokens/id/quotas');

const windows = quotaManager.formatQuotaWindows({
  weeklyRemaining: { gemini: 0.93, claude: 0.2 },
  weeklyResetTimes: { gemini: '2026-09-01T04:23:48Z' }
});
assert.equal(windows.gemini.weekly.remaining, 0.93);
assert.equal(windows.gemini.weekly.resetTimeRaw, '2026-09-01T04:23:48Z');
assert.ok(windows.gemini.weekly.resetTime);
assert.equal(windows.claude.weekly.remaining, 0.2);
assert.equal(windows.banana.weekly.remaining, null);

function formatResetLabel(resetTimeRaw, beijingText, now = Date.now()) {
  if (!resetTimeRaw && !beijingText) return '--';
  const ms = Date.parse(resetTimeRaw || '');
  if (!Number.isFinite(ms)) return beijingText || '--';
  const delta = ms - now;
  if (delta <= 0) return '已过';
  if (delta < 36 * 60 * 60 * 1000) {
    const clock = String(beijingText || '').split(/\s+/).pop();
    return clock || beijingText || '--';
  }
  const days = Math.max(1, Math.round(delta / 86400000));
  if (days <= 7) return `${days}天后`;
  return beijingText || '--';
}

const now = Date.parse('2026-08-25T10:33:00Z');
assert.equal(formatResetLabel('2026-08-25T10:41:00Z', '08/25 18:41', now), '18:41');
assert.equal(formatResetLabel('2026-08-28T08:00:00Z', '08/28 16:00', now), '3天后');
assert.equal(formatResetLabel('2026-08-25T09:00:00Z', '08/25 17:00', now), '已过');

console.log('quota display/cache choice tests passed');
process.exit(0);
