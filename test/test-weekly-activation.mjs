import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { WeeklyActivationManager } from '../src/auth/weekly_activation_manager.js';

console.log('🧪 开始运行周额度重置自动激活算法测试...\n');

// 使用独立的临时测试存储文件
const tempStorage = path.join(process.cwd(), 'tmp', `test_weekly_activation_${Date.now()}.json`);
fs.mkdirSync(path.dirname(tempStorage), { recursive: true });

try {
  const manager = new WeeklyActivationManager({ filePath: tempStorage });

  console.log('--- 测试 1: 判定满额未激活场景 ---');
  const now = Date.now();
  const futureReset = new Date(now + 7 * 24 * 3600 * 1000).toISOString();

  const mockToken = { email: 'test1@example.com', enable: true, access_token: 'mock-token' };
  const mockQuotaFull = {
    weeklyResetTimes: { gemini: futureReset, claude: futureReset },
    weeklyRemaining: { gemini: 1.0, claude: 0.9995 }
  };

  const evalGemini1 = manager.evaluateActivationNeed('token1', mockToken, 'gemini', mockQuotaFull);
  assert.strictEqual(evalGemini1.shouldActivate, true, '满额且未记录周期时应该需要激活');
  console.log('✓ 满额未激活正确判定触发:', evalGemini1.reason);

  console.log('\n--- 测试 2: 记录激活后同一周期防重放 ---');
  manager.recordActivation('token1', 'test1@example.com', 'gemini', futureReset, true);
  const evalGemini2 = manager.evaluateActivationNeed('token1', mockToken, 'gemini', mockQuotaFull);
  assert.strictEqual(evalGemini2.shouldActivate, false, '同一周期已激活后绝不应重复触发');
  console.log('✓ 同一周期防重放验证通过');

  console.log('\n--- 测试 3: 旧周重置时间到期场景 ---');
  const pastReset = new Date(now - 3600 * 1000).toISOString(); // 1小时前到期
  const mockQuotaExpired = {
    weeklyResetTimes: { gemini: pastReset },
    weeklyRemaining: { gemini: 0.05 }
  };
  const evalGemini3 = manager.evaluateActivationNeed('token2', mockToken, 'gemini', mockQuotaExpired);
  assert.strictEqual(evalGemini3.shouldActivate, true, '旧周重置时间到期应判定需要激活');
  console.log('✓ 到期重置正确判定触发:', evalGemini3.reason);

  console.log('\n--- 测试 4: 处于使用中途 (< 99.9% 且未到期) 绝不误触 ---');
  const mockQuotaInUse = {
    weeklyResetTimes: { claude: futureReset },
    weeklyRemaining: { claude: 0.45 }
  };
  const evalClaude4 = manager.evaluateActivationNeed('token3', mockToken, 'claude', mockQuotaInUse);
  assert.strictEqual(evalClaude4.shouldActivate, false, '中途正常消耗不应触发激活');
  console.log('✓ 中途使用中不误触验证通过');

  console.log('\n--- 测试 5: Gemini 与 Claude 独立跟踪 ---');
  const mockMixed = {
    weeklyResetTimes: { gemini: pastReset, claude: futureReset },
    weeklyRemaining: { gemini: 1.0, claude: 0.50 }
  };
  const evalGemini5 = manager.evaluateActivationNeed('token4', mockToken, 'gemini', mockMixed);
  const evalClaude5 = manager.evaluateActivationNeed('token4', mockToken, 'claude', mockMixed);
  assert.strictEqual(evalGemini5.shouldActivate, true, 'Gemini 达到条件应触发');
  assert.strictEqual(evalClaude5.shouldActivate, false, 'Claude 未达条件不应触发');
  console.log('✓ 双模型组独立判断验证通过');

  console.log('\n--- 测试 6: 数据持久化与重新加载 ---');
  const managerReloaded = new WeeklyActivationManager({ filePath: tempStorage });
  const isAct = managerReloaded.isGroupActivatedForCycle('token1', 'gemini', futureReset);
  assert.strictEqual(isAct, true, '持久化数据重新加载后应保持已激活状态');
  console.log('✓ 状态持久化与重载验证通过');

  console.log('\n--- 测试 7: 5h 额度重置独立检测与 10 分钟间隔 ---');
  assert.strictEqual(manager.checkIntervalMs, 10 * 60 * 1000, '默认巡检间隔应为 10 分钟');
  const fiveHourReset = new Date(now + 5 * 3600 * 1000).toISOString();
  const mock5hFull = {
    weeklyResetTimes: { gemini: futureReset },
    weeklyRemaining: { gemini: 0.50 }, // 周额度在使用中
    sessionResetTimes: { gemini: fiveHourReset },
    sessionRemaining: { gemini: 1.0 } // 5h 额度刚刚重置满额
  };
  const eval5h = manager.evaluateActivationNeed('token5', mockToken, 'gemini', mock5hFull);
  assert.strictEqual(eval5h.shouldActivate, true, '当 5h 额度重置满额时即使周额度在使用中也应触发激活');
  assert.ok(eval5h.reason.includes('5h'), '触发原因应包含 5h 额度');
  console.log('✓ 5h 额度检测与 10 分钟巡检间隔验证通过:', eval5h.reason);

  console.log('\n🎉 WeeklyActivationManager 全部 7 项逻辑单元测试全部通过！\n');
  process.exit(0);
} finally {
  if (fs.existsSync(tempStorage)) {
    fs.unlinkSync(tempStorage);
  }
}
