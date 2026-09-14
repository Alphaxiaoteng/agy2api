import assert from 'node:assert/strict';
import {
  requestStoreLevel,
  shouldPersistUiLog,
  matchesLogLevel,
  filterLogEntries
} from '../src/utils/logFilter.js';

assert.equal(requestStoreLevel(200), null);
assert.equal(requestStoreLevel(204), null);
assert.equal(requestStoreLevel(401), 'warn');
assert.equal(requestStoreLevel(429), 'warn');
assert.equal(requestStoreLevel(500), 'error');
assert.equal(requestStoreLevel(502), 'error');

assert.equal(shouldPersistUiLog('warn', '[POST] - /v1/chat/completions 401 12ms'), true);
assert.equal(shouldPersistUiLog('error', '上游失败'), true);
assert.equal(shouldPersistUiLog('request', '[POST] - /v1/chat/completions 200 12ms'), false);
assert.equal(shouldPersistUiLog('debug', 'trace'), false);
assert.equal(shouldPersistUiLog('info', '[loadCodeAssist] 请求: https://x'), false);
assert.equal(shouldPersistUiLog('info', '[RequesterManager] 使用原生 axios 请求'), false);
assert.equal(shouldPersistUiLog('info', '没有可用的token'), true);
assert.equal(shouldPersistUiLog('info', '服务器已启动: 127.0.0.1:8046'), true);

assert.equal(matchesLogLevel({ level: 'warn' }, 'core'), true);
assert.equal(matchesLogLevel({ level: 'error' }, 'core'), true);
assert.equal(matchesLogLevel({ level: 'info' }, 'core'), false);
assert.equal(matchesLogLevel({ level: 'request' }, 'all'), true);

const rows = filterLogEntries([
  { level: 'request', message: '200 ok' },
  { level: 'warn', message: '401 auth' },
  { level: 'error', message: '502 upstream' },
  { level: 'info', message: 'hello' }
], { level: 'core' });
assert.equal(rows.length, 2);
assert.deepEqual(rows.map((r) => r.level), ['warn', 'error']);

console.log('log filter tests passed');
process.exit(0);
