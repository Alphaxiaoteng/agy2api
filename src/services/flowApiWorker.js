/**
 * Flow API Worker
 *
 * Coordinates execution of image and video generation tasks using FlowApiProvider and FlowExtensionBridge.
 * Follows the workerRunner contract for FlowQueue:
 * async (job, storage) => manifest
 *
 * Operations supported:
 * 1. Image generation:
 *    - Calls flowApiProvider.generateImage
 *    - Downloads returned images via bridge (downloadImage) and writes to disk via FlowStorage
 *    - Creates outputs with mediaId, filename, mimeType, sizeBytes
 * 2. Video generation:
 *    - Submits video request via flowApiProvider.submitVideo
 *    - Marks job.submittedToBrowser = true immediately upon successful submit (to protect against duplicate submits)
 *    - Polls status via flowApiProvider.pollVideo until succeeded / failed or timeout
 *    - Downloads generated video via bridge (downloadVideo) and writes to disk via FlowStorage
 *    - Produces manifest with output media items
 */

import flowApiProvider from './flowApiProvider.js';
import flowExtensionBridge from './flowExtensionBridge.js';
import logger from '../utils/logger.js';

export const DEFAULT_POLL_INTERVAL_MS = 3000;
export const DEFAULT_POLL_TIMEOUT_MS = 300000; // 5 minutes

import fs from 'fs';

/**
 * Resolve an asset ID (either opaque media_xxx or upstream ID) into an upstream media ID.
 * If media is local and project/client differs, re-upload image asset using provider.uploadImage.
 *
 * @param {string} assetId
 * @param {object} storage
 * @param {object} provider
 * @param {string} currentClientId
 * @param {string} currentProjectId
 * @param {boolean} [isVideo=false]
 * @returns {Promise<string>} upstreamMediaId
 */
export async function resolveAssetToUpstream(assetId, storage, provider, currentClientId, currentProjectId, isVideo = false) {
  if (!assetId || typeof assetId !== 'string') {
    throw new Error(`Invalid asset ID: ${assetId}`);
  }

  // Check if it is a local opaque media_xxx ID
  if (assetId.startsWith('media_')) {
    const resolved = storage.resolveMedia(assetId);
    if (!resolved) {
      const err = new Error(`Local asset '${assetId}' not found`);
      err.status = 404;
      err.code = 'ASSET_NOT_FOUND';
      throw err;
    }

    // Same client & project and has upstreamMediaId?
    if (resolved.projectId === currentProjectId && resolved.clientId === currentClientId && resolved.upstreamMediaId) {
      return resolved.upstreamMediaId;
    }

    // If it's a video asset and not in the same project/client
    if (isVideo) {
      const err = new Error(`Cross-project or missing upstream video asset '${assetId}' cannot be re-uploaded (video upload is unsupported)`);
      err.status = 400;
      err.code = 'UNSUPPORTED_CROSS_PROJECT_VIDEO_ASSET';
      throw err;
    }

    // For images: re-upload from local disk file
    if (!fs.existsSync(resolved.absolutePath)) {
      const err = new Error(`Local file for asset '${assetId}' is missing on disk`);
      err.status = 404;
      err.code = 'ASSET_FILE_MISSING';
      throw err;
    }

    const fileBuffer = fs.readFileSync(resolved.absolutePath);
    const uploadRes = await provider.uploadImage({
      projectId: currentProjectId,
      imageBase64OrBuffer: fileBuffer,
      mimeType: resolved.mimeType || 'image/png',
    }, { clientId: currentClientId });

    return uploadRes.mediaId;
  }

  // Already an upstream ID
  return assetId;
}

/**
 * Detect image/video MIME type and extension from buffer magic bytes
 * @param {Buffer} buffer
 * @returns {{ mimeType: string, ext: string } | null}
 */
export function detectMediaFormat(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 4) {
    return null;
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
      buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) {
    return { mimeType: 'image/png', ext: 'png' };
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return { mimeType: 'image/jpeg', ext: 'jpg' };
  }

  // GIF: 47 49 46 38 ('GIF8')
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
    return { mimeType: 'image/gif', ext: 'gif' };
  }

  // WebP: 52 49 46 46 ... 57 45 42 50 ('RIFF....WEBP')
  if (buffer.length >= 12 &&
      buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
    return { mimeType: 'image/webp', ext: 'webp' };
  }

  // MP4 / QuickTime: bytes 4-8 is 'ftyp' (66 74 79 70) or 'moov' (6D 6F 6F 76) or 'mdat' (6D 64 61 74)
  if (buffer.length >= 12) {
    const brand = buffer.toString('ascii', 4, 8);
    if (brand === 'ftyp' || brand === 'moov' || brand === 'mdat') {
      const subBrand = buffer.toString('ascii', 8, 12);
      if (subBrand === 'qt  ') {
        return { mimeType: 'video/quicktime', ext: 'mov' };
      }
      return { mimeType: 'video/mp4', ext: 'mp4' };
    }
  }

  return null;
}

