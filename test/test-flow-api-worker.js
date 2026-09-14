/**
 * Unit Tests for flowApiWorker.js
 *
 * Tests:
 * 1. Image generation flow via flowApiWorker (submit, download, manifest creation with real magic bytes)
 * 2. Video generation flow via flowApiWorker (submit, poll, download, manifest creation with real magic bytes)
 * 3. Error on missing extension client
 * 4. Error on missing project ID
 * 5. Invalid magic bytes rejection
 * 6. Download failure rejection
 * 7. Local asset resolution and cross-project image re-upload
 * 8. Frames mapping and asset limits
 */

import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { runFlowApiWorker, detectMediaFormat, resolveAssetToUpstream } from '../src/services/flowApiWorker.js';
import { FlowStorage } from '../src/utils/flowStorage.js';
import { validateParams } from '../src/config/flowCapabilities.js';

console.log('=== Starting Flow API Worker Tests ===\n');

const testStorageDir = path.join(os.tmpdir(), `flow_worker_test_${Date.now()}`);
const storage = new FlowStorage(testStorageDir);

// Minimal valid PNG buffer (8-byte signature + IHDR chunk + IEND chunk)
const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
  0x89, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
  0x44, 0xAE, 0x42, 0x60, 0x82
]);

// Minimal valid MP4 buffer (ftyp box)
const VALID_MP4_BUFFER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, // 24 bytes, 'ftyp'
  0x69, 0x73, 0x6F, 0x6D, 0x00, 0x00, 0x02, 0x00, // 'isom'
  0x69, 0x73, 0x6F, 0x6D, 0x69, 0x73, 0x6F, 0x32
]);

