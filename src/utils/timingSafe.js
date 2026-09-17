import { createHash, timingSafeEqual } from 'crypto';

/**
 * 恒定时间比较 secret 字符串（API Key、管理员口令等）。
 *
 * 直接用 `provided !== expected` 会在第一个不同字节处短路，比较耗时随前缀
 * 匹配长度变化，可被统计型时序攻击逐字符猜解。这里先对两侧做 SHA-256，
 * 得到定长摘要后再比较：既保证恒定时间，也避免长度不等时提前返回导致长度泄露。
 *
 * @param {unknown} provided 客户端提供的值
 * @param {unknown} expected 服务端保存的值
 * @returns {boolean}
 */
export function timingSafeStringEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  const providedHash = createHash('sha256').update(provided, 'utf8').digest();
  const expectedHash = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(providedHash, expectedHash);
}