/**
 * Execute a generation job using Flow API Worker
 *
 * @param {object} job
 * @param {object} storage - FlowStorage instance
 * @param {object} [options]
 * @param {object} [options.provider]
 * @param {object} [options.bridge]
 * @param {number} [options.pollIntervalMs]
 * @param {number} [options.pollTimeoutMs]
 * @returns {Promise<object>} - Manifest object
 */
export async function runFlowApiWorker(job, storage, options = {}) {
  const provider = options.provider || flowApiProvider;
  const bridge = options.bridge || flowExtensionBridge;
  const pollIntervalMs = options.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs || DEFAULT_POLL_TIMEOUT_MS;

  const { jobId, type, params } = job;
  const targetDir = storage.createJobDir(jobId);

  // Determine client / project & estimate required credits
  const preferredClientId = params.clientId || params.preferredClientId;
  const preferredAccountLabel = params.accountLabel;
  const strictPreferred = Boolean(preferredClientId || preferredAccountLabel);
  const estimatedCost = params.estimatedCost !== undefined ? params.estimatedCost : 0;

  const targetClientId = bridge.clientPool.selectClient({
    preferredClientId,
    preferredAccountLabel,
    strictPreferred,
    minCredits: estimatedCost,
  });

  if (!targetClientId) {
    const err = new Error(preferredClientId || preferredAccountLabel
      ? `Extension client '${preferredClientId || preferredAccountLabel}' is not available or has insufficient credits (requires ${estimatedCost})` 
      : `No available connected extension clients with sufficient credits to process Flow job (requires ${estimatedCost})`);
    err.status = 503;
    err.code = 'NO_EXTENSION_CLIENTS';
    throw err;
  }

  // Reserve credits if pool supports it
  let reservationId = null;
  if (typeof bridge.clientPool.reserveCredits === 'function' && estimatedCost > 0) {
    reservationId = bridge.clientPool.reserveCredits(targetClientId, estimatedCost);
    if (!reservationId) {
      const err = new Error(`Failed to reserve ${estimatedCost} credits on client '${targetClientId}'`);
      err.status = 503;
      err.code = 'INSUFFICIENT_CREDITS';
      throw err;
    }
  }

  // Get project ID from client pool if not explicitly in params
  const projectId = params.projectId || bridge.clientPool.getClientProjectId(targetClientId);
  if (!projectId) {
    if (reservationId && typeof bridge.clientPool.releaseReservation === 'function') {
      bridge.clientPool.releaseReservation(reservationId);
    }
    const err = new Error(`Extension client '${targetClientId}' has no active Google Flow projectId`);
    err.status = 503;
    err.code = 'NO_PROJECT_ID';
    throw err;
  }

  // Retrieve client profile metadata for pinning
  const clientInfo = bridge.clientPool.getClient ? bridge.clientPool.getClient(targetClientId) : null;
  const profileHint = clientInfo?.profileHint || null;
  const accountLabel = clientInfo?.accountLabel || null;

  // Pin clientId, projectId, and profileHint to job object for tracking & recovery
  job.clientId = targetClientId;
  job.projectId = projectId;
  job.profileHint = profileHint;
  job.accountLabel = accountLabel;
  job.estimatedCost = estimatedCost;

  logger.info(`[FlowApiWorker] Processing job ${jobId} (type=${type}, model=${params.model}, client=${targetClientId}, profileHint=${profileHint || 'none'}, cost=${estimatedCost})`);

  try {
    if (type === 'image') {
      return await handleImageGeneration({
        job,
        storage,
        targetDir,
        provider,
        clientId: targetClientId,
        projectId,
      });
    } else if (type === 'video') {
      return await handleVideoGeneration({
        job,
        storage,
        targetDir,
        provider,
        clientId: targetClientId,
        projectId,
        pollIntervalMs,
        pollTimeoutMs,
      });
    } else {
      const err = new Error(`Unsupported job type '${type}'`);
      err.status = 400;
      err.code = 'UNSUPPORTED_JOB_TYPE';
      throw err;
    }
  } finally {
    // Release reserved credits upon completion or failure
    if (reservationId && typeof bridge.clientPool.releaseReservation === 'function') {
      bridge.clientPool.releaseReservation(reservationId);
    }
  }
}

