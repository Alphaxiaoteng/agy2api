import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import logger from '../utils/logger.js';
import { proxyWorkBuddyChat } from './workbuddyService.js';
import { syncCockpitQoderAccounts } from './cockpitQoderSync.js';
import { handleOpenAIRequest } from '../server/handlers/openai.js';
import SessionAffinity from '../auth/session_affinity.js';
import { getRequestSessionKey } from '../utils/requestSession.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CUSTOM_ACCOUNTS_PATH = path.join(PROJECT_ROOT, 'data', 'qoder_accounts.json');

/**
 * 内置基础保障 PAT 账号列表 (Tier 1 国内极速主力 + Tier 2 国际高可用备用)
 */
export const DEFAULT_QODER_ACCOUNTS = [
  {
    id: 'qoder-cn-1',
    label: 'Qoder CN (国内版 #1)',
    region: 'cn',
    tier: 1, // 第一优先级：极速低延迟主力
    binary: '/Users/albert/.local/bin/qodercn',
    envName: 'QODERCN_PERSONAL_ACCESS_TOKEN',
    token: 'pt-o3SolyeRL8YuTxSh52wSj5Cf_01a0ebd4-ea53-75ce-9e98-c69415ff65e3',
    enabled: true,
    source: 'builtin'
  },
  {
    id: 'qoder-global-1',
    label: 'Qoder Global (国际版 #1)',
    region: 'global',
    tier: 2, // 第二优先级：海外高可用备用
    binary: '/Users/albert/.local/bin/qodercli',
    envName: 'QODER_PERSONAL_ACCESS_TOKEN',
    token: 'pt-ZT0lIDhohfyL7veTMuxKEiJb_01a0ebd7-a807-7238-9ffe-432680875eb2',
    enabled: true,
    source: 'builtin'
  },
  {
    id: 'qoder-global-2',
    label: 'Qoder Global (国际版 #2)',
    region: 'global',
    tier: 2, // 第二优先级：海外高可用备用
    binary: '/Users/albert/.local/bin/qodercli',
    envName: 'QODER_PERSONAL_ACCESS_TOKEN',
    token: 'pt-rYEWfOtpbR1kxWciqYIQ8XZj_01a0ebd9-91a6-7d88-b66c-4216b7784bb3',
    enabled: true,
    source: 'builtin'
  }
];

/**
 * 全功能高可用 Qoder 号池管理器 (QoderPoolManager)
 * 职责：
 * 1. 动态加载：聚合内置 PAT、data/qoder_accounts.json 配置及 Cockpit 解密账号
 * 2. 智能调度：结合 Tier 分级、最少活跃并发 (Least-Busy) 与轮询负载均衡
 * 3. 分级熔断：对 429 限流、欠费/额度耗尽、认证异常与偶发网络抖动进行梯度退避
 * 4. 指标监控：记录各节点的总调用量、成功率、平均耗时与并发数
 */
class QoderPoolManager {
  constructor() {
    this.accounts = new Map();
    this.cooldowns = new Map(); // id -> { until, reason, level }
    this.inflight = new Map();  // id -> number
    this.metrics = new Map();   // id -> { total, success, failed, totalLatencyMs, avgLatencyMs, lastUsedAt, lastErrorAt, lastErrorMsg }
    this.consecutiveFailures = new Map(); // id -> number
    this.sessionAffinity = new SessionAffinity(1024, 30 * 60 * 1000);
    this.roundRobinIndex = 0;
    this.fileWatcher = null;

    // 后台主动探活：死节点（如已失效的国际版账号）会让 CLI 长时间挂起不输出，
    // 原先只能在用户请求的热路径上串行踩 12s 首字节看门狗，叠加出 30s+ 的体感延迟。
    // 改为后台定期探测，挂起/失败节点直接标记熔断，请求调度直接跳过。
    this.health = new Map();        // id -> { lastProbeAt, ok, latencyMs, reason }
    this.probeTimer = null;
    this.probeInFlight = new Set();

    this.loadAccounts();
    this.initFileWatcher();
    this.startHealthProbe();
  }

