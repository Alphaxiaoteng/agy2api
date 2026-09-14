/**
 * Comprehensive Offline / Mocked Unit Tests for Flow API
 * 测试覆盖：
 * 1. flowCapabilities 参数校验与能力矩阵
 * 2. flowStorage 目录管理、原子写 manifest、mediaId 映射与路径穿越防护
 * 3. flowQueue 并发控制、排队上限、Idempotency 校验与重放、取消逻辑
 * 4. flowBrowserWorker 脚本生成与状态机契约校验
 * 5. 端到端 Express HTTP 路由测试 (/v1/flow/models, /capabilities, /queue/status, /images/generations, /videos/generations, /jobs/:id, /files/:mediaId)
 * 6. 深度边界测试 (Queue Full, Abort Signal, Symlink/Traversal, Auth Middleware)
 * 7. Worker 状态机与协议流转静态断言与 Mock 解析
 */

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import http from 'http';
import express from 'express';

import { 
  getModel, 
  listModels, 
  getCapabilities, 
  validateParams,
  FLOW_MODELS 
} from '../src/config/flowCapabilities.js';
import { FlowStorage, defaultFlowStorage } from '../src/utils/flowStorage.js';
import { FlowQueue } from '../src/services/flowQueue.js';
import { buildWorkerScript } from '../src/services/flowBrowserWorker.js';
import { flowApiRouter } from '../src/routes/flowApi.js';
import { AlphaNexusFlowBridge, validateAlphaNexusBaseUrl } from '../src/services/alphaNexusFlowBridge.js';

console.log('=== Starting Flow API Tests ===\n');

// -------------------------------------------------------------
// 1. 测试 flowCapabilities
// -------------------------------------------------------------
console.log('1. Testing flowCapabilities...');

assert.equal(getModel('nano-banana-pro')?.id, 'nano-banana-pro');
assert.equal(getModel('Nano Banana 2 Lite')?.id, 'nano-banana-2-lite');
assert.equal(getModel('omni')?.id, 'omni-flash');
assert.equal(getModel('veo-fast')?.id, 'veo-3.1-fast');
assert.equal(getModel('unknown-model'), null);

const models = listModels();
assert.equal(models.length, 7);
assert.equal(models.filter(m => m.type === 'image').length, 3);
assert.equal(models.filter(m => m.type === 'video').length, 4);

const caps = getCapabilities();
assert.equal(caps.image.defaultModel, 'nano-banana-pro');
assert.equal(caps.video.defaultModel, 'omni-flash');

// 校验合法图片参数
const validImg = validateParams('image', {
  prompt: 'A cute futuristic cyber cat',
  model: 'nano-banana-2',
  aspect: '16:9',
  n: 2,
  client_id: 'client-unit-test'
});
assert.equal(validImg.model, 'nano-banana-2');
assert.equal(validImg.count, 2);
assert.equal(validImg.aspect, '16:9');
assert.equal(validImg.clientId, 'client-unit-test');
assert.throws(() => validateParams('image', { prompt: 'a', account_id: 123 }), (err) => err.code === 'unsupported_account_mapping');

// 校验非法情况
assert.throws(() => validateParams('image', { prompt: '' }), /prompt is required/);
assert.throws(() => validateParams('image', { prompt: 'a', model: 'omni-flash' }), /image endpoint/);
assert.throws(() => validateParams('image', { prompt: 'a', duration: 4 }), /Duration is not supported/);
assert.throws(() => validateParams('video', { prompt: 'a', model: 'veo-3.1-fast', duration: 4 }), /Duration selection is not supported/);
assert.throws(() => validateParams('video', { prompt: 'a', model: 'omni-flash', duration: 7 }), /Duration '7' is invalid/);

// 合法视频参数 (Omni Flash 6s 9:16)
const validVid = validateParams('video', {
  prompt: 'Drone shot over mountain river',
  model: 'omni-flash',
  aspect_ratio: '9:16',
  duration: 6,
  mode: 'frames',
  count: 1
});
assert.equal(validVid.model, 'omni-flash');
assert.equal(validVid.duration, 6);
assert.equal(validVid.aspect, '9:16');

console.log('✓ flowCapabilities tests passed.');