/**
 * Handle Image Generation
 */
async function handleImageGeneration({ job, storage, targetDir, provider, clientId, projectId }) {
  const { jobId, type, params } = job;

  // Resolve reference images if any
  let resolvedRefMediaIds = [];
  const rawRefs = params.referenceAssetIds || params.refMediaIds || params.inputAssetIds || [];
  if (Array.isArray(rawRefs) && rawRefs.length > 0) {
    for (const refId of rawRefs) {
      const upId = await resolveAssetToUpstream(refId, storage, provider, clientId, projectId, false);
      resolvedRefMediaIds.push(upId);
    }
  }

  // Build params
  const genParams = {
    projectId,
    prompt: params.prompt,
    model: params.model,
    aspectRatio: params.aspect || params.aspectRatio,
    count: params.count || params.n || 1,
    refMediaIds: resolvedRefMediaIds.length > 0 ? resolvedRefMediaIds : undefined,
    seed: params.seed,
  };

  const genResult = await provider.generateImage(genParams, {
    clientId,
    meta: { jobId, type: 'image' },
  });

  // Mark submit done
  job.submittedToBrowser = true;
  job.upstreamResponse = genResult.raw;
  const upstreamMediaIds = (genResult.images || []).map(img => img.upstreamMediaId).filter(Boolean);
  job.upstreamMediaIds = upstreamMediaIds;

  // CRITICAL: Once upstream returns generated images, write intermediate 'submitted' manifest immediately
  storage.writeManifest(jobId, {
    jobId,
    type,
    status: 'submitted',
    params,
    clientId,
    projectId,
    profileHint: job.profileHint || null,
    accountLabel: job.accountLabel || null,
    estimatedCost: job.estimatedCost || 0,
    upstreamMediaIds,
    idempotencyKeyHash: job.idempotencyKeyHash || null,
    requestHash: job.requestHash || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    submittedAt: new Date().toISOString(),
    outputs: [],
  });

  const outputs = [];
  const images = genResult.images || [];

  for (let i = 0; i < images.length; i++) {
    const imgInfo = images[i];
    let buffer = null;
    let mimeType = 'image/png';
    let ext = 'png';

    try {
      const dlResult = await provider.downloadImage({
        mediaId: imgInfo.upstreamMediaId,
        url: imgInfo.remoteUrl,
        projectId,
      }, { clientId });
      buffer = dlResult.buffer;
      mimeType = dlResult.mimeType || 'image/png';
    } catch (dlErr) {
      logger.error(`[FlowApiWorker] Failed to download image via bridge for ${jobId} output ${i + 1}: ${dlErr.message}`);
      const failDlErr = new Error(`Failed to download generated image for ${jobId}: ${dlErr.message}`);
      failDlErr.code = 'failed_download';
      failDlErr.submitted = true;
      failDlErr.status = 502;
      throw failDlErr;
    }

    if (!buffer || buffer.length === 0) {
      const emptyErr = new Error(`Downloaded empty image buffer for ${jobId} output ${i + 1}`);
      emptyErr.code = 'failed_download';
      emptyErr.submitted = true;
      emptyErr.status = 502;
      throw emptyErr;
    }

    const detected = detectMediaFormat(buffer);
    if (!detected || !detected.mimeType.startsWith('image/')) {
      const invalidErr = new Error(`Downloaded invalid image format (magic bytes mismatch) for ${jobId} output ${i + 1}`);
      invalidErr.code = 'failed_download';
      invalidErr.submitted = true;
      invalidErr.status = 502;
      throw invalidErr;
    }

    mimeType = detected.mimeType;
    ext = detected.ext;
    const filename = `output_${i + 1}.${ext}`;
    const mediaId = storage.generateMediaId(jobId, i, ext);

    storage.writeOutputFile(jobId, filename, buffer);

    // Archive output copy to /output/flow/YYYY-MM-DD/{image|video}/
    let archiveInfo = null;
    if (typeof storage.archiveOutput === 'function') {
      archiveInfo = storage.archiveOutput({
        jobId,
        type: 'image',
        filename,
        data: buffer,
        slugParams: {
          prompt: params.prompt,
          model: params.model,
          aspect: params.aspect || params.aspectRatio,
          duration: 'static',
          shortId: mediaId
        }
      });
    }

    // Note: NEVER persist signed remoteUrl to manifest
    outputs.push({
      mediaId,
      filename,
      mimeType,
      sizeBytes: buffer.length,
      upstreamMediaId: imgInfo.upstreamMediaId,
      model: imgInfo.model,
      archivePath: archiveInfo?.archivePath || null,
      slug: archiveInfo?.slug || null,
    });
  }

  const manifest = {
    jobId,
    type,
    status: 'completed',
    params,
    clientId,
    projectId,
    profileHint: job.profileHint || null,
    accountLabel: job.accountLabel || null,
    estimatedCost: job.estimatedCost || 0,
    upstreamMediaIds: (genResult.images || []).map(img => img.upstreamMediaId).filter(Boolean),
    idempotencyKeyHash: job.idempotencyKeyHash || null,
    requestHash: job.requestHash || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: new Date().toISOString(),
    outputs,
    remainingCredits: genResult.remainingCredits,
  };

  storage.writeManifest(jobId, manifest);
  return manifest;
}

