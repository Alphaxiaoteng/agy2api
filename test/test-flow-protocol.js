/**
 * Unit tests for flowProtocol.js and FlowApiProvider protocol parsing
 */

import assert from 'node:assert/strict';
import {
  IMAGE_MODELS,
  IMAGE_ASPECT_RATIOS,
  VIDEO_ASPECT_RATIOS,
  resolveImageModel,
  resolveImageAspectRatio,
  resolveVideoAspectRatio,
  buildClientContext,
  buildGenerationContext,
  buildImageRequest,
  buildVideoSubmitRequest,
  buildVideoPollRequest,
  parseImageResponse,
  parseSubmittedMediaIds,
  parseVideoPollResponse,
  normalizeUpstreamError,
} from '../src/services/flowProtocol.js';
import { FlowApiProvider } from '../src/services/flowApiProvider.js';

console.log('=== Starting Flow Protocol Tests ===\n');

// 1. Image Model Resolution & Aspect Ratio Mapping
console.log('1. Testing image models and aspect ratios...');
assert.equal(resolveImageModel('flow/gem-pix-2'), 'GEM_PIX_2');
assert.equal(resolveImageModel('flow/harbor-seal'), 'HARBOR_SEAL');
assert.equal(resolveImageModel('flow/narwhal'), 'NARWHAL');
assert.equal(resolveImageModel('gem-pix-2'), 'GEM_PIX_2');
assert.equal(resolveImageModel('nano-banana-pro'), 'GEM_PIX_2');
assert.equal(resolveImageModel('nano-banana-2-lite'), 'HARBOR_SEAL');
assert.equal(resolveImageModel('nano-banana-2'), 'NARWHAL');
assert.equal(resolveImageModel('unknown-model'), 'GEM_PIX_2');

assert.equal(resolveImageAspectRatio('16:9'), 'IMAGE_ASPECT_RATIO_LANDSCAPE');
assert.equal(resolveImageAspectRatio('portrait'), 'IMAGE_ASPECT_RATIO_PORTRAIT');
assert.equal(resolveImageAspectRatio('square'), 'IMAGE_ASPECT_RATIO_SQUARE');
assert.equal(resolveImageAspectRatio('4:3'), 'IMAGE_ASPECT_RATIO_4_3');
assert.equal(resolveImageAspectRatio('3:4'), 'IMAGE_ASPECT_RATIO_3_4');

assert.equal(resolveVideoAspectRatio('16:9'), 'VIDEO_ASPECT_RATIO_LANDSCAPE');
assert.equal(resolveVideoAspectRatio('9:16'), 'VIDEO_ASPECT_RATIO_PORTRAIT');
assert.equal(resolveVideoAspectRatio('portrait'), 'VIDEO_ASPECT_RATIO_PORTRAIT');
console.log('✓ Model and aspect ratio resolution passed');

// 2. Client Context & Generation Context Builders
console.log('2. Testing client and generation context builders...');
assert.throws(() => buildClientContext(''), /projectId is required/);
const ctx = buildClientContext('proj-123', {
  sessionId: ';1234567890',
  recaptchaToken: 'token-abc', // Callers cannot override recaptcha token in node
});
assert.equal(ctx.projectId, 'proj-123');
assert.equal(ctx.tool, 'PINHOLE');
assert.equal(ctx.userPaygateTier, 'PAYGATE_TIER_ONE');
assert.equal(ctx.sessionId, ';1234567890');
assert.equal(ctx.recaptchaContext.token, ''); // Must be hardcoded empty string in Node