  /**
   * 初始化并热重载全量号池
   */
  loadAccounts() {
    const newMap = new Map();

    // 1. 加载内置基础账号
    for (const acc of DEFAULT_QODER_ACCOUNTS) {
      newMap.set(acc.id, { ...acc });
    }

    // 2. 加载用户自定义外部文件 data/qoder_accounts.json
    try {
      if (fs.existsSync(CUSTOM_ACCOUNTS_PATH)) {
        const raw = fs.readFileSync(CUSTOM_ACCOUNTS_PATH, 'utf8');
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.accounts) ? parsed.accounts : []);
        for (const item of list) {
          if (!item.id || !item.token) continue;
          const isCn = item.region === 'cn' || (item.binary && item.binary.includes('cn')) || (item.label && item.label.includes('CN'));
          const defaultBinary = isCn ? '/Users/albert/.local/bin/qodercn' : '/Users/albert/.local/bin/qodercli';
          const defaultEnv = isCn ? 'QODERCN_PERSONAL_ACCESS_TOKEN' : 'QODER_PERSONAL_ACCESS_TOKEN';
          newMap.set(item.id, {
            id: item.id,
            label: item.label || `Qoder Custom (${item.id})`,
            region: isCn ? 'cn' : 'global',
            tier: Number(item.tier) || (isCn ? 1 : 2),
            binary: item.binary || defaultBinary,
            envName: item.envName || defaultEnv,
            token: item.token,
            enabled: item.enabled !== false,
            source: 'custom_file'
          });
        }
      }
    } catch (err) {
      logger.warn('[QoderPoolManager] 加载自定义 qoder_accounts.json 异常:', err.message);
    }

    // 3. 关联 Cockpit 账号信息与额度
    try {
      const cockpitAccounts = syncCockpitQoderAccounts();
      if (Array.isArray(cockpitAccounts) && cockpitAccounts.length > 0) {
        for (const cp of cockpitAccounts) {
          // 如果 Cockpit 账号带有 PAT (以 pt- 开头)，可以直接作为新节点注入
          if (cp.token && cp.token.startsWith('pt-') && !newMap.has(cp.id)) {
            const isCn = cp.email?.includes('QoderCN') || cp.planType?.includes('Standard');
            newMap.set(cp.id, {
              id: cp.id,
              label: `Cockpit Qoder (${cp.email})`,
              region: isCn ? 'cn' : 'global',
              tier: isCn ? 1 : 2,
              binary: isCn ? '/Users/albert/.local/bin/qodercn' : '/Users/albert/.local/bin/qodercli',
              envName: isCn ? 'QODERCN_PERSONAL_ACCESS_TOKEN' : 'QODER_PERSONAL_ACCESS_TOKEN',
              token: cp.token,
              creditsRemaining: cp.creditsRemaining,
              planType: cp.planType,
              enabled: true,
              source: 'cockpit'
            });
          } else {
            // 匹配现有账号并丰富额度与 plan 标签
            for (const acc of newMap.values()) {
              if (acc.email === cp.email || (acc.id && cp.id && acc.id.includes(cp.id))) {
                acc.creditsRemaining = cp.creditsRemaining;
                acc.planType = cp.planType;
              }
            }
          }
        }
      }
    } catch (cpErr) {
      logger.debug('[QoderPoolManager] Cockpit 账号关联跳过:', cpErr.message);
    }

    this.accounts = newMap;

    // 二进制缺失自愈：若账号配置的 CLI 可执行文件不存在（如被上游删除/升级移除），
    // 直接置 enabled=false —— 账号仍保留在号池中（不删除、不摘除），只是不参与探活与调度，
    // 避免每次请求白等 spawn ENOENT 并刷熔断日志。二进制恢复后重载即自动启用。
    for (const acc of this.accounts.values()) {
      if (!acc.binary) continue;
      if (!fs.existsSync(acc.binary) && acc.enabled !== false) {
        acc.enabled = false;
        logger.warn(`[QoderPoolManager] 账号 [${acc.id}] 的 CLI 不存在 (${acc.binary})，已置为 disabled（保留在号池，不参与调度）`);
      }
    }

    // 确保所有账号都初始化了指标记录
    for (const id of this.accounts.keys()) {
      if (!this.metrics.has(id)) {
        this.metrics.set(id, {
          total: 0,
          success: 0,
          failed: 0,
          totalLatencyMs: 0,
          avgLatencyMs: 0,
          lastUsedAt: 0,
          lastErrorAt: 0,
          lastErrorMsg: ''
        });
      }
      if (!this.inflight.has(id)) {
        this.inflight.set(id, 0);
      }
    }

    const enabledCount = Array.from(this.accounts.values()).filter(a => a.enabled !== false).length;
    logger.info(`[QoderPoolManager] 号池加载完成，节点总数: ${this.accounts.size}（启用: ${enabledCount}）`);
  }

  /**
   * 监听配置文件变动以支持热重载
   */
  initFileWatcher() {
    try {
      if (fs.existsSync(CUSTOM_ACCOUNTS_PATH)) {
        this.fileWatcher = fs.watch(CUSTOM_ACCOUNTS_PATH, (eventType) => {
          if (eventType === 'change') {
            logger.info('[QoderPoolManager] 检测到 qoder_accounts.json 变更，触发热重载...');
            this.loadAccounts();
          }
        });
        if (this.fileWatcher && typeof this.fileWatcher.unref === 'function') {
          this.fileWatcher.unref();
        }
      }
    } catch (_) {}
  }

  /**
   * 获取账号列表
   */
  getAllAccounts() {
    return Array.from(this.accounts.values());
  }

  /**
   * 检查指定账号是否正处于熔断冷却中
   */
  isAccountInCooldown(accountId) {
    const item = this.cooldowns.get(accountId);
    if (!item) return false;
    if (Date.now() >= item.until) {
      this.cooldowns.delete(accountId);
      return false;
    }
    return true;
  }

  /**
   * 标记账号进入分级熔断冷却
   * @param {string} accountId 账号唯一 ID
   * @param {number} ms 冷却时间 (毫秒)
   * @param {string} reason 冷却原因
   * @param {number} level 级别 (1: 瞬时抖动 2: 频率限制 3: 额度耗尽/认证错误)
   */
  markAccountCooldown(accountId, ms = 30000, reason = 'error', level = 1) {
    const currentFailures = (this.consecutiveFailures.get(accountId) || 0) + 1;
    this.consecutiveFailures.set(accountId, currentFailures);

    // 按节点历史健康度动态决定冷却时长：
    // - 健康/新节点（成功数占比正常）：保持短冷却（≤2s），失败只做临时跳过，不放大；
    // - 长期死节点（成功率 < 5% 且失败 ≥ 20 次，如已失效的国际版账号）：
    //   冷却拉长到 24h，避免每次轮到它都白等 30s 首字节超时、拖垮整条请求。
    const acc = this.accounts.get(accountId) || {};
    const metrics = this.metrics.get(accountId) || {};
    const okCount = Number(metrics.success || 0);
    const failCount = Number(metrics.failed || 0);
    const total = okCount + failCount;
    const successRate = total > 0 ? okCount / total : 1;
    const isDeadNode = total >= 20 && successRate < 0.05;

    let finalMs;
    if (isDeadNode) {
      finalMs = 24 * 60 * 60 * 1000;
      logger.warn(
        `[QoderPoolManager] 账号 [${accountId}] 判定为长期死节点 (成功 ${okCount}/${total}，成功率 ${(successRate * 100).toFixed(1)}%)，冷却 24h`
      );
    } else {
      // 不做阶梯放大：失败只做极短临时跳过，节点可用性由每次实际请求决定
      finalMs = Math.min(Math.max(ms, 0), 2000);
    }

    this.cooldowns.set(accountId, {
      until: Date.now() + finalMs,
      reason,
      level,
      startedAt: Date.now()
    });

    if (!isDeadNode) {
      logger.info(
        `[QoderPoolManager] 账号 [${accountId}] 临时跳过 ${Math.round(finalMs / 1000)}s (失败计数: ${currentFailures}, 原因: ${reason});不做长期封禁`
      );
    }
  }

  /**
   * 清除指定或全部账号的冷却状态
   */
  resetCooldown(accountId = null) {
    if (accountId) {
      this.cooldowns.delete(accountId);
      this.consecutiveFailures.set(accountId, 0);
      logger.info(`[QoderPoolManager] 账号 [${accountId}] 冷却已重置`);
    } else {
      this.cooldowns.clear();
      this.consecutiveFailures.clear();
      logger.info('[QoderPoolManager] 所有账号冷却已全量重置');
    }
  }

  /**
   * 占用节点并增加活跃并发计数
   */
  acquire(accountId) {
    const cur = this.inflight.get(accountId) || 0;
    this.inflight.set(accountId, cur + 1);
  }

  /**
   * 释放节点并沉淀指标
   */
  release(accountId, success, latencyMs, error = null) {
    const cur = this.inflight.get(accountId) || 0;
    this.inflight.set(accountId, Math.max(0, cur - 1));

    const m = this.metrics.get(accountId) || {
      total: 0,
      success: 0,
      failed: 0,
      totalLatencyMs: 0,
      avgLatencyMs: 0,
      lastUsedAt: 0,
      lastErrorAt: 0,
      lastErrorMsg: ''
    };

    m.total += 1;
    m.lastUsedAt = Date.now();

    if (success) {
      m.success += 1;
      m.totalLatencyMs += latencyMs;
      m.avgLatencyMs = Math.round(m.totalLatencyMs / m.success);
      this.consecutiveFailures.set(accountId, 0);
    } else {
      m.failed += 1;
      m.lastErrorAt = Date.now();
      m.lastErrorMsg = error ? error.message : 'Unknown error';

      // 错误类型分类熔断
      const errStr = (error?.message || '').toLowerCase();
      // 额度耗尽优先判定：必须排在 rate_limit 之前，避免 429/limit 误归类为短冷却
      const isQuotaExhausted =
        errStr.includes('quota') ||
        errStr.includes('credit') ||          // 覆盖 "credit usage limit" (单数) 与 "credits"
        errStr.includes('insufficient') ||
        errStr.includes('usage limit') ||     // "You've reached your credit usage limit"
        errStr.includes('subscription plan') ||
        errStr.includes('upgrade your') ||
        errStr.includes('欠费') ||
        errStr.includes('额度');

      if (isQuotaExhausted) {
        this.markAccountCooldown(accountId, 30 * 60 * 1000, 'quota_exceeded', 3);
      } else if (errStr.includes('429') || errStr.includes('rate limit') || errStr.includes('too many requests')) {
        this.markAccountCooldown(accountId, 45 * 1000, 'rate_limit', 2);
      } else if (errStr.includes('401') || errStr.includes('unauthorized') || errStr.includes('invalid pat') || errStr.includes('invalid token')) {
        this.markAccountCooldown(accountId, 15 * 60 * 1000, 'auth_invalid', 3);
      } else {
        this.markAccountCooldown(accountId, 15 * 1000, 'exec_failure', 1);
      }
    }

    this.metrics.set(accountId, m);
  }

  /**
   * 启动后台主动探活定时器
   *
   * 目的：把「踩坑」从用户请求的热路径搬到后台。
   * 死节点在热路径上每次都要白等首字节看门狗（默认 12s），3 个节点串行就是 30s+。
   * 后台每轮对节点做一次轻量探测，挂起/报错的节点直接进入冷却，请求不再选中它。
   */
  startHealthProbe() {
    const enabled = process.env.QODER_HEALTH_PROBE_ENABLED !== 'false';
    if (!enabled) return;

    const intervalMs = Number(process.env.QODER_HEALTH_PROBE_INTERVAL_MS) || 5 * 60 * 1000;
    // 探活超时独立于热路径看门狗：冷启动时网关本身有额外开销，
    // 曾经用 15s 却因 executeQoderCli 内部 6s 首字节看门狗先触发而误熔断了健康节点。
    // 这里显式把首字节容忍窗口提高，避免误杀健康节点。
    const probeTimeoutMs = Number(process.env.QODER_HEALTH_PROBE_TIMEOUT_MS) || 60000;
    const probeFirstByteMs = Number(process.env.QODER_HEALTH_PROBE_FIRST_BYTE_MS) || 30000;

    const runProbes = async () => {
      const accounts = Array.from(this.accounts.values()).filter(a => a.enabled !== false);
      // 串行探测，避免同时拉起多个 CLI 进程互相争抢 CPU
      for (const acc of accounts) {
        if (this.probeInFlight.has(acc.id)) continue;
        // 已有大量在途请求说明节点活着，无需重复探测
        if ((this.inflight.get(acc.id) || 0) > 0) continue;
        this.probeInFlight.add(acc.id);
        try {
          const t0 = Date.now();
          // 通过环境变量临时抬高本次探测的首字节容忍窗口，避免误熔断慢但健康的节点
          const prevFirstByte = process.env.QODER_FIRST_BYTE_TIMEOUT_MS;
          process.env.QODER_FIRST_BYTE_TIMEOUT_MS = String(probeFirstByteMs);
          try {
            await executeQoderCli(acc, 'Qwen3.8-Flash', 'ping', probeTimeoutMs, null, []);
          } finally {
            if (prevFirstByte === undefined) delete process.env.QODER_FIRST_BYTE_TIMEOUT_MS;
            else process.env.QODER_FIRST_BYTE_TIMEOUT_MS = prevFirstByte;
          }
          const latencyMs = Date.now() - t0;
          this.health.set(acc.id, { lastProbeAt: Date.now(), ok: true, latencyMs, reason: '' });
          this.consecutiveFailures.set(acc.id, 0);
          // 探测成功：清除该节点的冷却，让它重新进入候选池
          if (this.isAccountInCooldown(acc.id)) {
            this.cooldowns.delete(acc.id);
            this.consecutiveFailures.set(acc.id, 0);
            logger.info(`[QoderPoolManager] 探活恢复：账号 [${acc.id}] 已可用 (${latencyMs}ms)，解除冷却`);
          }
        } catch (err) {
          const reason = (err && err.message) || 'probe failed';
          this.health.set(acc.id, { lastProbeAt: Date.now(), ok: false, latencyMs: 0, reason });
          // 探测失败：按死节点标准熔断，避免热路径再次白等
          const isTimeout = /首字节超时|超时/i.test(reason);
          if (isTimeout) {
            this.markAccountCooldown(acc.id, 10 * 60 * 1000, 'probe_timeout', 3);
            logger.warn(`[QoderPoolManager] 探活超时熔断：账号 [${acc.id}] 挂起无响应，冷却 600s (${reason.slice(0, 120)})`);
          } else {
            this.markAccountCooldown(acc.id, 3 * 60 * 1000, 'probe_failed', 2);
            logger.warn(`[QoderPoolManager] 探活失败熔断：账号 [${acc.id}] 冷却 180s (${reason.slice(0, 120)})`);
          }
        } finally {
          this.probeInFlight.delete(acc.id);
        }
      }
    };

    // 启动后延迟 10s 再跑首轮，避免拖慢服务启动
    setTimeout(() => { runProbes().catch(e => logger.warn('[QoderPoolManager] 探活异常:', e.message)); }, 10000);
    this.probeTimer = setInterval(() => {
      runProbes().catch(e => logger.warn('[QoderPoolManager] 探活异常:', e.message));
    }, intervalMs);
    this.probeTimer.unref?.();
    logger.info(`[QoderPoolManager] 后台探活已启动 (间隔 ${Math.round(intervalMs / 1000)}s, 单次超时 ${Math.round(probeTimeoutMs / 1000)}s)`);
  }

  /**
   * 停止后台探活（测试/优雅退出用）
   */
  stopHealthProbe() {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  /**
   * 获取多维优先级调度的候选账号序列
   * 准则：单会话固定粘性绑定 (Session Affinity) > Tier 优先级 > Inflight 空闲优先 > 最少活跃会话数 > 轮询打散
   */
  getCandidates(sessionKey = null) {
    const all = Array.from(this.accounts.values()).filter(a => a.enabled !== false);
    if (all.length === 0) return [];

    // 1. 过滤未熔断节点
    let available = all.filter(a => !this.isAccountInCooldown(a.id));

    // 1.1 强排除「后台探活已确认失败」的节点。
    // 探活是在后台以长超时（默认首字节 30s）验证过的结论：这类节点必然挂起，
    // 放进候选池只会让用户在热路径上白等看门狗，重复制造 30s+ 延迟。
    const probeDead = available.filter(a => this.health.get(a.id)?.ok === false);
    if (probeDead.length > 0 && probeDead.length < all.length) {
      logger.info(
        `[QoderPoolManager] 跳过 ${probeDead.length} 个探活失败节点: ${probeDead.map(a => a.id).join(', ')}`
      );
      available = available.filter(a => this.health.get(a.id)?.ok !== false);
    }

    // 2. 候选池基准 (若全量熔断，自动降级选择冷却剩余时间最短的节点)
    let basePool = available;
    if (basePool.length === 0) {
      logger.warn('[QoderPoolManager] 所有 Qoder 节点处于临时跳过窗口，按剩余时间升序全部纳入候选（不做长期封禁）');
      const sortedByCooldown = [...all].sort((a, b) => {
        const untilA = this.cooldowns.get(a.id)?.until || 0;
        const untilB = this.cooldowns.get(b.id)?.until || 0;
        return untilA - untilB;
      });
      basePool = sortedByCooldown;
    }

    const pinnedAccountId = sessionKey ? this.sessionAffinity.get(sessionKey) : null;
    const sessionCounts = this.sessionAffinity.countByToken();

    // 仅在新会话或原绑定节点繁忙时旋转游标，避免同一会话每次调用都位移切号
    const pinnedInflight = pinnedAccountId ? (this.inflight.get(pinnedAccountId) || 0) : 0;
    const shouldAdvanceCursor = !pinnedAccountId || pinnedInflight > 0;
    const offset = (shouldAdvanceCursor ? this.roundRobinIndex++ : this.roundRobinIndex) % basePool.length;
    const rotated = [...basePool.slice(offset), ...basePool.slice(0, offset)];

    return rotated.sort((a, b) => {
      const inflightA = this.inflight.get(a.id) || 0;
      const inflightB = this.inflight.get(b.id) || 0;

      // 0. 会话粘性置顶：若该会话已绑定节点且当前空闲（inflight === 0），直接锁定首位不切换
      if (pinnedAccountId) {
        const aIsPinnedIdle = a.id === pinnedAccountId && inflightA === 0;
        const bIsPinnedIdle = b.id === pinnedAccountId && inflightB === 0;
        if (aIsPinnedIdle !== bIsPinnedIdle) return aIsPinnedIdle ? -1 : 1;
      }

      // 0.5 后台探活健康度置顶：探测失败/挂起的节点排到最后，
      // 避免热路径上先踩死节点白等首字节看门狗（这才是 30s+ 延迟的根因）
      const ha = this.health.get(a.id);
      const hb = this.health.get(b.id);
      const aOk = ha ? (ha.ok ? 1 : 0) : 0; // 未探测过的节点视为未知，不享受置顶
      const bOk = hb ? (hb.ok ? 1 : 0) : 0;
      if (aOk !== bOk) return bOk - aOk;

      // 1. Tier 排序 (1: 国内极速优先, 2: 国际版)
      const tierA = a.tier || 2;
      const tierB = b.tier || 2;
      if (tierA !== tierB) return tierA - tierB;

      // 2. Inflight 排序 (最少并发优先，空闲 0 并发优先)
      if (inflightA !== inflightB) return inflightA - inflightB;

      // 3. 新会话错峰分流：优先选择当前已绑定活跃会话数最少的节点（同时开多个会话时一人一号）
      const sessA = sessionCounts.get(a.id) || 0;
      const sessB = sessionCounts.get(b.id) || 0;
      if (sessA !== sessB) return sessA - sessB;

      // 稳定排序保留预旋转顺序
      return 0;
    });
  }

  /**
   * 输出可安全展示与运维查询的号池状态报告 (脱敏敏感 Token)
   */
  getPoolStatus() {
    const list = [];
    const now = Date.now();

    for (const [id, acc] of this.accounts.entries()) {
      const cd = this.cooldowns.get(id);
      const isCooling = cd ? now < cd.until : false;
      const m = this.metrics.get(id) || { total: 0, success: 0, failed: 0, avgLatencyMs: 0 };
      const inflight = this.inflight.get(id) || 0;

      let status = 'idle';
      if (!acc.enabled) status = 'disabled';
      else if (isCooling) status = 'cooldown';
      else if (inflight > 0) status = 'busy';

      list.push({
        id: acc.id,
        label: acc.label,
        region: acc.region,
        tier: acc.tier,
        status,
        activeInflight: inflight,
        creditsRemaining: acc.creditsRemaining ?? null,
        planType: acc.planType ?? null,
        source: acc.source,
        tokenMasked: acc.token ? `${acc.token.slice(0, 7)}...${acc.token.slice(-4)}` : 'none',
        cooldownRemainingSec: isCooling ? Math.round((cd.until - now) / 1000) : 0,
        cooldownReason: isCooling ? cd.reason : null,
        metrics: {
          total: m.total,
          success: m.success,
          failed: m.failed,
          successRate: m.total > 0 ? `${Math.round((m.success / m.total) * 100)}%` : '100%',
          avgLatencyMs: m.avgLatencyMs,
          lastUsedAt: m.lastUsedAt > 0 ? new Date(m.lastUsedAt).toISOString() : null,
          lastError: m.lastErrorMsg || null
        }
      });
    }

    return {
      success: true,
      timestamp: new Date().toISOString(),
      totalAccounts: this.accounts.size,
      activeHealthy: list.filter(a => a.status === 'idle' || a.status === 'busy').length,
      cooldownCount: list.filter(a => a.status === 'cooldown').length,
      accounts: list
    };
  }
}

