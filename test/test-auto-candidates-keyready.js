/**
 * 回归测试：Auto 候选池不得包含「没有 key 的必需 key 渠道」。
 *
 * 事故背景：bailian / tongyi-tp 等需要 key 的 provider 被排在 AUTO 候选最前面，
 * 未配置 key 时每个 auto 请求都要先空跑这些必败候选（空 Bearer → 上游 401），
 * 白占候选名额、污染健康统计并抬高首字延迟。
 *
 * 断言：返回的候选里，每个要么是 keyless，要么其 provider 确实有可用 key。
 * 这样测试不依赖本机具体配了哪些 key。
 *
 * 运行：node test/test-auto-candidates-keyready.js
 */
import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  getOrderedAutoCandidates,
  loadProviderKeys
} from '../src/services/freeModelUpstream.js';

// 不需要 key 的 provider（上游匿名放行）。来源：freeModelUpstream.js 中
// PROVIDER_DEFINITIONS 里标了 `keyless: true` 的条目。下面有一条断言会
// 用源码交叉校验这个清单，新增 keyless provider 时测试会主动报错提醒更新。
const KEYLESS_PROVIDERS = new Set(['opencode-free']);

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`✗ ${name}\n    ${err.message}`);
  }
}

const candidates = getOrderedAutoCandidates();
const keys = loadProviderKeys();

check('keyless 清单与源码一致（防止清单腐化）', () => {
  const src = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'src/services/freeModelUpstream.js'),
    'utf8'
  );
  // 只统计 PROVIDER_DEFINITIONS 块内的 keyless 标记：resolveFreeProvider 里
  // 也会为 `-free` 模型返回带 keyless 的描述对象，全局计数会把它算进来。
  const from = src.indexOf('const PROVIDER_DEFINITIONS');
  const to = src.indexOf('AUTO_POOL_CANDIDATES');
  assert.ok(from > -1 && to > from, '未能在源码中定位 PROVIDER_DEFINITIONS 块');
  const declared = (src.slice(from, to).match(/keyless:\s*true/g) || []).length;
  assert.strictEqual(
    declared,
    KEYLESS_PROVIDERS.size,
    `PROVIDER_DEFINITIONS 中有 ${declared} 个 keyless provider，但清单里只有 ${KEYLESS_PROVIDERS.size} 个，请同步 KEYLESS_PROVIDERS`
  );
});

check('候选池非空（否则 auto 会直接 503）', () => {
  assert.ok(Array.isArray(candidates), '返回值应为数组');
  assert.ok(candidates.length > 0, '本机至少应有一个可用候选；若一个都没有，说明 key 全没配，属配置问题');
});

check('每个候选要么 keyless、要么 provider 已配置 key', () => {
  const bad = candidates.filter((c) => {
    const hasKey = Boolean(keys[c.providerId]);
    return !hasKey && !KEYLESS_PROVIDERS.has(c.providerId);
  });
  assert.deepStrictEqual(
    bad.map((c) => `${c.providerId}:${c.model}`),
    [],
    `以下候选缺 key 却仍进入候选池：${bad.map((c) => `${c.providerId}:${c.model}`).join(', ')}`
  );
});

check('候选优先级仍然有序（过滤不得打乱调度顺序）', () => {
  const priorities = candidates.map((c) => c.priority);
  const sorted = [...priorities].sort((a, b) => a - b);
  assert.deepStrictEqual(priorities, sorted, `优先级应保持升序，实际 ${priorities.join(',')}`);
});

check('候选不含重复的 provider:model 组合', () => {
  const seen = new Set();
  const dupes = [];
  for (const c of candidates) {
    const k = `${c.providerId}:${c.model}`;
    if (seen.has(k)) dupes.push(k);
    seen.add(k);
  }
  assert.deepStrictEqual(dupes, [], `存在重复候选：${dupes.join(', ')}`);
});

console.log(
  `\n本机候选池 ${candidates.length} 个：${candidates
    .map((c) => `${c.providerId}(p${c.priority})`)
    .join(' > ')}`
);

if (failures > 0) {
  console.error(`\n${failures} 项失败：Auto 候选池仍混入无 key 的渠道。`);
  process.exit(1);
}
console.log('全部通过：Auto 候选池只包含能真正发出请求的渠道。');
process.exit(0);
