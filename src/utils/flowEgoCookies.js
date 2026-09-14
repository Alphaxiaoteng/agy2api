import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseEgoCookiePayload } from './flowProxyRewrite.js';

const DEFAULT_BIN = process.env.EGO_BROWSER_BIN || path.join(os.homedir(), '.local/bin/ego-browser');

const COOKIE_SCRIPT = `
const task = await useOrCreateTaskSpace('agy-flow-cookie-sync');
try { await claimTaskSpace(task.id); } catch (e) {}
await openOrReuseTab('https://labs.google/fx/zh/tools/flow', { wait: true, timeout: 35 });
await wait(2);
let cookies;
try {
  cookies = await cdp('Network.getAllCookies');
} catch (e) {
  cookies = await cdp('Network.getCookies', { urls: [
    'https://labs.google/',
    'https://aisandbox-pa.googleapis.com/',
    'https://www.google.com/',
    'https://accounts.google.com/'
  ]});
}
const raw = Array.isArray(cookies) ? cookies : ((cookies && cookies.cookies) || []);
function allow(domain) {
  const d = String(domain || '').replace(/^\\./, '').toLowerCase();
  return d === 'labs.google' || d.endsWith('.labs.google') ||
    d === 'google.com' || d.endsWith('.google.com') ||
    d === 'googleapis.com' || d.endsWith('.googleapis.com') ||
    d === 'googleusercontent.com' || d.endsWith('.googleusercontent.com');
}
const list = raw.filter(c => c && c.name && allow(c.domain));
cliLog('FLOW_COOKIES_BEGIN');
for (const c of list) {
  cliLog('FLOW_COOKIE:' + JSON.stringify({
    name: c.name,
    value: c.value || '',
    domain: c.domain || '',
    path: c.path || '/',
    secure: !!c.secure,
    expires: c.expires
  }));
}
cliLog('FLOW_COOKIES_END:' + list.length);
`;

export function fetchEgoGoogleCookies() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DEFAULT_BIN)) {
      reject(new Error('ego-browser not found'));
      return;
    }
    const child = spawn(DEFAULT_BIN, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      reject(new Error('ego cookie sync timeout'));
    }, 45000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const cookies = parseEgoCookiePayload(out + '\n' + err);
        if (!cookies.length) {
          const hasEnd = (out + err).includes('FLOW_COOKIES_END:');
          reject(new Error(`ego returned 0 google cookies (exit ${code}, marker=${hasEnd})`));
          return;
        }
        resolve(cookies);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(COOKIE_SCRIPT);
  });
}
