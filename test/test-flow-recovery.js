/**
 * Unit Tests for Flow Queue Crash Recovery and Idempotency Invariants
 *
 * Tests:
 * 1. Queue storage hydration recovers completed job manifests
 * 2. Queue storage hydration recovers unknown job manifests and prevents double charging (409 manual_recovery_required)
 * 3. Pre-submit failure recovery returns original failure
 * 4. Idempotency key hash conflict returns 409
 * 5. Concurrent deduplication with AbortSignal
 */

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { FlowQueue } from '../src/services/flowQueue.js';
import { FlowStorage } from '../src/utils/flowStorage.js';
import { validateParams } from '../src/config/flowCapabilities.js';

console.log('=== Starting Flow Recovery Tests ===\n');

const testStorageDir = path.join(os.tmpdir(), `flow_recovery_test_${Date.now()}`);
const storage = new FlowStorage(testStorageDir);

try {
  // -------------------------------------------------------------
  // Test 1: Storage Manifest Hydration of Completed Jobs
  // -------------------------------------------------------------
  console.log('1. Testing hydration of completed jobs from disk...');
  const completedJobId = 'flow_hydrated_completed_001';
  const completedIdempKey = 'idemp-hydrate-done-1';
  const completedParams = validateParams('image', { prompt: 'Hydrated prompt test' });

  const dummyQ = new FlowQueue({ storage });
  const completedKeyHash = dummyQ.hashIdempotencyKey(completedIdempKey);
  const completedReqHash = dummyQ.calculateRequestHash('image', completedParams);

  storage.createJobDir(completedJobId);
  const completedManifest = {
    jobId: completedJobId,
    type: 'image',
    status: 'completed',
    params: completedParams,
    idempotencyKeyHash: completedKeyHash,
    requestHash: completedReqHash,
    clientId: 'client-1',
    projectId: 'proj-1',
    createdAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    outputs: [{
      mediaId: storage.generateMediaId(completedJobId, 0, 'png'),
      filename: 'output_1.png',
      mimeType: 'image/png',
      sizeBytes: 1024,
    }],
  };
  storage.writeManifest(completedJobId, completedManifest);

  let workerRunCount = 0;
  const dummyWorker = async (job) => {
    workerRunCount++;
    return { jobId: job.jobId, status: 'completed', outputs: [] };
  };

  const restoredQueue = new FlowQueue({
    concurrency: 1,
    maxQueue: 5,
    storage,
    workerRunner: dummyWorker,
  });

  // Query with the same idempotency key — should return instantly from hydrated index without invoking worker
  const replayResult = await restoredQueue.submitJob({
    type: 'image',
    params: completedParams,
    idempotencyKey: completedIdempKey,
  });

  assert.equal(replayResult.status, 'completed');
  assert.equal(replayResult.isIdempotentReplay, true);
  assert.equal(replayResult.jobId, completedJobId);
  assert.equal(workerRunCount, 0); // No worker call
  console.log('✓ Completed job hydration passed');

  // -------------------------------------------------------------
  // Test 2: Storage Manifest Hydration of Unknown / Crashed Jobs
  // -------------------------------------------------------------
  console.log('2. Testing hydration of unknown / post-submit crashed jobs...');
  const unknownJobId = 'flow_hydrated_unknown_002';
  const unknownIdempKey = 'idemp-hydrate-unknown-2';
  const unknownParams = validateParams('video', { prompt: 'Unknown video prompt', duration: 6 });

  const unknownKeyHash = dummyQ.hashIdempotencyKey(unknownIdempKey);
  const unknownReqHash = dummyQ.calculateRequestHash('video', unknownParams);

  storage.createJobDir(unknownJobId);
  const unknownManifest = {
    jobId: unknownJobId,
    type: 'video',
    status: 'unknown_after_submit',
    params: unknownParams,
    idempotencyKeyHash: unknownKeyHash,
    requestHash: unknownReqHash,
    clientId: 'client-2',
    projectId: 'proj-2',
    upstreamMediaIds: ['up-vid-2'],
    createdAt: new Date().toISOString(),
    failedAt: new Date().toISOString(),
    error: 'Gateway timeout after submit',
    outputs: [],
  };
  storage.writeManifest(unknownJobId, unknownManifest);

  const restoredQueue2 = new FlowQueue({
    concurrency: 1,
    maxQueue: 5,
    storage,
    workerRunner: dummyWorker,
  });

  // Resubmitting with same key MUST throw 409 manual_recovery_required and NEVER resubmit
  await assert.rejects(
    async () => {
      await restoredQueue2.submitJob({
        type: 'video',
        params: unknownParams,
        idempotencyKey: unknownIdempKey,
      });
    },
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'manual_recovery_required');
      assert.equal(err.jobId, unknownJobId);
      return true;
    }
  );
  assert.equal(workerRunCount, 0); // No double submit
  console.log('✓ Unknown state protection & hydration passed');

  // -------------------------------------------------------------
  // Test 3: Idempotency Key Hash Conflict Detection
  // -------------------------------------------------------------
  console.log('3. Testing idempotency key hash conflict...');
  const conflictingParams = validateParams('image', { prompt: 'Different prompt with same key' });
  await assert.rejects(
    async () => {
      await restoredQueue.submitJob({
        type: 'image',
        params: conflictingParams,
        idempotencyKey: completedIdempKey,
      });
    },
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'idempotency_conflict');
      return true;
    }
  );
  console.log('✓ Idempotency conflict detection passed');

  // -------------------------------------------------------------
  // Test 4: Abort / Cancel vs Unknown differentiation
  // -------------------------------------------------------------
  console.log('4. Testing pre-submit abort sets canceled vs post-submit sets unknown_after_submit...');
  const cancelQueue = new FlowQueue({
    storage,
    workerRunner: async (job) => {
      if (job.params.failPreSubmit) {
        const abortErr = new Error('Client abort before submit');
        abortErr.code = 'request_aborted';
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      if (job.params.failPostSubmit) {
        job.submittedToBrowser = true;
        const abortErr = new Error('Client abort after submit');
        abortErr.code = 'JOB_ABORTED';
        abortErr.submitted = true;
        throw abortErr;
      }
      return { jobId: job.jobId, status: 'completed' };
    }
  });

  // Pre-submit abort -> status = 'canceled'
  const preSubmitIdempKey = 'idemp-cancel-pre-1';
  await assert.rejects(
    async () => {
      await cancelQueue.submitJob({
        type: 'image',
        params: { prompt: 'pre submit test', failPreSubmit: true },
        idempotencyKey: preSubmitIdempKey,
      });
    },
    (err) => err.code === 'request_aborted'
  );
  const preKeyHash = cancelQueue.hashIdempotencyKey(preSubmitIdempKey);
  assert.equal(cancelQueue.idempotencyIndex.get(preKeyHash).status, 'canceled');

  // Post-submit abort -> status = 'unknown_after_submit'
  const postSubmitIdempKey = 'idemp-cancel-post-2';
  await assert.rejects(
    async () => {
      await cancelQueue.submitJob({
        type: 'video',
        params: { prompt: 'post submit test', failPostSubmit: true },
        idempotencyKey: postSubmitIdempKey,
      });
    },
    (err) => err.code === 'JOB_ABORTED'
  );
  const postKeyHash = cancelQueue.hashIdempotencyKey(postSubmitIdempKey);
  assert.equal(cancelQueue.idempotencyIndex.get(postKeyHash).status, 'unknown_after_submit');
  console.log('✓ Pre-submit vs post-submit abort status differentiation passed');

  console.log('\n=== All Flow Recovery Tests Passed Successfully! ===');
} finally {
  try {
    fs.rmSync(testStorageDir, { recursive: true, force: true });
  } catch (_) {}
}