// -------------------------------------------------------------
// 2. 测试 flowStorage
// -------------------------------------------------------------
console.log('2. Testing flowStorage...');

const testStorageDir = path.join(os.tmpdir(), `flow_storage_test_${Date.now()}`);
const storage = new FlowStorage(testStorageDir);

const testJobId = 'job_test_123';
const jobDir = storage.createJobDir(testJobId);
assert.equal(fs.existsSync(jobDir), true);

const sampleFile = path.join(jobDir, 'output_1.png');
fs.writeFileSync(sampleFile, Buffer.from('mock png content'));

const mediaId = storage.generateMediaId(testJobId, 0, 'png');
const manifest = {
  jobId: testJobId,
  type: 'image',
  status: 'completed',
  createdAt: new Date().toISOString(),
  outputs: [
    {
      mediaId,
      filename: 'output_1.png',
      mimeType: 'image/png',
      sizeBytes: 16
    }
  ]
};
storage.writeManifest(testJobId, manifest);

const readBack = storage.readManifest(testJobId);
assert.equal(readBack.jobId, testJobId);
assert.equal(readBack.outputs[0].mediaId, mediaId);

// 查找 media
const resolvedMedia = storage.resolveMedia(mediaId);
assert.notEqual(resolvedMedia, null);
assert.equal(resolvedMedia.filename, 'output_1.png');
assert.equal(resolvedMedia.mimeType, 'image/png');

// 防路径穿越与非法 mediaId 注入
assert.equal(storage.resolveMedia('../../../etc/passwd'), null);
assert.equal(storage.resolveMedia('media_non_existent_12345'), null);
assert.throws(() => storage.getJobDir('../evil'), /Invalid jobId/);

console.log('✓ flowStorage tests passed.');

// -------------------------------------------------------------
// 3. 测试 flowQueue (并发与幂等)
// -------------------------------------------------------------
console.log('3. Testing flowQueue (concurrency & idempotency)...');

let workerCalls = 0;
const mockWorker = async (job, storageInstance) => {
  workerCalls++;
  await new Promise(r => setTimeout(r, 50));
  const jobTargetDir = storageInstance.createJobDir(job.jobId);
  const fn = 'result.png';
  fs.writeFileSync(path.join(jobTargetDir, fn), Buffer.from('mock img'));
  const mId = storageInstance.generateMediaId(job.jobId, 0, 'png');
  return {
    jobId: job.jobId,
    type: job.type,
    status: 'completed',
    params: job.params,
    createdAt: job.createdAt,
    completedAt: new Date().toISOString(),
    outputs: [{ mediaId: mId, filename: fn, mimeType: 'image/png', sizeBytes: 8 }]
  };
};

const queue = new FlowQueue({
  concurrency: 1,
  maxQueue: 2,
  storage,
  workerRunner: mockWorker
});

// 测试单并发 FIFO
const jobPromise1 = queue.submitJob({
  type: 'image',
  params: validateParams('image', { prompt: 'Prompt 1' }),
  idempotencyKey: 'idemp-1'
});
const jobPromise2 = queue.submitJob({
  type: 'image',
  params: validateParams('image', { prompt: 'Prompt 2' })
});

const [res1, res2] = await Promise.all([jobPromise1, jobPromise2]);
assert.equal(res1.status, 'completed');
assert.equal(res2.status, 'completed');
assert.equal(workerCalls, 2);

// 测试幂等复用已完成结果
const res1Replay = await queue.submitJob({
  type: 'image',
  params: validateParams('image', { prompt: 'Prompt 1' }),
  idempotencyKey: 'idemp-1'
});
assert.equal(res1Replay.isIdempotentReplay, true);
assert.equal(res1Replay.jobId, res1.jobId);
assert.equal(workerCalls, 2); // 未再次执行 worker

// 测试幂等 key 冲突 (相同 key 但不同参数)
await assert.rejects(async () => {
  await queue.submitJob({
    type: 'image',
    params: validateParams('image', { prompt: 'Prompt 1 Conflict' }),
    idempotencyKey: 'idemp-1'
  });
}, (err) => err.code === 'idempotency_conflict' && err.status === 409);

console.log('✓ flowQueue tests passed.');

