import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizePriorityAccountIds } from '../src/utils/utils.js';
import config, { buildConfig, saveConfigJson, getConfigJson } from '../src/config/config.js';
import { TokenManager, RotationStrategy } from '../src/auth/token_manager.js';
import tokenManager from '../src/auth/token_manager.js';
import { reloadConfig } from '../src/utils/configReloader.js';

async function runTests() {
  console.log('=== 开始优先账号边界与自验测试 ===\n');

  // 1. normalizePriorityAccountIds 单元测试：脏数据、空白、trim、非字符串、去重
  console.log('测试 1: normalizePriorityAccountIds 规范化与去重');
  const dirtyInput = ['  id-1 ', '', '   ', null, undefined, 123, {}, 'id-2', 'id-1', '  id-2  ', 'id-3'];
  const cleaned = normalizePriorityAccountIds(dirtyInput);
  assert.deepEqual(cleaned, ['id-1', 'id-2', 'id-3']);
  assert.deepEqual(normalizePriorityAccountIds(null), []);
  assert.deepEqual(normalizePriorityAccountIds(undefined), []);
  assert.deepEqual(normalizePriorityAccountIds('not-array'), []);
  assert.deepEqual(normalizePriorityAccountIds([]), []);
  console.log('✓ 测试 1 通过');

  // 2. buildConfig 边界测试：空值过滤与去重
  console.log('测试 2: buildConfig 构造配置中的 priorityAccountIds 规范化');
  const builtCfg = buildConfig({
    rotation: {
      strategy: 'round_robin',
      priorityAccountIds: ['  account-a ', 'account-b', 'account-a', '', 123]
    }
  });
  assert.deepEqual(builtCfg.rotation.priorityAccountIds, ['account-a', 'account-b']);
  console.log('✓ 测试 2 通过');

  // 3. 通用配置热刷新 (reloadConfig) 能够同步刷新 tokenManager 内存中的 priorityAccountIds 与策略
  console.log('测试 3: reloadConfig 热刷新同步 tokenManager 内存');
  const originalJson = getConfigJson();
  try {
    // 写入新的 rotation 配置
    saveConfigJson({
      rotation: {
        strategy: 'round_robin',
        requestCount: 15,
        priorityAccountIds: ['  fresh-p1 ', 'fresh-p2', 'fresh-p1']
      }
    });

    // 触发 reloadConfig（模拟 PUT /config 或 PUT /rotation）
    reloadConfig();

    const rotationCfg = tokenManager.getRotationConfig();
    assert.equal(rotationCfg.strategy, 'round_robin');
    assert.equal(rotationCfg.requestCount, 15);
    assert.deepEqual(rotationCfg.priorityAccountIds, ['fresh-p1', 'fresh-p2']);
    console.log('✓ 测试 3 通过');
  } finally {
    saveConfigJson(originalJson);
    reloadConfig();
  }

  // 4. 删除账号时清理内存与持久化配置中的 priorityAccountIds
  console.log('测试 4: deleteTokenById 同步清理内存与持久化配置中的优先账号');
  const tempFilePath = `/tmp/test-delete-account-${Date.now()}.json`;
  const customManager = new TokenManager(tempFilePath);
  customManager.store.getSalt = async () => 'test-salt-bound';
  customManager.lifecycle.isExpired = () => false;

  const mockTokens = [
    { refresh_token: 'rf-del-1', access_token: 'acc-del-1', sessionId: 's-1', enable: true },
    { refresh_token: 'rf-del-2', access_token: 'acc-del-2', sessionId: 's-2', enable: true }
  ];

  await customManager.store._ensureFileExists();
  const tid1 = await customManager.pool.generateTokenId(mockTokens[0]);
  const tid2 = await customManager.pool.generateTokenId(mockTokens[1]);

  await customManager.pool.add(mockTokens[0]);
  await customManager.pool.add(mockTokens[1]);
  await customManager.store.writeAll(mockTokens);

  // 设置优先账号列表包含 tid1 和 tid2
  customManager.priorityAccountIds = [tid1, tid2];

  // 同时在 config.json 模拟存在 tid1 和 tid2
  const currentConfigBefore = getConfigJson();
  saveConfigJson({
    rotation: {
      strategy: 'round_robin',
      priorityAccountIds: [tid1, tid2]
    }
  });

  try {
    const deleteResult = await customManager.deleteTokenById(tid1);
    assert.equal(deleteResult.success, true);
    // 内存中的 priorityAccountIds 已移除 tid1
    assert.deepEqual(customManager.priorityAccountIds, [tid2]);

    // 持久化配置中的 priorityAccountIds 也已移除 tid1
    const currentConfigAfter = getConfigJson();
    assert.deepEqual(currentConfigAfter.rotation.priorityAccountIds, [tid2]);
    console.log('✓ 测试 4 通过');
  } finally {
    saveConfigJson(currentConfigBefore);
    reloadConfig();
    try {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    } catch {}
  }

  console.log('\n✅ 优先账号边界修复所有测试全部通过！');
}

try {
  await runTests();
  process.exit(0);
} catch (err) {
  console.error('❌ 测试失败:', err);
  process.exit(1);
}
