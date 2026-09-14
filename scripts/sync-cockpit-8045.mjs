#!/usr/bin/env node
/**
 * Cockpit Antigravity 账号 → AGY 8045 池同步
 *
 * 用法:
 *   node scripts/sync-cockpit-8045.mjs              # 同步一次
 *   node scripts/sync-cockpit-8045.mjs --watch      # 监听 Cockpit 变更自动同步
 *   node scripts/sync-cockpit-8045.mjs --dry-run    # 仅预览
 *   node scripts/sync-cockpit-8045.mjs --prune      # 移除 Cockpit 中已不存在的池内账号
 */

import crypto from 'crypto';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import ProjectIdFetcher from '../src/auth/project_id_fetcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const POOL_PATH = path.join(PROJECT_ROOT, 'data', 'accounts.json');
const COCKPIT_ROOT = path.join(os.homedir(), '.antigravity_cockpit');
const COCKPIT_INDEX = path.join(COCKPIT_ROOT, 'accounts.json');
const COCKPIT_ACCOUNTS_DIR = path.join(COCKPIT_ROOT, 'accounts');
const KEY_CANDIDATES = [
  path.join(COCKPIT_ROOT, 'secure-account-storage.key'),
  path.join(COCKPIT_ROOT, 'account-token.key')
];

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const WATCH = args.has('--watch');
const PRUNE = args.has('--prune');
const NO_RELOAD = args.has('--no-reload');
const WATCH_INTERVAL_MS = Number.parseInt(process.env.COCKPIT_SYNC_INTERVAL_MS || '120', 10) * 1000;
const MIN_RELOAD_GAP_MS = Number.parseInt(process.env.COCKPIT_SYNC_RELOAD_GAP_MS || '90', 10) * 1000;
let lastReloadAt = 0;
const projectIdFetcher = new ProjectIdFetcher({ maxRetries: 2, retryDelay: 1000 });

function hardenLocalPermissions() {
  const targets = [
    POOL_PATH,
    ...KEY_CANDIDATES,
    path.join(COCKPIT_ROOT, 'server.json'),
    path.join(COCKPIT_ROOT, 'accounts.json')
  ];
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // ignore
    }
  }
  try {
    fs.chmodSync(path.dirname(POOL_PATH), 0o700);
  } catch {
    // ignore
  }
}

function log(...parts) {
  console.log(`[sync-cockpit-8045] ${parts.join(' ')}`);
}