/**
 * Handle Video Generation
 */
async function handleVideoGeneration({
  job,
  storage,
  targetDir,
  provider,
  clientId,
  projectId,
  pollIntervalMs,
  pollTimeoutMs,
}) {
  const { jobId, type, params } = job;

  // Resolve assets
  let startImageId = params.startImageId || params.startAssetId;
  let endImageId = params.endImageId || params.endAssetId;
  let videoMediaId = params.videoMediaId || params.sourceVideoAssetId;
  let refMediaIds = params.refMediaIds || params.referenceAssetIds || params.inputAssetIds || [];

  if (startImageId) {
    startImageId = await resolveAssetToUpstream(startImageId, storage, provider, clientId, projectId, false);
  }
  if (endImageId) {
    endImageId = await resolveAssetToUpstream(endImageId, storage, provider, clientId, projectId, false);
  }
  if (videoMediaId) {
    videoMediaId = await resolveAssetToUpstream(videoMediaId, storage, provider, clientId, projectId, true);
  }
  if (Array.isArray(refMediaIds) && refMediaIds.length > 0) {
    const resolvedRefs = [];
    for (const rId of refMediaIds) {
      const upId = await resolveAssetToUpstream(rId, storage, provider, clientId, projectId, false);
      resolvedRefs.push(upId);
    }
    refMediaIds = resolvedRefs;
  }

  // Build params
  const submitParams = {
    projectId,
    prompt: params.prompt,
    mode: params.mode || 't2v',
    aspectRatio: params.aspect || params.aspectRatio,
    duration: params.duration,
    count: params.count || params.n || 1,
    startImageId,
    endImageId,
    refMediaIds: refMediaIds.length > 0 ? refMediaIds : undefined,
    videoMediaId,
    fps: params.fps,
    startFrame: params.startFrame,
    endFrame: params.endFrame,
    seed: params.seed,
  };

  const submitResult = await provider.submitVideo(submitParams, {
    clientId,
    meta: { jobId, type: 'video' },
  });

  // CRITICAL: Once submit succeeds, mark submittedToBrowser = true so recovery never resubmits
  job.submittedToBrowser = true;
  job.upstreamMediaIds = submitResult.mediaIds;
  job.upstreamResponse = submitResult.raw;

  // Write intermediate status manifest
  storage.writeManifest(jobId, {
    jobId,
    type,
    status: 'submitted',
    params,
    clientId,
    projectId,
    profileHint: job.profileHint || null,
    accountLabel: job.accountLabel || null,
    estimatedCost: job.estimatedCost || 0,
    upstreamMediaIds: submitResult.mediaIds,
    idempotencyKeyHash: job.idempotencyKeyHash || null,
    requestHash: job.requestHash || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    submittedAt: new Date().toISOString(),
    outputs: [],
  });

  const mediaIds = submitResult.mediaIds;
  logger.info(`[FlowApiWorker] Video submitted for job ${jobId}, mediaIds: ${JSON.stringify(mediaIds)}, starting poll...`);

  // Poll until completion or timeout
  const startTime = Date.now();
  let pollStatus = 'processing';
  let pollResult = null;

  while (Date.now() - startTime < pollTimeoutMs) {
    // Check if job was aborted
    if (job.signal && job.signal.aborted) {
      const abortErr = new Error('Job aborted by client during polling');
      abortErr.code = 'JOB_ABORTED';
      abortErr.submitted = true;
      throw abortErr;
    }

    try {
      pollResult = await provider.pollVideo({ mediaIds, projectId }, { clientId });
      pollStatus = pollResult.status;

      if (pollStatus === 'succeeded' || pollStatus === 'failed') {
        break;
      }
    } catch (pollErr) {
      logger.warn(`[FlowApiWorker] Poll error for ${jobId}: ${pollErr.message}`);
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  if (pollStatus === 'processing') {
    const timeoutErr = new Error(`Video generation timed out while polling after ${pollTimeoutMs}ms`);
    timeoutErr.code = 'flow_timeout_after_submit';
    timeoutErr.submitted = true;
    timeoutErr.status = 504;
    throw timeoutErr;
  }

  if (pollStatus === 'failed') {
    const failReason = pollResult?.media?.[0]?.status || 'Video generation failed upstream';
    const failErr = new Error(`Upstream video generation failed: ${failReason}`);
    failErr.code = 'UPSTREAM_VIDEO_GENERATION_FAILED';
    failErr.submitted = true;
    failErr.status = 502;
    failErr.raw = pollResult;
    throw failErr;
  }

  // Succeeded — Download videos
  const outputs = [];
  for (let i = 0; i < mediaIds.length; i++) {
    const mId = mediaIds[i];
    let buffer = null;
    let mimeType = 'video/mp4';
    let ext = 'mp4';

    try {
      const dlResult = await provider.downloadVideo({ mediaId: mId, projectId }, { clientId });
      buffer = dlResult.buffer;
      mimeType = dlResult.mimeType || 'video/mp4';
    } catch (dlErr) {
      logger.error(`[FlowApiWorker] Failed to download video via bridge for ${jobId} output ${i + 1}: ${dlErr.message}`);
      const failDlErr = new Error(`Failed to download generated video for ${jobId}: ${dlErr.message}`);
      failDlErr.code = 'failed_download';
      failDlErr.submitted = true;
      failDlErr.status = 502;
      throw failDlErr;
    }

    if (!buffer || buffer.length === 0) {
      const emptyErr = new Error(`Downloaded empty video buffer for ${jobId} output ${i + 1}`);
      emptyErr.code = 'failed_download';
      emptyErr.submitted = true;
      emptyErr.status = 502;
      throw emptyErr;
    }

    const detected = detectMediaFormat(buffer);
    if (!detected || !detected.mimeType.startsWith('video/')) {
      const invalidErr = new Error(`Downloaded invalid video format (magic bytes mismatch) for ${jobId} output ${i + 1}`);
      invalidErr.code = 'failed_download';
      invalidErr.submitted = true;
      invalidErr.status = 502;
      throw invalidErr;
    }

    mimeType = detected.mimeType;
    ext = detected.ext;
    const filename = `output_${i + 1}.${ext}`;
    const localMediaId = storage.generateMediaId(jobId, i, ext);

    storage.writeOutputFile(jobId, filename, buffer);

    let archiveInfo = null;
    if (typeof storage.archiveOutput === 'function') {
      archiveInfo = storage.archiveOutput({
        jobId,
        type: 'video',
        filename,
        data: buffer,
        slugParams: {
          prompt: params.prompt,
          model: params.model,
          aspect: params.aspect || params.aspectRatio,
          duration: params.duration || 5,
          shortId: localMediaId
        }
      });
    }

    outputs.push({
      mediaId: localMediaId,
      filename,
      mimeType,
      sizeBytes: buffer.length,
      upstreamMediaId: mId,
      archivePath: archiveInfo?.archivePath || null,
      slug: archiveInfo?.slug || null,
    });
  }

  const manifest = {
    jobId,
    type,
    status: 'completed',
    params,
    clientId,
    projectId,
    profileHint: job.profileHint || null,
    accountLabel: job.accountLabel || null,
    estimatedCost: job.estimatedCost || 0,
    upstreamMediaIds: mediaIds,
    idempotencyKeyHash: job.idempotencyKeyHash || null,
    requestHash: job.requestHash || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: new Date().toISOString(),
    outputs,
    remainingCredits: submitResult.remainingCredits,
  };

  storage.writeManifest(jobId, manifest);
  return manifest;
}

export default runFlowApiWorker;
