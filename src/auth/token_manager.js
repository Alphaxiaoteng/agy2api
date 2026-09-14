import { log } from '../utils/logger.js';
import { generateSessionId, generateInstanceId } from '../utils/idGenerator.js';
import config, { getConfigJson, saveConfigJson } from '../config/config.js';
import { normalizePriorityAccountIds } from '../utils/utils.js';
import { DEFAULT_REQUEST_COUNT_PER_TOKEN } from '../constants/index.js';
import TokenStore from './token_store.js';
import TokenPool from './token_pool.js';
import TokenLifecycleManager from './token_lifecycle_manager.js';
import ProjectIdFetcher from './project_id_fetcher.js';
import TokenValidator from './token_validator.js';
import { StrategyFactory, RotationStrategy } from './token_rotation_strategy.js';
import { TokenError } from '../utils/errors.js';
import quotaManager from './quota_manager.js';
import tokenCooldownManager from './token_cooldown_manager.js';
import { randomUUID } from 'crypto';
import SessionAffinity from './session_affinity.js';

const WEEKLY_URGENT_MS = 48 * 60 * 60 * 1000;
const WEEKLY_RESET_PRIORITY_GAP_MS = 24 * 60 * 60 * 1000;
const WEEKLY_DEPLETED = 0.02;

function futureTimestamp(resetTime, now) {
  return resetTime !== null && resetTime > now ? resetTime : Number.POSITIVE_INFINITY;
}

/**
 * 0: 周额度 48h 内要重置，Weekly 抢先
 * 1: 周额度还不急（或没有周数据），交给 5h
 * 2: 周额度见底且这周还早，往后排
 */
function weeklyPriorityBand(weekly, now) {
  if (!weekly.hasData) return 1;

  const resetDelta = weekly.resetTime !== null && weekly.resetTime > now
    ? weekly.resetTime - now
    : Number.POSITIVE_INFINITY;
  const soon = resetDelta <= WEEKLY_URGENT_MS;
  const depleted = typeof weekly.remaining === 'number' && weekly.remaining <= WEEKLY_DEPLETED;

  if (depleted && !soon) return 2;
  if (soon) return 0;
  return 1;
}

function resetSortScore(tokenId, modelId, now) {
  const weekly = quotaManager.getModelGroupWeeklyResetTime(tokenId, modelId);
  const session = quotaManager.getModelGroupResetTime(tokenId, modelId);
  return {
    weeklyBand: weeklyPriorityBand(weekly, now),
    weeklyReset: futureTimestamp(weekly.resetTime, now),
    sessionReset: futureTimestamp(session.resetTime, now),
    sessionRemaining: quotaManager.getModelGroupQuota(tokenId, modelId)
  };
}

function compareResetScores(left, right) {
  if (left.weeklyBand !== right.weeklyBand) return left.weeklyBand - right.weeklyBand;
  if (left.weeklyGapBand !== right.weeklyGapBand) return left.weeklyGapBand - right.weeklyGapBand;

  if (left.weeklyBand === 0) {
    return left.weeklyReset - right.weeklyReset
      || left.sessionReset - right.sessionReset
      || right.sessionRemaining - left.sessionRemaining
      || left.index - right.index;
  }

  return left.sessionReset - right.sessionReset
    || right.sessionRemaining - left.sessionRemaining
    || left.weeklyReset - right.weeklyReset
    || left.index - right.index;
}

/**
 * 号池排序：Weekly 快重置时优先；否则按 5h 额度，周重置只做次要键。
 * 只统计仍在未来的重置点（已过期视为无效数据，排到后面）。
 * @param {Array<{tokenId: string, token: Object}>} entries
 * @param {string} modelId
 * @param {number} [now]
 * @returns {Array<{tokenId: string, token: Object}>}
 */
export function sortEntriesByResetTime(entries, modelId, now = Date.now()) {
  if (!modelId || !Array.isArray(entries) || entries.length < 2) return entries;

  const scored = entries
    .map((entry, index) => {
      const score = resetSortScore(entry.tokenId, modelId, now);
      return { entry, index, ...score };
    });
  const weeklyResets = scored
    .map(({ weeklyReset }) => weeklyReset)
    .filter(Number.isFinite);
  const earliestWeeklyReset = weeklyResets.length > 0 ? Math.min(...weeklyResets) : null;

  return scored
    .map((score) => ({
      ...score,
      // 只在同一优先级内按周重置日分组，避免破坏“周额度见底账号最后”的保护。
      weeklyGapBand: Number.isFinite(earliestWeeklyReset)
        && Number.isFinite(score.weeklyReset)
        && score.weeklyReset - earliestWeeklyReset > WEEKLY_RESET_PRIORITY_GAP_MS
        ? 1
        : 0
    }))
    .sort(compareResetScores)
    .map(({ entry }) => entry);
}

