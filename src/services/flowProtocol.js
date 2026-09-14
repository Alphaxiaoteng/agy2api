/**
 * Google Flow Private API Protocol Definitions & Message Builders
 *
 * Implements Google Flow protocol helpers, mappings, request builders,
 * and response parsers. No user secrets, project IDs, tokens, or cookies are hardcoded.
 */

import crypto from 'crypto';

// Standard UUID matcher
export const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// Image Model Mapping: public names -> Google internal model keys
// Supports flow/gem-pix-2, flow/harbor-seal, flow/narwhal and legacy aliases
export const IMAGE_MODELS = {
  'flow/gem-pix-2': 'GEM_PIX_2',
  'gem-pix-2': 'GEM_PIX_2',
  'gem_pix_2': 'GEM_PIX_2',
  'pro': 'GEM_PIX_2',
  'nano-banana-pro': 'GEM_PIX_2',

  'flow/harbor-seal': 'HARBOR_SEAL',
  'harbor-seal': 'HARBOR_SEAL',
  'harbor_seal': 'HARBOR_SEAL',
  'lite': 'HARBOR_SEAL',
  'nano-banana-2-lite': 'HARBOR_SEAL',
  'nano-banana-lite': 'HARBOR_SEAL',

  'flow/narwhal': 'NARWHAL',
  'narwhal': 'NARWHAL',
  'standard': 'NARWHAL',
  'nano-banana-2': 'NARWHAL',
  'nano-banana': 'NARWHAL',
};

export const DEFAULT_IMAGE_MODEL = 'GEM_PIX_2';

// Image Aspect Ratio Mapping
export const IMAGE_ASPECT_RATIOS = {
  '16:9': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
  'landscape': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
  '4:3': 'IMAGE_ASPECT_RATIO_4_3',
  '4x3': 'IMAGE_ASPECT_RATIO_4_3',
  '1:1': 'IMAGE_ASPECT_RATIO_SQUARE',
  'square': 'IMAGE_ASPECT_RATIO_SQUARE',
  '3:4': 'IMAGE_ASPECT_RATIO_3_4',
  '3x4': 'IMAGE_ASPECT_RATIO_3_4',
  '9:16': 'IMAGE_ASPECT_RATIO_PORTRAIT',
  'portrait': 'IMAGE_ASPECT_RATIO_PORTRAIT',
};

// Video Aspect Ratio Mapping
export const VIDEO_ASPECT_RATIOS = {
  '16:9': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
  'landscape': 'VIDEO_ASPECT_RATIO_LANDSCAPE',
  '9:16': 'VIDEO_ASPECT_RATIO_PORTRAIT',
  'portrait': 'VIDEO_ASPECT_RATIO_PORTRAIT',
};

// Supported Video Durations
export const SUPPORTED_VIDEO_DURATIONS = [4, 6, 8, 10];
export const DEFAULT_VIDEO_DURATION = 10;

/**
 * Resolve an image model alias to internal model key
 * @param {string} [name]
 * @returns {string}
 */
export function resolveImageModel(name) {
  if (!name || typeof name !== 'string') return DEFAULT_IMAGE_MODEL;
  const key = name.trim().toLowerCase();
  return IMAGE_MODELS[key] || DEFAULT_IMAGE_MODEL;
}

/**
 * Resolve image aspect ratio
 * @param {string} [aspect]
 * @returns {string}
 */
export function resolveImageAspectRatio(aspect) {
  if (!aspect || typeof aspect !== 'string') return 'IMAGE_ASPECT_RATIO_LANDSCAPE';
  const key = aspect.trim().toLowerCase();
  return IMAGE_ASPECT_RATIOS[key] || IMAGE_ASPECT_RATIOS['16:9'];
}

/**
 * Resolve video aspect ratio
 * @param {string} [aspect]
 * @returns {string}
 */
export function resolveVideoAspectRatio(aspect) {
  if (!aspect || typeof aspect !== 'string') return 'VIDEO_ASPECT_RATIO_LANDSCAPE';
  const key = aspect.trim().toLowerCase();
  return VIDEO_ASPECT_RATIOS[key] || VIDEO_ASPECT_RATIOS['16:9'];
}

/**
 * Build clientContext dictionary required by Google Flow backend.
 * NOTE: recaptcha_token is ALWAYS hardcoded to empty string in Node payload construction.
 * Caller injection of token is strictly disallowed (recaptcha token is handled by browser extension).
 * @param {string} projectId
 * @param {object} [options]
 * @returns {object}
 */
