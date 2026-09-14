#!/usr/bin/env node
/**
 * 8045 本地安全加固：敏感文件权限 + 服务探活
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const COCKPIT = path.join(os.homedir(), '.antigravity_cockpit');

const FILES = [
  path.join(PROJECT_ROOT, 'data', 'accounts.json'),
  path.join(COCKPIT, 'secure-account-storage.key'),
  path.join(COCKPIT, 'account-token.key'),
  path.join(COCKPIT, 'server.json'),
  path.join(COCKPIT, 'accounts.json'),
  path.join(PROJECT_ROOT, '.env'),
  path.join(os.homedir(), '.antigravity_cockpit/codex_local_access.json')
];

const DIRS = [
  path.join(PROJECT_ROOT, 'data'),
  path.join(COCKPIT, 'accounts')
];

function chmodSafe(target, mode) {
  if (!fs.existsSync(target)) return 'missing';
  try {
    fs.chmodSync(target, mode);
    return fs.statSync(target).mode.toString(8).slice(-3);
  } catch (error) {
    return `err:${error.message}`;
  }
}

console.log('[harden-8045] 加固本地权限');
for (const dir of DIRS) {
  const mode = chmodSafe(dir, 0o700);
  if (mode !== 'missing') console.log(`  dir  ${dir} → ${mode}`);
}
for (const file of FILES) {
  const mode = chmodSafe(file, 0o600);
  if (mode !== 'missing') console.log(`  file ${file} → ${mode}`);
}

try {
  const uid = execSync('id -u', { encoding: 'utf8' }).trim();
  for (const label of ['com.agy.proxy', 'com.agy.relay', 'com.agy.cockpit-sync']) {
    try {
      execSync(`launchctl print gui/${uid}/${label}`, { stdio: 'pipe' });
      console.log(`  svc  ${label} → running`);
    } catch {
      console.log(`  svc  ${label} → not loaded`);
    }
  }
} catch {
  // ignore
}

try {
  const { probeCodexUpstream } = await import('../src/services/codexUpstream.js');
  const codex = await probeCodexUpstream();
  console.log(`  probe codex → ${codex.ok ? `OK ${codex.modelCount} models ${codex.ms}ms` : codex.error}`);
} catch (error) {
  console.log(`  probe codex → failed (${error.message?.split('\n')[0]})`);
}

try {
  const code = execSync(
    'curl -sS -m 5 -o /dev/null -w "%{http_code}" http://127.0.0.1:8045/v1/models -H "Authorization: Bearer sk-agy-proxy"',
    { encoding: 'utf8' }
  ).trim();
  console.log(`  probe 8045 /v1/models → HTTP ${code}`);
} catch (error) {
  console.log(`  probe 8045 → failed (${error.message?.split('\n')[0]})`);
}

console.log('[harden-8045] 完成');
