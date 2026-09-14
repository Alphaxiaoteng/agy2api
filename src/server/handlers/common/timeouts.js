/**
 * 禁用 Express 的请求/响应超时（适用于大模型长响应）
 * @param {any} req
 * @param {any} res
 */
export function disableTimeouts(req, res) {
  if (req && typeof req.setTimeout === 'function') req.setTimeout(0);
  if (res && typeof res.setTimeout === 'function') res.setTimeout(0);
}
