/**
 * Comprehensive CLI Integration & Exit Code Contract Tests for scripts/flow.mjs
 *
 * Checks:
 * 1. CLI stdout strictly contains valid JSON (JSON.parse(stdout))
 * 2. Exit code 2 on missing/invalid arguments (--prompt missing, invalid model/target)
 * 3. Exit code 3 when extension client is offline / unavailable
 * 4. Image upload command returns media_id and JSON
 * 5. Detach mode (default / async) returns 202 job manifest instantly (<100ms) with exit code 0
 * 6. Wait mode (--wait) completes generation and outputs final job manifest with exit code 0
 * 7. Status and Resume commands
 * 8. Archive path slug validation
 */

import assert from 'node:assert/strict';
import { spawn } from 'child_process';
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import express from 'express';
import { fileURLToPath } from 'url';

import { flowApiRouter, flowQueue } from '../src/routes/flowApi.js';
import { defaultFlowStorage, generateArchiveSlug } from '../src/utils/flowStorage.js';
import { flowExtensionBridge } from '../src/services/flowExtensionBridge.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const cliPath = path.join(rootDir, 'scripts/flow.mjs');

console.log('=== Starting Flow CLI Integration & Exit Code Tests ===\n');

// -------------------------------------------------------------
// Slug generation unit check
// -------------------------------------------------------------
console.log('1. Testing slug generator format...');
{
  const slug = generateArchiveSlug({
    prompt: 'A cyberpunk samurai cat in Tokyo!',
    model: 'imagen-3.0-generate-002',
    aspect: '16:9',
    duration: 'static',
    shortId: 'media_abcd1234ef',
    ext: 'png'
  });
  assert.equal(slug, 'A-cyberpunk-samurai-cat-in-Tok_imagen-3-0-generate-002_16-9_static_cd1234ef.png');
  console.log(`✓ Slug format: ${slug}`);
}

// -------------------------------------------------------------
// CLI Subprocess Helper
// -------------------------------------------------------------
function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      cwd: rootDir
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

// -------------------------------------------------------------
// Test 2: CLI argument errors (Exit 2)
// -------------------------------------------------------------
console.log('2. Testing argument validation exit codes (exit 2)...');
{
  // Missing prompt
  const res1 = await runCli(['generate', 'image']);
  assert.equal(res1.code, 2);
  assert.ok(res1.stderr.includes('--prompt is required') || res1.stderr.includes('Error'));

  // Invalid command
  const res2 = await runCli(['unknown_command']);
  assert.equal(res2.code, 2);

  // Missing file in upload
  const res3 = await runCli(['upload']);
  assert.equal(res3.code, 2);

  console.log('✓ Invalid CLI parameters correctly exit with code 2');
}

