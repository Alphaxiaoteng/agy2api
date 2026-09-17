/**
 * 回归测试：管理后台 / Flow 路由的「本机豁免」必须基于真实 TCP 对端，
 * 不能被 `X-Forwarded-For` / `X-Real-IP` 伪造绕过。
 *
 * 事故背景：这三条路由曾经各自用 getClientIP()（优先取 XFF 首段）判断
 * 「是否本机回环」，于是任意外部请求只要带 `X-Forwarded-For: 127.0.0.1`
 * 就能免密拿到管理员 JWT。判定逻辑现已统一到 src/utils/peerIp.js。
 *
 * 本测试刻意不加载路由模块（那样会拉起 config/tokenManager 等长驻句柄），
 * 只做两件事：① 单测 peerIp 判定本身；② 静态把关，禁止路由层重新长出
 * 「用请求头判断回环」的写法。
 *
 * 运行：node test/test-admin-local-bypass.js
 */
import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { getPeerIP, isLoopbackPeer, isLocalPeer } from '../src/utils/peerIp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const EXTERNAL_IP = '198.51.100.7'; // TEST-NET-2，永不可能出现在本机

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

// ── ① peerIp 判定单测 ───────────────────────────────────────────────────────

check('外部 IP + 伪造 X-Forwarded-For: 127.0.0.1 不被判定为本机', () => {
  const req = { headers: { 'x-forwarded-for': '127.0.0.1' }, socket: { remoteAddress: EXTERNAL_IP } };
  assert.strictEqual(getPeerIP(req), EXTERNAL_IP);
  assert.strictEqual(isLocalPeer(req), false);
});

check('外部 IP + 伪造 X-Real-IP: 127.0.0.1 不被判定为本机', () => {
  const req = { headers: { 'x-real-ip': '::1' }, socket: { remoteAddress: EXTERNAL_IP } };
  assert.strictEqual(isLocalPeer(req), false);
});

check('外部 IP + 伪造 XFF 含多跳（127.0.0.1, 10.0.0.1）不被判定为本机', () => {
  const req = {
    headers: { 'x-forwarded-for': '127.0.0.1, 10.0.0.1' },
    socket: { remoteAddress: EXTERNAL_IP }
  };
  assert.strictEqual(isLocalPeer(req), false);
});

check('真实 127.0.0.1 / ::1 / ::ffff:127.0.0.1 直连判定为本机', () => {
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.strictEqual(isLoopbackPeer(ip), true, `${ip} 应为本机`);
    assert.strictEqual(isLocalPeer({ headers: {}, socket: { remoteAddress: ip } }), true, `${ip} 应为 isLocalPeer`);
  }
});

check('本机直连 + 伪造外部 XFF 仍判定为本机（豁免只看真实对端）', () => {
  const req = { headers: { 'x-forwarded-for': EXTERNAL_IP }, socket: { remoteAddress: '127.0.0.1' } };
  assert.strictEqual(isLocalPeer(req), true);
});

check('socket 缺失时回落 req.connection，且不因缺 socket 抛错', () => {
  assert.strictEqual(getPeerIP({ connection: { remoteAddress: '127.0.0.1' } }), '127.0.0.1');
  assert.strictEqual(getPeerIP({}), 'unknown');
  assert.strictEqual(isLocalPeer({}), false, '未知对端不得视为本机');
});

// ── ② 静态把关：路由层不得再用请求头判回环 ──────────────────────────────────

// 这些路由都做过「本机免密 → 提升为 admin」的判定，全部必须走 isLocalPeer
const SECURITY_ROUTES = [
  'src/routes/admin.js',
  'src/routes/flow.js',
  'src/routes/flowSiteProxy.js'
];

// 旧写法特征：把 XFF/X-Real-IP 派生出的值直接与回环地址字面量比较
const FORBIDDEN_PATTERNS = [
  { re: /headers\[\s*'x-forwarded-for'\s*\][^\n]*===\s*'127\.0\.0\.1'/, why: '用 X-Forwarded-For 直接判回环' },
  { re: /headers\[\s*'x-real-ip'\s*\][^\n]*===\s*'127\.0\.0\.1'/, why: '用 X-Real-IP 直接判回环' },
  { re: /clientIP\s*===\s*'127\.0\.0\.1'/, why: '用（头派生的）clientIP 判回环' },
  { re: /socketIP\s*===\s*'127\.0\.0\.1'/, why: '内联 socketIP 判回环（应改用 isLocalPeer）' }
];

for (const rel of SECURITY_ROUTES) {
  const src = readFileSync(join(ROOT, rel), 'utf8');

  check(`${rel} 使用统一的 isLocalPeer() 判定本机豁免`, () => {
    assert.ok(src.includes('isLocalPeer('), `${rel} 未使用 isLocalPeer()`);
    assert.ok(
      src.includes("from '../utils/peerIp.js'"),
      `${rel} 未从 utils/peerIp.js 引入判定函数`
    );
  });

  for (const { re, why } of FORBIDDEN_PATTERNS) {
    check(`${rel} 无「${why}」写法`, () => {
      const hit = src.match(re);
      assert.strictEqual(hit, null, `仍存在反模式：${hit?.[0]}`);
    });
  }
}

if (failures > 0) {
  console.error(`\n${failures} 项失败：本机豁免判定存在被 XFF 伪造绕过的风险。`);
  process.exit(1);
}
console.log(`\n全部通过：${SECURITY_ROUTES.length} 条安全路由的本机豁免均基于真实 TCP 对端。`);
process.exit(0);