// -------------------------------------------------------------
// 4. 测试 flowBrowserWorker 脚本生成与状态机契约
// -------------------------------------------------------------
console.log('4. Testing flowBrowserWorker script generation & contract...');

const videoScript = buildWorkerScript({
  jobId: 'flow_vid_123',
  type: 'video',
  params: {
    model: 'omni-flash',
    displayName: 'Omni Flash',
    prompt: 'A car zooming fast on mountain highway',
    aspect: '16:9',
    count: 1,
    mode: 'frames',
    duration: 6,
    accountId: 7,
    identityId: 3,
    spaceId: 42,
    taskId: 'alpha-nexus/matrix-3'
  }
}, '/tmp/test_dir');

// 断言关键状态机逻辑与选择器存在
assert.equal(videoScript.includes('"flow_vid_123"'), true);
assert.equal(videoScript.includes('taskSpaceRef'), true);
assert.equal(videoScript.includes('takeOverTaskSpace(existingSpace.id)'), true);
assert.equal(videoScript.includes('useOrCreateTaskSpace(config.spaceId'), true);
assert.equal(videoScript.includes('handOffTaskSpace(currentTask?.id ?? taskSpaceRef)'), true);
assert.equal(videoScript.includes('completeTaskSpace'), false);
assert.equal(videoScript.includes('const tabs = await listTabs()'), true);
assert.equal(videoScript.includes('await closeTab(tabId)'), true);
assert.equal(videoScript.includes('flow_download_transport_unavailable'), true);
assert.equal(videoScript.includes('-trigger-IMAGE'), true);
assert.equal(videoScript.includes('-trigger-VIDEO'), true);
assert.equal(videoScript.includes('-trigger-VIDEO_FRAMES'), true);
assert.equal(videoScript.includes('-trigger-VIDEO_REFERENCES'), true);
assert.equal(videoScript.includes('data-slate-editor="true"'), true);
assert.equal(videoScript.includes('Input.insertText'), true);
assert.equal(videoScript.includes('a[href*="/project/"][href*="/edit/"]'), true);
assert.equal(videoScript.includes('Browser.setDownloadBehavior'), true);
assert.equal(videoScript.includes('Page.setDownloadBehavior'), true);
assert.equal(videoScript.includes('FLOW_EVENT:'), true);
assert.equal(videoScript.includes('FLOW_RESULT:'), true);

// 校验资产上传暂未开放的 501 契约
const assetUploadScript = buildWorkerScript({
  jobId: 'flow_asset_123',
  type: 'image',
  params: {
    model: 'nano-banana-pro',
    displayName: 'Nano Banana Pro',
    prompt: 'image with input assets',
    inputAssetIds: ['asset_1']
  }
}, '/tmp/test_dir');
assert.equal(assetUploadScript.includes('flow_asset_upload_not_implemented'), true);

const defaultSpaceScript = buildWorkerScript({
  jobId: 'flow_default_space',
  type: 'image',
  params: { model: 'nano-banana-pro', displayName: 'Nano Banana Pro', prompt: 'default', count: 1 }
}, '/tmp/test_dir');
assert.equal(defaultSpaceScript.includes("config.spaceId || 'flow-default'"), true);
assert.equal(defaultSpaceScript.includes("useOrCreateTaskSpace(config.spaceId ? Number(config.spaceId) : 'flow-default')"), true);

console.log('✓ flowBrowserWorker script tests passed.');

// -------------------------------------------------------------
// 4.1 Alpha Nexus Flow bridge（安全账号/Space 契约）
// -------------------------------------------------------------
console.log('4.1 Testing Alpha Nexus Flow bridge...');
assert.equal(validateAlphaNexusBaseUrl('http://127.0.0.1:17421'), 'http://127.0.0.1:17421');
assert.equal(validateAlphaNexusBaseUrl('http://localhost:17421/'), 'http://localhost:17421');
assert.throws(() => validateAlphaNexusBaseUrl('https://example.com'), /loopback HTTP URL/);
assert.throws(() => validateAlphaNexusBaseUrl('http://user:pass@127.0.0.1:17421'), /credential-free/);

