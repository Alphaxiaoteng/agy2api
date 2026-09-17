/**
 * 回归测试：签名缓存目录必须自我回收，不能随会话数无界增长。
 *
 * 事故背景：缓存文件按 (model, sessionId) 建，环形队列只限制「单文件内 3 条」，
 * 每个新会话都会留下一个几乎不再被读到的文件，实测累积到 650 个 / 19MB。
 *
 * 验证方式：把工作目录切到临时目录再加载模块（CACHE_DIR 是相对 process.cwd()
 * 计算的），这样测试完全不会碰到真实的 data/signature-cache。
 *
 * 运行：node test/test-signature-cache-prune.js
 */
import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sigcache-'));
const CACHE_DIR = path.join(TMP, 'data', 'signature-cache');
fs.mkdirSync(CACHE_DIR, { recursive: true });

const DAY = 24 * 60 * 60 * 1000;
const OLD_FILES = 3;
const FRESH_LIMIT_EXCEED = 502; // 上限 500，多造 2 个触发按 mtime 回收

function touch(name, ageDays) {
  const p = path.join(CACHE_DIR, name);
  fs.writeFileSync(p, JSON.stringify({ model: name, signatures: [], lastModified: Date.now() }));
  const when = (Date.now() - ageDays * DAY) / 1000;
  fs.utimesSync(p, when, when);
}

let failures = 0;
try {
  // 造的旧文件按"最旧 → 较新"命名，便于断言保留下来的边界
  for (let i = 0; i < OLD_FILES; i += 1) touch(`old-${i}.json`, 30 - i);
  for (let i = 0; i < FRESH_LIMIT_EXCEED; i += 1) touch(`fresh-${String(i).padStart(4, '0')}.json`, 0);
  // 非 .json 文件不应被回收
  fs.writeFileSync(path.join(CACHE_DIR, 'keep.txt'), 'not a cache file');

  const before = fs.readdirSync(CACHE_DIR).length;
  assert.strictEqual(before, OLD_FILES + FRESH_LIMIT_EXCEED + 1);

  process.chdir(TMP);
  // 必须在 chdir 之后再加载：CACHE_DIR 是用 process.cwd() 拼出来的，
  // 这样模块指向 /tmp 下的假目录，不会碰真实 data/signature-cache。
  const { pruneStaleCacheFiles } = await import(
    '/Users/albert/Documents/project/api/antigravity2api-nodejs/src/utils/thoughtSignatureCache.js'
  );

  const removed = pruneStaleCacheFiles();
  const after = fs.readdirSync(CACHE_DIR);

  // 期望：3 个过期文件 + 2 个最旧的 fresh 被回收
  assert.strictEqual(removed, OLD_FILES + 2, `应回收 ${OLD_FILES + 2} 个，实际 ${removed} 个`);
  console.log(`✓ 回收数量正确（${removed} 个：过期 + 超量最旧）`);

  assert.ok(!after.some((n) => n.startsWith('old-')), '过期文件应全部被回收');
  console.log('✓ TTL 过期文件已回收');

  const freshLeft = after.filter((n) => n.startsWith('fresh-'));
  assert.strictEqual(freshLeft.length, 500, `fresh 文件应被压到上限 500，实际 ${freshLeft.length}`);
  console.log('✓ 超出上限时按 mtime 从最旧回收，压回 500');

  assert.ok(freshLeft.includes('fresh-0501.json'), '最新的 fresh 文件必须保留');
  assert.ok(!freshLeft.includes('fresh-0000.json'), '最旧的 fresh 文件应被回收');
  console.log('✓ 保留的是较新文件（LRU 方向正确）');

  assert.ok(after.includes('keep.txt'), '非 .json 文件不得被误删');
  console.log('✓ 非缓存文件未被误删');

  // 节流：同一进程内第二次调用应被跳过
  const second = pruneStaleCacheFiles();
  assert.strictEqual(second, 0, '一小时内的重复调用应被节流跳过');
  console.log('✓ 回收动作按小时节流，不会每写一次就遍历目录');
} catch (err) {
  failures += 1;
  console.error(`✗ ${err.message}`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (failures > 0) {
  console.error('\n失败：签名缓存目录仍会无界增长。');
  process.exit(1);
}
console.log('\n全部通过：签名缓存目录会按 TTL 与总量上限自我回收。');
process.exit(0);
