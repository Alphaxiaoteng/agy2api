#!/usr/bin/env node
/**
 * Unified Google Flow CLI (`flow` / `npm run flow`)
 *
 * Commands:
 *   flow generate image --prompt "..." [--model <model>] [--aspect <16:9|1:1|9:16>] [--count <n>] [--ref <path_or_media_id>] [--wait] [--detach]
 *   flow generate video --prompt "..." [--model <model>] [--aspect <16:9|9:16>] [--duration <s>] [--start-image <id>] [--end-image <id>] [--wait] [--detach]
 *   flow status <job_id>
 *   flow resume <job_id> [--timeout <ms>]
 *   flow upload <file_path>
 *   flow accounts status
 *   flow accounts verify [--client <id>] [--label <label>]
 *
 * Output Discipline:
 *   - STDOUT: Pure JSON output only (easy piping to jq / scripts)
 *   - STDERR: Progress spinners, informational logs, warnings
 *
 * Exit Codes:
 *   0  - Success
 *   2  - Invalid params / CLI flags / missing prompt
 *   3  - Extension offline / bridge unavailable / no clients
 *   4  - Auth / project missing or unauthorized
 *   5  - Image upload error
 *   6  - Upstream generation error
 *   7  - Unknown state after submit (credit deduction possible)
 *   8  - Timeout during polling
 *   9  - Media download error
 *   10 - Disk write / storage error
 *   1  - General/unclassified error
 */

import fs from 'fs';
import path from 'path';

const DEFAULT_BASE_URL = process.env.FLOW_API_URL || 'http://127.0.0.1:8045';
const DEFAULT_API_KEY = process.env.ANTIGRAVITY_API_KEY || process.env.API_KEY || null;

function logErr(msg) {
  process.stderr.write(`${msg}\n`);
}