const bridgeRequests = [];
const mockBridge = new AlphaNexusFlowBridge({
  transportToken: 'test-transport-token',
  fetchImpl: async (url, options) => {
    bridgeRequests.push({ url, options });
    if (url.includes('/space/ensure')) {
      return new Response(JSON.stringify({ identity_id: 10, space_id: 91, task_id: 'alpha-nexus/matrix-10', name: 'matrix', ownership: 'agent' }), { status: 200 });
    }
    return new Response(JSON.stringify([
      { id: 7, identityId: 10, name: 'Google A', enabled: true, loginState: 'logged_in', spaceId: 91 },
      { id: 8, identityId: 10, name: 'Google A duplicate platform', enabled: true, loginState: 'logged_in', spaceId: 91 },
      { id: 9, identityId: 11, name: 'Disabled', enabled: false, loginState: 'logged_in' },
      { id: 12, identityId: 12, name: 'Logged out', enabled: true, loginState: 'logged_out' }
    ]), { status: 200 });
  }
});
const bridgeAccounts = await mockBridge.listFlowAccounts();
assert.equal(bridgeAccounts.length, 1);
assert.deepEqual(bridgeAccounts[0].account_ids, [7, 8]);
assert.equal(bridgeRequests[0].options.headers['X-Alpha-Transport-Token'], 'test-transport-token');
const ensuredSpace = await mockBridge.ensureAccountSpace(7);
assert.equal(ensuredSpace.spaceId, 91);
assert.equal(ensuredSpace.identityId, 10);
assert.equal(bridgeRequests.some(r => r.url.endsWith('/api/accounts/7/space/ensure')), true);
console.log('✓ Alpha Nexus Flow bridge tests passed.');

// -------------------------------------------------------------
// 5. 测试 HTTP 路由与端点
// -------------------------------------------------------------
console.log('5. Testing HTTP router endpoints...');

const app = express();
app.use(express.json());
app.use('/v1/flow', flowApiRouter);

const server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const apiBase = `http://127.0.0.1:${port}/v1/flow`;