/**
 * Token 管理器（重构版）
 * 负责 Token 的存储、轮询、刷新等功能
 */
export class TokenManager {
  /**
   * @param {string} filePath - Token 数据文件路径
   */
  constructor(filePath) {
    // 核心组件
    this.store = new TokenStore(filePath);
    this.pool = new TokenPool(this.store);
    this.lifecycle = new TokenLifecycleManager(this.store);
    this.projectIdFetcher = new ProjectIdFetcher();
    this.validator = new TokenValidator(this.store);

    // 轮询策略
    this.strategy = null;
    this.rotationStrategyName = RotationStrategy.ROUND_ROBIN;
    this.requestCountPerToken = DEFAULT_REQUEST_COUNT_PER_TOKEN;
    this.priorityAccountIds = [];
    this.sessionAffinity = new SessionAffinity();

    // 初始化状态
    this._initPromise = null;
  }

  /**
   * 规范化 token 对象，确保所有必需字段存在
   * - sessionId: 每次启动必须新生成（代表 IDE 会话，上游会校验）
   * - instanceId/deviceId: 有值就保留，缺失或空串才生成
   * - sub: 有值就保留（后续 fetchProjectId 时上游返回新值会覆盖）
   * - 布尔字段用 ?? 保留 false 的语义
   * @param {Object} token - 原始 token 对象
   * @returns {Object} 规范化后的 token 对象
   * @private
   */
  static _normalizeToken(token) {
    return {
      ...token,
      sessionId: generateSessionId(),
      instanceId: token.instanceId || generateInstanceId(),
      deviceId: token.deviceId || randomUUID(),
      sub: token.sub || 'g1-pro-tier',
      hasQuota: token.hasQuota ?? true,
      enable: token.enable ?? true,
    };
  }

  /**
   * 初始化
   * @private
   */
  async _initialize() {
    try {
      log.info('正在初始化token管理器...');

      // 1. 读取所有 token
      const tokenArray = await this.store.readAll();

      // 2. 清空池并重新加载
      this.pool.clear();
      this.sessionAffinity.clear();

      // 3. 所有 token 都加载进池，启用状态由 TokenPool 单独维护
      const normalizedTokens = tokenArray.map(TokenManager._normalizeToken);

      // 4. 批量添加到池中
      await this.pool.addAll(normalizedTokens);

      // 5. 加载轮询策略配置
      this._loadRotationConfig();

      // 6. 创建轮询策略实例
      this.strategy = StrategyFactory.create(this.rotationStrategyName, {
        requestCountPerToken: this.requestCountPerToken
      });

      // 7. 日志输出
      const poolSize = this.pool.size();
      const enabledCount = this.pool.getEnabledIds().length;
      if (poolSize === 0) {
        log.warn('⚠ 暂无可用账号，请使用以下方式添加：');
        log.warn('  方式1: 运行 npm run login 命令登录');
        log.warn('  方式2: 访问前端管理页面添加账号');
      } else {
        log.info(`成功加载 ${poolSize} 个token（启用 ${enabledCount} 个，禁用 ${poolSize - enabledCount} 个）`);
        if (this.rotationStrategyName === RotationStrategy.REQUEST_COUNT) {
          log.info(`轮询策略: ${this.rotationStrategyName}, 每token请求 ${this.requestCountPerToken} 次后切换`);
        } else {
          log.info(`轮询策略: ${this.rotationStrategyName}`);
        }

        // 8. 只刷新启用且过期的 token
        if (enabledCount > 0) {
          await this._refreshExpiredTokens();
          await this._syncMissingCreditsForEnabledTokens();
          this._refreshWeeklySummariesInBackground();
        }
      }
    } catch (error) {
      log.error('初始化token失败:', error.message);
      this.pool.clear();
    }
  }

