/**
 * 客户端网络身份判定的唯一真源。
 *
 * 背景：`app.set('trust proxy', true)` 之后 express 的 `req.ip` 会解析
 * `X-Forwarded-For`，而 `X-Forwarded-For` / `X-Real-IP` 是**客户端完全可控**的
 * 请求头。因此凡是用于安全决策（登录豁免、权限提升、封禁）的 IP 判定，必须取
 * 真实 TCP 对端地址，不能取请求头。
 *
 * 历史事故面：曾有代码用 `X-Forwarded-For` 首段判断「是否本机回环」来决定要不要
 * 免密放行管理员，导致任意外部请求只要带 `X-Forwarded-For: 127.0.0.1`
 * 就能直接拿到管理员 JWT。
 */

/**
 * 真实 TCP 对端地址。`trust proxy` 与任何请求头都不会影响它。
 * @param {import('express').Request} req
 * @returns {string}
 */
export function getPeerIP(req) {
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
}

/**
 * 对端是否为回环地址（本机直连）。
 * @param {string} peerIP getPeerIP() 的返回值
 * @returns {boolean}
 */
export function isLoopbackPeer(peerIP) {
  return peerIP === '127.0.0.1' || peerIP === '::1' || peerIP === '::ffff:127.0.0.1';
}

/**
 * 是否为来自本机 TCP 直连的请求。安全决策一律走这里。
 * @param {import('express').Request} req
 * @returns {boolean}
 */
export function isLocalPeer(req) {
  return isLoopbackPeer(getPeerIP(req));
}
