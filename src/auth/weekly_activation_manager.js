import fs from 'fs';
import path from 'path';
import { log } from '../utils/logger.js';
import { getDataDir } from '../utils/paths.js';
import { generateRequestBody } from '../utils/converters/openai.js';
import { generateAssistantResponseNoStream, refreshTokenQuotaCache, fetchQuotaSummary } from '../api/client.js';
import quotaManager from './quota_manager.js';
import tokenCooldownManager from './token_cooldown_manager.js';

const CANDIDATE_MODELS = {
  gemini: ['gemini-3.8-flash', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium'],
  claude: ['claude-sonnet-4-6', 'claude-sonnet-4-6-thinking', 'claude-opus-4-6-thinking']
};

export class WeeklyActivationManager {
  /**
   * @param {Object} [options]
   * @param {string} [options.filePath]
   * @param {number} [options.checkIntervalMs] 检查间隔，默认 10 分钟 (600,000 ms)
   */
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(getDataDir(), 'weekly_activation.json');
    this.checkIntervalMs = options.checkIntervalMs || 10 * 60 * 1000;
    /** @type {Map<string, Object>} tokenId -> { email, gemini?: { cycleResetTime, weeklyCycleResetTime, sessionCycleResetTime, activatedAt, active }, claude?: { ... } } */
    this.records = new Map();
    this.busyKeys = new Set();
    this.intervalTimer = null;
    this.isChecking = false;

    this.ensureFileExists();
    this.loadFromFile();
  }

  ensureFileExists() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (!fs.existsSync(this.filePath)) {
        const initial = {
          meta: { version: 2, lastCheck: Date.now() },
          records: {}
        };
        fs.writeFileSync(this.filePath, JSON.stringify(initial, null, 2), 'utf8');
      }
    } catch (err) {
      log.error(`[WeeklyActivation] 创建存储文件失败: ${err.message}`);
    }
  }

  loadFromFile() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const content = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(content);
      this.records.clear();
      Object.entries(parsed.records || {}).forEach(([id, rec]) => {
        if (rec && typeof rec === 'object') {
          this.records.set(id, rec);
        }
      });
    } catch (err) {
      log.error(`[WeeklyActivation] 读取存储文件失败: ${err.message}`);
    }
  }

  saveToFile() {
    try {
      const recordsObj = {};
      this.records.forEach((val, key) => {
        recordsObj[key] = val;
      });
      const data = {
        meta: { version: 2, lastCheck: Date.now(), intervalMs: this.checkIntervalMs },
        records: recordsObj
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      log.error(`[WeeklyActivation] 保存存储文件失败: ${err.message}`);
    }
  }

  getActivationRecord(tokenId, groupKey) {
    const entry = this.records.get(tokenId);
    return entry?.[groupKey] || null;
  }

  isGroupActivatedForCycle(tokenId, groupKey, cycleResetTime) {
    if (!cycleResetTime) return false;
    const rec = this.getActivationRecord(tokenId, groupKey);
    const recorded = rec?.weeklyCycleResetTime || rec?.cycleResetTime;
    return recorded === cycleResetTime && rec?.active === true;
  }

  recordActivation(tokenId, email, groupKey, weeklyCycleResetTime, sessionCycleResetTime = null, isActivated = true) {
    let entry = this.records.get(tokenId);
    if (!entry) {
      entry = { email };
      this.records.set(tokenId, entry);
    }
    if (email && !entry.email) entry.email = email;

    const existingGroup = entry[groupKey] || {};
    entry[groupKey] = {
      cycleResetTime: weeklyCycleResetTime || existingGroup.cycleResetTime || null,
      weeklyCycleResetTime: weeklyCycleResetTime || existingGroup.weeklyCycleResetTime || null,
      sessionCycleResetTime: sessionCycleResetTime || existingGroup.sessionCycleResetTime || null,
      activatedAt: Date.now(),
      active: isActivated
    };
    this.saveToFile();
  }

  /**
   * 发送极轻量探针请求（提示词“只回复ok”，极低消耗），激活指定模型组的周额度与 5h 额度。
   * 支持多模型候选平滑回退（如 Claude 遇 503 容量不足时自动回退思考版或 Opus）。
   * @param {Object} token
   * @param {string} groupKey 'gemini' | 'claude'
   * @returns {Promise<{success: boolean, model: string, response: Object}>}
   */
  async sendActivationProbe(token, groupKey) {
    const models = CANDIDATE_MODELS[groupKey] || ['gemini-3.1-pro-high'];
    let lastError = null;

    for (const model of models) {
      try {
        const reqBody = generateRequestBody(
          [{ role: 'user', content: '只回复ok' }],
          model,
          { max_tokens: 2, temperature: 0 },
          null,
          token
        );
        const resp = await generateAssistantResponseNoStream(reqBody, token);
        return { success: true, model, response: resp };
      } catch (err) {
        lastError = err;
        log.warn(`[WeeklyActivation] 探针请求模型 ${model} 失败 (${token.email || 'token'}): ${err.message}`);
      }
    }

    throw lastError || new Error(`所有候选模型均无法激活组 ${groupKey}`);
  }

  /**
   * 判定指定 token 和 groupKey 是否需要激活周额度或 5h 额度
   * @param {string} tokenId
   * @param {Object} token
   * @param {string} groupKey 'gemini' | 'claude'
   * @param {Object} quotaData
   * @returns {{shouldActivate: boolean, reason: string, weeklyResetRaw: string|null, sessionResetRaw: string|null}}
   */
  evaluateActivationNeed(tokenId, token, groupKey, quotaData) {
    const weeklyResetTimes = quotaData?.weeklyResetTimes || {};
    const weeklyRemaining = quotaData?.weeklyRemaining || {};
    const sessionResetTimes = quotaData?.sessionResetTimes || {};
    const sessionRemaining = quotaData?.sessionRemaining || {};

    const weeklyResetRaw = weeklyResetTimes[groupKey] || null;
    const weeklyResetMs = weeklyResetRaw ? Date.parse(weeklyResetRaw) : null;
    const weeklyRem = weeklyRemaining[groupKey];
    const hasWeeklyRem = typeof weeklyRem === 'number' && Number.isFinite(weeklyRem);

    const sessionResetRaw = sessionResetTimes[groupKey] || null;
    const sessionResetMs = sessionResetRaw ? Date.parse(sessionResetRaw) : null;
    const sessionRem = sessionRemaining[groupKey];
    const hasSessionRem = typeof sessionRem === 'number' && Number.isFinite(sessionRem);

    const now = Date.now();

    // 检查冷却状态：若处于冷却中则跳过
    if (tokenCooldownManager && !tokenCooldownManager.isAvailable(tokenId, groupKey)) {
      return { shouldActivate: false, reason: '处于冷却状态中', weeklyResetRaw, sessionResetRaw };
    }

    const record = this.getActivationRecord(tokenId, groupKey);
    const lastWeeklyCycle = record?.weeklyCycleResetTime || record?.cycleResetTime;
    const lastSessionCycle = record?.sessionCycleResetTime;

    const reasons = [];

    // --- 1. 周额度 (Weekly) 检查 ---
    let weeklyNeedsActivation = false;
    if (weeklyResetMs && Number.isFinite(weeklyResetMs) && now >= weeklyResetMs) {
      weeklyNeedsActivation = true;
      reasons.push(`旧周重置时间已到期 (${weeklyResetRaw})`);
    } else if (hasWeeklyRem && weeklyRem >= 0.999) {
      if (!lastWeeklyCycle || lastWeeklyCycle !== weeklyResetRaw) {
        weeklyNeedsActivation = true;
        reasons.push(`周额度恢复满额 (${(weeklyRem * 100).toFixed(1)}%) 且未激活`);
      }
    } else if (weeklyResetRaw && lastWeeklyCycle && weeklyResetRaw !== lastWeeklyCycle && hasWeeklyRem && weeklyRem >= 0.95) {
      weeklyNeedsActivation = true;
      reasons.push(`周重置时间滚动到新周期 (${weeklyResetRaw} vs ${lastWeeklyCycle})`);
    }

    // --- 2. 5小时额度 (5h Session) 检查 ---
    let sessionNeedsActivation = false;
    if (sessionResetMs && Number.isFinite(sessionResetMs) && now >= sessionResetMs) {
      sessionNeedsActivation = true;
      reasons.push(`旧5h重置时间已到期 (${sessionResetRaw})`);
    } else if (hasSessionRem && sessionRem >= 0.999) {
      if (!lastSessionCycle || lastSessionCycle !== sessionResetRaw) {
        sessionNeedsActivation = true;
        reasons.push(`5h额度恢复满额 (${(sessionRem * 100).toFixed(1)}%) 且未激活`);
      }
    } else if (sessionResetRaw && lastSessionCycle && sessionResetRaw !== lastSessionCycle && hasSessionRem && sessionRem >= 0.95) {
      sessionNeedsActivation = true;
      reasons.push(`5h重置时间滚动到新周期 (${sessionResetRaw} vs ${lastSessionCycle})`);
    }

    // 若首次初始化且账号已处于周期中途 (< 99.9% 且未到期)，直接固化当前周期，避免误触
    if (weeklyResetRaw && !lastWeeklyCycle && hasWeeklyRem && weeklyRem < 0.999) {
      this.recordActivation(tokenId, token.email, groupKey, weeklyResetRaw, sessionResetRaw, true);
    } else if (sessionResetRaw && !lastSessionCycle && hasSessionRem && sessionRem < 0.999) {
      this.recordActivation(tokenId, token.email, groupKey, weeklyResetRaw, sessionResetRaw, true);
    }

    if (weeklyNeedsActivation || sessionNeedsActivation) {
      return {
        shouldActivate: true,
        reason: reasons.join('; '),
        weeklyResetRaw,
        sessionResetRaw
      };
    }

    return { shouldActivate: false, reason: '无需激活', weeklyResetRaw, sessionResetRaw };
  }

  /**
   * 检查并激活单个 Token
   * @param {string} tokenId
   * @param {Object} token
   * @param {Object} [quotaData]
   */
  async checkAndActivateToken(tokenId, token, quotaData = null) {
    if (!token || token.enable === false || !token.access_token) return;

    let currentQuota = quotaData || quotaManager.cache.get(tokenId) || {};

    for (const groupKey of ['gemini', 'claude']) {
      const lockKey = `${tokenId}:${groupKey}`;
      if (this.busyKeys.has(lockKey)) continue;

      let evalResult = this.evaluateActivationNeed(tokenId, token, groupKey, currentQuota);

      // 如果任一重置时间已过，先尝试拉取一次最新额度摘要，确保拿到上游最新状态
      if (evalResult.shouldActivate && evalResult.reason.includes('到期')) {
        try {
          const freshWeekly = await fetchQuotaSummary(token);
          if (freshWeekly) {
            quotaManager.updateQuotaSummary(tokenId, freshWeekly);
            currentQuota = quotaManager.cache.get(tokenId) || currentQuota;
            evalResult = this.evaluateActivationNeed(tokenId, token, groupKey, currentQuota);
          }
        } catch (err) {
          log.warn(`[WeeklyActivation] 拉取最新配额摘要失败 (${token.email}): ${err.message}`);
        }
      }

      if (!evalResult.shouldActivate) continue;

      this.busyKeys.add(lockKey);
      try {
        log.info(`[WeeklyActivation] 发现待激活账号 ${token.email || tokenId} [${groupKey}]，触发原因: ${evalResult.reason}`);

        const probeResult = await this.sendActivationProbe(token, groupKey);

        // 探针成功后立即拉取最新的配额缓存（更新 7 天与 5h 倒计时）
        await refreshTokenQuotaCache(tokenId, token);
        const refreshedQuota = quotaManager.cache.get(tokenId);
        const newWeeklyReset = refreshedQuota?.weeklyResetTimes?.[groupKey] || evalResult.weeklyResetRaw;
        const newSessionReset = refreshedQuota?.sessionResetTimes?.[groupKey] || evalResult.sessionResetRaw;

        this.recordActivation(tokenId, token.email, groupKey, newWeeklyReset, newSessionReset, true);

        log.info(
          `[WeeklyActivation] ✓ 账号 ${token.email || tokenId} [${groupKey}] 激活成功！使用模型: ${probeResult.model}，周重置: ${newWeeklyReset || '未知'}，5h重置: ${newSessionReset || '未知'}`
        );
      } catch (err) {
        log.error(`[WeeklyActivation] ✗ 账号 ${token.email || tokenId} [${groupKey}] 激活失败: ${err.message}`);
      } finally {
        this.busyKeys.delete(lockKey);
      }
    }
  }

  /**
   * 检查并激活号池中所有启用账号
   * @param {Object} [tokenManagerInstance]
   */
  async checkAndActivateAll(tokenManagerInstance = null) {
    if (this.isChecking) return;
    this.isChecking = true;

    try {
      let tm = tokenManagerInstance;
      if (!tm) {
        const { default: defaultTm } = await import('./token_manager.js');
        tm = defaultTm;
      }
      await tm.getTokenList();
      const enabledIds = tm.pool.getEnabledIds();

      for (const tokenId of enabledIds) {
        const token = tm.pool.get(tokenId);
        if (!token?.access_token) continue;
        const quotaData = quotaManager.cache.get(tokenId);
        await this.checkAndActivateToken(tokenId, token, quotaData);
      }
    } catch (err) {
      log.error(`[WeeklyActivation] 扫描激活号池异常: ${err.message}`);
    } finally {
      this.isChecking = false;
    }
  }

  /**
   * 启动后台定时轮询（默认 10 分钟）
   */
  start(intervalMs = null) {
    if (intervalMs) this.checkIntervalMs = intervalMs;
    if (this.intervalTimer) clearInterval(this.intervalTimer);

    this.intervalTimer = setInterval(() => {
      this.checkAndActivateAll().catch(err => {
        log.error(`[WeeklyActivation] 定时激活检查失败: ${err.message}`);
      });
    }, this.checkIntervalMs);

    this.intervalTimer.unref?.();
    const mins = Math.round(this.checkIntervalMs / 60000);
    log.info(`[WeeklyActivation] 周额度/5h额度重置自动激活守护已启动，检查间隔: ${mins} 分钟 (${this.checkIntervalMs} ms)`);

    // 启动后异步执行一次初次扫描
    Promise.resolve().then(() => this.checkAndActivateAll()).catch(() => {});
  }

  /**
   * 停止后台定时轮询
   */
  stop() {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
      log.info('[WeeklyActivation] 周额度/5h额度自动激活守护已停止');
    }
  }

  /**
   * 获取当前全部激活状态信息，供前端或管理 API 查询
   */
  getStatus() {
    const statusObj = {};
    this.records.forEach((rec, id) => {
      statusObj[id] = rec;
    });
    return {
      running: !!this.intervalTimer,
      checkIntervalMs: this.checkIntervalMs,
      checkIntervalMinutes: Math.round(this.checkIntervalMs / 60000),
      busyCount: this.busyKeys.size,
      records: statusObj
    };
  }
}

const weeklyActivationManager = new WeeklyActivationManager();
export default weeklyActivationManager;