  /**
   * 加载轮询策略配置
   * @private
   */
  _loadRotationConfig() {
    try {
      const jsonConfig = getConfigJson();
      if (jsonConfig.rotation) {
        this.rotationStrategyName = jsonConfig.rotation.strategy || RotationStrategy.ROUND_ROBIN;
        this.requestCountPerToken = jsonConfig.rotation.requestCount || DEFAULT_REQUEST_COUNT_PER_TOKEN;
        const rawPriority = jsonConfig.rotation.priorityAccountIds ??
          jsonConfig.rotation.auto_switch_selected_account_ids ??
          jsonConfig.rotation.selected_accounts;
        this.priorityAccountIds = normalizePriorityAccountIds(rawPriority);
      } else {
        this.priorityAccountIds = [];
      }
    } catch (error) {
      log.warn('加载轮询配置失败，使用默认值:', error.message);
    }
  }

  /**
   * 刷新所有过期的 token
   * @private
   */
  async _refreshExpiredTokens() {
    // 获取所有启用的 tokens
    const allTokens = this.pool.getEnabledIds().map(tokenId => ({
      tokenId,
      token: this.pool.get(tokenId)
    }));

    // 过滤出过期的 tokens
    const expiredTokens = this.lifecycle.getExpiredTokens(allTokens);

    if (expiredTokens.length === 0) {
      return;
    }

    // 并发刷新
    const { tokensToDisable } = await this.lifecycle.refreshTokensConcurrently(expiredTokens);

    // 禁用失效的 tokens
    for (const { token, tokenId } of tokensToDisable) {
      await this._disableTokenInternal(tokenId);
    }
  }

  /**
   * 为已启用但缺少积分信息的 token 自动补拉积分
   * @private
   */
  async _syncMissingCreditsForEnabledTokens() {
    const tokenIds = this.pool.getEnabledIds().filter(tokenId => {
      const token = this.pool.get(tokenId);
      return token && token.sub !== 'free-tier' && (token.credits === null || token.credits === undefined);
    });

    if (tokenIds.length === 0) {
      return;
    }

    log.info(`检测到 ${tokenIds.length} 个启用Token缺少积分信息，开始自动同步`);

    const results = await Promise.allSettled(tokenIds.map(async (tokenId) => {
      const token = this.pool.get(tokenId);
      if (!token) return false;

      const subscriptionInfo = await this.projectIdFetcher.fetchSubscriptionAndCredits(token);
      if (subscriptionInfo.fetched === false) {
        return false;
      }

      this.pool.update(tokenId, {
        sub: subscriptionInfo.sub || 'free-tier',
        credits: subscriptionInfo.credits ?? null
      });
      await this._persistToken(token);
      return true;
    }));

    const successCount = results.filter(result => result.status === 'fulfilled' && result.value === true).length;
    const failCount = tokenIds.length - successCount;

    if (successCount > 0) {
      log.info(`积分自动同步完成: 成功 ${successCount} 个${failCount > 0 ? `, 失败 ${failCount} 个` : ''}`);
    } else if (failCount > 0) {
      log.warn(`积分自动同步失败: 共 ${failCount} 个`);
    }
  }

  /**
   * 确保已初始化
   * @private
   */
  async _ensureInitialized() {
    if (!this._initPromise) {
      this._initPromise = this._initialize();
    }
    return this._initPromise;
  }

  /**
   * 内部禁用 token（不持久化）
   * @param {string} tokenId - Token ID
   * @private
   */
  async _disableTokenInternal(tokenId) {
    this.pool.disable(tokenId);
    log.warn(`Token ${tokenId} 已被禁用`);
  }

  /**
   * 获取启用 token 条目
   * @returns {Array<{tokenId: string, token: Object}>}
   * @private
   */
  _getEnabledTokenEntries() {
    return this.pool.getEnabledIds().map(tokenId => ({
      tokenId,
      token: this.pool.get(tokenId)
    }));
  }

  /**
   * 后台拉取 Weekly 额度，供号池按周重置时间排序。失败不影响主流程。
   * @private
   */
  _refreshWeeklySummariesInBackground() {
    Promise.resolve()
      .then(() => this._refreshWeeklySummaries())
      .catch((error) => log.warn(`后台拉取周额度失败: ${error.message}`));
  }

  /**
   * @private
   */
  async _refreshWeeklySummaries() {
    const { fetchQuotaSummary } = await import('../api/client.js');
    const ids = this.pool.getEnabledIds();
    let successCount = 0;

    for (const tokenId of ids) {
      const token = this.pool.get(tokenId);
      if (!token?.access_token) continue;
      try {
        const weekly = await fetchQuotaSummary(token);
        if (weekly) {
          quotaManager.updateQuotaSummary(tokenId, weekly);
          successCount += 1;
        }
      } catch (error) {
        log.warn(`拉取周额度失败${token.email ? ` (${token.email})` : ''}: ${error.message}`);
      }
    }

    if (successCount > 0) {
      log.info(`周额度同步完成: ${successCount}/${ids.length}`);
    }

    // 同步完成后触发周额度重置自动激活扫描
    import('./weekly_activation_manager.js')
      .then(({ default: weeklyActivationManager }) => weeklyActivationManager.checkAndActivateAll(this))
      .catch((err) => log.warn(`周额度自动激活检查触发失败: ${err.message}`));
  }