function outputJson(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const k = arg.slice(2, eqIdx);
        const v = arg.slice(eqIdx + 1);
        flags[k] = v;
      } else {
        const k = arg.slice(2);
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[k] = next;
          i++;
        } else {
          flags[k] = true;
        }
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function requestApi(endpoint, options = {}) {
  const url = `${DEFAULT_BASE_URL.replace(/\/$/, '')}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...(DEFAULT_API_KEY ? { 'Authorization': `Bearer ${DEFAULT_API_KEY}` } : {}),
    ...(options.headers || {})
  };

  try {
    const res = await fetch(url, {
      ...options,
      headers
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (netErr) {
    return {
      ok: false,
      status: 0,
      error: netErr,
      data: { error: { message: `Connection to Flow API failed: ${netErr.message}`, code: 'network_error' } }
    };
  }
}

async function uploadLocalImage(filePath) {
  if (!fs.existsSync(filePath)) {
    logErr(`Error: File '${filePath}' does not exist`);
    process.exit(5);
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    logErr(`Error: Invalid image file path`);
    process.exit(5);
  }

  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/png';

  const base64 = buffer.toString('base64');
  const res = await requestApi('/v1/flow/uploads', {
    method: 'POST',
    body: JSON.stringify({
      image: base64,
      mime_type: mimeType
    })
  });

  if (!res.ok) {
    logErr(`Upload failed: ${res.data?.error?.message || res.status}`);
    process.exit(5);
  }

  return res.data;
}

async function pollJobUntilDone(jobId, timeoutMs = 300000, pollIntervalMs = 2000) {
  const startTime = Date.now();
  logErr(`Polling job ${jobId}...`);

  while (Date.now() - startTime < timeoutMs) {
    const res = await requestApi(`/v1/flow/jobs/${jobId}`);
    if (!res.ok) {
      if (res.status === 404) {
        logErr(`Job ${jobId} not found`);
        process.exit(4);
      }
      logErr(`Poll request returned HTTP ${res.status}`);
    } else {
      const job = res.data;
      if (job.status === 'completed') {
        return job;
      }
      if (job.status === 'failed') {
        logErr(`Job failed: ${job.error || 'Upstream error'}`);
        process.exit(6);
      }
      if (job.status === 'unknown_after_submit') {
        logErr(`Job ended in unknown state after submit (credit deduction possible): ${job.error || 'Unknown'}`);
        outputJson(job);
        process.exit(7);
      }
      if (job.status === 'canceled') {
        logErr(`Job was canceled`);
        outputJson(job);
        process.exit(1);
      }
    }
    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  logErr(`Polling timed out after ${timeoutMs}ms`);
  process.exit(8);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const { positional, flags } = parseArgs(rawArgs);

  const command = positional[0];
  const subcommand = positional[1];

  if (!command || command === 'help' || flags.help || flags.h) {
    logErr(`Google Flow CLI
Usage:
  flow generate image --prompt "..." [--model <m>] [--aspect <ratio>] [--count <n>] [--ref <img_or_id>] [--wait] [--detach]
  flow generate video --prompt "..." [--model <m>] [--aspect <ratio>] [--duration <s>] [--start-image <img_or_id>] [--end-image <img_or_id>] [--wait] [--detach]
  flow status <job_id>
  flow resume <job_id>
  flow upload <file_path>
  flow accounts status
  flow accounts verify [--client <id>] [--label <label>]
`);
    process.exit(positional.length === 0 ? 2 : 0);
  }

  // 1. UPLOAD
  if (command === 'upload') {
    const filePath = positional[1] || flags.file;
    if (!filePath) {
      logErr('Error: Image file path is required');
      process.exit(2);
    }
    const uploaded = await uploadLocalImage(filePath);
    outputJson(uploaded);
    process.exit(0);
  }

  // 2. STATUS
  if (command === 'status') {
    const jobId = positional[1] || flags.id;
    if (!jobId) {
      logErr('Error: jobId is required');
      process.exit(2);
    }
    const res = await requestApi(`/v1/flow/jobs/${jobId}`);
    if (!res.ok) {
      if (res.status === 404) {
        logErr(`Job '${jobId}' not found`);
        process.exit(4);
      }
      logErr(`Error fetching job: ${res.data?.error?.message || res.status}`);
      process.exit(1);
    }
    outputJson(res.data);
    process.exit(0);
  }

  // 3. RESUME
  if (command === 'resume') {
    const jobId = positional[1] || flags.id;
    if (!jobId) {
      logErr('Error: jobId is required');
      process.exit(2);
    }
    const timeout = Number(flags.timeout) || 300000;
    const finalJob = await pollJobUntilDone(jobId, timeout);
    outputJson(finalJob);
    process.exit(0);
  }

  // 4. ACCOUNTS (status / verify)
  if (command === 'accounts' || command === 'account') {
    if (subcommand === 'status' || !subcommand) {
      const res = await requestApi('/v1/flow/accounts');
      if (!res.ok) {
        logErr(`Failed to retrieve accounts status: ${res.data?.error?.message || res.status}`);
        if (res.status === 401 || res.status === 403) {
          outputJson({ error: { code: 'AUTH_REQUIRED', message: 'API authentication required to inspect accounts status' } });
          process.exit(4);
        }
        process.exit(1);
      }

      // Check for duplicate account labels
      const data = res.data?.data || [];
      const labelCounts = new Map();
      for (const acc of data) {
        if (acc.account_label) {
          labelCounts.set(acc.account_label, (labelCounts.get(acc.account_label) || 0) + 1);
        }
      }
      const duplicateLabels = Array.from(labelCounts.entries())
        .filter(([_, count]) => count > 1)
        .map(([label]) => label);

      if (duplicateLabels.length > 0) {
        logErr(`Warning: Duplicate account labels detected: ${duplicateLabels.join(', ')}`);
      }

      outputJson({
        ...res.data,
        duplicate_labels: duplicateLabels.length > 0 ? duplicateLabels : undefined,
      });
      process.exit(0);
    }

    if (subcommand === 'verify') {
      const targetClientId = flags.client || flags['client-id'];
      const targetLabel = flags.label || flags['account-label'];

      const res = await requestApi('/v1/flow/accounts/verify', {
        method: 'POST',
        body: JSON.stringify({
          client_id: targetClientId,
          account_label: targetLabel,
        }),
      });

      if (!res.ok) {
        logErr(`Verification request failed: ${res.data?.error?.message || res.status}`);
        if (res.status === 401 || res.status === 403) {
          outputJson({ error: { code: 'AUTH_REQUIRED', message: 'API authentication required to verify accounts' } });
          process.exit(4);
        }
        if (res.status === 404) {
          outputJson(res.data);
          process.exit(4);
        }
        if (res.status === 503) {
          outputJson(res.data);
          process.exit(3);
        }
        outputJson(res.data);
        process.exit(1);
      }

      outputJson(res.data);
      process.exit(0);
    }

    logErr(`Error: Unknown accounts subcommand '${subcommand}'. Expected 'status' or 'verify'.`);
    process.exit(2);
  }

  // 4. GENERATE
  if (command === 'generate') {
    if (subcommand !== 'image' && subcommand !== 'video') {
      logErr(`Error: Unknown generate target '${subcommand}'. Expected 'image' or 'video'.`);
      process.exit(2);
    }

    const prompt = flags.prompt || positional[2];
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      logErr('Error: --prompt is required');
      process.exit(2);
    }

    const waitMode = Boolean(flags.wait);
    const body = {
      prompt: prompt.trim()
    };

    if (flags.model) body.model = flags.model;
    if (flags.aspect || flags['aspect-ratio']) body.aspect = flags.aspect || flags['aspect-ratio'];
    if (flags.count || flags.n) body.count = Number(flags.count || flags.n);
    if (flags.client || flags['client-id']) body.client_id = flags.client || flags['client-id'];
    if (flags.account || flags['account-id']) body.account_id = flags.account || flags['account-id'];
    if (flags.label || flags['account-label']) body.account_label = flags.label || flags['account-label'];
    if (flags.cost !== undefined) body.estimated_cost = Number(flags.cost);

    if (subcommand === 'image') {
      let ref = flags.ref || flags['reference-image'] || flags['ref-image'];
      if (ref) {
        if (fs.existsSync(ref)) {
          logErr(`Uploading reference image '${ref}'...`);
          const up = await uploadLocalImage(ref);
          ref = up.media_id;
        }
        body.reference_asset_ids = [ref];
      }

      const endpoint = waitMode ? '/v1/flow/images/generations?wait=true' : '/v1/flow/images/generations';
      const res = await requestApi(endpoint, {
        method: 'POST',
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const code = res.data?.error?.type || res.data?.error?.code || '';
        const msg = res.data?.error?.message || `HTTP ${res.status}`;
        logErr(`Generation failed: ${msg}`);

        if (res.status === 400 || code === 'invalid_request_error') process.exit(2);
        if (res.status === 503 && (code === 'NO_EXTENSION_CLIENTS' || msg.includes('offline'))) process.exit(3);
        if (res.status === 401 || res.status === 403 || code === 'NO_PROJECT_ID') process.exit(4);
        if (code === 'failed_download') process.exit(9);
        process.exit(6);
      }

      if (waitMode) {
        outputJson(res.data);
        process.exit(0);
      } else {
        // Detached 202 response
        outputJson(res.data);
        process.exit(0);
      }
    } else if (subcommand === 'video') {
      if (flags.duration) body.duration = Number(flags.duration);
      if (flags.mode) body.mode = flags.mode;

      let startImg = flags['start-image'] || flags.startImage;
      if (startImg) {
        if (fs.existsSync(startImg)) {
          logErr(`Uploading start image '${startImg}'...`);
          const up = await uploadLocalImage(startImg);
          startImg = up.media_id;
        }
        body.start_image_id = startImg;
      }

      let endImg = flags['end-image'] || flags.endImage;
      if (endImg) {
        if (fs.existsSync(endImg)) {
          logErr(`Uploading end image '${endImg}'...`);
          const up = await uploadLocalImage(endImg);
          endImg = up.media_id;
        }
        body.end_image_id = endImg;
      }

      const endpoint = waitMode ? '/v1/flow/videos/generations?wait=true' : '/v1/flow/videos/generations';
      const res = await requestApi(endpoint, {
        method: 'POST',
        body: JSON.stringify(body)
      });

      if (!res.ok) {
        const code = res.data?.error?.type || res.data?.error?.code || '';
        const msg = res.data?.error?.message || `HTTP ${res.status}`;
        logErr(`Generation failed: ${msg}`);

        if (res.status === 400 || code === 'invalid_request_error') process.exit(2);
        if (res.status === 503 && (code === 'NO_EXTENSION_CLIENTS' || msg.includes('offline'))) process.exit(3);
        if (res.status === 401 || res.status === 403 || code === 'NO_PROJECT_ID') process.exit(4);
        if (code === 'failed_download') process.exit(9);
        process.exit(6);
      }

      if (waitMode) {
        outputJson(res.data);
        process.exit(0);
      } else {
        outputJson(res.data);
        process.exit(0);
      }
    }
  }

  logErr(`Error: Unknown command '${command}'`);
  process.exit(2);
}

main().catch(err => {
  logErr(`Unexpected fatal error: ${err.stack || err.message}`);
  process.exit(1);
});