export function buildClientContext(projectId, options = {}) {
  if (!projectId || typeof projectId !== 'string') {
    throw new Error('projectId is required for buildClientContext');
  }
  return {
    projectId,
    tool: options.tool || 'PINHOLE',
    userPaygateTier: options.userPaygateTier || 'PAYGATE_TIER_ONE',
    sessionId: options.sessionId || `;${Date.now()}`,
    recaptchaContext: {
      applicationType: options.applicationType || 'RECAPTCHA_APPLICATION_TYPE_WEB',
      token: '', // Always empty string in Node buildClientContext
    },
  };
}

/**
 * Build mediaGenerationContext dictionary
 * @param {object} [options]
 * @returns {object}
 */
export function buildGenerationContext(options = {}) {
  const ctx = {
    batchId: options.batchId || crypto.randomUUID(),
  };
  if (options.audioFailurePreference) {
    ctx.audioFailurePreference = options.audioFailurePreference;
  }
  return ctx;
}

/**
 * Build image generation request
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.prompt
 * @param {string} [params.model]
 * @param {string} [params.aspectRatio]
 * @param {number} [params.count=1]
 * @param {string[]} [params.refMediaIds]
 * @param {number} [params.seed]
 * @returns {{ endpoint: string, body: object, captchaAction: string }}
 */
export function buildImageRequest(params = {}) {
  const {
    projectId,
    prompt,
    model,
    aspectRatio,
    count = 1,
    refMediaIds = [],
    seed,
  } = params;

  if (!projectId) throw new Error('projectId is required for buildImageRequest');
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('prompt is required for buildImageRequest');
  }

  const safeCount = Math.max(1, Math.min(4, Number(count) || 1));
  const targetModel = resolveImageModel(model);
  const targetAspect = resolveImageAspectRatio(aspectRatio);
  const baseSeed = Number.isInteger(seed) ? seed : Date.now() % 1000000;

  const requests = [];
  for (let i = 0; i < safeCount; i++) {
    const reqItem = {
      clientContext: buildClientContext(projectId),
      seed: (baseSeed + i * 1000) % 1000000,
      structuredPrompt: {
        parts: [{ text: prompt.trim() }],
      },
      imageAspectRatio: targetAspect,
      imageModelName: targetModel,
    };

    if (Array.isArray(refMediaIds) && refMediaIds.length > 0) {
      reqItem.imageInputs = refMediaIds.map(mid => ({
        name: mid,
        imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE',
      }));
    }

    requests.push(reqItem);
  }

  const body = {
    clientContext: buildClientContext(projectId),
    requests,
  };

  if (Array.isArray(refMediaIds) && refMediaIds.length > 0) {
    body.mediaGenerationContext = buildGenerationContext();
    body.useNewMedia = true;
  }

  return {
    endpoint: `/v1/projects/${projectId}/flowMedia:batchGenerateImages`,
    body,
    captchaAction: 'IMAGE_GENERATION',
  };
}

/**
 * Build video submit request supporting:
 * - t2v (Text to Video)
 * - i2v (Start image to Video)
 * - first_last (Start & End image to Video)
 * - reference / r2v (Reference images Video)
 * - edit / v2v (Video to Video edit)
 *
 * @param {object} params
 * @returns {{ endpoint: string, body: object, captchaAction: string, mode: string }}
 */