  /**
   * 按 Weekly（仅快重置时）再 5h 额度排序。
   * @param {Array<{tokenId: string, token: Object}>} entries
   * @param {string} modelId
   * @param {number} [now]
   * @returns {Array<{tokenId: string, token: Object}>}
   * @private
   */
  _sortTokensByResetTime(entries, modelId, now = Date.now()) {
    return sortEntriesByResetTime(entries, modelId, now);
  }

  /**
   * 按模型过滤可用 token；只有允许时才重置陈旧的额度标记，且重置后仍会重新校验冷却状态。
   * @param {string} modelId - 模型 ID
   * @param {Object} options - 过滤选项
   * @param {boolean} options.allowQuotaReset - 是否允许重置 hasQuota 标记后重试过滤
   * @returns {Promise<Array<{tokenId: string, token: Object}>>}
   * @private
   */
  async _getAvailableTokenEntries(modelId, { allowQuotaReset = true } = {}) {
    const enabledTokens = this._getEnabledTokenEntries();

    if (enabledTokens.length === 0) {
      log.error('没有可用的token');
      return [];
    }

    if (!modelId) {
      return enabledTokens;
    }

    let availableTokens = await this.validator.filterAvailableTokens(enabledTokens, modelId);
    if (availableTokens.length > 0) {
      return availableTokens;
    }

    if (allowQuotaReset) {
      log.warn(`没有对模型 ${modelId} 可用的token，尝试重置本地额度标记后重新校验`);
      this.pool.resetAllQuotas();
      availableTokens = await this.validator.filterAvailableTokens(this._getEnabledTokenEntries(), modelId);
    }

    if (availableTokens.length === 0) {
      log.error(`没有对模型 ${modelId} 可用的token`);
    }

    return availableTokens;
  }

  /**
   * 从可用 token 中选择一个，并在必要时刷新。
   * @param {string} modelId - 模型 ID
   * @param {Object} options - 选择选项
   * @param {boolean} options.allowQuotaReset - 是否允许重置本地额度标记
   * @param {string|null} options.excludeTokenId - 有其他候选时排除指定 token
   * @returns {Promise<Object|null>} token 对象或 null
   * @private
   */
  async _selectToken(modelId, { allowQuotaReset = true, excludeTokenId = null, sessionKey = null } = {}) {
    await this._ensureInitialized();

    let availableTokens = await this._getAvailableTokenEntries(modelId, { allowQuotaReset });
    if (excludeTokenId && availableTokens.length > 1) {
      availableTokens = availableTokens.filter(({ tokenId }) => tokenId !== excludeTokenId);
    }

    if (Array.isArray(this.priorityAccountIds) && this.priorityAccountIds.length > 0) {
      const prioritySet = new Set(this.priorityAccountIds);
      const priorityAvailable = availableTokens.filter(({ tokenId }) => prioritySet.has(tokenId));
      if (priorityAvailable.length > 0) {
        availableTokens = priorityAvailable;
      }
    }

    availableTokens = this._sortTokensByResetTime(availableTokens, modelId);

    let selected = null;
    if (sessionKey) {
      const boundTokenId = this.sessionAffinity.get(sessionKey);
      selected = availableTokens.find(({ tokenId }) => tokenId === boundTokenId) || null;
      if (boundTokenId && !selected) this.sessionAffinity.delete(sessionKey, boundTokenId);
    }

    selected ||= this.strategy.selectToken(availableTokens);
    if (!selected) return null;

    const { token, tokenId } = selected;
    if (sessionKey) this.sessionAffinity.set(sessionKey, tokenId);

    if (this.lifecycle.isExpired(token)) {
      try {
        await this.lifecycle.refreshToken(token, tokenId);
        await this._persistToken(token);
      } catch (error) {
        log.error(`刷新token失败: ${error.message}`);
        if (error.statusCode === 403 || error.statusCode === 400) {
          await this.disableToken(token);
        }
        if (sessionKey) this.sessionAffinity.delete(sessionKey, tokenId);
        return this._selectToken(modelId, { allowQuotaReset: false, excludeTokenId, sessionKey });
      }
    }

    const shouldSwitch = this.strategy.recordUsage(tokenId);

    if (shouldSwitch && this.rotationStrategyName === RotationStrategy.REQUEST_COUNT) {
      this.strategy.switchToNext(availableTokens.length, tokenId);
    }

    return token;
  }