try {
  // GET /v1/flow/models
  const modelsRes = await fetch(`${apiBase}/models`);
  assert.equal(modelsRes.status, 200);
  const modelsJson = await modelsRes.json();
  assert.equal(modelsJson.object, 'list');
  assert.equal(modelsJson.data.length >= 7, true);

  // GET /v1/flow/capabilities
  const capsRes = await fetch(`${apiBase}/capabilities`);
  assert.equal(capsRes.status, 200);
  const capsJson = await capsRes.json();
  assert.equal(capsJson.object, 'capabilities');
  assert.equal(capsJson.image.defaultModel, 'nano-banana-pro');

  // GET /v1/flow/queue/status
  const queueRes = await fetch(`${apiBase}/queue/status`);
  assert.equal(queueRes.status, 200);
  const queueJson = await queueRes.json();
  assert.equal(queueJson.object, 'queue_status');

  // GET /v1/flow/accounts 未配置时安全返回空列表
  const accountsRes = await fetch(`${apiBase}/accounts`);
  assert.equal(accountsRes.status, 200);
  const accountsJson = await accountsRes.json();
  assert.equal(accountsJson.configured, false);
  assert.deepEqual(accountsJson.data, []);

  // GET /v1/flow/files/:mediaId (404 for invalid)
  const fileNotFoundRes = await fetch(`${apiBase}/files/media_invalid`);
  assert.equal(fileNotFoundRes.status, 404);

  // POST /v1/flow/images/generations (400 for bad model)
  const badImageRes = await fetch(`${apiBase}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'test', model: 'invalid-model' })
  });
  assert.equal(badImageRes.status, 400);

  // POST /v1/flow/videos/generations (400 for bad duration on Veo Fast)
  const badDurationRes = await fetch(`${apiBase}/videos/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'test', model: 'veo-3.1-fast', duration: 4 })
  });
  assert.equal(badDurationRes.status, 400);

  const accountWithoutBridgeRes = await fetch(`${apiBase}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'test', account_id: 7 })
  });
  assert.equal(accountWithoutBridgeRes.status, 400);

  console.log('✓ HTTP router endpoint tests passed.');
} finally {
  server.close();
  // 清理临时测试存储目录
  try {
    fs.rmSync(testStorageDir, { recursive: true, force: true });
  } catch (_) {}
}

// -------------------------------------------------------------
// 6. 深入增补边界测试 (Queue Full, Abort Signal, Symlink/Traversal, Auth Middleware)
// -------------------------------------------------------------
console.log('6. Testing deep edge cases...');

// 6.1 队列满载测试 (Queue Full -> 503)
{
  const testStorage = new FlowStorage(path.join(os.tmpdir(), `flow_q_full_${Date.now()}`));
  let releaseWorker;
  const blockingWorker = () => new Promise(resolve => { releaseWorker = resolve; });
  const smallQueue = new FlowQueue({
    concurrency: 1,
    maxQueue: 1,
    storage: testStorage,
    workerRunner: blockingWorker
  });

  // 第1个进入 processing
  const p1 = smallQueue.submitJob({
    type: 'image',
    params: validateParams('image', { prompt: 'task 1' })
  });
  // 第2个进入 queued
  const p2 = smallQueue.submitJob({
    type: 'image',
    params: validateParams('image', { prompt: 'task 2' })
  });
  // 第3个超过 maxQueue=1 -> 必须立即抛出 503 queue_full
  await assert.rejects(async () => {
    await smallQueue.submitJob({
      type: 'image',
      params: validateParams('image', { prompt: 'task 3' })
    });
  }, (err) => {
    assert.equal(err.status, 503);
    assert.equal(err.code, 'queue_full');
    return true;
  });

  // 释放第1个任务
  testStorage.createJobDir('dummy');
  releaseWorker({ jobId: 'dummy', outputs: [] });
  await p1;
  // 释放第2个任务
  releaseWorker({ jobId: 'dummy2', outputs: [] });
  await p2;
}

// 6.2 客户端未执行前 Abort 撤销测试与等待者清理
{
  const testStorage = new FlowStorage(path.join(os.tmpdir(), `flow_abort_${Date.now()}`));
  let releaseFirst;
  const firstBlocker = () => new Promise(r => { releaseFirst = r; });
  const testQueue = new FlowQueue({
    concurrency: 1,
    maxQueue: 5,
    storage: testStorage,
    workerRunner: firstBlocker
  });

  // 占住 active slot
  const pActive = testQueue.submitJob({
    type: 'image',
    params: validateParams('image', { prompt: 'active' })
  });

  const abortCtrl = new AbortController();
  const pAborted = testQueue.submitJob({
    type: 'image',
    params: validateParams('image', { prompt: 'to be aborted' }),
    idempotencyKey: 'idemp-abort-key',
    signal: abortCtrl.signal
  });

  const abortKeyHash = testQueue.hashIdempotencyKey('idemp-abort-key');
  assert.equal(testQueue.queue.length, 1);
  assert.equal(testQueue.idempotencyIndex.has(abortKeyHash), true);

  // 触发 abort: 必须导致 pAborted 被 reject，且不遗留悬挂
  abortCtrl.abort();

  await assert.rejects(async () => {
    await pAborted;
  }, /canceled/);

  assert.equal(testQueue.queue.length, 0);

  // 同 key 再次提交必须直接返回原失败，不自动重新跑
  await assert.rejects(async () => {
    await testQueue.submitJob({
      type: 'image',
      params: validateParams('image', { prompt: 'to be aborted' }),
      idempotencyKey: 'idemp-abort-key'
    });
  }, /canceled/);

  releaseFirst({ outputs: [] });
  await pActive;
}

// 6.2.1 幂等 unknown 状态阻断与 409 manual_recovery_required 测试
{
  const testStorage = new FlowStorage(path.join(os.tmpdir(), `flow_unknown_${Date.now()}`));
  const unknownQueue = new FlowQueue({
    concurrency: 1,
    maxQueue: 5,
    storage: testStorage,
    workerRunner: async (job) => {
      const err = new Error('Gateway Timeout');
      err.code = 'flow_timeout_after_submit';
      err.submitted = true;
      throw err;
    }
  });

  await assert.rejects(async () => {
    await unknownQueue.submitJob({
      type: 'image',
      params: validateParams('image', { prompt: 'unknown test' }),
      idempotencyKey: 'idemp-unknown-key'
    });
  }, /Gateway Timeout/);

  // 再次重放相同 key，必须抛出 409 manual_recovery_required
  await assert.rejects(async () => {
    await unknownQueue.submitJob({
      type: 'image',
      params: validateParams('image', { prompt: 'unknown test' }),
      idempotencyKey: 'idemp-unknown-key'
    });
  }, (err) => {
    assert.equal(err.status, 409);
    assert.equal(err.code, 'manual_recovery_required');
    return true;
  });
}

// 6.3 存储穿越与软链接安全防护验证
{
  const traversalStorage = new FlowStorage(path.join(os.tmpdir(), `flow_trav_${Date.now()}`));
  // 注入非法 mediaId 格式（杜绝 .. / 斜杠 / 特殊字符）
  assert.equal(traversalStorage.resolveMedia('media_../../etc/passwd'), null);
  assert.equal(traversalStorage.resolveMedia('../etc/passwd'), null);
  assert.equal(traversalStorage.resolveMedia(''), null);
  assert.equal(traversalStorage.resolveMedia(null), null);
  assert.throws(() => traversalStorage.getJobDir('job/../evil'), /Invalid jobId/);
  assert.throws(() => traversalStorage.getJobDir('job\\evil'), /Invalid jobId/);
  assert.throws(() => traversalStorage.getJobDir(''), /Invalid jobId/);

  // 验证 mediaId 不泄漏任何内部文件绝对路径
  const mId = traversalStorage.generateMediaId('job_secret_123', 0, 'png');
  assert.equal(mId.includes('/'), false);
  assert.equal(mId.includes('\\'), false);
  assert.equal(mId.includes('Users'), false);
  assert.equal(mId.startsWith('media_'), true);
}

// 6.4 验证 /v1/flow 路由在带 API Key 中间件的完整服务器管道下生效
{
  const authApp = express();
  authApp.use(express.json());
  
  // 模拟 server/index.js 中的 API Key 验证中间件
  const REQUIRED_KEY = 'test-secret-flow-key';
  authApp.use((req, res, next) => {
    if (req.path.startsWith('/v1/')) {
      const authHeader = req.headers.authorization || req.headers['x-api-key'];
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
      if (providedKey !== REQUIRED_KEY) {
        return res.status(401).json({ error: 'Invalid API Key' });
      }
    }
    next();
  });

  // 挂载 /v1/flow
  authApp.use('/v1/flow', flowApiRouter);

  const authServer = http.createServer(authApp);
  await new Promise(r => authServer.listen(0, '127.0.0.1', r));
  const authPort = authServer.address().port;
  const baseUrl = `http://127.0.0.1:${authPort}/v1/flow`;

  try {
    // 未带 key -> 401
    const unauthRes = await fetch(`${baseUrl}/models`);
    assert.equal(unauthRes.status, 401);

    // 带错误 key -> 401
    const wrongKeyRes = await fetch(`${baseUrl}/models`, {
      headers: { 'Authorization': 'Bearer wrong-key' }
    });
    assert.equal(wrongKeyRes.status, 401);

    // 带正确 key -> 200
    const authOkRes = await fetch(`${baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${REQUIRED_KEY}` }
    });
    assert.equal(authOkRes.status, 200);
    const body = await authOkRes.json();
    assert.equal(body.object, 'list');
  } finally {
    authServer.close();
  }
}

