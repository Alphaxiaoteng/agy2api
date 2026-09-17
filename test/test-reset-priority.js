import assert from 'node:assert/strict';
import quotaManager from '../src/auth/quota_manager.js';
import { sortEntriesByResetTime, filterTopPriorityTier } from '../src/auth/token_manager.js';
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

  // 测试高优分层隔离：3个15小时内重置账号必须被严格隔离，绝不泄漏至2天与4天账号
  quotaManager.cache.clear();
  const testNow = Date.parse('2026-09-16T02:00:00Z');
  const claudeModel = 'claude-sonnet-4-6-thinking';

  // 3个15小时重置账号
  quotaManager.cache.set('chenpaiteng', {
    models: { [claudeModel]: { r: 0.5, t: '2026-09-16T03:21:00Z' } },
    weeklyResetTimes: { claude: '2026-09-16T16:27:00Z' }, // 14h27m
    weeklyRemaining: { claude: 0.29 }
  });
  quotaManager.cache.set('sokinaskhatun', {
    models: { [claudeModel]: { r: 0.5, t: '2026-09-16T06:35:00Z' } },
    weeklyResetTimes: { claude: '2026-09-16T17:21:00Z' }, // 15h21m
    weeklyRemaining: { claude: 0.39 }
  });
  quotaManager.cache.set('pksbuss', {
    models: { [claudeModel]: { r: 0.5, t: '2026-09-16T05:36:00Z' } },
    weeklyResetTimes: { claude: '2026-09-16T17:21:00Z' }, // 15h21m
    weeklyRemaining: { claude: 0.67 }
  });

  // 2天与4天账号
  quotaManager.cache.set('bejeje92', {
    models: { [claudeModel]: { r: 0.89, t: '2026-09-16T03:29:00Z' } },
    weeklyResetTimes: { claude: '2026-09-18T15:14:00Z' }, // 2d 13h
    weeklyRemaining: { claude: 0.96 }
  });
  quotaManager.cache.set('quanghuychuong', {
    models: { [claudeModel]: { r: 0.5, t: '2026-09-16T03:53:00Z' } },
    weeklyResetTimes: { claude: '2026-09-20T02:15:00Z' }, // 4d
    weeklyRemaining: { claude: 0.54 }
  });

  const allFive = [
    entry('bejeje92'),
    entry('quanghuychuong'),
    entry('chenpaiteng'),
    entry('sokinaskhatun'),
    entry('pksbuss')
  ];

  const topTier = filterTopPriorityTier(allFive, claudeModel, testNow).map(e => e.tokenId);
  assert.deepEqual(topTier, ['chenpaiteng', 'pksbuss', 'sokinaskhatun']);

  // 验证轮询只在这3个15小时账号之间轮转，绝不会选到 bejeje92 或 quanghuychuong
  const rrPicked = Array.from({ length: 9 }, () => strategy.selectToken(
    filterTopPriorityTier(allFive, claudeModel, testNow)
  ).tokenId);
  assert.ok(rrPicked.every(id => ['chenpaiteng', 'sokinaskhatun', 'pksbuss'].includes(id)));
  assert.ok(!rrPicked.includes('bejeje92'));
  assert.ok(!rrPicked.includes('quanghuychuong'));

  // 只有当3个15小时账号全部不可用时，才降级到 bejeje92（2天账号优先于4天账号）
  const fallbackTier = filterTopPriorityTier([entry('bejeje92'), entry('quanghuychuong')], claudeModel, testNow).map(e => e.tokenId);
  assert.deepEqual(fallbackTier, ['bejeje92']);

  console.log('reset-priority sort & tier isolation passed');
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
