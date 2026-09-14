import config, { getConfigJson, getUpstreamConfig, buildConfig } from '../config/config.js';
import requesterManager from './requesterManager.js';
import tokenManager from '../auth/token_manager.js';

/**
 * 重新加载配置到 config 对象
 * 同时重置请求器，使新的 useNativeAxios / proxy / timeout 配置生效
 * 同步刷新 tokenManager 内存中的轮询策略及优先账号池配置
 */
export function reloadConfig() {
  const newConfig = buildConfig(getConfigJson(), getUpstreamConfig());
  Object.assign(config, newConfig);
  requesterManager.reload();
  if (config.rotation) {
    tokenManager.updateRotationConfig(
      config.rotation.strategy,
      config.rotation.requestCount,
      config.rotation.priorityAccountIds
    );
  }
}