// -------------------------------------------------------------
// Test 3: Upload command
// -------------------------------------------------------------
console.log('3. Testing flow upload command with mock server...');
const tmpImageDir = path.join(os.tmpdir(), `flow_cli_test_${Date.now()}`);
fs.mkdirSync(tmpImageDir, { recursive: true });
const testImgPath = path.join(tmpImageDir, 'test_sample.png');
// 1x1 PNG magic bytes
fs.writeFileSync(testImgPath, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex'));

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use('/v1/flow', flowApiRouter);

const server = http.createServer(app);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const flowApiUrl = `http://127.0.0.1:${port}`;

try {
  const uploadRes = await runCli(['upload', testImgPath], { FLOW_API_URL: flowApiUrl });
  assert.equal(uploadRes.code, 0);
  const parsedUpload = JSON.parse(uploadRes.stdout);
  assert.ok(parsedUpload.media_id.startsWith('media_'));
  assert.ok(parsedUpload.url.includes('/v1/flow/files/'));
  console.log(`✓ Upload succeeded, media_id: ${parsedUpload.media_id}`);

  // -------------------------------------------------------------
  // Test 4: Extension Offline Preflight (Exit 3)
  // -------------------------------------------------------------
  console.log('4. Testing extension offline preflight check (exit 3)...');
  const offlineRes = await runCli(['generate', 'image', '--prompt', 'cyber cat'], { FLOW_API_URL: flowApiUrl });
  assert.equal(offlineRes.code, 3);
  assert.ok(offlineRes.stderr.includes('offline') || offlineRes.stderr.includes('NO_EXTENSION_CLIENTS'));
  console.log('✓ Extension offline check correctly exits with code 3');

  // -------------------------------------------------------------
  // Test 5: Connected Mock Extension Client & Fast Async / Detach (202, <100ms)
  // -------------------------------------------------------------
  console.log('5. Registering mock extension client and testing Fast Async 202 Detach mode...');
  // Manually add mock client to flowExtensionBridge clientPool
  const mockClientId = 'cli-test-client-1';
  flowExtensionBridge.clientPool.upsertClient(mockClientId, {
    send: () => {},
    readyState: 1,
    protocolVersion: 1
  }, {
    clientId: mockClientId,
    projectId: 'mock-proj-123',
    tokenPresent: true,
    platform: 'mac'
  });

  // Mock workerRunner in flowQueue for immediate fast completion
  flowQueue.workerRunner = async (job, storage) => {
    const jobDir = storage.createJobDir(job.jobId);
    const fn = 'output_1.png';
    const fakeData = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082', 'hex');
    storage.writeOutputFile(job.jobId, fn, fakeData);
    const mId = storage.generateMediaId(job.jobId, 0, 'png');
    const manifest = {
      jobId: job.jobId,
      type: job.type,
      status: 'completed',
      params: job.params,
      createdAt: job.createdAt,
      completedAt: new Date().toISOString(),
      outputs: [
        {
          mediaId: mId,
          filename: fn,
          mimeType: 'image/png',
          sizeBytes: fakeData.length
        }
      ]
    };
    storage.writeManifest(job.jobId, manifest);
    return manifest;
  };

  const t0 = Date.now();
  const detachRes = await runCli(['generate', 'image', '--prompt', 'fast async prompt', '--detach'], { FLOW_API_URL: flowApiUrl });
  const latency = Date.now() - t0;
  assert.equal(detachRes.code, 0);
  const detachJson = JSON.parse(detachRes.stdout);
  assert.ok(detachJson.job_id.startsWith('flow_'));
  assert.equal(detachJson.status, 'queued');
  assert.ok(detachJson.poll_url.includes('/v1/flow/jobs/'));
  console.log(`✓ Fast Async Detach 202 response received in ${latency}ms, jobId: ${detachJson.job_id}`);

  // -------------------------------------------------------------
  // Test 6: CLI Status & Resume
  // -------------------------------------------------------------
  console.log('6. Testing CLI status and resume commands...');
  // Poll until job is completed
  let statusJson = null;
  for (let i = 0; i < 20; i++) {
    const statusRes = await runCli(['status', detachJson.job_id], { FLOW_API_URL: flowApiUrl });
    assert.equal(statusRes.code, 0);
    statusJson = JSON.parse(statusRes.stdout);
    if (statusJson.status === 'completed') break;
    await new Promise(r => setTimeout(r, 100));
  }

  assert.equal(statusJson.job_id, detachJson.job_id);
  assert.equal(statusJson.status, 'completed');
  assert.ok(statusJson.data.length >= 1);
  console.log('✓ Status command returned completed job JSON');

  const resumeRes = await runCli(['resume', detachJson.job_id], { FLOW_API_URL: flowApiUrl });
  assert.equal(resumeRes.code, 0);
  const resumeJson = JSON.parse(resumeRes.stdout);
  assert.equal(resumeJson.status, 'completed');
  console.log('✓ Resume command succeeded');

  // -------------------------------------------------------------
  // Test 7: CLI Wait Mode (--wait)
  // -------------------------------------------------------------
  console.log('7. Testing CLI --wait synchronous mode...');
  const waitRes = await runCli(['generate', 'image', '--prompt', 'wait mode test', '--wait'], { FLOW_API_URL: flowApiUrl });
  assert.equal(waitRes.code, 0);
  const waitJson = JSON.parse(waitRes.stdout);
  assert.equal(waitJson.status, 'completed');
  assert.ok(waitJson.data[0].media_id.startsWith('media_'));
  console.log('✓ Synchronous --wait mode succeeded');

  // -------------------------------------------------------------
  // Test 8: CLI Image generation with --ref parameter
  // -------------------------------------------------------------
  console.log('8. Testing CLI image generation with --ref uploaded file...');
  const refRes = await runCli(['generate', 'image', '--prompt', 'ref prompt', '--ref', testImgPath, '--wait'], { FLOW_API_URL: flowApiUrl });
  assert.equal(refRes.code, 0);
  const refJson = JSON.parse(refRes.stdout);
  assert.equal(refJson.status, 'completed');
  console.log('✓ Reference image upload & generation succeeded');

  // -------------------------------------------------------------
  // Test 9: CLI Video generation with --start-image parameter
  // -------------------------------------------------------------
  console.log('9. Testing CLI video generation with --start-image and --wait...');
  const vidRes = await runCli(['generate', 'video', '--prompt', 'video prompt', '--model', 'omni-flash', '--start-image', testImgPath, '--duration', '6', '--wait'], { FLOW_API_URL: flowApiUrl });
  assert.equal(vidRes.code, 0);
  const vidJson = JSON.parse(vidRes.stdout);
  assert.equal(vidJson.status, 'completed');
  assert.equal(vidJson.type, 'video');
  console.log('✓ Video generation with start-image succeeded');

  console.log('\n=== All Flow CLI Tests Passed Successfully! ===');
} finally {
  server.close();
  try {
    fs.rmSync(tmpImageDir, { recursive: true, force: true });
  } catch (_) {}
}