export function buildVideoSubmitRequest(params = {}) {
  const {
    projectId,
    prompt,
    mode = 't2v',
    aspectRatio,
    duration = DEFAULT_VIDEO_DURATION,
    count = 1,
    startImageId,
    endImageId,
    refMediaIds,
    videoMediaId,
    fps = 24,
    startFrame = 0,
    endFrame,
    seed,
  } = params;

  if (!projectId) throw new Error('projectId is required for buildVideoSubmitRequest');
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('prompt is required for buildVideoSubmitRequest');
  }

  const safeCount = Math.max(1, Math.min(4, Number(count) || 1));
  const safeDuration = SUPPORTED_VIDEO_DURATIONS.includes(Number(duration))
    ? Number(duration)
    : DEFAULT_VIDEO_DURATION;
  const targetAspect = resolveVideoAspectRatio(aspectRatio);
  const modelKey = `abra_t2v_${safeDuration}s`;
  const baseSeed = Number.isInteger(seed) ? seed : Math.floor(Math.random() * 9000) + 1000;

  const normalizedMode = String(mode).toLowerCase();

  switch (normalizedMode) {
    case 't2v':
    case 'text_to_video': {
      const requests = [];
      for (let i = 0; i < safeCount; i++) {
        requests.push({
          aspectRatio: targetAspect,
          textInput: { structuredPrompt: { parts: [{ text: prompt.trim() }] } },
          videoModelKey: modelKey,
          seed: (baseSeed + i) % 10000,
          metadata: {},
        });
      }
      return {
        mode: 't2v',
        endpoint: '/v1/video:batchAsyncGenerateVideoText',
        body: {
          mediaGenerationContext: buildGenerationContext(),
          clientContext: buildClientContext(projectId),
          requests,
          useV2ModelConfig: true,
        },
        captchaAction: 'VIDEO_GENERATION',
      };
    }

    case 'i2v':
    case 'image_to_video': {
      if (!startImageId) throw new Error('startImageId is required for i2v mode');
      const requests = [];
      for (let i = 0; i < safeCount; i++) {
        requests.push({
          aspectRatio: targetAspect,
          textInput: { structuredPrompt: { parts: [{ text: prompt.trim() }] } },
          videoModelKey: modelKey,
          seed: (baseSeed + i) % 10000,
          metadata: {},
          startImage: { mediaId: startImageId },
        });
      }
      return {
        mode: 'i2v',
        endpoint: '/v1/video:batchAsyncGenerateVideoStartImage',
        body: {
          mediaGenerationContext: buildGenerationContext(),
          clientContext: buildClientContext(projectId),
          requests,
        },
        captchaAction: 'VIDEO_GENERATION',
      };
    }

    case 'first_last':
    case 'fl':
    case 'start_end': {
      if (!startImageId) throw new Error('startImageId is required for first_last mode');
      if (!endImageId) throw new Error('endImageId is required for first_last mode');
      const requests = [];
      for (let i = 0; i < safeCount; i++) {
        requests.push({
          aspectRatio: targetAspect,
          textInput: { structuredPrompt: { parts: [{ text: prompt.trim() }] } },
          videoModelKey: modelKey,
          seed: (baseSeed + i) % 10000,
          metadata: {},
          startImage: { mediaId: startImageId },
          endImage: { mediaId: endImageId },
        });
      }
      return {
        mode: 'first_last',
        endpoint: '/v1/video:batchAsyncGenerateVideoStartAndEndImage',
        body: {
          mediaGenerationContext: buildGenerationContext(),
          clientContext: buildClientContext(projectId),
          requests,
          useV2ModelConfig: true,
        },
        captchaAction: 'VIDEO_GENERATION',
      };
    }

    case 'reference':
    case 'r2v': {
      if (!Array.isArray(refMediaIds) || refMediaIds.length === 0) {
        throw new Error('refMediaIds array is required for reference mode');
      }
      const refImages = refMediaIds.map(mid => ({
        mediaId: mid,
        imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
      }));
      const requests = [];
      for (let i = 0; i < safeCount; i++) {
        requests.push({
          aspectRatio: targetAspect,
          textInput: { structuredPrompt: { parts: [{ text: prompt.trim() }] } },
          videoModelKey: modelKey,
          seed: (baseSeed + i) % 10000,
          metadata: {},
          referenceImages: refImages,
        });
      }
      return {
        mode: 'reference',
        endpoint: '/v1/video:batchAsyncGenerateVideoReferenceImages',
        body: {
          mediaGenerationContext: buildGenerationContext(),
          clientContext: buildClientContext(projectId),
          requests,
          useV2ModelConfig: true,
        },
        captchaAction: 'VIDEO_GENERATION',
      };
    }

    case 'edit':
    case 'v2v': {
      if (!videoMediaId) throw new Error('videoMediaId is required for edit mode');
      const actualEndFrame = endFrame !== undefined ? Number(endFrame) : (Number(fps) || 24) * safeDuration;
      const refImages = (Array.isArray(refMediaIds) && refMediaIds.length > 0)
        ? refMediaIds.map(mid => ({ mediaId: mid, imageUsageType: 'IMAGE_USAGE_TYPE_ASSET' }))
        : null;

      const reqItem = {
        aspectRatio: targetAspect,
        textInput: { structuredPrompt: { parts: [{ text: prompt.trim() }] } },
        videoModelKey: 'abra_edit',
        seed: baseSeed % 10000,
        metadata: {},
        videoInput: {
          mediaId: videoMediaId,
          startFrameIndex: Number(startFrame) || 0,
          endFrameIndex: actualEndFrame,
        },
      };
      if (refImages) {
        reqItem.referenceImages = refImages;
      }

      return {
        mode: 'edit',
        endpoint: '/v1/video:batchAsyncGenerateVideoEditVideo',
        body: {
          mediaGenerationContext: buildGenerationContext({ audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' }),
          clientContext: buildClientContext(projectId),
          requests: [reqItem],
        },
        captchaAction: 'VIDEO_GENERATION',
      };
    }

    default:
      throw new Error(`Unsupported video submit mode: ${mode}`);
  }
}

/**
 * Build poll request body for batchCheckAsyncVideoGenerationStatus
 * @param {string[]} mediaIds
 * @param {string} projectId
 * @returns {{ endpoint: string, body: object, captchaAction: string }}
 */
export function buildVideoPollRequest(mediaIds, projectId) {
  if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
    throw new Error('mediaIds must be a non-empty array');
  }
  if (!projectId) {
    throw new Error('projectId is required for buildVideoPollRequest');
  }

  return {
    endpoint: '/v1/video:batchCheckAsyncVideoGenerationStatus',
    body: {
      media: mediaIds.map(name => ({ name, projectId })),
    },
    captchaAction: '',
  };
}

