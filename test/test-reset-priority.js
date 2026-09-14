import assert from 'node:assert/strict';
import quotaManager from '../src/auth/quota_manager.js';
import { sortEntriesByResetTime } from '../src/auth/token_manager.js';
import { StrategyFactory } from '../src/auth/token_rotation_strategy.js';

const originalCache = new Map(quotaManager.cache);
const now = Date.parse('2026-08-25T10:00:00Z');
const modelId = 'gemini-3.7-flash-tiered';

function entry(tokenId) {
  return { tokenId, token: { email: tokenId } };
}

try {
  quotaManager.cache.clear();
  quotaManager.cache.set('late', {
    models: { 'gemini-2.5-flash': { r: 0.9, t: '2026-08-25T14:00:00Z' } }
  });
  quotaManager.cache.set('soon', {
    models: { 'gemini-2.5-flash': { r: 0.4, t: '2026-08-25T10:30:00Z' } }
  });
  quotaManager.cache.set('expired', {
    models: { 'gemini-2.5-flash': { r: 0.1, t: '2026-08-25T09:00:00Z' } }
  });
  quotaManager.cache.set('unknown', { models: {} });

  const sorted = sortEntriesByResetTime(
    [entry('late'), entry('expired'), entry('unknown'), entry('soon')],
    modelId,
    now
  ).map((item) => item.tokenId);

  assert.deepEqual(sorted, ['soon', 'late', 'unknown', 'expired']);
  assert.deepEqual(
    sortEntriesByResetTime([entry('soon')], modelId, now).map((item) => item.tokenId),
    ['soon']
  );

  quotaManager.cache.clear();
  quotaManager.cache.set('weekly-late', {
    models: { 'gemini-2.5-flash': { r: 0.9, t: '2026-08-25T10:15:00Z' } },
    weeklyResetTimes: { gemini: '2026-08-31T10:00:00Z' }
  });
  quotaManager.cache.set('weekly-soon', {
    models: { 'gemini-2.5-flash': { r: 0.2, t: '2026-08-25T16:00:00Z' } },
    weeklyResetTimes: { gemini: '2026-08-25T12:00:00Z' }
  });
  quotaManager.cache.set('session-only', {
    models: { 'gemini-2.5-flash': { r: 0.8, t: '2026-08-25T10:10:00Z' } }
  });

  const weeklySorted = sortEntriesByResetTime(
    [entry('session-only'), entry('weekly-late'), entry('weekly-soon')],
    modelId,
    now
  ).map((item) => item.tokenId);
  assert.deepEqual(weeklySorted, ['weekly-soon', 'session-only', 'weekly-late']);

  quotaManager.cache.clear();
  quotaManager.cache.set('far-a', {
    models: { 'gemini-2.5-flash': { r: 0.2, t: '2026-08-25T11:00:00Z' } },
    weeklyResetTimes: { gemini: '2026-08-31T10:00:00Z' },
    weeklyRemaining: { gemini: 0.8 }
  });
  quotaManager.cache.set('far-b', {
    models: { 'gemini-2.5-flash': { r: 0.9, t: '2026-08-25T10:20:00Z' } },
    weeklyResetTimes: { gemini: '2026-09-01T10:00:00Z' },
    weeklyRemaining: { gemini: 0.7 }
  });
  quotaManager.cache.set('weekly-dead', {
    models: { 'gemini-2.5-flash': { r: 0.95, t: '2026-08-25T10:05:00Z' } },
    weeklyResetTimes: { gemini: '2026-08-31T08:00:00Z' },
    weeklyRemaining: { gemini: 0.01 }
  });

  const mixedSorted = sortEntriesByResetTime(
    [entry('far-a'), entry('weekly-dead'), entry('far-b')],
    modelId,
    now
  ).map((item) => item.tokenId);
  assert.deepEqual(mixedSorted, ['far-a', 'far-b', 'weekly-dead']);

  quotaManager.cache.clear();
  quotaManager.cache.set('near-reset-a', {
    models: { 'gemini-2.5-flash': { r: 0.8, t: '2026-08-25T11:00:00Z' } },
    weeklyResetTimes: { gemini: '2026-08-28T02:47:00Z' },
    weeklyRemaining: { gemini: 0.46 }
  });
  quotaManager.cache.set('near-reset-b', {
    models: { 'gemini-2.5-flash': { r: 0.8, t: '2026-08-25T12:00:00Z' } },
    weeklyResetTimes: { gemini: '2026-08-28T15:11:00Z' },
    weeklyRemaining: { gemini: 0.48 }
  });
  quotaManager.cache.set('later-reset', {
    models: { 'gemini-2.5-flash': { r: 0.8, t: '2026-08-25T10:30:00Z' } },
    weeklyResetTimes: { gemini: '2026-08-30T02:15:00Z' },
    weeklyRemaining: { gemini: 0.6 }
  });

  const gapSorted = sortEntriesByResetTime(
    [entry('later-reset'), entry('near-reset-b'), entry('near-reset-a')],
    modelId,
    now
  ).map((item) => item.tokenId);
  assert.deepEqual(gapSorted, ['near-reset-a', 'near-reset-b', 'later-reset']);

  quotaManager.cache.set('weekly-late', {
    models: { 'gemini-2.5-flash': { r: 0.9, t: '2026-08-25T10:15:00Z' } },
    weeklyResetTimes: { gemini: '2026-08-31T10:00:00Z' }
  });
  quotaManager.cache.set('weekly-soon', {
    models: { 'gemini-2.5-flash': { r: 0.2, t: '2026-08-25T16:00:00Z' } },
    weeklyResetTimes: { gemini: '2026-08-25T12:00:00Z' }
  });
  quotaManager.cache.set('session-only', {
    models: { 'gemini-2.5-flash': { r: 0.8, t: '2026-08-25T10:10:00Z' } }
  });

  const strategy = StrategyFactory.create('round_robin');
  const rrEntries = sortEntriesByResetTime(
    [entry('weekly-late'), entry('weekly-soon'), entry('session-only')],
    modelId,
    now
  );
  const picked = Array.from({ length: 6 }, () => strategy.selectToken(rrEntries).tokenId);
  assert.deepEqual(picked, [
    'weekly-soon',
    'session-only',
    'weekly-late',
    'weekly-soon',
    'session-only',
    'weekly-late'
  ]);

  console.log('reset-priority sort passed');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  quotaManager.cache.clear();
  for (const [key, value] of originalCache) {
    quotaManager.cache.set(key, value);
  }
  process.exit(process.exitCode || 0);
}