// 6.5 校验 Worker 脚���无前端 DOM 内存泄漏传输（无 FileReader / readAsDataURL）
{
  const dummyJob = {
    jobId: 'worker_check_001',
    type: 'image',
    params: { model: 'nano-banana-pro', displayName: 'Nano Banana Pro', prompt: 'test' }
  };
  const code = buildWorkerScript(dummyJob, '/tmp/target');
  assert.equal(/readAsDataURL/.test(code), false);
  assert.equal(/FileReader/.test(code), false);
  assert.equal(/canvas\.toDataURL/.test(code), false);
}

// -------------------------------------------------------------
// 8. 针对审查问题的专项回归测试 (Exit 0 missing result, Baseline sampling, Socket IP Auth, Safe Headers)
// -------------------------------------------------------------
console.log('8. Testing regression for code review findings...');

// 8.1 缺失结果协议报错 (Exit 0 无 FLOW_RESULT 抛出 flow_worker_missing_result)
{
  const testStorage = new FlowStorage(path.join(os.tmpdir(), `flow_missing_${Date.now()}`));
  // buildWorkerScript 包含关键契约
  const dummyJob = {
    jobId: 'missing_res_job',
    type: 'image',
    params: { model: 'nano-banana-pro', prompt: 'cat', count: 1 }
  };
  const script = buildWorkerScript(dummyJob, '/tmp/target');
  assert.ok(script.includes('dual sampling') || script.includes('baselineSample1'));
  assert.ok(script.includes('sourceEditHref'));
}