try {
  // Test detectMediaFormat helper
  assert.equal(detectMediaFormat(VALID_PNG_BUFFER)?.mimeType, 'image/png');
  assert.equal(detectMediaFormat(VALID_MP4_BUFFER)?.mimeType, 'video/mp4');
  assert.equal(detectMediaFormat(Buffer.from('not an image or video')), null);

  // 1. Mock Bridge and Provider
  const mockBridge = {
    clientPool: {
      selectClient: ({ preferredClientId }) => preferredClientId || 'client-1',
      getClientProjectId: (cid) => (cid === 'client-1' ? 'proj-test-uuid' : null),
    },
  };

  const mockProvider = {
    generateImage: async (params) => {
      return {
        images: [{
          upstreamMediaId: 'media-img-123',
          remoteUrl: 'https://example.com/img.png',
          model: 'GEM_PIX_2',
        }],
        remainingCredits: 99,
        raw: { ok: true },
      };
    },
    downloadImage: async (params) => {
      return {
        buffer: VALID_PNG_BUFFER,
        mimeType: 'image/png',
      };
    },
    uploadImage: async (params) => {
      return {
        mediaId: 'uploaded-upstream-id-789',
        raw: { ok: true },
      };
    },
    submitVideo: async (params) => {
      return {
        mediaIds: ['media-vid-456'],
        remainingCredits: 95,
        raw: { ok: true },
      };
    },
    pollVideo: async (params) => {
      return {
        status: 'succeeded',
        media: [{
          mediaId: 'media-vid-456',
          status: 'MEDIA_GENERATION_STATUS_SUCCESSFUL',
          isSuccess: true,
          isFailed: false,
        }],
      };
    },
    downloadVideo: async (params) => {
      return {
        buffer: VALID_MP4_BUFFER,
        mimeType: 'video/mp4',
      };
    },
  };

  // -------------------------------------------------------------
  // Test 1: Image Generation Flow
  // -------------------------------------------------------------
  console.log('1. Testing image generation workflow...');
  const imageJob = {
    jobId: 'job_img_test_1',
    type: 'image',
    params: {
      prompt: 'a tranquil zen garden',
      model: 'flow/gem-pix-2',
      aspect: '16:9',
      count: 1,
    },
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };

  const imgManifest = await runFlowApiWorker(imageJob, storage, {
    provider: mockProvider,
    bridge: mockBridge,
  });

  assert.equal(imgManifest.status, 'completed');
  assert.equal(imgManifest.outputs.length, 1);
  assert.equal(imgManifest.outputs[0].mimeType, 'image/png');
  assert.equal(imgManifest.outputs[0].sizeBytes, VALID_PNG_BUFFER.length);
  assert.equal(imgManifest.outputs[0].upstreamMediaId, 'media-img-123');
  assert.equal(imgManifest.outputs[0].remoteUrl, undefined); // Remote URL MUST NOT be saved in manifest
  assert.equal(imageJob.submittedToBrowser, true);

  const savedImgManifest = storage.readManifest('job_img_test_1');
  assert.equal(savedImgManifest.status, 'completed');
  console.log('✓ Image generation workflow passed');

  // -------------------------------------------------------------
  // Test 2: Video Generation Flow
  // -------------------------------------------------------------
  console.log('2. Testing video generation workflow...');
  const videoJob = {
    jobId: 'job_vid_test_1',
    type: 'video',
    params: {
      prompt: 'waterfall flowing down mountain',
      mode: 't2v',
      duration: 6,
      aspect: '16:9',
      count: 1,
    },
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };

  const vidManifest = await runFlowApiWorker(videoJob, storage, {
    provider: mockProvider,
    bridge: mockBridge,
    pollIntervalMs: 10,
    pollTimeoutMs: 1000,
  });

  assert.equal(vidManifest.status, 'completed');
  assert.equal(vidManifest.outputs.length, 1);
  assert.equal(vidManifest.outputs[0].mimeType, 'video/mp4');
  assert.equal(vidManifest.outputs[0].sizeBytes, VALID_MP4_BUFFER.length);
  assert.equal(vidManifest.outputs[0].upstreamMediaId, 'media-vid-456');
  assert.equal(videoJob.submittedToBrowser, true);

  const savedVidManifest = storage.readManifest('job_vid_test_1');
  assert.equal(savedVidManifest.status, 'completed');
  console.log('✓ Video generation workflow passed');

  // -------------------------------------------------------------
  // Test 3: No Client Available (503)
  // -------------------------------------------------------------
  console.log('3. Testing no client available error handling...');
  const emptyBridge = {
    clientPool: {
      selectClient: () => null,
      getClientProjectId: () => null,
    },
  };

  await assert.rejects(
    async () => {
      await runFlowApiWorker({
        jobId: 'job_no_client',
        type: 'image',
        params: { prompt: 'test' },
      }, storage, {
        provider: mockProvider,
        bridge: emptyBridge,
      });
    },
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, 'NO_EXTENSION_CLIENTS');
      return true;
    }
  );
  console.log('✓ No client error handling passed');

  // -------------------------------------------------------------
  // Test 4: Missing Project ID (503)
  // -------------------------------------------------------------
  console.log('4. Testing missing projectId error handling...');
  const noProjBridge = {
    clientPool: {
      selectClient: () => 'client-without-proj',
      getClientProjectId: () => null,
    },
  };

  await assert.rejects(
    async () => {
      await runFlowApiWorker({
        jobId: 'job_no_proj',
        type: 'image',
        params: { prompt: 'test' },
      }, storage, {
        provider: mockProvider,
        bridge: noProjBridge,
      });
    },
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, 'NO_PROJECT_ID');
      return true;
    }
  );
  console.log('✓ Missing projectId error handling passed');

  // -------------------------------------------------------------
  // Test 5: Invalid Magic Bytes Rejection
  // -------------------------------------------------------------
  console.log('5. Testing invalid magic bytes rejection on download...');
  const corruptDownloadProvider = {
    ...mockProvider,
    downloadImage: async () => ({
      buffer: Buffer.from('corrupted HTML response <html><body>Error</body></html>'),
      mimeType: 'text/html',
    }),
  };

  await assert.rejects(
    async () => {
      await runFlowApiWorker({
        jobId: 'job_corrupt_dl',
        type: 'image',
        params: { prompt: 'test corrupt' },
      }, storage, {
        provider: corruptDownloadProvider,
        bridge: mockBridge,
      });
    },
    (err) => {
      assert.equal(err.code, 'failed_download');
      assert.equal(err.submitted, true);
      return true;
    }
  );
  console.log('✓ Invalid magic bytes correctly rejected');

  // -------------------------------------------------------------
  // Test 6: Local Asset Resolution & Cross-project Re-upload
  // -------------------------------------------------------------
  console.log('6. Testing local asset resolution & cross-project re-upload...');
  // Create a local image asset in storage under client-1/proj-1
  const assetJobId = 'job_asset_owner_1';
  storage.createJobDir(assetJobId);
  storage.writeOutputFile(assetJobId, 'output_1.png', VALID_PNG_BUFFER);
  storage.writeManifest(assetJobId, {
    jobId: assetJobId,
    type: 'image',
    status: 'completed',
    clientId: 'client-1',
    projectId: 'proj-1',
    outputs: [{
      mediaId: 'media_test_asset_001',
      filename: 'output_1.png',
      mimeType: 'image/png',
      upstreamMediaId: 'upstream-original-id',
    }],
  });

  // Same client & project -> returns existing upstreamMediaId directly
  const sameProjectUpstream = await resolveAssetToUpstream('media_test_asset_001', storage, mockProvider, 'client-1', 'proj-1', false);
  assert.equal(sameProjectUpstream, 'upstream-original-id');

  // Different project -> re-uploads image to new project and returns new mediaId
  const diffProjectUpstream = await resolveAssetToUpstream('media_test_asset_001', storage, mockProvider, 'client-2', 'proj-2', false);
  assert.equal(diffProjectUpstream, 'uploaded-upstream-id-789');

  // Unknown local asset ID -> 404
  await assert.rejects(
    async () => {
      await resolveAssetToUpstream('media_nonexistent_999', storage, mockProvider, 'client-1', 'proj-1', false);
    },
    (err) => {
      assert.equal(err.status, 404);
      assert.equal(err.code, 'ASSET_NOT_FOUND');
      return true;
    }
  );
  console.log('✓ Asset resolution & cross-project re-upload passed');

  // -------------------------------------------------------------
  // Test 7: Parameter Validation & Frames Mode Mapping
  // -------------------------------------------------------------
  console.log('7. Testing parameter validation & frames mode mapping...');
  const t2vParams = validateParams('video', { prompt: 't2v test', mode: 'frames' });
  assert.equal(t2vParams.mode, 't2v');

  const i2vParams = validateParams('video', { prompt: 'i2v test', mode: 'frames', input_assets: ['media_1'] });
  assert.equal(i2vParams.mode, 'i2v');
  assert.equal(i2vParams.startAssetId, 'media_1');

  const firstLastParams = validateParams('video', { prompt: 'first_last test', mode: 'frames', input_assets: ['media_1', 'media_2'] });
  assert.equal(firstLastParams.mode, 'first_last');
  assert.equal(firstLastParams.startAssetId, 'media_1');
  assert.equal(firstLastParams.endAssetId, 'media_2');

  assert.throws(
    () => validateParams('video', { prompt: 'too many frames', mode: 'frames', input_assets: ['m1', 'm2', 'm3'] }),
    (err) => err.status === 400
  );

  const ingParams = validateParams('video', { prompt: 'ingredients test', mode: 'ingredients', input_assets: ['ref_1', 'ref_2'] });
  assert.equal(ingParams.mode, 'reference');
  assert.deepEqual(ingParams.referenceAssetIds, ['ref_1', 'ref_2']);

  // account_id without reliable extension mapping throws unsupported_account_mapping
  assert.throws(
    () => validateParams('video', { prompt: 'account test', account_id: 123 }),
    (err) => err.code === 'unsupported_account_mapping' && err.status === 400
  );
  console.log('✓ Parameter validation & frames mapping passed');

  console.log('\n=== All Flow API Worker Tests Passed Successfully! ===');
} finally {
  try {
    fs.rmSync(testStorageDir, { recursive: true, force: true });
  } catch (_) {}
}