  /**
   * 获取下一个可用的 token（兼容旧调用）
   * @param {string} modelId - 模型 ID
   * @returns {Promise<Object|null>} token 对象或 null
   */
  async getNextToken(modelId) {
    return this.getToken(modelId);
  }

  /**
   * 获取可用 token
   * @param {string} modelId - 模型 ID
   * @returns {Promise<Object|null>} token 对象或 null
   */
  async getToken(modelId, sessionKey = null) {
    return this._selectToken(modelId, { allowQuotaReset: true, sessionKey });
  }

  /**
   * 重试前重新选择对当前模型组可用的 token。
   * 不重置本地额度标记；如果存在其他候选，会避开刚失败的 token。
   * @param {string} modelId - 模型 ID
   * @param {string|null} previousTokenId - 刚失败的 tokenId
   * @returns {Promise<Object|null>} token 对象或 null
   */
  async getTokenForRetry(modelId, previousTokenId = null, sessionKey = null) {
    if (sessionKey) this.sessionAffinity.delete(sessionKey, previousTokenId);
    return this._selectToken(modelId, {
      allowQuotaReset: false,
      excludeTokenId: previousTokenId,
      sessionKey
    });
  }

  /**
   * 持久化单个 token
   * @param {Object} token - Token 对象
   * @private
   */
  async _persistToken(token) {
    try {
      const allTokens = await this.store.readAll();
      const tokenId = await this.pool.generateTokenId(token);
      let index = -1;

      for (let i = 0; i < allTokens.length; i++) {
        const currentTokenId = await this.pool.generateTokenId(allTokens[i]);
        if (currentTokenId === tokenId) {
          index = i;
          break;
        }
      }

      if (index !== -1) {
        allTokens[index] = token;
        await this.store.writeAll(allTokens);
      }
    } catch (error) {
      log.error(`持久化token失败: ${error.message}`);
    }
  }

  /**
   * 添加新的 token
   * @param {Object} tokenData - Token 数据
   * @returns {Promise<Object>} 添加后的 token
   */
  async addToken(tokenData) {
    await this._ensureInitialized();

    if (!tokenData?.refresh_token) {
      throw new TokenError('refresh_token必填', null, 400);
    }

    const existingTokenId = await this.pool.findTokenId(tokenData.refresh_token);
    if (existingTokenId) {
      throw new TokenError('Token已存在，请使用刷新或导入更新', existingTokenId, 409);
    }

    const token = {
      ...tokenData,
      projectId: tokenData.projectId || null,
      sub: tokenData.sub || null,
      credits: tokenData.credits ?? null,
      enable: tokenData.enable ?? true,
      hasQuota: tokenData.hasQuota ?? true,
      sessionId: generateSessionId(),
      instanceId: generateInstanceId(),
      deviceId: randomUUID()
    };
    const tokenId = await this.pool.add(token);

    try {
      // 只有 refresh_token 时，先换取 access_token，再调用需要授权的上游接口。
      if (!token.access_token) {
        await this.lifecycle.refreshToken(token, tokenId, true);
      }

      const fetchResult = await this.projectIdFetcher.fetchProjectId(token);
      const projectId = token.projectId || fetchResult?.projectId || null;
      const sub = fetchResult?.sub || token.sub || (projectId ? 'g1-pro-tier' : 'free-tier');
      const credits = fetchResult?.credits !== undefined
        ? fetchResult.credits
        : (token.credits ?? null);

      this.pool.update(tokenId, {
        projectId,
        sub,
        credits,
        hasQuota: projectId ? true : (tokenData.hasQuota ?? false)
      });

      const allTokens = await this.store.readAll();
      allTokens.push(token);
      await this.store.writeAll(allTokens);

      log.info(`Token ${tokenId} 添加成功`);
      return token;
    } catch (error) {
      // 初始化失败时不把半成品留在内存池中；持久化发生在所有必要步骤成功之后。
      this.pool.remove(tokenId);
      throw error;
    }
  }

