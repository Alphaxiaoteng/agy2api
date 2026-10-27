import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import logger from '../utils/logger.js';

const COCKPIT_ROOT = path.join(os.homedir(), '.antigravity_cockpit');
const QODER_ACCOUNTS_DIR = path.join(COCKPIT_ROOT, 'qoder_accounts');
const QODER_INDEX_FILE = path.join(COCKPIT_ROOT, 'qoder_accounts.json');
const KEY_CANDIDATES = [
  path.join(COCKPIT_ROOT, 'secure-account-storage.key'),
  path.join(COCKPIT_ROOT, 'account-token.key')
];

let cachedAccounts = [];
let lastSyncAt = 0;
let roundRobinIndex = 0;

function readMasterKey() {
  for (const keyPath of KEY_CANDIDATES) {
    if (!fs.existsSync(keyPath)) continue;
    try {
      const raw = fs.readFileSync(keyPath, 'utf8').trim();
      const key = Buffer.from(raw, 'base64');
      if (key.length === 32) return key;
    } catch (e) {
      logger.warn('[CockpitQoderSync] 读取密钥失败:', keyPath, e.message);
    }
  }
  return null;
}

function decryptEnvelope(envelope, key32) {
  const nonce = Buffer.from(envelope.nonce, 'base64');
  const raw = Buffer.from(envelope.ciphertext, 'base64');
  if (raw.length < 17) throw new Error('ciphertext 过短');
  const authTag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(0, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key32, nonce);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/**
 * 同步并解密 Cockpit Qoder 账号池
 */
export function syncCockpitQoderAccounts() {
  const key32 = readMasterKey();
  if (!key32) {
    logger.warn('[CockpitQoderSync] 未找到 Cockpit 解密密钥，跳过 Qoder 账号池同步');
    return [];
  }

  if (!fs.existsSync(QODER_ACCOUNTS_DIR)) {
    return [];
  }

  const results = [];
  try {
    const files = fs.readdirSync(QODER_ACCOUNTS_DIR).filter(f => f.endsWith('.json') && !f.includes('.bak'));
    for (const file of files) {
      try {
        const fullPath = path.join(QODER_ACCOUNTS_DIR, file);
        const envelope = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        let plain = null;
        if (envelope?.ciphertext && envelope?.nonce) {
          plain = decryptEnvelope(envelope, key32);
        } else if (envelope?.email) {
          plain = envelope;
        }

        if (!plain) continue;

        let authUser = null;
        if (plain.auth_user_info_raw) {
          authUser = typeof plain.auth_user_info_raw === 'string' 
            ? JSON.parse(plain.auth_user_info_raw) 
            : plain.auth_user_info_raw;
        }

        let creditUsage = null;
        if (plain.auth_credit_usage_raw) {
          creditUsage = typeof plain.auth_credit_usage_raw === 'string'
            ? JSON.parse(plain.auth_credit_usage_raw)
            : plain.auth_credit_usage_raw;
        }

        const remaining = Number(plain.credits_remaining ?? (creditUsage?.addOnQuota?.remainingCredits ?? 0));
        const total = Number(plain.credits_total ?? (creditUsage?.addOnQuota?.totalCredits ?? 0));
        const used = Number(plain.credits_used ?? (creditUsage?.addOnQuota?.usedCredits ?? 0));
        const percent = total > 0 ? Math.round((remaining / total) * 100) : 0;

        results.push({
          id: plain.id || file.replace(/\.json$/, ''),
          email: plain.email || 'unknown',
          userId: plain.user_id,
          planType: plain.plan_type || 'Free',
          token: authUser?.token || '',
          refreshToken: authUser?.refreshToken || '',
          expireTime: authUser?.expireTime || 0,
          creditsRemaining: remaining,
          creditsTotal: total,
          creditsUsed: used,
          creditsUsagePercent: percent,
          isQuotaExceeded: remaining <= 0 || !!plain.isQuotaExceeded || !!authUser?.isQuotaExceeded,
          updatedAt: plain.usage_updated_at ? plain.usage_updated_at * 1000 : Date.now()
        });
      } catch (err) {
        logger.warn(`[CockpitQoderSync] 解析账号文件 ${file} 异常:`, err.message);
      }
    }
  } catch (err) {
    logger.error('[CockpitQoderSync] 扫描账号目录失败:', err.message);
  }

  // 排序：剩余 Credits 从多到少优先排布
  results.sort((a, b) => b.creditsRemaining - a.creditsRemaining);
  cachedAccounts = results;
  lastSyncAt = Date.now();
  return cachedAccounts;
}

/**
 * 获取活跃账号 Token（带轮询与配额熔断）
 */
export function getActiveQoderToken(region = 'global', isFreeModel = false) {
  if (Date.now() - lastSyncAt > 60000 || cachedAccounts.length === 0) {
    syncCockpitQoderAccounts();
  }

  if (cachedAccounts.length === 0) return null;

  let candidates;
  if (isFreeModel) {
    // 3.8 Flash 属于免费免额度模型，任意可用 Token 账号均可畅享，不受剩余 Credits 限制
    candidates = cachedAccounts.filter(a => a.token);
  } else {
    // 3.8 Max 计费模型，优先选择有可用 Credits 的账号
    candidates = cachedAccounts.filter(a => !a.isQuotaExceeded && a.creditsRemaining > 0 && a.token);
    if (candidates.length === 0) {
      candidates = cachedAccounts.filter(a => a.token);
    }
  }

  if (!candidates || candidates.length === 0) return null;

  roundRobinIndex = (roundRobinIndex + 1) % candidates.length;
  const chosen = candidates[roundRobinIndex];
  return {
    token: chosen.token,
    email: chosen.email,
    creditsRemaining: chosen.creditsRemaining,
    isExhausted: !isFreeModel && chosen.creditsRemaining <= 0
  };
}

/**
 * 获取本地 Qoder 运行状态（检测 ~/.qoder, ~/.qoder-cn）
 */
export function getLocalQoderAppsStatus() {
  const home = os.homedir();
  const globalStatusFile = path.join(home, '.qoder', '.qoder-app-status.json');
  const cnStatusFile = path.join(home, '.qoder-cn', '.qoder-app-status.json');

  let globalApp = { installed: fs.existsSync('/Applications/Qoder.app'), loggedIn: false, name: '', email: '' };
  let cnApp = { installed: fs.existsSync('/Applications/Qoder CN.app'), loggedIn: false, name: '', email: '' };

  try {
    if (fs.existsSync(globalStatusFile)) {
      const data = JSON.parse(fs.readFileSync(globalStatusFile, 'utf8'));
      globalApp.loggedIn = !!data.logged_in;
      globalApp.name = data.name || '';
      globalApp.email = data.email || '';
      globalApp.version = data.version || '';
    }
  } catch {}

  try {
    if (fs.existsSync(cnStatusFile)) {
      const data = JSON.parse(fs.readFileSync(cnStatusFile, 'utf8'));
      cnApp.loggedIn = !!data.logged_in;
      cnApp.name = data.name || '';
      cnApp.email = data.email || '';
      cnApp.version = data.version || '';
    }
  } catch {}

  return { globalApp, cnApp };
}

/**
 * 获取全量通道概览数据供 UI 与管理端使用
 */
export function getQoderChannelOverview() {
  if (Date.now() - lastSyncAt > 60000 || cachedAccounts.length === 0) {
    syncCockpitQoderAccounts();
  }

  const localApps = getLocalQoderAppsStatus();

  return {
    cockpitQoder: {
      totalAccounts: cachedAccounts.length,
      activeAccounts: cachedAccounts.filter(a => !a.isQuotaExceeded && a.creditsRemaining > 0).length,
      accounts: cachedAccounts.map(a => ({
        id: a.id,
        email: a.email,
        planType: a.planType,
        creditsRemaining: a.creditsRemaining,
        creditsTotal: a.creditsTotal,
        creditsUsed: a.creditsUsed,
        creditsUsagePercent: a.creditsUsagePercent,
        isQuotaExceeded: a.isQuotaExceeded,
        updatedAt: a.updatedAt
      }))
    },
    localApps
  };
}

// 启动时自动同步一次
try {
  syncCockpitQoderAccounts();
} catch (e) {
  logger.warn('[CockpitQoderSync] 初始同步跳过:', e.message);
}
