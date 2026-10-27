import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';
import { getDataDir } from '../utils/paths.js';
import { QUOTA_CACHE_TTL, QUOTA_CLEANUP_INTERVAL } from '../constants/index.js';
import { getGroupKey } from '../utils/modelGroups.js';

// 每次请求消耗的额度百分比（按模型系列区分）
const REQUEST_COST_PERCENT = 0.6667;

// 不同模型系列的每次请求消耗百分比
const GROUP_COST_PERCENT = {
  claude: 0.6667,
  gemini: 0.6667,
  banana: 5.0,    // 图片生成模型消耗更高，约 20 次/满额
  other: 0.6667
};

class QuotaManager {
  /**
   * @param {string} filePath - 额度数据文件路径
   */
  constructor(filePath = path.join(getDataDir(), 'quotas.json')) {
    this.filePath = filePath;
    /** @type {Map<string, {lastUpdated: number, models: Object, requestCounts: Object, resetTimes: Object}>} */
    this.cache = new Map();
    this.CACHE_TTL = QUOTA_CACHE_TTL;
    this.CLEANUP_INTERVAL = QUOTA_CLEANUP_INTERVAL;
    this.cleanupTimer = null;
    // 热路径 I/O 保护：recordRequest 每次请求都会触发落盘，
    // 同步 fs.writeFileSync 会冻结 Node 主事件循环（影响并发流与心跳定时器）。
    // 改为「脏标记 + 防抖异步落盘」，把高频写合并为低频刷盘。
    this._saveTimer = null;
    this._saveInProgress = false;
    this._saveAgain = false;
    this.ensureFileExists();
    this.loadFromFile();
    this.startCleanupTimer();
  }