function readMasterKey() {
  for (const keyPath of KEY_CANDIDATES) {
    if (!fs.existsSync(keyPath)) continue;
    const raw = fs.readFileSync(keyPath).toString('utf8').trim();
    const key = Buffer.from(raw, 'base64');
    if (key.length === 32) return key;
  }
  throw new Error(`未找到 Cockpit master key（${KEY_CANDIDATES.join(' 或 ')}）`);
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

function loadCockpitIndex() {
  if (!fs.existsSync(COCKPIT_INDEX)) {
    throw new Error(`Cockpit 索引不存在: ${COCKPIT_INDEX}`);
  }
  const index = JSON.parse(fs.readFileSync(COCKPIT_INDEX, 'utf8'));
  const accounts = Array.isArray(index?.accounts) ? index.accounts : [];
  return accounts.filter(a => a?.id && a?.email);
}

function loadCockpitAccount(id, key32) {
  const filePath = path.join(COCKPIT_ACCOUNTS_DIR, `${id}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(`账号文件缺失: ${filePath}`);
  }
  const envelope = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (envelope?.ciphertext && envelope?.nonce) {
    return decryptEnvelope(envelope, key32);
  }
  if (envelope?.token?.refresh_token || envelope?.refresh_token) {
    return envelope;
  }
  throw new Error(`无法解析账号 ${id}`);
}

async function hydrateProjectId(token, email) {
  if (token?.projectId || !token?.access_token) return token;

  try {
    const result = await projectIdFetcher.fetchProjectId(token);
    if (result?.projectId) {
      return {
        ...token,
        projectId: result.projectId,
        sub: result.sub || token.sub,
        credits: result.credits ?? token.credits
      };
    }
    log('ProjectId 未返回，保留账号但暂不参与请求:', email);
  } catch (error) {
    log('ProjectId 获取失败，保留账号待下次同步:', email, '-', error.message);
  }
  return token;
}

function toPoolEntry(email, token, existing) {
  const now = Date.now();
  const refresh = token?.refresh_token;
  const access = token?.access_token;
  if (!refresh) return null;

  const base = existing ? { ...existing } : {
    sub: 'g1-pro-tier',
    projectId: null,
    credits: null,
    hasQuota: true,
    sessionId: null,
    instanceId: null,
    deviceId: null
  };

  base.email = email;
  base.refresh_token = refresh;
  if (access) base.access_token = access;
  if (token?.projectId) base.projectId = token.projectId;
  if (token?.sub) base.sub = token.sub;
  if (token?.credits !== undefined) base.credits = token.credits;
  base.expires_in = token?.expires_in || base.expires_in || 3599;
  base.enable = true;
  base.hasQuota = base.hasQuota ?? true;
  base.timestamp = now;

  if (!base.deviceId) base.deviceId = crypto.randomUUID();
  if (!base.sessionId) {
    base.sessionId = String(crypto.randomBytes(8).readBigUInt64BE() % BigInt(1e19));
  }
  if (!base.instanceId) {
    base.instanceId = `cockpit-${email.split('@')[0].slice(0, 16)}`;
  }

  return base;
}

function loadPool() {
  if (!fs.existsSync(POOL_PATH)) {
    return { salt: crypto.randomBytes(16).toString('hex'), tokens: [] };
  }
  const parsed = JSON.parse(fs.readFileSync(POOL_PATH, 'utf8'));
  if (Array.isArray(parsed)) {
    return { salt: crypto.randomBytes(16).toString('hex'), tokens: parsed };
  }
  return {
    salt: parsed.salt || crypto.randomBytes(16).toString('hex'),
    tokens: Array.isArray(parsed.tokens) ? parsed.tokens : []
  };
}

function mergePool(pool, cockpitEntries, { prune }) {
  const byEmail = new Map();
  for (const t of pool.tokens) {
    const email = (t.email || '').toLowerCase();
    if (!email) continue;
    if (!byEmail.has(email)) byEmail.set(email, t);
  }

  const cockpitEmails = new Set();
  const added = [];
  const updated = [];

  for (const { email, token } of cockpitEntries) {
    const key = email.toLowerCase();
    cockpitEmails.add(key);
    const existing = byEmail.get(key);
    const entry = toPoolEntry(email, token, existing);
    if (!entry) continue;
    const unchanged = existing
      && existing.refresh_token === entry.refresh_token
      && existing.access_token === entry.access_token
      && existing.enable !== false;
    if (existing) {
      if (unchanged) {
        byEmail.set(key, existing);
        continue;
      }
      byEmail.set(key, entry);
      updated.push(email);
    } else {
      byEmail.set(key, entry);
      added.push(email);
    }
  }

  const removed = [];
  if (prune) {
    for (const email of [...byEmail.keys()]) {
      if (!cockpitEmails.has(email)) {
        removed.push(byEmail.get(email)?.email || email);
        byEmail.delete(email);
      }
    }
  }

  const order = cockpitEntries.map(e => e.email.toLowerCase());
  const seen = new Set();
  const tokens = [];
  for (const email of order) {
    if (seen.has(email)) continue;
    const t = byEmail.get(email);
    if (t) {
      tokens.push(t);
      seen.add(email);
    }
  }
  for (const [email, t] of byEmail.entries()) {
    if (!seen.has(email)) {
      tokens.push(t);
      seen.add(email);
    }
  }

  return { pool: { salt: pool.salt, tokens }, added, updated, removed };
}

async function secureWritePool(pool) {
  const dir = path.dirname(POOL_PATH);
  await fsp.mkdir(dir, { recursive: true });
  const backup = `${POOL_PATH}.bak-cockpit-${Date.now()}`;
  if (fs.existsSync(POOL_PATH)) {
    await fsp.copyFile(POOL_PATH, backup);
    log('已备份', path.basename(backup));
  }
  const temp = `${POOL_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(pool, null, 2)}\n`, 'utf8');
  await fsp.chmod(temp, 0o600);
  await fsp.rename(temp, POOL_PATH);
  await fsp.chmod(POOL_PATH, 0o600);
}

function reloadProxy({ force = false, added = [], removed = [] } = {}) {
  const now = Date.now();
  const structuralChange = added.length > 0 || removed.length > 0;
  if (!force && !structuralChange && now - lastReloadAt < MIN_RELOAD_GAP_MS) {
    log('跳过重载（距上次不足', `${MIN_RELOAD_GAP_MS / 1000}s，仅 token 刷新）`);
    return;
  }
  const uid = execSync('id -u', { encoding: 'utf8' }).trim();
  for (const label of ['com.agy.proxy']) {
    try {
      execSync(`launchctl kickstart -k gui/${uid}/${label}`, { stdio: 'pipe' });
      log('已重载', label);
    } catch (error) {
      log('重载跳过', label, '-', error.message?.split('\n')[0] || 'failed');
    }
  }
  lastReloadAt = now;
}

function cockpitFingerprint() {
  let maxMtime = 0;
  const files = [COCKPIT_INDEX];
  if (fs.existsSync(COCKPIT_ACCOUNTS_DIR)) {
    for (const name of fs.readdirSync(COCKPIT_ACCOUNTS_DIR)) {
      if (!name.endsWith('.json') || name.endsWith('.bak')) continue;
      files.push(path.join(COCKPIT_ACCOUNTS_DIR, name));
    }
  }
  for (const file of files) {
    try {
      maxMtime = Math.max(maxMtime, fs.statSync(file).mtimeMs);
    } catch {
      // ignore
    }
  }
  return String(maxMtime);
}

async function syncOnce() {
  hardenLocalPermissions();
  const key32 = readMasterKey();
  const index = loadCockpitIndex();
  const cockpitEntries = [];
  const errors = [];

  for (const { id, email } of index) {
    try {
      const account = loadCockpitAccount(id, key32);
      const token = await hydrateProjectId(account.token || account, email);
      if (!token?.refresh_token) {
        errors.push(`${email}: 无 refresh_token`);
        continue;
      }
      cockpitEntries.push({ email, token });
    } catch (error) {
      errors.push(`${email}: ${error.message}`);
    }
  }

  if (cockpitEntries.length === 0) {
    throw new Error(`Cockpit 无可用账号${errors.length ? `\n  ${errors.join('\n  ')}` : ''}`);
  }

  const pool = loadPool();
  const { pool: nextPool, added, updated, removed } = mergePool(pool, cockpitEntries, { prune: PRUNE });

  log(`Cockpit ${cockpitEntries.length} 个 → 池内 ${nextPool.tokens.length} 个`);
  if (added.length) log('新增', added.join(', '));
  if (updated.length) log('更新', updated.join(', '));
  if (removed.length) log('移除', removed.join(', '));
  if (errors.length) log('跳过', errors.join(' | '));

  if (DRY_RUN) {
    log('dry-run，未写入');
    return { changed: added.length + updated.length + removed.length > 0, added, updated, removed };
  }

  if (added.length === 0 && updated.length === 0 && removed.length === 0) {
    log('无变更');
    return { changed: false, added, updated, removed };
  }

  await secureWritePool(nextPool);
  log('已写入', POOL_PATH);

  if (!NO_RELOAD) reloadProxy({ force: args.has('--force-reload'), added, removed });
  return { changed: true, added, updated, removed };
}

async function watchLoop() {
  let last = '';
  log(`监听 Cockpit 变更，间隔 ${WATCH_INTERVAL_MS / 1000}s`);
  for (;;) {
    try {
      const fp = cockpitFingerprint();
      if (fp !== last) {
        if (last) log('检测到 Cockpit 变更');
        const result = await syncOnce();
        if (!result.changed && last) log('变更已同步或无有效差异');
        last = fp;
      }
    } catch (error) {
      log('同步失败:', error.message);
    }
    await new Promise(r => setTimeout(r, WATCH_INTERVAL_MS));
  }
}

async function main() {
  if (WATCH) {
    await syncOnce();
    await watchLoop();
    return;
  }
  await syncOnce();
}

main().catch(error => {
  console.error(`[sync-cockpit-8045] 失败: ${error.message}`);
  process.exit(1);
});
