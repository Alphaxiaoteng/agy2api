import assert from 'node:assert/strict';
import { TokenManager, RotationStrategy } from '../src/auth/token_manager.js';
import { StrategyFactory } from '../src/auth/token_rotation_strategy.js';
import quotaManager from '../src/auth/quota_manager.js';
import tokenCooldownManager from '../src/auth/token_cooldown_manager.js';

// 保存原始状态
const originalQuotaCache = new Map(quotaManager.cache);
const originalCooldowns = new Map(tokenCooldownManager.cooldowns);

async function runTests() {
  console.log('=== 开始优先账号池单元测试 ===\n');

  const manager = new TokenManager('/tmp/test-priority-accounts.json');

  // 构造5个账号：两个优先账号 (p-1, p-2) 和三个普通账号 (n-1, n-2, n-3)
  const mockTokens = [
    { refresh_token: 'rf-p1', access_token: 'acc-p1', sessionId: 's-p1', enable: true, hasQuota: true },
    { refresh_token: 'rf-p2', access_token: 'acc-p2', sessionId: 's-p2', enable: true, hasQuota: true },
    { refresh_token: 'rf-n1', access_token: 'acc-n1', sessionId: 's-n1', enable: true, hasQuota: true },
    { refresh_token: 'rf-n2', access_token: 'acc-n2', sessionId: 's-n2', enable: true, hasQuota: true },
    { refresh_token: 'rf-n3', access_token: 'acc-n3', sessionId: 's-n3', enable: true, hasQuota: true }
  ];

  // 覆盖 store 的 salt 生成逻辑或直接初始化
  manager.store.getSalt = async () => 'test-salt-123456';
  manager.lifecycle.isExpired = () => false;

  await manager.store._ensureFileExists();
  const tidP1 = await manager.pool.generateTokenId(mockTokens[0]);
  const tidP2 = await manager.pool.generateTokenId(mockTokens[1]);
  const tidN1 = await manager.pool.generateTokenId(mockTokens[2]);
  const tidN2 = await manager.pool.generateTokenId(mockTokens[3]);
  const tidN3 = await manager.pool.generateTokenId(mockTokens[4]);

  // 模拟初始化
  manager._initialize = async () => {
    manager.pool.clear();
    manager.sessionAffinity.clear();
    for (const t of mockTokens) {
      await manager.pool.add(t);
    }
    manager.rotationStrategyName = RotationStrategy.ROUND_ROBIN;
    manager.strategy = StrategyFactory.create(RotationStrategy.ROUND_ROBIN);
    manager.priorityAccountIds = [tidP1, tidP2];
    manager._loadRotationConfig = () => {};
  };

  // 覆盖 validator 逻辑以纯依赖 pool/quota/cooldown 检查
  manager.validator.filterAvailableTokens = async (entries, modelId) => {
    return entries.filter(e => {
      const isEnabled = e.token.enable !== false;
      const hasQuota = quotaManager.hasQuotaForModel(e.tokenId, modelId);
      const isAvailable = tokenCooldownManager.isAvailable(e.tokenId, modelId);
      return isEnabled && hasQuota && isAvailable;
    });
  };
  manager.validator.canUseForModel = async (token, modelId) => {
    const tid = await manager.getTokenId(token);
    return token.enable !== false &&
      quotaManager.hasQuotaForModel(tid, modelId) &&
      tokenCooldownManager.isAvailable(tid, modelId);
  };

  await manager._ensureInitialized();

  // 1. 两个优先账号均可用时，只选优先池且公平轮询
  console.log('测试 1: 两个优先账号均可用时只选优先池且公平轮询');
  const picks1 = [];
  for (let i = 0; i < 6; i++) {
    const t = await manager.getToken('claude-3-5-sonnet');
    picks1.push(t.access_token);
  }
  // p1 和 p2 都在优先池中，公平交替轮询
  assert.deepEqual(picks1, ['acc-p1', 'acc-p2', 'acc-p1', 'acc-p2', 'acc-p1', 'acc-p2']);
  console.log('✓ 测试 1 通过');

  // 2. 一个优先不可用（例如 p1 禁用）时选另一个优先账号 (p2)
  console.log('测试 2: 一个优先不可用时选另一个');
  manager.pool.disable(tidP1);
  const picks2 = [];
  for (let i = 0; i < 4; i++) {
    const t = await manager.getToken('claude-3-5-sonnet');
    picks2.push(t.access_token);
  }
  assert.deepEqual(picks2, ['acc-p2', 'acc-p2', 'acc-p2', 'acc-p2']);
  console.log('✓ 测试 2 通过');

  // 3. 优先池全不可用时（p2 也进入冷却），普通池兜底
  console.log('测试 3: 优先池全不可用时普通池兜底');
  tokenCooldownManager.setCooldown(tidP2, 'claude-3-5-sonnet', Date.now() + 60000);
  const picks3 = [];
  for (let i = 0; i < 6; i++) {
    const t = await manager.getToken('claude-3-5-sonnet');
    picks3.push(t.access_token);
  }
  // 普通池包含 n1, n2, n3 轮询
  assert.equal(picks3.filter(x => ['acc-p1', 'acc-p2'].includes(x)).length, 0);
  assert.equal(new Set(picks3).size, 3);
  console.log('✓ 测试 3 通过');

  // 4. 优先账号恢复后重新优先
  console.log('测试 4: 优先账号恢复后重新优先');
  tokenCooldownManager.clearCooldown(tidP2, 'claude-3-5-sonnet'); // 恢复 p2 冷却
  const pick4Single = await manager.getToken('claude-3-5-sonnet');
  assert.equal(pick4Single.access_token, 'acc-p2');
  manager.pool.enable(tidP1); // 恢复 p1
  const picks4 = [];
  for (let i = 0; i < 4; i++) {
    const t = await manager.getToken('claude-3-5-sonnet');
    picks4.push(t.access_token);
  }
  assert.equal(picks4.filter(x => x === 'acc-p1').length, 2);
  assert.equal(picks4.filter(x => x === 'acc-p2').length, 2);
  console.log('✓ 测试 4 通过');

  // 5. exclude 当前优先账号时仍能选另一个或兜底
  console.log('测试 5: exclude 当前优先账号时仍能选另一个或兜底');
  // 两个优先都在，exclude p1，应选 p2
  const retryPick1 = await manager.getTokenForRetry('claude-3-5-sonnet', tidP1);
  assert.equal(retryPick1.access_token, 'acc-p2');

  // 此时若 p2 不可用，exclude p1 则优先池无可用候选，自动降级普通池
  tokenCooldownManager.setCooldown(tidP2, 'claude-3-5-sonnet', Date.now() + 60000);
  const retryPick2 = await manager.getTokenForRetry('claude-3-5-sonnet', tidP1);
  assert.ok(['acc-n1', 'acc-n2', 'acc-n3'].includes(retryPick2.access_token));
  tokenCooldownManager.clearCooldown(tidP2, 'claude-3-5-sonnet');
  console.log('✓ 测试 5 通过');

  // 6. ��型组额度/冷却独立
  console.log('测试 6: 模型组额度/冷却独立');
  // 设置 p1 在 claude 组冷却，但在 gemini 组正常
  tokenCooldownManager.setCooldown(tidP1, 'claude-3-5-sonnet', Date.now() + 60000);
  const claudePick = await manager.getToken('claude-3-5-sonnet');
  assert.equal(claudePick.access_token, 'acc-p2'); // claude 选 p2

  // 请求 gemini 模型，p1 仍可用，因此优先池包含 p1 和 p2
  const geminiPicks = [];
  for (let i = 0; i < 4; i++) {
    const t = await manager.getToken('gemini-3.7-flash-tiered');
    geminiPicks.push(t.access_token);
  }
  assert.equal(geminiPicks.filter(x => x === 'acc-p1').length, 2);
  assert.equal(geminiPicks.filter(x => x === 'acc-p2').length, 2);
  tokenCooldownManager.clearCooldown(tidP1, 'claude-3-5-sonnet');
  console.log('✓ 测试 6 通过');

  // 7. Session affinity 在优先池生效
  console.log('测试 7: Session affinity 在优先池生效');
  const sessionToken1 = await manager.getToken('claude-3-5-sonnet', 'user-sess-1');
  const sessionToken2 = await manager.getToken('claude-3-5-sonnet', 'user-sess-1');
  assert.equal(sessionToken1.access_token, sessionToken2.access_token);
  console.log('✓ 测试 7 通过');

  console.log('\n✅ 所有优先账号池单元测试均顺利通过！');
}

try {
  await runTests();
  process.exit(0);
} catch (err) {
  console.error('❌ 测试失败:', err);
  process.exit(1);
} finally {
  quotaManager.cache.clear();
  for (const [k, v] of originalQuotaCache) {
    quotaManager.cache.set(k, v);
  }
  tokenCooldownManager.cooldowns.clear();
  for (const [k, v] of originalCooldowns) {
    tokenCooldownManager.cooldowns.set(k, v);
  }
}