  /**
   * 禁用 token
   * @param {Object} token - Token 对象
   */
  async disableToken(token, reason = null) {
    const tokenId = await this.pool.findTokenId(token.refresh_token);
    if (!tokenId) {
      log.warn('尝试禁用不存在的token');
      return;
    }

    // 1. 在池中禁用
    this.pool.disable(tokenId);
    this.sessionAffinity.deleteToken(tokenId);

    // 2. 持久化
    try {
      const allTokens = await this.store.readAll();
      let index = -1;

      for (let i = 0; i < allTokens.length; i++) {
        const currentTokenId = await this.pool.generateTokenId(allTokens[i]);
        if (currentTokenId === tokenId) {
          index = i;
          break;
        }
      }

      if (index !== -1) {
        allTokens[index].enable = false;
        if (reason?.reason === 'VALIDATION_REQUIRED') {
          allTokens[index].statusReason = reason.reason;
          allTokens[index].validationUrl = reason.validationUrl;
          allTokens[index].disabledAt = new Date().toISOString();
        }
        await this.store.writeAll(allTokens);
      }
    } catch (error) {
      log.error(`持久化禁用状态失败: ${error.message}`);
    }

    log.warn(`Token ${tokenId} 已被禁用`);
  }

  /**
   * 标记 token 额度耗尽
   * @param {Object} token - Token 对象
   */
  async markTokenQuotaExhausted(token) {
    const tokenId = await this.pool.findTokenId(token.refresh_token);
    if (!tokenId) {
      return;
    }

    this.pool.markQuotaExhausted(tokenId);
    this.sessionAffinity.deleteToken(tokenId);

    // 如果是 quota_exhausted 策略，切换到下一个
    if (this.rotationStrategyName === RotationStrategy.QUOTA_EXHAUSTED) {
      const totalTokens = this.pool.getEnabledWithQuotaIds().length;
      this.strategy.switchToNext(totalTokens, tokenId);
    }
  }

  /**
   * 刷新指定 token
   * @param {Object} token - Token 对象
   * @param {boolean} silent - 是否静默模式
   * @returns {Promise<Object>} 刷新后的 token
   */
  async refreshToken(token, silent = false) {
    const tokenId = await this.pool.findTokenId(token.refresh_token);
    if (!tokenId) {
      throw new TokenError('Token不存在', null, 404);
    }

    await this.lifecycle.refreshToken(token, tokenId, silent);
    await this._persistToken(token);

    return token;
  }

  /**
   * 检查 token 是否过期
   * @param {Object} token - Token 对象
   * @returns {boolean} 是否过期
   */
  isExpired(token) {
    return this.lifecycle.isExpired(token);
  }

  /**
   * 重新加载所有 token
   */
  async reload() {
    this._initPromise = null;
    await this._ensureInitialized();
  }

  /**
   * 更新轮询策略配置
   * @param {string} strategy - 策略名称
   * @param {number} requestCount - 请求计数（仅用于 request_count 策略）
   * @param {Array<string>} priorityAccountIds - 优先账号ID列表
   */
  updateRotationConfig(strategy, requestCount, priorityAccountIds = undefined) {
    if (strategy && StrategyFactory.isValidStrategy(strategy)) {
      this.rotationStrategyName = strategy;
      this.strategy = StrategyFactory.create(strategy, {
        requestCountPerToken: requestCount || this.requestCountPerToken
      });

      if (requestCount && requestCount > 0) {
        this.requestCountPerToken = requestCount;
      }

      if (this.rotationStrategyName === RotationStrategy.REQUEST_COUNT) {
        log.info(`轮询策略已更新: ${this.rotationStrategyName}, 每token请求 ${this.requestCountPerToken} 次后切换`);
      } else {
        log.info(`轮询策略已更新: ${this.rotationStrategyName}`);
      }
    }

    if (priorityAccountIds !== undefined) {
      this.priorityAccountIds = normalizePriorityAccountIds(priorityAccountIds);
      log.info(`优先账号池已更新: 共 ${this.priorityAccountIds.length} 个优先账号`);
    }
  }

  /**
   * 获取轮询策略配置
   * @returns {Object} 配置对象
   */
  getRotationConfig() {
    const currentIndex = Number.isInteger(this.strategy?.currentIndex)
      ? this.strategy.currentIndex
      : 0;

    return {
      strategy: this.rotationStrategyName,
      requestCount: this.requestCountPerToken,
      priorityAccountIds: this.priorityAccountIds,
      currentIndex,
      sessionBindings: this.sessionAffinity.size()
    };
  }