// 单例实例
export const poolManager = new QoderPoolManager();

// 兼容老调用方式的导出
export const QODER_ACCOUNTS = poolManager.getAllAccounts();
export function markAccountCooldown(accountId, ms = 30000, reason = 'error') {
  poolManager.markAccountCooldown(accountId, ms, reason);
}
export function isAccountInCooldown(accountId) {
  return poolManager.isAccountInCooldown(accountId);
}
export function getRoundRobinCandidates() {
  return poolManager.getCandidates();
}
export function getPoolStatus() {
  return poolManager.getPoolStatus();
}
export function reloadPool() {
  poolManager.loadAccounts();
  return poolManager.getPoolStatus();
}
export function resetPoolCooldown(accountId = null) {
  poolManager.resetCooldown(accountId);
  return poolManager.getPoolStatus();
}

/**
 * 格式化 messages 数组与 tools 为 CLI 对话 prompt
 */
export function formatMessagesToPrompt(messages, tools) {
  if (!Array.isArray(messages) || messages.length === 0) return '';
  
  const parts = [];

  // 若客户端定义了 tools，注入工具描述
  if (Array.isArray(tools) && tools.length > 0) {
    const toolsDesc = JSON.stringify(tools, null, 2);
    parts.push(`### Available Tools:
You have access to the following tools:
${toolsDesc}

To call a tool, you MUST format your response as:
<invoke name="tool_name">
<parameter name="parameter_name">parameter_value</parameter>
</invoke>

CRITICAL RULES:
1. Always output actual <invoke> tool calls whenever you need to read, write, edit, grep, or run commands.
2. NEVER simulate, fake, or narrate tool executions/results in natural language (e.g. do NOT write "Running grep...", "Audit verdict: clean", or markdown pseudo-steps). Issue the actual tool invocation directly.
3. If no tools are required, reply with concise, direct markdown.`);
  }

  for (const m of messages) {
    const role = m.role || 'user';
    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .map(c => (c.type === 'text' ? c.text : ''))
        .filter(Boolean)
        .join('\n');
    }
    
    // 若 assistant 曾发起 tool_calls，将其还原为 XML 格式加入上下文
    if (role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const tcXml = m.tool_calls.map(tc => {
        let argsObj = {};
        try {
          argsObj = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
        } catch (_) {}
        const paramsXml = Object.entries(argsObj)
          .map(([k, v]) => `<parameter name="${k}">${typeof v === 'object' ? JSON.stringify(v) : v}</parameter>`)
          .join('\n');
        return `<invoke name="${tc.function?.name}">\n${paramsXml}\n</invoke>`;
      }).join('\n');
      text = (text ? text + '\n' : '') + tcXml;
    }

    if (!text && !m.tool_call_id) continue;

    if (role === 'system') {
      parts.push(`### System Instruction:\n${text}`);
    } else if (role === 'user') {
      parts.push(`### User Request:\n${text}`);
    } else if (role === 'assistant') {
      parts.push(`### Assistant Response:\n${text}`);
    } else if (role === 'tool') {
      parts.push(`### Tool Execution Result (tool_call_id: ${m.tool_call_id || 'default'}):\n${text}`);
    }
  }
  return parts.join('\n\n');
}