const genCtx = buildGenerationContext({ audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' });
assert.ok(genCtx.batchId);
assert.equal(genCtx.audioFailurePreference, 'BLOCK_SILENCED_VIDEOS');
console.log('✓ Context builders passed');

// 3. Image Request Builder
console.log('3. Testing buildImageRequest...');
assert.throws(() => buildImageRequest({ prompt: 'test' }), /projectId is required/);
assert.throws(() => buildImageRequest({ projectId: 'proj-123' }), /prompt is required/);

const imgReq = buildImageRequest({
  projectId: 'test-project-uuid',
  prompt: 'cyberpunk street in rain',
  model: 'flow/harbor-seal',
  aspectRatio: '16:9',
  count: 2,
  seed: 42,
});
assert.equal(imgReq.endpoint, '/v1/projects/test-project-uuid/flowMedia:batchGenerateImages');
assert.equal(imgReq.captchaAction, 'IMAGE_GENERATION');
assert.equal(imgReq.body.requests.length, 2);
assert.equal(imgReq.body.requests[0].imageModelName, 'HARBOR_SEAL');
assert.equal(imgReq.body.requests[0].imageAspectRatio, 'IMAGE_ASPECT_RATIO_LANDSCAPE');
assert.equal(imgReq.body.requests[0].structuredPrompt.parts[0].text, 'cyberpunk street in rain');

// Image request with reference images
const imgReqRef = buildImageRequest({
  projectId: 'test-project-uuid',
  prompt: 'consistent character in space',
  model: 'flow/gem-pix-2',
  refMediaIds: ['ref-id-1', 'ref-id-2'],
});
assert.equal(imgReqRef.body.useNewMedia, true);
assert.ok(imgReqRef.body.mediaGenerationContext);
assert.equal(imgReqRef.body.requests[0].imageInputs.length, 2);
assert.equal(imgReqRef.body.requests[0].imageInputs[0].imageInputType, 'IMAGE_INPUT_TYPE_REFERENCE');
console.log('✓ buildImageRequest passed');

// 4. Video Submit Request Builder for 5 Modes (t2v, i2v, first_last, reference, edit)
console.log('4. Testing buildVideoSubmitRequest (5 modes)...');

// Mode 1: t2v
const t2vReq = buildVideoSubmitRequest({
  projectId: 'proj-123',
  prompt: 'ocean waves slow motion',
  mode: 't2v',
  duration: 8,
  aspectRatio: '16:9',
  count: 1,
});
assert.equal(t2vReq.mode, 't2v');
assert.equal(t2vReq.endpoint, '/v1/video:batchAsyncGenerateVideoText');
assert.equal(t2vReq.body.requests[0].videoModelKey, 'abra_t2v_8s');
assert.equal(t2vReq.body.requests[0].aspectRatio, 'VIDEO_ASPECT_RATIO_LANDSCAPE');

// Mode 2: i2v
const i2vReq = buildVideoSubmitRequest({
  projectId: 'proj-123',
  prompt: 'animate this portrait smiling',
  mode: 'i2v',
  startImageId: 'media-start-image-123',
  duration: 6,
});
assert.equal(i2vReq.mode, 'i2v');
assert.equal(i2vReq.endpoint, '/v1/video:batchAsyncGenerateVideoStartImage');
assert.equal(i2vReq.body.requests[0].startImage.mediaId, 'media-start-image-123');

// Mode 3: first_last
const flReq = buildVideoSubmitRequest({
  projectId: 'proj-123',
  prompt: 'smooth camera pan from mountain to valley',
  mode: 'first_last',
  startImageId: 'media-start-img',
  endImageId: 'media-end-img',
  duration: 10,
});
assert.equal(flReq.mode, 'first_last');
assert.equal(flReq.endpoint, '/v1/video:batchAsyncGenerateVideoStartAndEndImage');
assert.equal(flReq.body.requests[0].startImage.mediaId, 'media-start-img');
assert.equal(flReq.body.requests[0].endImage.mediaId, 'media-end-img');

// Mode 4: reference (r2v)
const refReq = buildVideoSubmitRequest({
  projectId: 'proj-123',
  prompt: 'character dancing in disco',
  mode: 'reference',
  refMediaIds: ['ref-char-1', 'ref-style-2'],
  duration: 8,
});
assert.equal(refReq.mode, 'reference');
assert.equal(refReq.endpoint, '/v1/video:batchAsyncGenerateVideoReferenceImages');
assert.equal(refReq.body.requests[0].referenceImages.length, 2);
assert.equal(refReq.body.requests[0].referenceImages[0].imageUsageType, 'IMAGE_USAGE_TYPE_ASSET');

// Mode 5: edit (v2v)
const editReq = buildVideoSubmitRequest({
  projectId: 'proj-123',
  prompt: 'change style to oil painting',
  mode: 'edit',
  videoMediaId: 'input-video-media-id',
  fps: 24,
  startFrame: 0,
  endFrame: 240,
  refMediaIds: ['style-ref-1'],
});
assert.equal(editReq.mode, 'edit');
assert.equal(editReq.endpoint, '/v1/video:batchAsyncGenerateVideoEditVideo');
assert.equal(editReq.body.requests[0].videoModelKey, 'abra_edit');
assert.equal(editReq.body.requests[0].videoInput.mediaId, 'input-video-media-id');
assert.equal(editReq.body.requests[0].videoInput.endFrameIndex, 240);
assert.equal(editReq.body.requests[0].referenceImages[0].mediaId, 'style-ref-1');
assert.equal(editReq.body.mediaGenerationContext.audioFailurePreference, 'BLOCK_SILENCED_VIDEOS');

console.log('✓ buildVideoSubmitRequest (5 modes) passed');

// 5. Video Poll Request Builder
console.log('5. Testing buildVideoPollRequest...');
assert.throws(() => buildVideoPollRequest([], 'proj-123'), /non-empty array/);
assert.throws(() => buildVideoPollRequest(['m1'], ''), /projectId is required/);
const pollReq = buildVideoPollRequest(['media-1', 'media-2'], 'proj-123');
assert.equal(pollReq.endpoint, '/v1/video:batchCheckAsyncVideoGenerationStatus');
assert.equal(pollReq.body.media.length, 2);
assert.equal(pollReq.body.media[0].name, 'media-1');
assert.equal(pollReq.body.media[0].projectId, 'proj-123');
console.log('✓ buildVideoPollRequest passed');

// 6. Response Parsers (Image, Submitted Media IDs, Poll Status)
console.log('6. Testing response parsers...');

// Image parser
const sampleImgResponse = {
  media: [
    {
      name: 'c87fa135-231a-4d76-b924-d2e825a07c1b',
      image: {
        generatedImage: {
          fifeUrl: 'https://storage.googleapis.com/ai-sandbox-videofx/image/c87fa135-231a-4d76-b924-d2e825a07c1b?sign=123',
        },
      },
    },
    {
      image: {
        generatedImage: {
          imageUri: 'https://storage.googleapis.com/ai-sandbox-videofx/image/550e8400-e29b-41d4-a716-446655440000?sign=456',
        },
      },
    },
  ],
};
const parsedImgs = parseImageResponse(sampleImgResponse);
assert.equal(parsedImgs.length, 2);
assert.equal(parsedImgs[0].upstreamMediaId, 'c87fa135-231a-4d76-b924-d2e825a07c1b');
assert.equal(parsedImgs[0].remoteUrl, 'https://storage.googleapis.com/ai-sandbox-videofx/image/c87fa135-231a-4d76-b924-d2e825a07c1b?sign=123');
assert.equal(parsedImgs[1].upstreamMediaId, '550e8400-e29b-41d4-a716-446655440000');

// Video submit IDs parser
const sampleVidSubmitResponse = {
  media: [
    { name: 'video-media-id-1' },
    { name: 'video-media-id-2' },
  ],
};
const parsedMediaIds = parseSubmittedMediaIds(sampleVidSubmitResponse);
assert.deepEqual(parsedMediaIds, ['video-media-id-1', 'video-media-id-2']);

// Video poll parser (successful)
const samplePollSuccess = {
  media: [
    {
      name: 'video-media-id-1',
      mediaMetadata: {
        mediaStatus: {
          mediaGenerationStatus: 'MEDIA_GENERATION_STATUS_SUCCESSFUL',
        },
      },
    },
  ],
};
const pollSuccessResult = parseVideoPollResponse(samplePollSuccess);
assert.equal(pollSuccessResult.status, 'succeeded');
assert.equal(pollSuccessResult.media[0].isSuccess, true);

// Video poll parser (failed/blocked)
const samplePollFailed = {
  media: [
    {
      name: 'video-media-id-1',
      mediaMetadata: {
        mediaStatus: {
          mediaGenerationStatus: 'MEDIA_GENERATION_STATUS_FAILED_CONTENT_BLOCKED',
        },
      },
    },
  ],
};
const pollFailedResult = parseVideoPollResponse(samplePollFailed);
assert.equal(pollFailedResult.status, 'failed');
assert.equal(pollFailedResult.media[0].isFailed, true);

// Video poll parser (in progress)
const samplePollPending = {
  media: [
    {
      name: 'video-media-id-1',
      mediaMetadata: {
        mediaStatus: {
          mediaGenerationStatus: 'MEDIA_GENERATION_STATUS_PENDING',
        },
      },
    },
  ],
};
const pollPendingResult = parseVideoPollResponse(samplePollPending);
assert.equal(pollPendingResult.status, 'processing');
console.log('✓ Response parsers passed');

// 7. Normalize Upstream Errors
console.log('7. Testing normalizeUpstreamError...');
const errWithDetails = {
  data: {
    error: {
      code: 400,
      message: 'Invalid prompt',
      details: [{ reason: 'PROMPT_FILTERED' }],
    },
  },
};
const normErr = normalizeUpstreamError(errWithDetails);
assert.equal(normErr.message, 'Invalid prompt (PROMPT_FILTERED)');
assert.equal(normErr.code, 400);

const simpleErr = { error: 'TIMEOUT', status: 504 };
const normSimple = normalizeUpstreamError(simpleErr);
assert.equal(normSimple.message, 'TIMEOUT');
assert.equal(normSimple.code, 504);
console.log('✓ normalizeUpstreamError passed');

// 8. Uncertain Submit Error Handling in FlowApiProvider
console.log('8. Testing uncertain submit error handling...');
{
  const mockFailingBridge = {
    clientPool: {
      selectClient: () => 'client-test',
      getClientProjectId: () => 'test-project',
    },
    request: async () => {
      const timeoutErr = new Error('Socket timeout after 120s');
      timeoutErr.code = 'TIMEOUT';
      timeoutErr.dispatched = true;
      throw timeoutErr;
    },
  };

  const provider = new FlowApiProvider({ bridge: mockFailingBridge });

  // Submit video should throw an error with submitted: true, unknown: true
  await assert.rejects(
    async () => {
      await provider.submitVideo({
        projectId: 'test-project',
        prompt: 'test prompt',
        mode: 't2v',
      });
    },
    (err) => {
      assert.equal(err.code, 'SUBMISSION_UNCERTAIN');
      assert.equal(err.submitted, true);
      assert.equal(err.unknown, true);
      return true;
    }
  );

  // Submit image should also throw submitted: true, unknown: true
  await assert.rejects(
    async () => {
      await provider.generateImage({
        projectId: 'test-project',
        prompt: 'test prompt',
      });
    },
    (err) => {
      assert.equal(err.code, 'SUBMISSION_UNCERTAIN');
      assert.equal(err.submitted, true);
      assert.equal(err.unknown, true);
      return true;
    }
  );

  // Read-only operation like getCredits should NOT have submitted: true
  await assert.rejects(
    async () => {
      await provider.getCredits({ projectId: 'test-project' });
    },
    (err) => {
      assert.equal(err.submitted, undefined);
      assert.equal(err.unknown, undefined);
      return true;
    }
  );
}
console.log('✓ Uncertain submit error handling passed');

console.log('\n=== All Flow Protocol Tests Passed Successfully! ===');