  /**
   * 记录请求（用于配额管理）
   * @param {Object} token - Token 对象
   * @param {string} modelId - 模型 ID
   */
  async recordRequest(token, modelId) {
    if (!token || !modelId) return;

    try {
      const tokenId = await this.pool.generateTokenId(token);
      quotaManager.recordRequest(tokenId, modelId);
    } catch (error) {
      // 记录失败不影响请求
      log.warn('记录请求次数失败:', error.message);
    }
  }

  async markValidationSuccessful(token) {
    const tokenId = await this.getTokenId(token);
    if (!tokenId) return;
    const current = this.pool.get(tokenId);
    if (!current?.statusReason) return;
    delete current.statusReason;
    delete current.validationUrl;
    delete current.disabledAt;
    await this._persistToken(current);
  }

  /**
   * 获取所有 token 列表（不含敏感信息）
   * @returns {Promise<Array>} Token 列表
   */
  async getTokenList() {
    try {
      await this._ensureInitialized();
      const salt = await this.store.getSalt();

      return this.pool.getAllIds().map(tokenId => {
        const token = this.pool.get(tokenId);
        return {
          id: tokenId,
          expires_in: token.expires_in,
          timestamp: token.timestamp,
          enable: token.enable !== false,
          projectId: token.projectId || null,
          email: token.email || null,
          hasQuota: token.hasQuota !== false,
          sub: token.sub || null,
          credits: token.credits !== null && token.credits !== undefined ? token.credits : null,
          statusReason: token.statusReason || null,
          validationUrl: token.validationUrl || null,
          disabledAt: token.disabledAt || null
        };
      });
    } catch (error) {
      log.error('获取Token列表失败:', error.message);
      return [];
    }
  }

  /**
   * 获取供内部刷新流程使用的完整 token 条目。
   * 与 getTokenList 分开，避免管理 API 的脱敏数据被误用于刷新。
   * @returns {Promise<Array<{tokenId: string, token: Object}>>}
   */
  async getRefreshableTokenEntries() {
    await this._ensureInitialized();
    return this.pool.getAllIds().map(tokenId => ({
      tokenId,
      token: this.pool.get(tokenId)
    })).filter(entry => entry.token);
  }

  /**
   * 根据 tokenId 查找 token
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object|null>} token 对象或 null
   */
  async findTokenById(tokenId) {
    await this._ensureInitialized();
    return this.pool.get(tokenId);
  }

