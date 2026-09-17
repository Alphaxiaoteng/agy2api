/**
 * 回归测试：Token 刷新必须按 tokenId 合并并发请求（防惊群）。
 *
 * 事故背景：多个并发请求同时选中同一个临近过期的 token 时，各自独立调用
 * refreshToken，会对同一 refresh_token 并发打 OAuth 端点。提供方轮换
 * refresh_token 时先到的那次会让旧值失效，后到的并发请求因此拿到 400/403，
 * 被 token_manager 误判为凭证失效而 disableToken —— 一个健康账号被并发打挂。
 *
 * 运行：node test/test-refresh-dedupe.js
 */
import { strict as assert } from 'assert';
import requesterManager from '../src/utils/requesterManager.js';
import TokenLifecycleManager from '../src/auth/token_lifecycle_manager.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${name}\n    ${err.message}`);
  }
}

const originalFetch = requesterManager.fetch;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 统计对上游的调用次数，并模拟一个"慢"的刷新端点 */
function stubFetch({ delay = 40, fail = null } = {}) {
  const state = { calls: 0 };
  requesterManager.fetch = async () => {
    state.calls += 1;
    await sleep(delay);
    if (fail) {
      const err = new Error(fail);
      err.status = 400;
      throw err;
    }
    return { data: { access_token: `at-${state.calls}`, expires_in: 3600 } };
  };
  return state;
}

async function main() {
  // ── 用例 1：同一 tokenId 的 5 个并发刷新，只应打 1 次上游 ────────────────
  await check('同一 tokenId 并发 5 次刷新只请求上游 1 次', async () => {
    const state = stubFetch();
    const mgr = new TokenLifecycleManager({});
    const token = { refresh_token: 'r1', timestamp: 0, expires_in: 0 };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => mgr.refreshToken(token, 'acc-1', true))
    );

    assert.strictEqual(state.calls, 1, `上游应只被调用 1 次，实际 ${state.calls} 次`);
    assert.strictEqual(results.length, 5);
    for (const r of results) assert.strictEqual(r, token, '并发调用应共享同一个 token 结果');
    assert.strictEqual(token.access_token, 'at-1', 'token 应已被刷新');
    assert.strictEqual(mgr._inflightRefresh.size, 0, '刷新完成后 in-flight 表应清空');
  });

  // ── 用例 2：不同 tokenId 不得被错误合并 ────────────────────────────────
  await check('不同 tokenId 的并发刷新各自请求上游（不误合并）', async () => {
    const state = stubFetch();
    const mgr = new TokenLifecycleManager({});
    const a = { refresh_token: 'ra', timestamp: 0, expires_in: 0 };
    const b = { refresh_token: 'rb', timestamp: 0, expires_in: 0 };

    await Promise.all([
      mgr.refreshToken(a, 'acc-a', true),
      mgr.refreshToken(b, 'acc-b', true)
    ]);

    assert.strictEqual(state.calls, 2, `两个账号应各刷一次，实际 ${state.calls} 次`);
  });

  // ── 用例 3：刷新失败时全部调用方收到异常，且 in-flight 表被清理 ──────────
  await check('刷新失败时所有并发调用方都收到异常且不泄漏 in-flight 记录', async () => {
    const state = stubFetch({ fail: 'invalid_grant' });
    const mgr = new TokenLifecycleManager({});
    const token = { refresh_token: 'rx', timestamp: 0, expires_in: 0 };

    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, () => mgr.refreshToken(token, 'acc-x', true))
    );

    assert.strictEqual(state.calls, 1, `失败也只应打 1 次上游，实际 ${state.calls} 次`);
    assert.ok(settled.every((s) => s.status === 'rejected'), '所有调用方都应收到拒绝');
    assert.strictEqual(mgr._inflightRefresh.size, 0, '失败后 in-flight 表也必须清空（否则永久卡死）');
  });

  // ── 用例 4：失败后允许重试（证明 in-flight 清理生效）────────────────────
  await check('失败后的下一次刷理会重新请求上游', async () => {
    const state = stubFetch({ fail: 'temporary' });
    const mgr = new TokenLifecycleManager({});
    const token = { refresh_token: 'ry', timestamp: 0, expires_in: 0 };

    await mgr.refreshToken(token, 'acc-y', true).catch(() => {});
    await mgr.refreshToken(token, 'acc-y', true).catch(() => {});

    assert.strictEqual(state.calls, 2, `两次独立刷新应各打一次上游，实际 ${state.calls} 次`);
  });

  // ── 用例 5：刷新后 token 不再过期 ──────────────────────────────────────
  await check('刷新成功后同 token 的 isExpired 翻转为 false', async () => {
    stubFetch();
    const mgr = new TokenLifecycleManager({});
    const token = { refresh_token: 'rz', timestamp: 0, expires_in: 0 };
    assert.strictEqual(mgr.isExpired(token), true, '刷新前应判定为过期');

    await mgr.refreshToken(token, 'acc-z', true);
    assert.strictEqual(mgr.isExpired(token), false, '刷新后不应再判定为过期');
  });

  requesterManager.fetch = originalFetch;

  if (failures > 0) {
    console.error(`\n${failures} 项失败：并发刷新仍未合并，存在把健康账号并发打挂的风险。`);
    process.exit(1);
  }
  console.log('\n全部通过：并发刷新已按 tokenId 合并，失败路径不泄漏 in-flight 记录。');
  process.exit(0);
}

main();