/**
 * Parse image response from batchGenerateImages
 * @param {object} responseData
 * @returns {Array<{ upstreamMediaId: string, remoteUrl: string, model?: string }>}
 */
export function parseImageResponse(responseData) {
  if (!responseData || typeof responseData !== 'object') return [];
  const mediaList = Array.isArray(responseData.media) ? responseData.media : [];
  const results = [];

  for (const item of mediaList) {
    let upstreamMediaId = '';
    let remoteUrl = '';

    const name = item?.name || '';
    if (typeof name === 'string' && UUID_RE.test(name)) {
      upstreamMediaId = name;
    }

    const gen = item?.image?.generatedImage || {};
    const url = gen.fifeUrl || gen.imageUri || '';
    if (typeof url === 'string' && url.trim()) {
      remoteUrl = url.trim();
      if (!upstreamMediaId) {
        const match = remoteUrl.match(UUID_RE);
        if (match) upstreamMediaId = match[0];
      }
    }

    if (upstreamMediaId || remoteUrl) {
      results.push({
        upstreamMediaId,
        remoteUrl,
      });
    }
  }

  return results;
}

/**
 * Parse submitted video media IDs from submit response
 * @param {object} responseData
 * @returns {string[]}
 */
export function parseSubmittedMediaIds(responseData) {
  if (!responseData || typeof responseData !== 'object') return [];
  const mediaList = Array.isArray(responseData.media) ? responseData.media : [];
  const mediaIds = [];

  for (const m of mediaList) {
    const name = m?.name || '';
    if (typeof name === 'string' && name.trim()) {
      mediaIds.push(name.trim());
    }
  }

  return mediaIds;
}

/**
 * Parse video poll response
 * @param {object} responseData
 * @returns {{
 *   status: 'succeeded' | 'failed' | 'processing',
 *   media: Array<{ mediaId: string, status: string, isSuccess: boolean, isFailed: boolean, raw: object }>
 * }}
 */
export function parseVideoPollResponse(responseData) {
  if (!responseData || typeof responseData !== 'object') {
    return { status: 'processing', media: [] };
  }

  const mediaList = Array.isArray(responseData.media) ? responseData.media : [];
  if (mediaList.length === 0) {
    return { status: 'processing', media: [] };
  }

  const parsedMedia = [];
  let allSucceeded = true;
  let anyFailed = false;

  for (const item of mediaList) {
    const mediaId = item?.name || '';
    const meta = item?.mediaMetadata?.mediaStatus || {};
    const genStatus = meta.mediaGenerationStatus || '';

    const isSuccess = genStatus === 'MEDIA_GENERATION_STATUS_SUCCESSFUL';
    const isFailed = genStatus.includes('FAILED') || genStatus.includes('BLOCKED');

    if (!isSuccess) allSucceeded = false;
    if (isFailed) anyFailed = true;

    parsedMedia.push({
      mediaId,
      status: genStatus,
      isSuccess,
      isFailed,
      raw: item,
    });
  }

  let overallStatus = 'processing';
  if (anyFailed) {
    overallStatus = 'failed';
  } else if (allSucceeded && parsedMedia.length > 0) {
    overallStatus = 'succeeded';
  }

  return {
    status: overallStatus,
    media: parsedMedia,
  };
}

/**
 * Normalize upstream errors into a standard structure
 * @param {any} result
 * @returns {{ message: string, code: number|string, reason?: string, raw?: any }}
 */
export function normalizeUpstreamError(result) {
  if (!result) {
    return { message: 'Unknown error', code: 'UNKNOWN' };
  }

  if (result.error && typeof result.error === 'string') {
    return {
      message: result.error,
      code: result.status || 'ERROR',
      raw: result,
    };
  }

  const data = result.data || result;
  if (typeof data === 'object' && data.error) {
    const errObj = data.error;
    const msg = errObj.message || 'Upstream error';
    const code = errObj.code || result.status || 'UPSTREAM_ERROR';
    let reason = '';
    if (Array.isArray(errObj.details)) {
      for (const d of errObj.details) {
        if (d && typeof d === 'object' && d.reason) {
          reason = d.reason;
          break;
        }
      }
    }
    return {
      message: reason ? `${msg} (${reason})` : msg,
      code,
      reason: reason || undefined,
      raw: result,
    };
  }

  return {
    message: typeof result === 'string' ? result : JSON.stringify(result),
    code: result.status || 500,
    raw: result,
  };
}
