/**
 * Real E2E Probe for Flow Image Generation
 *
 * Checks health, checks status/bridge, performs single image generation via CLI,
 * verifies archive output in output/flow/<date>/image/,
 * checks magic bytes, and outputs JSON metrics.
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import { spawn } from 'child_process';
import crypto from 'crypto';

const BASE_URL = 'http://127.0.0.1:8045';

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (_) {}
        resolve({
          status: res.status,
          statusCode: res.statusCode,
          headers: res.headers,
          data: json,
          raw: data
        });
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

function verifyMagicBytes(filePath) {
  if (!fs.existsSync(filePath)) {
    return { valid: false, format: 'missing', size: 0 };
  }
  const buffer = fs.readFileSync(filePath);
  const size = buffer.length;
  if (size < 8) {
    return { valid: false, format: 'too_small', size };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
    return { valid: true, format: 'png', size };
  }
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { valid: true, format: 'jpeg', size };
  }
  // WebP: RIFF ... WEBP
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { valid: true, format: 'webp', size };
  }

  return { valid: false, format: 'unknown', size };
}

async function probe() {
  const probeStartTime = Date.now();
  console.log('=== Step 1: Checking Localhost Server Health ===');

  let healthRes;
  try {
    healthRes = await fetchUrl(`${BASE_URL}/health`);
    console.log(`✓ Health endpoint response: HTTP ${healthRes.statusCode}`, JSON.stringify(healthRes.data));
  } catch (err) {
    console.error('❌ Server is not running on http://127.0.0.1:8045:', err.message);
    process.exit(1);
  }

  console.log('\n=== Step 2: Checking Desensitized Admin & Flow Status ===');
  let statusRes;
  try {
    statusRes = await fetchUrl(`${BASE_URL}/admin/flow/status`);
    console.log(`✓ /admin/flow/status response: HTTP ${statusRes.statusCode}`);
    console.log('Status Data Summary:', JSON.stringify({
      officialAuth: statusRes.data?.data?.officialAuth,
      extensionBridge: {
        serverRunning: statusRes.data?.data?.extensionBridge?.serverRunning,
        totalClients: statusRes.data?.data?.extensionBridge?.totalClients,
        connectedClients: statusRes.data?.data?.extensionBridge?.connectedClients,
        clients: statusRes.data?.data?.extensionBridge?.clients
      },
      accountBridge: statusRes.data?.data?.accountBridge,
      queue: statusRes.data?.data?.queue
    }, null, 2));
  } catch (err) {
    console.error('❌ Failed to fetch /admin/flow/status:', err.message);
    process.exit(1);
  }

  const clients = statusRes.data?.data?.extensionBridge?.clients || [];
  const activeClient = clients.find(c => c.connected && c.tokenPresent);
  console.log(`\nExtension Bridge Status: ${clients.length} total clients, ${activeClient ? '1 active client ready' : 'no active client'}`);

  let creditsBefore = activeClient?.credits ?? null;

  // Let's also check /v1/flow/status
  try {
    const v1Status = await fetchUrl(`${BASE_URL}/v1/flow/status`);
    console.log('✓ /v1/flow/status response:', JSON.stringify(v1Status.data, null, 2));
  } catch (_) {}

  if (!activeClient) {
    console.error('❌ Extension client is offline or missing credentials. Stopping as required.');
    process.exit(3);
  }

  console.log(`\nActive client found: id=${activeClient.clientId}, tier=${activeClient.tier}, credits=${activeClient.credits}, tokenPresent=${activeClient.tokenPresent}`);

  console.log('\n=== Step 3: Executing Single Image Generation ===');
  const prompt = 'Cinematic view of planet Earth glowing blue in deep space, realistic atmosphere and clouds, subtle sunrise rim light, high detail, vertical composition';
  const model = 'nano-banana-2-lite';
  const aspect = '9:16';
  const count = 1;
  const idempotencyKey = `flow_e2e_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

  console.log(`Submitting generation: model=${model}, aspect=${aspect}, count=${count}`);
  console.log(`Idempotency Key: ${idempotencyKey}`);
  console.log(`Prompt: "${prompt}"`);

  const apiStartTime = Date.now();
  const cliArgs = [
    'scripts/flow.mjs',
    'generate',
    'image',
    '--prompt',
    prompt,
    '--model',
    model,
    '--aspect',
    aspect,
    '--count',
    String(count),
    '--wait'
  ];

  console.log(`Running CLI: node ${cliArgs.join(' ')}`);

  const cliResult = await new Promise((resolve) => {
    const proc = spawn(process.execPath, cliArgs, {
      cwd: path.resolve(process.cwd()),
      env: {
        ...process.env,
        FLOW_API_URL: BASE_URL,
        IDEMPOTENCY_KEY: idempotencyKey
      }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => {
      stderr += d.toString();
      process.stderr.write(d);
    });

    proc.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });

  const apiDurationMs = Date.now() - apiStartTime;
  console.log(`\nCLI Process exited with code ${cliResult.code} (duration: ${apiDurationMs}ms)`);

  let parsedOutput = null;
  try {
    parsedOutput = JSON.parse(cliResult.stdout);
  } catch (err) {
    console.error('❌ CLI stdout is not valid JSON:\n', cliResult.stdout);
    process.exit(cliResult.code || 1);
  }

  console.log('CLI Result JSON:\n', JSON.stringify(parsedOutput, null, 2));

  if (cliResult.code !== 0 || parsedOutput.status !== 'completed') {
    console.error(`❌ Generation failed with status: ${parsedOutput.status || 'unknown'}, error: ${parsedOutput.error || 'none'}`);
    process.exit(cliResult.code || 6);
  }

  const jobId = parsedOutput.job_id;
  const firstData = parsedOutput.data?.[0];
  const mediaId = firstData?.media_id;
  const filename = firstData?.filename;

  console.log('\n=== Step 4: Checking Credits After Generation ===');
  let creditsAfter = null;
  try {
    const statusAfter = await fetchUrl(`${BASE_URL}/admin/flow/status`);
    const clientAfter = statusAfter.data?.data?.extensionBridge?.clients?.find(c => c.clientId === activeClient.clientId);
    creditsAfter = clientAfter?.credits ?? null;
    console.log(`Credits before: ${creditsBefore}, Credits after: ${creditsAfter}`);
  } catch (_) {}

  console.log('\n=== Step 5: Validating Output File & Magic Bytes ===');
  const dateStr = '2026-09-01';
  const flowBaseDir = process.env.FLOW_ARCHIVE_DIR || path.resolve(process.cwd(), 'output/flow');
  const expectedDir = path.join(flowBaseDir, dateStr, 'image');
  console.log(`Expected directory: ${expectedDir}`);

  // Find the file in the date directory
  let targetFile = null;
  if (fs.existsSync(expectedDir)) {
    const files = fs.readdirSync(expectedDir);
    // Look for files created or containing part of slug / shortId
    for (const f of files) {
      if (filename && f === filename) {
        targetFile = path.join(expectedDir, f);
        break;
      }
      if (jobId && f.includes(jobId.slice(-8))) {
        targetFile = path.join(expectedDir, f);
        break;
      }
      if (f.includes('planet-Earth') || f.includes('nano-banana-2-lite')) {
        targetFile = path.join(expectedDir, f);
      }
    }
  }

  if (!targetFile && fs.existsSync(expectedDir)) {
    const files = fs.readdirSync(expectedDir);
    if (files.length > 0) {
      // Pick the latest file
      const sorted = files.map(f => ({
        name: f,
        time: fs.statSync(path.join(expectedDir, f)).mtimeMs
      })).sort((a, b) => b.time - a.time);
      targetFile = path.join(expectedDir, sorted[0].name);
    }
  }

  // Also check job directory if needed
  const jobDirFile = path.join(flowBaseDir, 'jobs', jobId || 'unknown', filename || 'output_1.png');

  console.log(`Target archive file: ${targetFile}`);
  console.log(`Target job file: ${jobDirFile}`);

  const archiveVerify = targetFile ? verifyMagicBytes(targetFile) : { valid: false, format: 'not_found', size: 0 };
  const jobVerify = verifyMagicBytes(jobDirFile);

  console.log(`Archive file magic bytes verification: valid=${archiveVerify.valid}, format=${archiveVerify.format}, size=${archiveVerify.size} bytes`);
  console.log(`Job file magic bytes verification: valid=${jobVerify.valid}, format=${jobVerify.format}, size=${jobVerify.size} bytes`);

  if (!archiveVerify.valid && !jobVerify.valid) {
    console.error('❌ Failed magic bytes verification!');
    process.exit(10);
  }

  const finalFile = (archiveVerify.valid ? targetFile : jobDirFile);
  const finalVerify = archiveVerify.valid ? archiveVerify : jobVerify;
  const totalDurationMs = Date.now() - probeStartTime;

  console.log('\n======================================================');
  console.log('=== FLOW IMAGE E2E TEST SUMMARY ===');
  console.log('======================================================');
  const summary = {
    result: 'SUCCESS',
    submissionsCount: 1,
    idempotencyKey,
    httpDurationMs: apiDurationMs,
    totalDurationMs,
    jobId,
    mediaId,
    model,
    aspect,
    count,
    creditsBefore,
    creditsAfter,
    filePath: finalFile,
    fileSizeBytes: finalVerify.size,
    fileFormat: finalVerify.format,
    magicBytesValid: finalVerify.valid
  };

  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

probe().catch(err => {
  console.error('\n❌ Probe encountered fatal error:', err);
  process.exit(1);
});