  ensureFileExists() {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ meta: { lastCleanup: Date.now(), ttl: this.CLEANUP_INTERVAL }, quotas: {} }, null, 2), 'utf8');
    }
  }

  loadFromFile() {
    try {
      const data = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(data);
      Object.entries(parsed.quotas || {}).forEach(([key, value]) => {
        // 确保 requestCounts 和 resetTimes 字段存在
        if (!value.requestCounts) value.requestCounts = {};
        if (!value.resetTimes) value.resetTimes = {};
        this.cache.set(key, value);
      });
    } catch (error) {
      log.error('加载额度文件失败:', error.message);
    }
  }

  saveToFile() {
    try {
      const quotas = {};
      this.cache.forEach((value, key) => {
        quotas[key] = value;
      });
      const data = {
        meta: { lastCleanup: Date.now(), ttl: this.CLEANUP_INTERVAL },
        quotas
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      log.error('保存额度文件失败:', error.message);
    }
  }

  /**
   * 防抖异步落盘（热路径专用）
   *
   * 背景：recordRequest() 位于每个请求的关键路径上，原先直接同步写盘会阻塞
   * Node.js 事件循环，导致同进程内其他并发 SSE 流与心跳定时器被卡住。
   * 这里改为：立即返回 + 延迟合并写 + 串行化异步写，彻底释放事件循环。
   *
   * @param {number} [delayMs=2000] 防抖窗口
   */
  saveToFileDebounced(delayMs = 2000) {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._flushAsync();
    }, delayMs);
    // 不阻止进程退出
    this._saveTimer.unref?.();
  }

  /**
   * 串行化异步刷盘：同一时刻只允许一个写操作，期间的变更通过 _saveAgain 标记再次触发
   */
  _flushAsync() {
    if (this._saveInProgress) {
      this._saveAgain = true;
      return;
    }
    this._saveInProgress = true;

    try {
      const quotas = {};
      this.cache.forEach((value, key) => {
        quotas[key] = value;
      });
      const data = {
        meta: { lastCleanup: Date.now(), ttl: this.CLEANUP_INTERVAL },
        quotas
      };
      const payload = JSON.stringify(data, null, 2);

      fs.writeFile(this.filePath, payload, 'utf8', (err) => {
        this._saveInProgress = false;
        if (err) {
          log.error('异步保存额度文件失败:', err.message);
        }
        if (this._saveAgain) {
          this._saveAgain = false;
          this._flushAsync();
        }
      });
    } catch (error) {
      this._saveInProgress = false;
      log.error('异步保存额度文件异常:', error.message);
    }
  }

  /**
   * 立即同步落盘（仅用于进程退出前或关键状态变更，非热路径）
   */
  flushSync() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this.saveToFile();
  }

  /**
   * 更新额度数据
   * @param {string} refreshToken - Token ID
   * @param {Object} quotas - 额度数据
   */
  updateQuota(refreshToken, quotas) {
    const existing = this.cache.get(refreshToken) || {};
    const existingModels = existing.models || {};
    const existingRequestCounts = existing.requestCounts || {};
    const existingResetTimes = existing.resetTimes || {};

    // 检查各个模型组的重置时间和额度变化
    const newResetTimes = {};
    const newRequestCounts = { ...existingRequestCounts };

    // 记录额度真正重置的组（需要打印日志）
    const quotaResetGroups = new Set();

    // 记录每个组的最低额度，用于检测额度变化
    const groupMinRemaining = {};
    const existingGroupMinRemaining = {};

    // 计算新数据中每个组的最低额度和重置时间
    Object.entries(quotas || {}).forEach(([modelId, quotaData]) => {
      const groupKey = getGroupKey(modelId);
      const remaining = quotaData.r || 0;

      if (groupMinRemaining[groupKey] === undefined || remaining < groupMinRemaining[groupKey]) {
        groupMinRemaining[groupKey] = remaining;
      }

      const resetTimeRaw = quotaData.t;
      if (resetTimeRaw) {
        const newResetMs = Date.parse(resetTimeRaw);

        // 更新重置时间（取最早的）
        if (!newResetTimes[groupKey] || newResetMs < Date.parse(newResetTimes[groupKey])) {
          newResetTimes[groupKey] = resetTimeRaw;
        }
      }
    });

    // 计算旧数据中每个组的最低额度
    Object.entries(existingModels).forEach(([modelId, quotaData]) => {
      const groupKey = getGroupKey(modelId);
      const remaining = quotaData.r || 0;

      if (existingGroupMinRemaining[groupKey] === undefined || remaining < existingGroupMinRemaining[groupKey]) {
        existingGroupMinRemaining[groupKey] = remaining;
      }
    });

    // 检测额度重置：只有当旧的重置时间已经过去，才认为是真正的额度重置
    const now = Date.now();
    for (const groupKey of Object.keys(groupMinRemaining)) {
      const newMin = groupMinRemaining[groupKey];
      const oldMin = existingGroupMinRemaining[groupKey];
      const oldResetTimeRaw = existingResetTimes[groupKey];
      const oldResetMs = oldResetTimeRaw ? Date.parse(oldResetTimeRaw) : null;

      // 条件1: 旧的重置时间已经过去（说明进入了新的额度周期）
      const resetTimePassed = oldResetMs && Number.isFinite(oldResetMs) && now > oldResetMs;

      // 条件2: 新额度明显高于旧额度（说明额度确实恢复了）
      const quotaIncreased = oldMin !== undefined && newMin > oldMin + 0.05;

      if (resetTimePassed && existingRequestCounts[groupKey] > 0) {
        // 重置时间已过，清零计数
        newRequestCounts[groupKey] = 0;
        quotaResetGroups.add(groupKey);
      } else if (resetTimePassed && quotaIncreased) {
        // 重置时间已过且额度增加，清零计数
        newRequestCounts[groupKey] = 0;
        quotaResetGroups.add(groupKey);
      }
      // 注意：如果重置时间未过，即使 API 返回的额度更高，也不重置计数
      // 这避免了官方 API 返回值波动导致的误重置
    }

    // 只有额度真正重置时才打印日志
    if (quotaResetGroups.size > 0) {
      log.info(`[QuotaManager] 额度重置（重置时间已过），清零请求计数: ${Array.from(quotaResetGroups).join(', ')}`);
    }

    this.cache.set(refreshToken, {
      lastUpdated: Date.now(),
      models: quotas,
      requestCounts: newRequestCounts,
      resetTimes: newResetTimes,
      weeklyResetTimes: existing.weeklyResetTimes || {},
      weeklyRemaining: existing.weeklyRemaining || {}
    });
    this.saveToFileDebounced();
  }

  /**
   * 写入 retrieveUserQuotaSummary 解析出的周额度。
   * @param {string} tokenId
   * @param {{weekly?: Object}} summary
   */
  updateQuotaSummary(tokenId, summary) {
    if (!tokenId || !summary || typeof summary !== 'object') return;

    const existing = this.cache.get(tokenId) || {
      lastUpdated: Date.now(),
      models: {},
      requestCounts: {},
      resetTimes: {}
    };
    const weeklyResetTimes = { ...(existing.weeklyResetTimes || {}) };
    const weeklyRemaining = { ...(existing.weeklyRemaining || {}) };
    const sessionResetTimes = { ...(existing.sessionResetTimes || {}) };
    const sessionRemaining = { ...(existing.sessionRemaining || {}) };

    for (const [groupKey, rec] of Object.entries(summary.weekly || {})) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.t) weeklyResetTimes[groupKey] = rec.t;
      if (typeof rec.r === 'number' && Number.isFinite(rec.r)) weeklyRemaining[groupKey] = rec.r;
    }

    for (const [groupKey, rec] of Object.entries(summary.session || {})) {
      if (!rec || typeof rec !== 'object') continue;
      if (rec.t) sessionResetTimes[groupKey] = rec.t;
      if (typeof rec.r === 'number' && Number.isFinite(rec.r)) sessionRemaining[groupKey] = rec.r;
    }

    this.cache.set(tokenId, {
      ...existing,
      lastUpdated: Date.now(),
      weeklyResetTimes,
      weeklyRemaining,
      sessionResetTimes,
      sessionRemaining
    });
    this.saveToFileDebounced();
  }

  /**
   * 记录一次请求
   * @param {string} refreshToken - Token ID
   * @param {string} modelId - 使用的模型 ID
   */
  recordRequest(refreshToken, modelId) {
    let data = this.cache.get(refreshToken);

    // 如果没有缓存条目，创建一个新的
    if (!data) {
      data = {
        lastUpdated: Date.now(),
        models: {},
        requestCounts: {},
        resetTimes: {}
      };
      this.cache.set(refreshToken, data);
    }

    const groupKey = getGroupKey(modelId);
    if (!data.requestCounts) data.requestCounts = {};

    // 检查是否已过重置时间
    const resetTimeRaw = data.resetTimes?.[groupKey];
    if (resetTimeRaw) {
      const resetMs = Date.parse(resetTimeRaw);
      if (Date.now() > resetMs) {
        // 已过重置时间，重置计数
        data.requestCounts[groupKey] = 0;
      }
    }

    data.requestCounts[groupKey] = (data.requestCounts[groupKey] || 0) + 1;
    // 热路径：改为防抖异步落盘，避免 fs.writeFileSync 冻结事件循环
    this.saveToFileDebounced();
  }

  /**
   * 获取指定 token 的额度数据
   * @param {string} refreshToken - Token ID
   * @param {boolean} allowExpired - 是否允许返回过期的最近额度（统计与大盘展示必须为 true）
   * @returns {Object|null} 额度数据
   */
  getQuota(refreshToken, allowExpired = false) {
    const data = this.cache.get(refreshToken);
    if (!data) return null;

    // 如果不允许过期，检查缓存是否过期
    if (!allowExpired && (Date.now() - data.lastUpdated > this.CACHE_TTL)) {
      return null;
    }

    return data;
  }

  /**
   * 获取指定 token 的请求计数
   * @param {string} refreshToken - Token ID
   * @returns {Object} 请求计数 { claude: number, gemini: number, banana: number, other: number }
   */
  getRequestCounts(refreshToken) {
    const data = this.cache.get(refreshToken);
    return data?.requestCounts || {};
  }

  /**
   * 检查 token 对特定模型组是否有额度
   * @param {string} tokenId - Token ID
   * @param {string} modelId - 模型 ID
   * @returns {boolean} 是否有额度（true = 有额度或无数据，false = 额度为 0）
   */
  hasQuotaForModel(tokenId, modelId) {
    const data = this.cache.get(tokenId);
    if (!data || !data.models) {
      // 没有额度数据，假设有额度
      return true;
    }

    const now = Date.now();
    const isResetPassed = (resetRaw) => {
      if (!resetRaw) return false;
      const ms = Date.parse(resetRaw);
      return Number.isFinite(ms) && now >= ms;
    };

    const groupKey = getGroupKey(modelId);

    // 模型真实支持度硬门禁（严格对齐上游授权，没有该模型权限坚决不派发）
    const modelKeys = Object.keys(data.models || {});
    const tokenHas55 = modelKeys.some(m => m.includes('5-5'));
    const tokenHas46 = modelKeys.some(m => m.includes('4-6'));

    // 全量统一模式：响应用户指令「5个也配置到 opus 5.5吧 全部统一下吧 gemini4也一样吧」
    // 前端统一暴露 claude-opus-5.5 / claude-sonnet-5.5 与 gemini-4-argon，9个账号全部打通统一服务
    const tokenHasClaude = tokenHas55 || tokenHas46;
    if (modelId.includes('opus') || modelId.includes('sonnet')) {
      if (!tokenHasClaude) return false;
      if ((modelId.includes('4-6') || modelId.includes('4.6')) && !tokenHas46) {
        return false;
      }
    }

    if (modelId.includes('argon') || modelId === 'gemini-4') {
      const hasArgon = tokenHas55 || modelKeys.some(m => m.includes('argon') && !m.includes('disabled'));
      if (!hasArgon) return false;
    }

    // 遵从用户指令「冻结上官方的」：以官方真实 429 报错为唯一冻结依据。
    // 本地不预先人工阻断具备模型权限的账号，让请求真实穿透到官方上游。
    const exactQuota = data.models[modelId];
    if (exactQuota) {
      if ((exactQuota.r || 0) > 0) return true;
      if (isResetPassed(exactQuota.t)) return true;
      // 当 exactQuota 的 remaining 为 null 或未精确统计 (known === false) 时，
      // 说明上游未单独限流，允许穿透
      if (exactQuota.r === null || exactQuota.r === undefined || exactQuota.known === false) {
        return true;
      }
      return false;
    }

    // 使用该组的最小额度来判断（与 getModelGroupQuota 逻辑一致）
    let minRemaining = null;
    let earliestResetPassed = false;

    for (const [id, quotaData] of Object.entries(data.models)) {
      const idGroupKey = getGroupKey(id);
      if (idGroupKey === groupKey) {
        const remaining = isResetPassed(quotaData.t) ? 1 : (quotaData.r || 0);
        if (isResetPassed(quotaData.t)) earliestResetPassed = true;
        if (minRemaining === null || remaining < minRemaining) {
          minRemaining = remaining;
        }
      }
    }

    // 没有找到该组的模型数据，假设有额度
    if (minRemaining === null) return true;
    if (earliestResetPassed && minRemaining > 0) return true;

    // 该组最小额度为 0，说明额度耗尽
    return minRemaining > 0;
  }

  /**
   * 获取模型组的最小额度
   * @param {string} tokenId - Token ID
   * @param {string} modelId - 模型 ID
   * @returns {number} 该组的最小额度 (0-1)，如果没有数据返回 1
   */
  getModelGroupQuota(tokenId, modelId) {
    const data = this.cache.get(tokenId);
    if (!data || !data.models) {
      return 1; // 没有数据，假设满额
    }

    const groupKey = getGroupKey(modelId);
    if (groupKey === 'claude' && typeof data.weeklyRemaining?.claude === 'number' && data.weeklyRemaining.claude <= 0) {
      return 0;
    }
    if (groupKey === 'gemini' && typeof data.weeklyRemaining?.gemini === 'number' && data.weeklyRemaining.gemini <= 0) {
      return 0;
    }

    let minRemaining = 1;
    let found = false;

    for (const [id, quotaData] of Object.entries(data.models)) {
      const idGroupKey = getGroupKey(id);
      if (idGroupKey === groupKey) {
        found = true;
        const remaining = quotaData.r || 0;
        if (remaining < minRemaining) {
          minRemaining = remaining;
        }
      }
    }

    return found ? minRemaining : 1;
  }

  /**
   * 获取模型系列的最早恢复时间
   * @param {string} tokenId - Token ID
   * @param {string} modelId - 模型 ID
   * @returns {{resetTime: number|null, hasData: boolean}} resetTime 为时间戳（毫秒），hasData 表示是否有该系列的数据
   */
  getModelGroupResetTime(tokenId, modelId) {
    const data = this.cache.get(tokenId);
    if (!data || !data.models) {
      return { resetTime: null, hasData: false };
    }

    const groupKey = getGroupKey(modelId);
    let earliestReset = null;
    let found = false;

    for (const [id, quotaData] of Object.entries(data.models)) {
      const idGroupKey = getGroupKey(id);
      if (idGroupKey === groupKey) {
        found = true;
        const resetTimeRaw = quotaData.t;
        if (resetTimeRaw) {
          const resetMs = Date.parse(resetTimeRaw);
          if (Number.isFinite(resetMs)) {
            if (earliestReset === null || resetMs < earliestReset) {
              earliestReset = resetMs;
            }
          }
        }
      }
    }

    return { resetTime: earliestReset, hasData: found };
  }

  /**
   * 获取模型系列的 Weekly 重置时间与剩余比例（retrieveUserQuotaSummary）。
   * @param {string} tokenId
   * @param {string} modelId
   * @returns {{resetTime: number|null, remaining: number|null, hasData: boolean}}
   */
  getModelGroupWeeklyResetTime(tokenId, modelId) {
    const data = this.cache.get(tokenId);
    const groupKey = getGroupKey(modelId);
    const resetTimeRaw = data?.weeklyResetTimes?.[groupKey];
    const remainingRaw = data?.weeklyRemaining?.[groupKey];
    const remaining = typeof remainingRaw === 'number' && Number.isFinite(remainingRaw)
      ? remainingRaw
      : null;
    const resetMs = resetTimeRaw ? Date.parse(resetTimeRaw) : NaN;
    const resetTime = Number.isFinite(resetMs) ? resetMs : null;
    if (resetTime === null && remaining === null) {
      return { resetTime: null, remaining: null, hasData: false };
    }
    return { resetTime, remaining, hasData: true };
  }

  /**
   * 把缓存里的周额度折叠成前端 windows。
   * @param {Object} quotaData
   * @returns {Object}
   */
  formatQuotaWindows(quotaData) {
    const windows = {};
    for (const groupKey of ['gemini', 'claude', 'banana', 'other']) {
      const remaining = quotaData?.weeklyRemaining?.[groupKey];
      const resetRaw = quotaData?.weeklyResetTimes?.[groupKey];
      windows[groupKey] = {
        weekly: {
          remaining: typeof remaining === 'number' && Number.isFinite(remaining) ? remaining : null,
          resetTimeRaw: resetRaw || null,
          resetTime: resetRaw ? this.convertToBeijingTime(resetRaw) : null
        }
      };
    }
    return windows;
  }

  /**
   * 检查是否有指定 token 的额度数据
   * @param {string} tokenId - Token ID
   * @returns {boolean} 是否有数据
   */
  hasQuotaData(tokenId) {
    const data = this.cache.get(tokenId);
    return !!(data && data.models && Object.keys(data.models).length > 0);
  }

  /**
   * 计算预估剩余请求次数
   * @param {number} remainingFraction - 剩余额度比例 (0-1)
   * @param {number} requestCount - 已使用的请求次数
   * @param {string} [groupKey] - 模型系列 key（用于获取对应的消耗率）
   * @returns {number} 预估剩余请求次数
   */
  calculateEstimatedRequests(remainingFraction, requestCount = 0, groupKey = null) {
    // 根据模型系列使用不同的消耗率
    const costPercent = (groupKey && GROUP_COST_PERCENT[groupKey]) || REQUEST_COST_PERCENT;
    // 基于当前阈值计算总的可用次数
    const percentageValue = remainingFraction * 100;
    const totalFromThreshold = Math.floor(percentageValue / costPercent);
    // 减去已记录的请求次数
    return Math.max(0, totalFromThreshold - requestCount);
  }

  /**
   * 获取模型系列的消耗率配置（供前端使用）
   * @returns {Object} 各系列的消耗率
   */
  static getGroupCostPercent() {
    return { ...GROUP_COST_PERCENT };
  }

  cleanup() {
    const now = Date.now();
    let cleaned = 0;

    this.cache.forEach((value, key) => {
      if (now - value.lastUpdated > this.CLEANUP_INTERVAL) {
        this.cache.delete(key);
        cleaned++;
      }
    });

    if (cleaned > 0) {
      log.info(`清理了 ${cleaned} 个过期的额度记录`);
      this.saveToFile();
    }
  }

  startCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.cleanupTimer = setInterval(() => this.cleanup(), this.CLEANUP_INTERVAL);
    // 使用 unref 避免阻止进程退出
    this.cleanupTimer.unref?.();
  }

  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  convertToBeijingTime(utcTimeStr) {
    if (!utcTimeStr) return 'N/A';
    try {
      const utcDate = new Date(utcTimeStr);
      return utcDate.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Asia/Shanghai'
      });
    } catch (error) {
      return 'N/A';
    }
  }
}

const quotaManager = new QuotaManager();
export default quotaManager;