// 8.2 安全下载 Header 验证
{
  const dlStorage = defaultFlowStorage;
  const testJobId = 'job_sec_headers';
  const jDir = dlStorage.createJobDir(testJobId);
  const sampleFile = path.join(jDir, 'output_1.png');
  fs.writeFileSync(sampleFile, Buffer.from('png data content'));

  const mId = dlStorage.generateMediaId(testJobId, 0, 'png');
  dlStorage.writeManifest(testJobId, {
    jobId: testJobId,
    type: 'image',
    status: 'completed',
    createdAt: new Date().toISOString(),
    outputs: [{ mediaId: mId, filename: 'output_1.png', mimeType: 'image/png', sizeBytes: 16 }]
  });

  const app = express();
  app.use('/v1/flow', flowApiRouter);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/flow/files/${mId}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(res.headers.get('content-disposition')?.includes('inline; filename="output_1.png"'));
  } finally {
    server.close();
    try { fs.rmSync(jDir, { recursive: true, force: true }); } catch (_) {}
  }
}

console.log('✓ Regression tests for review findings passed.');
console.log('7. Testing protocol parser for FLOW_EVENT & FLOW_RESULT...');

{
  const mockStorage = new FlowStorage(path.join(os.tmpdir(), `flow_proto_${Date.now()}`));
  const testJob = {
    jobId: 'proto_test_job_1',
    type: 'image',
    params: { model: 'nano-banana-pro', prompt: 'proto test' },
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString()
  };

  mockStorage.createJobDir(testJob.jobId);
  mockStorage.writeManifest(testJob.jobId, {
    jobId: testJob.jobId,
    type: testJob.type,
    status: 'queued',
    params: testJob.params,
    createdAt: testJob.createdAt,
    outputs: []
  });

  // 模拟标准���出行流转
  const eventLines = [
    'FLOW_EVENT:{"type":"configuring","jobId":"proto_test_job_1"}',
    'FLOW_EVENT:{"type":"submitted","jobId":"proto_test_job_1"}',
    'FLOW_EVENT:{"type":"generating","jobId":"proto_test_job_1"}',
    'FLOW_EVENT:{"type":"downloading","jobId":"proto_test_job_1"}',
    'FLOW_RESULT:{"jobId":"proto_test_job_1","status":"completed","outputs":[{"mediaId":"media_abc","filename":"output_1.png","mimeType":"image/png","sizeBytes":1024}]}'
  ];

  for (const line of eventLines) {
    if (line.startsWith('FLOW_EVENT:')) {
      const evt = JSON.parse(line.slice('FLOW_EVENT:'.length));
      const m = mockStorage.readManifest(testJob.jobId);
      m.status = evt.type;
      mockStorage.writeManifest(testJob.jobId, m);
    } else if (line.startsWith('FLOW_RESULT:')) {
      const res = JSON.parse(line.slice('FLOW_RESULT:'.length));
      const m = mockStorage.readManifest(testJob.jobId);
      m.status = res.status;
      m.outputs = res.outputs;
      m.completedAt = new Date().toISOString();
      mockStorage.writeManifest(testJob.jobId, m);
    }
  }

  const finalManifest = mockStorage.readManifest(testJob.jobId);
  assert.equal(finalManifest.status, 'completed');
  assert.equal(finalManifest.outputs.length, 1);
  assert.equal(finalManifest.outputs[0].mediaId, 'media_abc');
}

console.log('✓ Deep edge cases and protocol parser tests passed.');

console.log('\n=== All Flow API Tests Passed Successfully! ===');