/**
 * 映射为目标 CLI 模型名（与 `qodercli --list-models` 显示名一致）
 * - Cantus / Sonus：尝鲜顶级（勿误映射到 Qwen）
 * - Qwen3.8-Max / Qwen3.8-Flash：日常主力
 */
export function resolveCliModelName(rawModel) {
  const raw = String(rawModel || '').trim();
  const m = raw
    .toLowerCase()
    .replace(/^qoder\//, '')
    .replace(/^qodercn\//, '')
    .replace(/\s*\(qoder\)\s*$/i, '')
    .trim();

  if (m === 'cantus' || m === 'cmodel' || m.includes('cantus')) return 'Cantus';
  if (m === 'sonus' || m === 'smodel' || m.includes('sonus')) return 'Sonus';
  if (m.includes('deepseek') || m.includes('v4.1') || m.includes('ds4')) {
    if (m.includes('flash')) return 'DeepSeek-Flash';
    return 'DeepSeek-V4-Pro';
  }
  if (m.includes('max') || m.includes('38max') || m.includes('plus') || m === 'qmodel_38max') {
    return 'Qwen3.8-Max';
  }
  if (m.includes('flash') || m === 'qfmodel' || m.includes('qwen')) {
    return 'Qwen3.8-Flash';
  }
  // 已是 CLI 显示名（如 Cantus / Sonus）则原样透传
  if (/^[A-Za-z][\w.+-]*$/.test(raw) && !raw.includes('/')) {
    return raw;
  }
  return 'Qwen3.8-Flash';
}

/**
 * 提取 messages 中的多模态图片并落盘为 /tmp 临时文件供 --attachment 使用
 */
// Qoder CLI 硬性限制：单次请求最多允许 5 个 --attachment。
// 超出会直接报 "too many attachments, only 5 allowed" 并触发整号熔断，
// 因此这里主动截断，只保留最近 5 张（越靠后的上下文越重要），并清理被丢弃的临时文件。
const QODER_MAX_ATTACHMENTS = 5;

function extractAttachmentsFromMessages(messages) {
  const tempFiles = [];
  if (!Array.isArray(messages)) return tempFiles;
  for (const m of messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const part of m.content) {
      if (!part || typeof part !== 'object') continue;
      let rawUrl = '';
      if (part.type === 'image_url') {
        rawUrl = typeof part.image_url === 'string' ? part.image_url : (part.image_url?.url || '');
      } else if (part.type === 'image' && part.source?.data) {
        const mediaType = part.source.media_type || 'image/png';
        rawUrl = `data:${mediaType};base64,${part.source.data}`;
      }
      if (!rawUrl) continue;
      const match = /^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/i.exec(rawUrl);
      if (match) {
        let ext = match[1].toLowerCase();
        if (ext === 'jpeg') ext = 'jpg';
        const filePath = path.join('/tmp', `qoder_att_${crypto.randomBytes(8).toString('hex')}.${ext}`);
        try {
          fs.writeFileSync(filePath, Buffer.from(match[2], 'base64'));
          tempFiles.push(filePath);
        } catch (err) {
          logger.warn('[QoderCliPool] 写入临时图片附件失败:', err.message);
        }
      }
    }
  }

  // 超出上限时保留最后 N 张，并删除被丢弃的临时文件，避免 /tmp 堆积
  if (tempFiles.length > QODER_MAX_ATTACHMENTS) {
    const dropped = tempFiles.splice(0, tempFiles.length - QODER_MAX_ATTACHMENTS);
    cleanupTempAttachments(dropped);
    logger.warn(
      `[QoderCliPool] 图片附件 ${dropped.length + QODER_MAX_ATTACHMENTS} 张超过上限 ${QODER_MAX_ATTACHMENTS}，仅保留最近 ${QODER_MAX_ATTACHMENTS} 张`
    );
  }
  return tempFiles;
}

function cleanupTempAttachments(files) {
  if (!Array.isArray(files)) return;
  for (const f of files) {
    try {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {}
  }
}

/**
 * 底层执行 CLI 并捕获净输出
 * 优化：在 /tmp 运行，禁用 tools 与 setting 深度扫描，支持优雅超时控制
 */
export function executeQoderCli(account, model, prompt, timeoutMs = 300000, abortSignal = null, attachments = [], onChunk = null) {
  return new Promise((resolve, reject) => {
    const isCn = account.region === 'cn' || (account.binary && account.binary.includes('qodercn'));
    let actualModel = model;
    if (isCn) {
      // qodercn 国内版仅支持 Qwen3.8-Flash 与 DeepSeek-Flash，若传入 Max/Pro 需映射至对应可用模型防止挂起
      if (/deepseek/i.test(actualModel)) actualModel = 'DeepSeek-Flash';
      else if (/qwen/i.test(actualModel)) actualModel = 'Qwen3.8-Flash';
    }

    const args = [
      '-m', actualModel,
      '--no-session-persistence',
      '--dangerously-skip-permissions',
      '--tools', ''
    ];
    if (Array.isArray(attachments) && attachments.length > 0) {
      for (const att of attachments) {
        args.push('--attachment', att);
      }
    }
    args.push('-p');

    const env = {
      ...process.env,
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      http_proxy: '',
      https_proxy: '',
      all_proxy: '',
      NO_PROXY: '*',
      no_proxy: '*',
      [account.envName]: account.token,
      HOME: process.env.HOME || '/Users/albert'
    };

    logger.info(`[QoderCliPool] 执行子进程: ${account.binary} -m ${actualModel} [账号: ${account.id}, Tier: ${account.tier}] (stdin 传输)`);

    const child = spawn(account.binary, args, {
      env,
      cwd: '/tmp', // 关键提速优化：在 /tmp 执行避免扫描工程目录
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const killChild = () => {
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
      }, 1000);
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        killChild();
        return reject(new Error('客户端已断开'));
      }
      abortSignal.addEventListener('abort', killChild, { once: true });
    }

    child.stdin.on('error', () => {});
    if (prompt) {
      child.stdin.write(prompt, 'utf8');
    }
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    let timer = null;
    let firstByteTimer = null;
    let sawFirstByte = false;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        killChild();
        reject(new Error(`Qoder CLI 超时 (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);
    }

    // 首字节看门狗：额度耗尽或失效的账号 CLI 会长时间挂起不产出任何内容。
    // 原先默认 12s，3 个节点串行失败就是 36s，正是 37s 平均延迟的直接来源。
    // 配合后台探活熔断后，热路径踩坑概率大幅下降，这里再缩短到 6s 压缩最坏情况。
    const FIRST_BYTE_TIMEOUT_MS = Number(process.env.QODER_FIRST_BYTE_TIMEOUT_MS) || 6000;
    if (FIRST_BYTE_TIMEOUT_MS > 0) {
      firstByteTimer = setTimeout(() => {
        if (sawFirstByte) return;
        killChild();
        const tail = (stderr || stdout).trim().slice(-300);
        reject(new Error(
          `Qoder CLI 首字节超时 (${Math.round(FIRST_BYTE_TIMEOUT_MS / 1000)}s 内无任何输出)` +
          (tail ? `: ${tail}` : '')
        ));
      }, FIRST_BYTE_TIMEOUT_MS);
    }

    const clearFirstByteTimer = () => {
      if (firstByteTimer) {
        clearTimeout(firstByteTimer);
        firstByteTimer = null;
      }
    };

    child.stdout.on('data', d => {
      if (!sawFirstByte) {
        sawFirstByte = true;
        clearFirstByteTimer();
      }
      const piece = d.toString('utf8');
      stdout += piece;
      // 真实流式：CLI 每吐出一块就立刻回调给上层，由上层决定立即 flush 给客户端。
      // 这样客户端在模型生成过程中就能持续收到 token，而不是等子进程跑完才一次性拿到。
      if (typeof onChunk === 'function') {
        try { onChunk(piece); } catch (_) {}
      }
    });

    child.stderr.on('data', d => {
      stderr += d.toString('utf8');
    });

    child.on('error', err => {
      if (timer) clearTimeout(timer);
      clearFirstByteTimer();
      reject(err);
    });

    child.on('close', code => {
      if (timer) clearTimeout(timer);
      clearFirstByteTimer();
      if (code === 0) {
        // 清洗无用告警与冲突日志
        let cleaned = stdout
          .replace(/^Detected \d+ skill name conflicts across sources[^\n]*\n?/gm, '')
          .replace(/^Run \/skills to inspect[^\n]*\n?/gm, '')
          .trim();
        resolve(cleaned);
      } else {
        const errMsg = stderr.trim() || stdout.trim() || `Exit Code ${code}`;
        reject(new Error(`Qoder CLI 退出码 ${code}: ${errMsg}`));
      }
    });
  });
}

/**
 * 从模型文本中解析 XML / JSON 格式的 Tool Calls 并转为 OpenAI 标准 tool_calls 结构
 */
export function parseToolCallsFromText(rawText, tools = []) {
  if (!rawText || typeof rawText !== 'string') return { text: rawText, toolCalls: null, reasoning: '' };

  const validToolNames = (Array.isArray(tools) ? tools : [])
    .map(t => (t.function?.name || t.name || '').trim())
    .filter(Boolean);

  const normalizeToolName = (rawName) => {
    if (!rawName) return '';
    const clean = rawName.trim();
    const found = validToolNames.find(n => n.toLowerCase() === clean.toLowerCase());
    return found || clean.toLowerCase();
  };

  let reasoning = '';
  // 提取显式 <thought> 或 <thinking> 标签
  const thoughtMatch = /<(?:thought|thinking)>([\s\S]*?)<\/(?:thought|thinking)>/gi;
  let tm;
  while ((tm = thoughtMatch.exec(rawText)) !== null) {
    reasoning += (reasoning ? '\n' : '') + tm[1].trim();
  }
  let cleanedText = rawText.replace(/<(?:thought|thinking)>[\s\S]*?<\/(?:thought|thinking)>/gi, '').trim();

  const toolCalls = [];

  // 格式 0: <invoke name="...">...</invoke> (Anthropic / OMP 规范，支持并发多工具)
  const invokeRegex = /<invoke\s+(?:name|tool|function)=["']?([a-zA-Z0-9_\-\.]+)["']?[^>]*>([\s\S]*?)(?:<\/invoke>|(?=<invoke\s+(?:name|tool|function)=)|$)/gi;
  let invMatch;
  while ((invMatch = invokeRegex.exec(rawText)) !== null) {
    const fnName = normalizeToolName(invMatch[1]);
    const body = invMatch[2].trim();
    if (!fnName) continue;

    const args = {};
    const paramRegex = /<(?:parameter|arg|param)\s+name=["']?([a-zA-Z0-9_\-\.]+)["']?[^>]*>([\s\S]*?)<\/(?:parameter|arg|param)>/gi;
    let pm;
    let foundParam = false;
    while ((pm = paramRegex.exec(body)) !== null) {
      foundParam = true;
      const k = pm[1].trim();
      let v = pm[2];
      if (v.startsWith('\n')) v = v.slice(1);
      if (v.endsWith('\n')) v = v.slice(0, -1);
      try {
        const parsed = JSON.parse(v);
        if (typeof parsed === 'object' || typeof parsed === 'number' || typeof parsed === 'boolean') {
          v = parsed;
        }
      } catch (_) {}
      args[k] = v;
    }

    // 若未用 name= 属性，检查 <parameter=key> 形式
    if (!foundParam) {
      const eqParamRegex = /<parameter=([a-zA-Z0-9_\-\.]+)>([\s\S]*?)<\/parameter>/gi;
      let epm;
      while ((epm = eqParamRegex.exec(body)) !== null) {
        foundParam = true;
        const k = epm[1].trim();
        let v = epm[2];
        try { v = JSON.parse(v); } catch (_) {}
        args[k] = v;
      }
    }

    // 若仍未匹配到特定标签，检查任意 XML 标签 <key>val</key>
    if (!foundParam && body) {
      const altParamRegex = /<([a-zA-Z0-9_\-]+)>([\s\S]*?)<\/\1>/gi;
      let ap;
      while ((ap = altParamRegex.exec(body)) !== null) {
        foundParam = true;
        const k = ap[1].trim();
        let v = ap[2];
        try { v = JSON.parse(v); } catch (_) {}
        args[k] = v;
      }
      if (!foundParam) {
        if (fnName === 'bash' || fnName === 'sh' || fnName === 'terminal') {
          args.command = body;
        } else if (fnName === 'eval') {
          args.code = body;
        } else {
          args.input = body;
        }
      }
    }

    toolCalls.push({
      id: 'call_' + Math.random().toString(36).slice(2, 11),
      type: 'function',
      function: { name: fnName, arguments: JSON.stringify(args) }
    });
  }

  // 格式 1: <tool_call><function=xxx><parameter=yyy>zzz</parameter></function></tool_call>
  if (toolCalls.length === 0) {
    const format1Regex = /<tool_call>[\s\S]*?<function=([a-zA-Z0-9_\-\.]+)>([\s\S]*?)<\/function>[\s\S]*?<\/tool_call>/gi;
    let m1;
    while ((m1 = format1Regex.exec(rawText)) !== null) {
      const fnName = normalizeToolName(m1[1]);
      const paramsBlock = m1[2];
      const args = {};
      const paramRegex = /<parameter=([a-zA-Z0-9_\-\.]+)>([\s\S]*?)<\/parameter>/gi;
      let pm;
      while ((pm = paramRegex.exec(paramsBlock)) !== null) {
        const k = pm[1].trim();
        let v = pm[2].trim();
        try { v = JSON.parse(v); } catch (_) {}
        args[k] = v;
      }
      toolCalls.push({
        id: 'call_' + Math.random().toString(36).slice(2, 11),
        type: 'function',
        function: { name: fnName, arguments: JSON.stringify(args) }
      });
    }
  }

  // 格式 2: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
  if (toolCalls.length === 0) {
    const format2Regex = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi;
    let m2;
    while ((m2 = format2Regex.exec(rawText)) !== null) {
      try {
        const parsed = JSON.parse(m2[1]);
        if (parsed.name) {
          toolCalls.push({
            id: 'call_' + Math.random().toString(36).slice(2, 11),
            type: 'function',
            function: {
              name: normalizeToolName(parsed.name),
              arguments: typeof parsed.arguments === 'string' ? parsed.arguments : JSON.stringify(parsed.arguments || {})
            }
          });
        }
      } catch (_) {}
    }
  }

  // 格式 3: <tool_calls> 或 <tool> 块 (XML 结构，如 <tool><tool_name>xxx</tool_name>...)
  if (toolCalls.length === 0) {
    const normalized = rawText.replace(/<\/function>/gi, '</tool>');
    if (/<tool_calls>|<tool/i.test(normalized)) {
      const toolBlockRegex = /<tool(?![a-zA-Z0-9_])>([\s\S]*?)(?:<\/tool>|(?=<tool(?![a-zA-Z0-9_])>)|<\/tool_calls>|$)/gi;
      let match;
      while ((match = toolBlockRegex.exec(normalized)) !== null) {
        const block = match[1].trim();
        if (!block) continue;

        let fnName = '';
        const nameMatch = /<tool_name>([\s\S]*?)<\/tool_name>/i.exec(block);
        if (nameMatch) {
          fnName = normalizeToolName(nameMatch[1]);
        } else {
          const altMatch = /<name>([\s\S]*?)<\/name>/i.exec(block);
          if (altMatch) fnName = normalizeToolName(altMatch[1]);
        }
        if (!fnName) continue;

        const args = {};
        if (fnName === 'eval' || fnName === 'eval_js') {
          const langMatch = /<language>([\s\S]*?)<\/language>/i.exec(block);
          const codeMatch = /<code>([\s\S]*?)<\/code>/i.exec(block);
          if (langMatch) args.language = langMatch[1].trim();
          if (codeMatch) {
            args.code = codeMatch[1].trim();
          } else {
            const afterLang = block.replace(/<tool_name>[\s\S]*?<\/tool_name>/i, '').replace(/<language>[\s\S]*?<\/language>/i, '').trim();
            if (afterLang) args.code = afterLang;
          }
        } else if (fnName === 'bash' || fnName === 'sh' || fnName === 'terminal') {
          const cmdMatch = /<command>([\s\S]*?)<\/command>/i.exec(block);
          if (cmdMatch) {
            args.command = cmdMatch[1].trim();
          } else {
            const afterName = block.replace(/<tool_name>[\s\S]*?<\/tool_name>/i, '').trim();
            if (afterName) args.command = afterName;
          }
        } else {
          const tagRegex = /<([a-zA-Z0-9_\-]+)>([\s\S]*?)<\/\1>/gi;
          let tagMatch;
          let foundAny = false;
          while ((tagMatch = tagRegex.exec(block)) !== null) {
            const k = tagMatch[1];
            if (k.toLowerCase() === 'tool_name' || k.toLowerCase() === 'name') continue;
            let val = tagMatch[2].trim();
            try { val = JSON.parse(val); } catch (_) {}
            args[k] = val;
            foundAny = true;
          }
          if (!foundAny) {
            const remaining = block.replace(/<tool_name>[\s\S]*?<\/tool_name>/i, '').trim();
            if (remaining) args.input = remaining;
          }
        }

        toolCalls.push({
          id: 'call_' + Math.random().toString(36).slice(2, 11),
          type: 'function',
          function: { name: fnName, arguments: JSON.stringify(args) }
        });
      }
    }
  }

  // 清洗正文中的所有工具调用块与标签残留
  if (toolCalls.length > 0) {
    cleanedText = cleanedText
      .replace(/<invoke\s+[\s\S]*?(?:<\/invoke>|$)/gi, '')
      .replace(/<tool_calls>[\s\S]*?(?:<\/tool_calls>|$)/gi, '')
      .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, '')
      .replace(/<tool(?![a-zA-Z0-9_])>[\s\S]*?(?:<\/tool>|$)/gi, '')
      .replace(/<\/?(?:invoke|parameter|arg|param|tool_calls|tool_call|tool|function|tool_name)[^>]*>/gi, '')
      .trim();
  }

  return { text: cleanedText, toolCalls: toolCalls.length > 0 ? toolCalls : null, reasoning };
}

/**
 * Qoder CLI 2API 核心调度入口 (最少活跃并发 + 智能分级熔断 + 自动容灾)
 */
export async function proxyQoderCliChat(req, res) {
  const rawModel = req.body?.model || 'Qwen-3.8-Flash(Qoder)';
  const stream = !!req.body?.stream;
  const messages = req.body?.messages || [];
  const reqId = 'chatcmpl-qoder-' + crypto.randomBytes(12).toString('hex');
  const created = Math.floor(Date.now() / 1000);

  const targetModel = resolveCliModelName(rawModel);
  const prompt = formatMessagesToPrompt(messages, req.body?.tools);
  const tempAttachments = extractAttachmentsFromMessages(messages);

  if (!prompt && tempAttachments.length === 0) {
    return res.status(400).json({
      error: {
        message: 'messages 不能为空',
        type: 'invalid_request_error',
        code: 'empty_prompt'
      }
    });
  }

  const abortCtrl = new AbortController();
  const onClientClose = () => {
    if (!res.writableEnded) abortCtrl.abort();
  };
  res.on('close', onClientClose);

  const sessionKey = getRequestSessionKey(req, 'openai', rawModel, req.body);
  const pinnedBefore = sessionKey ? poolManager.sessionAffinity.get(sessionKey) : null;
  const candidates = poolManager.getCandidates(sessionKey);
  // 对 DeepSeek 模型优先排布国内版 (qodercn) 节点（但若已有会话粘性绑定且空闲，则优先保持粘性）
  if (targetModel.toLowerCase().includes('deepseek')) {
    candidates.sort((a, b) => {
      if (pinnedBefore) {
        const aIsPinned = a.id === pinnedBefore && (poolManager.inflight.get(a.id) || 0) === 0;
        const bIsPinned = b.id === pinnedBefore && (poolManager.inflight.get(b.id) || 0) === 0;
        if (aIsPinned !== bIsPinned) return aIsPinned ? -1 : 1;
      }
      const aIsCn = a.region === 'cn' || (a.binary && a.binary.includes('qodercn')) ? 1 : 0;
      const bIsCn = b.region === 'cn' || (b.binary && b.binary.includes('qodercn')) ? 1 : 0;
      return bIsCn - aIsCn;
    });
  }
  let lastError = null;

  // 热路径总耗时预算：所有 Qoder 候选节点串行尝试的累计上限。
  // 超出预算立刻放弃号池、转 Gemini 兜底，杜绝「用户干等 30+ 秒才拿到答案」。
  const POOL_BUDGET_MS = Number(process.env.QODER_POOL_BUDGET_MS) || 15000;
  const poolStartT = Date.now();

  try {
    for (let i = 0; i < candidates.length; i++) {
      const acc = candidates[i];

      // 预算耗尽：不再串行踩坑，直接走兜底通道
      if (i > 0 && Date.now() - poolStartT > POOL_BUDGET_MS) {
        logger.warn(
          `[QoderCliPool] 号池调度预算耗尽 (${Date.now() - poolStartT}ms > ${POOL_BUDGET_MS}ms)，` +
          `放弃剩余 ${candidates.length - i} 个候选，直接转兜底通道`
        );
        lastError = lastError || new Error(`号池调度预算耗尽 (${POOL_BUDGET_MS}ms)`);
        break;
      }

      if (sessionKey && (!pinnedBefore || i > 0 || acc.id === pinnedBefore)) {
        poolManager.sessionAffinity.set(sessionKey, acc.id);
      }
      const isStickyHit = i === 0 && pinnedBefore && acc.id === pinnedBefore;
      const curInflight = poolManager.inflight.get(acc.id) || 0;
      logger.info(`[QoderCliPool] 发起调度 [${i + 1}/${candidates.length}] (${isStickyHit ? '会话粘性锁定' : '优先分配'}): 账号=${acc.label} (${acc.id}) [Tier ${acc.tier}, 活跃并发: ${curInflight}] -> 模型=${targetModel}`);
      const startT = Date.now();
      const timeoutMs = Number(process.env.QODER_TIMEOUT_MS) || 600000; // 600s (10分钟)，全面保障复杂长任务与深度思考不被中断

      let heartbeatTimer = null;
      if (stream && !res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        heartbeatTimer = setInterval(() => {
          try {
            if (!res.writableEnded) res.write(`: keep-alive\n\n`);
          } catch (_) {}
        }, 4000);
      }

      // 占用节点活跃并发
      poolManager.acquire(acc.id);

      try {
        // 真实流式透传：CLI 每产生一块 stdout 就即时转成 SSE content chunk 下发给客户端。
        // 原先是等子进程完全退出后一次性 flush，客户端在几十秒内收不到任何正文。
        let streamedPrefix = '';
        let roleSent = false;
        const onCliChunk = stream
          ? (piece) => {
              if (!piece || res.writableEnded) return;
              if (!roleSent) {
                roleSent = true;
                res.write(`data: ${JSON.stringify({
                  id: reqId,
                  object: 'chat.completion.chunk',
                  created,
                  model: rawModel,
                  choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
                })}\n\n`);
              }
              streamedPrefix += piece;
              res.write(`data: ${JSON.stringify({
                id: reqId,
                object: 'chat.completion.chunk',
                created,
                model: rawModel,
                choices: [{ index: 0, delta: { content: piece }, finish_reason: null }]
              })}\n\n`);
            }
          : null;

        const rawAnswer = await executeQoderCli(
          acc,
          targetModel,
          prompt || '请查看附加图片并回答。',
          timeoutMs,
          abortCtrl.signal,
          tempAttachments,
          onCliChunk
        );
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        const elapsed = Date.now() - startT;
        
        // 沉淀成功指标
        poolManager.release(acc.id, true, elapsed);

        const { text: answer, toolCalls, reasoning } = parseToolCallsFromText(rawAnswer, req.body?.tools);
        logger.info(`[QoderCliPool] 调用成功 [${acc.id}] (${elapsed}ms), toolCalls=${toolCalls ? toolCalls.length : 0}, reasoning=${reasoning ? reasoning.length : 0}chars`);

        // 设置响应头，便于运维与排查当前生效账号与拓扑
        if (!res.headersSent) {
          res.setHeader('X-Qoder-Account', acc.id);
          res.setHeader('X-Qoder-Region', acc.region);
          res.setHeader('X-Qoder-Tier', String(acc.tier));
          res.setHeader('X-Qoder-Inflight', String(poolManager.inflight.get(acc.id) || 0));
        }

        const finishReason = toolCalls ? 'tool_calls' : 'stop';

        if (stream) {
          // 1. Role chunk（真实流式模式下 role 已在首块前发出，避免重复）
          if (!roleSent) {
            roleSent = true;
            res.write(`data: ${JSON.stringify({
              id: reqId,
              object: 'chat.completion.chunk',
              created,
              model: rawModel,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
            })}\n\n`);
          }

          // 2. Reasoning chunk (思维链隔离，供 OMP 折叠)
          if (reasoning) {
            res.write(`data: ${JSON.stringify({
              id: reqId,
              object: 'chat.completion.chunk',
              created,
              model: rawModel,
              choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }]
            })}\n\n`);
          }

          // 3. Content chunk
          // 真实流式已把 CLI 原始 stdout 逐块下发过，此处只补发「清洗后剩余」的部分，
          // 避免客户端收到两份重复正文。
          // 真实流式已逐块下发过 CLI 原始输出，此处只补发「清洗后新增」的部分。
          // 注意做归一化比较：清洗会去掉首尾空白，直接 startsWith 会因换行差异误判，
          // 导致客户端收到两份重复正文。
          const norm = (t) => (t || '').replace(/\s+/g, '');
          const streamedNorm = norm(streamedPrefix);
          const answerNorm = norm(answer);
          const remaining = streamedNorm && answerNorm.startsWith(streamedNorm)
            ? ''
            : (answer || '');
          if (remaining) {
            res.write(`data: ${JSON.stringify({
              id: reqId,
              object: 'chat.completion.chunk',
              created,
              model: rawModel,
              choices: [{ index: 0, delta: { content: remaining }, finish_reason: null }]
            })}\n\n`);
          }

          // 4. Tool calls chunk (若提取到结构化工具调用)
          if (toolCalls && toolCalls.length > 0) {
            res.write(`data: ${JSON.stringify({
              id: reqId,
              object: 'chat.completion.chunk',
              created,
              model: rawModel,
              choices: [{
                index: 0,
                delta: {
                  tool_calls: toolCalls.map((tc, idx) => ({
                    index: idx,
                    id: tc.id,
                    type: 'function',
                    function: tc.function
                  }))
                },
                finish_reason: null
              }]
            })}\n\n`);
          }

          // 5. Finish chunk & Done
          res.write(`data: ${JSON.stringify({
            id: reqId,
            object: 'chat.completion.chunk',
            created,
            model: rawModel,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
          })}\n\n`);
          res.write('data: [DONE]\n\n');
          return res.end();
        } else {
          const choiceMessage = {
            role: 'assistant',
            content: answer || null
          };
          if (reasoning) {
            choiceMessage.reasoning_content = reasoning;
          }
          if (toolCalls) {
            choiceMessage.tool_calls = toolCalls;
          }

          return res.json({
            id: reqId,
            object: 'chat.completion',
            created,
            model: rawModel,
            choices: [
              {
                index: 0,
                message: choiceMessage,
                finish_reason: finishReason
              }
            ],
            usage: {
              prompt_tokens: prompt.length,
              completion_tokens: (answer || '').length,
              total_tokens: prompt.length + (answer || '').length
            }
          });
        }
      } catch (err) {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        const elapsed = Date.now() - startT;

        // 若是因为客户端主动取消或中断，安全释放节点并发，不触发熔断处罚
        const isClientAbort = abortCtrl.signal.aborted || err.message?.includes('客户端已断开') || err.name === 'AbortError';
        if (isClientAbort) {
          poolManager.release(acc.id, true, elapsed);
          logger.info(`[QoderCliPool] 客户端中断或取消，安全释放账号 [${acc.id}] 并发`);
          return;
        }

        // 真实异常：释放并发、解绑当前会话粘性并触发分级熔断
        poolManager.release(acc.id, false, elapsed, err);
        if (sessionKey) poolManager.sessionAffinity.delete(sessionKey, acc.id);

        lastError = err;
        logger.warn(`[QoderCliPool] 账号 ${acc.id} 失败: ${err.message}`);
        if (i < candidates.length - 1) {
          logger.info(`[QoderCliPool] 自动 Failover 切换到下一个候选 Qoder 账号...`);
        }
      }
    }

    logger.warn(`[QoderCliPool] 所有 Qoder 账号调用均未响应，自动触发兜底通道 (WorkBuddy deepseek-v4.1-flash)...`);
    if (!res.headersSent) {
      req.body.model = 'deepseek-v4.1-flash';
      return await proxyWorkBuddyChat(req, res);
    }

    // 已写入 SSE 响应头（HTTP 200 无法再改状态码），只能在流内投递错误块
    if (stream) {
      res.write(`data: ${JSON.stringify({
        error: {
          message: `Qoder CLI 2API 所有账号均不可用: ${lastError?.message}`,
          type: 'gateway_error',
          code: 'qoder_pool_exhausted'
        }
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    return res.status(502).json({
      error: {
        message: `Qoder CLI 2API 所有账号均不可用: ${lastError?.message}`,
        type: 'gateway_error',
        code: 'qoder_pool_exhausted'
      }
    });
  } finally {
    cleanupTempAttachments(tempAttachments);
    res.off?.('close', onClientClose);
  }
}
