import tokenManager from '../src/auth/token_manager.js';
import weeklyActivationManager from '../src/auth/weekly_activation_manager.js';
import quotaManager from '../src/auth/quota_manager.js';

console.log('🧪 开始对现有真实号池运行周额度重置自动激活扫描...\n');

async function run() {
  await tokenManager.getTokenList();
  const enabledIds = tokenManager.pool.getEnabledIds();
  console.log(`号池启用账号数: ${enabledIds.length}`);

  for (const id of enabledIds) {
    const t = tokenManager.pool.get(id);
    const q = quotaManager.cache.get(id);
    console.log(`- 账号: ${t.email}`);
    console.log(`  Gemini: remaining=${q?.weeklyRemaining?.gemini}, reset=${q?.weeklyResetTimes?.gemini}`);
    console.log(`  Claude: remaining=${q?.weeklyRemaining?.claude}, reset=${q?.weeklyResetTimes?.claude}`);
  }

  console.log('\n--- 触发 checkAndActivateAll() ---');
  await weeklyActivationManager.checkAndActivateAll(tokenManager);

  console.log('\n--- 扫描后状态快照 ---');
  const status = weeklyActivationManager.getStatus();
  console.log(JSON.stringify(status, null, 2));

  console.log('\n✓ 真实号池扫描与激活执行成功！\n');
  process.exit(0);
}

run().catch(err => {
  console.error('扫描异常:', err);
  process.exit(1);
});