  /**
   * 根据 tokenId 更新 token
   * @param {string} tokenId - Token ID
   * @param {Object} updates - 更新内容
   * @returns {Promise<Object>} 操作结果
   */
  async updateTokenById(tokenId, updates) {
    try {
      await this._ensureInitialized();

      const tokenBeforeUpdate = this.pool.get(tokenId);
      if (!tokenBeforeUpdate) {
        return { success: false, message: 'Token不存在' };
      }

      const wasEnabled = tokenBeforeUpdate.enable !== false;

      // 更新池中的 token
      const success = this.pool.update(tokenId, updates);
      if (!success) {
        return { success: false, message: 'Token不存在' };
      }

      // 持久化
      const token = this.pool.get(tokenId);
      if (updates.enable === false) this.sessionAffinity.deleteToken(tokenId);
      await this._persistToken(token);

      const isEnabling = updates.enable === true && !wasEnabled;
      if (isEnabling) {
        delete token.statusReason;
        delete token.validationUrl;
        delete token.disabledAt;
        await this._persistToken(token);
        let syncedCredits = false;

        try {
          if (this.lifecycle.isExpired(token)) {
            await this.lifecycle.refreshToken(token, tokenId);
            await this._persistToken(token);
          }

          const subscriptionInfo = await this.refreshSubscriptionAndCreditsById(tokenId);
          syncedCredits = subscriptionInfo.fetched !== false;
        } catch (error) {
          log.warn(`启用Token后自动同步积分失败 (${tokenId}): ${error.message}`);
        }

        return {
          success: true,
          message: syncedCredits ? 'Token启用成功，积分已自动同步' : 'Token启用成功，但积分同步失败',
          syncedCredits
        };
      }

      return { success: true, message: 'Token更新成功' };
    } catch (error) {
      log.error('更新Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * 根据 tokenId 删除 token
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object>} 操作结果
   */
  async deleteTokenById(tokenId) {
    try {
      await this._ensureInitialized();

      // 从池中删除
      const success = this.pool.remove(tokenId);
      if (!success) {
        return { success: false, message: 'Token不存在' };
      }
      this.sessionAffinity.deleteToken(tokenId);

      // 持久化
      const allTokens = await this.store.readAll();
      const filteredTokens = [];
      for (const token of allTokens) {
        const tid = await this.pool.generateTokenId(token);
        if (tid !== tokenId) {
          filteredTokens.push(token);
        }
      }

      await this.store.writeAll(filteredTokens);

      // 若被删除账号在优先账号列表中，同步从内存与持久化配置中移除
      if (Array.isArray(this.priorityAccountIds) && this.priorityAccountIds.includes(tokenId)) {
        this.priorityAccountIds = this.priorityAccountIds.filter(id => id !== tokenId);
        try {
          const currentConfig = getConfigJson();
          if (currentConfig.rotation && Array.isArray(currentConfig.rotation.priorityAccountIds)) {
            currentConfig.rotation.priorityAccountIds = currentConfig.rotation.priorityAccountIds.filter(id => id !== tokenId);
            saveConfigJson(currentConfig);
          }
        } catch (configErr) {
          log.warn('删除Token后清理持久化优先账号配置失败:', configErr.message);
        }
      }

      return { success: true, message: 'Token删除成功' };
    } catch (error) {
      log.error('删除Token失败:', error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * 根据 tokenId 刷新 token
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object>} 刷新后的 token 信息
   */
  async refreshTokenById(tokenId) {
    await this._ensureInitialized();

    const token = this.pool.get(tokenId);
    if (!token) {
      throw new TokenError('Token不存在', null, 404);
    }

    await this.lifecycle.refreshToken(token, tokenId);
    await this._persistToken(token);

    return {
      expires_in: token.expires_in,
      timestamp: token.timestamp
    };
  }

  /**
   * 根据 tokenId 刷新订阅和积分信息
   * @param {string} tokenId - Token ID
   * @returns {Promise<{sub: string, credits: number|null, isActivated: boolean}>}
   */
  async refreshSubscriptionAndCreditsById(tokenId) {
    await this._ensureInitialized();

    const token = this.pool.get(tokenId);
    if (!token) {
      throw new TokenError('Token不存在', null, 404);
    }

    const subscriptionInfo = await this.projectIdFetcher.fetchSubscriptionAndCredits(token);
    if (!subscriptionInfo.fetched) {
      return {
        sub: token.sub || 'free-tier',
        credits: token.credits ?? null,
        isActivated: false,
        fetched: false
      };
    }

    const updates = {
      sub: subscriptionInfo.sub || 'free-tier',
      credits: subscriptionInfo.credits ?? null
    };

    this.pool.update(tokenId, updates);
    await this._persistToken(token);

    return {
      ...subscriptionInfo,
      ...updates,
      fetched: true
    };
  }

  /**
   * 获取盐值
   * @returns {Promise<string>} 盐值
   */
  async getSalt() {
    return this.store.getSalt();
  }

  /**
   * 根据 token 对象获取 tokenId
   * @param {Object} token - Token 对象
   * @returns {Promise<string|null>} tokenId
   */
  async getTokenId(token) {
    if (!token?.refresh_token) return null;
    try {
      return await this.pool.findTokenId(token.refresh_token);
    } catch (error) {
      log.error(`生成tokenId失败: ${error.message}`);
      return null;
    }
  }

  /**
   * 获取 projectId（兼容旧 API）
   * @param {Object} token - Token 对象
   * @returns {Promise<Object>} {projectId, sub}
   */
  async fetchProjectId(token) {
    return this.projectIdFetcher.fetchProjectId(token);
  }

  /**
   * 根据 tokenId 获取并更新 projectId
   * @param {string} tokenId - Token ID
   * @returns {Promise<Object>} 包含 projectId 的结果
   */
  async fetchProjectIdForToken(tokenId) {
    await this._ensureInitialized();

    const token = this.pool.get(tokenId);
    if (!token) {
      throw new TokenError('Token不存在', null, 404);
    }

    // 确保 token 未过期
    if (this.lifecycle.isExpired(token)) {
      await this.lifecycle.refreshToken(token, tokenId);
      await this._persistToken(token);
    }

    const { projectId, sub } = await this.projectIdFetcher.fetchProjectId(token);
    if (!projectId) {
      throw new TokenError('无法获取 projectId，该账号可能无资格', null, 400);
    }

    // 更新 token
    this.pool.update(tokenId, {
      projectId,
      sub,
      hasQuota: true
    });

    // 持久化
    await this._persistToken(token);

    return { projectId };
  }
}

// 导出策略枚举（向后兼容）
export { RotationStrategy };

const tokenManager = new TokenManager();
export default tokenManager;
