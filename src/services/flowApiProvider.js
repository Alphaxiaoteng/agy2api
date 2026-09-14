/**
 * Flow API Provider
 *
 * Wraps FlowExtensionBridge to provide private Google Flow API operations:
 * - getCredits
 * - generateImage
 * - uploadImage
 * - submitVideo (t2v, i2v, first_last, reference, edit)
 * - pollVideo
 * - downloadVideo
 *
 * Implements strict error handling:
 * - 401 unauthenticated self-healing (refresh_auth once and retry once before submit)
 * - Uncertain submit error marking (submitted: true, unknown: true) to prevent upper-level duplicate retries
 * - Returns structured payloads:
 *   - Image: { images: [{ upstreamMediaId, remoteUrl, model }] }
 *   - Video submit: { mediaIds: string[], clientContext?: object }
 *   - Poll: { status: 'processing'|'succeeded'|'failed', media: [...] }
 *   - Download: Buffer or structured payload { buffer, mimeType }
 */

import flowExtensionBridge from './flowExtensionBridge.js';
import {
  buildImageRequest,
  buildVideoSubmitRequest,
  buildVideoPollRequest,
  parseImageResponse,
  parseSubmittedMediaIds,
  parseVideoPollResponse,
  normalizeUpstreamError,
} from './flowProtocol.js';
import logger from '../utils/logger.js';

export class FlowApiProvider {
  constructor(options = {}) {
    this.bridge = options.bridge || flowExtensionBridge;
    this.defaultProjectId = options.defaultProjectId || null;
  }

  /**
   * Helper to check if an upstream error response represents 401 Unauthenticated
   */
  _isUnauthenticated(res) {
    if (!res) return false;
    if (res.status === 401) return true;
    if (res.error === 'UNAUTHENTICATED' || res.error === 'NO_FLOW_KEY') return true;
    const data = res.data;
    if (data && typeof data === 'object') {
      const err = data.error;
      if (err && (err.code === 401 || err.status === 'UNAUTHENTICATED')) {
        return true;
      }
    }
    return false;
  }

  /**
   * Helper to resolve and pin clientId and projectId
   * @param {object} [options]
   * @returns {{ clientId: string, projectId: string }}
   */
  resolveClientAndProject(options = {}) {
    const preferredClientId = options.clientId || options.preferredClientId;
    let clientId = null;

    if (preferredClientId) {
      // 严格校验 preferredClientId 是否连接、有 token 与 apiKey
      if (this.bridge && this.bridge.clientPool) {
        clientId = this.bridge.clientPool.selectClient({
          preferredClientId,
          strictPreferred: true,
          cost: options.meta?.cost,
        });
      } else {
        clientId = preferredClientId;
      }
      if (!clientId) {
        const err = new Error(`Specified extension client '${preferredClientId}' is not connected or not available`);
        err.status = 503;
        err.code = 'NO_EXTENSION_CLIENTS';
        throw err;
      }
    } else if (this.bridge && this.bridge.clientPool) {
      clientId = this.bridge.clientPool.selectClient({
        cost: options.meta?.cost,
      });
    }

    if (!clientId) {
      const err = new Error('No available connected extension clients');
      err.status = 503;
      err.code = 'NO_EXTENSION_CLIENTS';
      throw err;
    }

    let projectId = options.projectId || this.defaultProjectId;
    if (!projectId && this.bridge && this.bridge.clientPool) {
      projectId = this.bridge.clientPool.getClientProjectId(clientId);
    }

    return { clientId, projectId: projectId || null };
  }

  /**
   * Helper to run an operation with single-shot 401 refresh_auth retry.
   * If isSubmit is true and the error is a timeout or network break during submit (and bridge dispatched the request),
   * it throws an error marked with `submitted = true` and `unknown = true`.
   * Explicit 4xx / 5xx responses from Google are known failures and MUST NOT be marked unknown.
   */
  async _executeWithAuthRetry(operation, payload, options = {}, isSubmit = false) {
    const { clientId, timeout, meta } = options;

    let res;
    try {
      res = await this.bridge.request(operation, payload, { clientId, timeout, meta });
    } catch (err) {
      if (isSubmit && err.dispatched === true) {
        // Dispatched submit timed out or broke — Google might have processed it
        const submitErr = new Error(`Video/Image generation submission result uncertain: ${err.message}`);
        submitErr.code = 'SUBMISSION_UNCERTAIN';
        submitErr.submitted = true;
        submitErr.unknown = true;
        submitErr.originalError = err;
        throw submitErr;
      }
      throw err;
    }

    // Check for 401 UNAUTHENTICATED
    if (this._isUnauthenticated(res)) {
      logger.warn(`[FlowApiProvider] Received 401 for operation '${operation}', attempting refresh_auth...`);
      const targetClientId = clientId;

      try {
        await this.bridge.request('refresh_auth', { force: true }, { clientId: targetClientId, timeout: 15000 });
      } catch (refreshErr) {
        logger.warn(`[FlowApiProvider] refresh_auth failed: ${refreshErr.message}`);
      }

      // Retry once pinned to the exact same client
      try {
        res = await this.bridge.request(operation, payload, { clientId: targetClientId, timeout, meta });
      } catch (retryErr) {
        if (isSubmit && retryErr.dispatched === true) {
          const submitErr = new Error(`Video/Image generation submission result uncertain on retry: ${retryErr.message}`);
          submitErr.code = 'SUBMISSION_UNCERTAIN';
          submitErr.submitted = true;
          submitErr.unknown = true;
          submitErr.originalError = retryErr;
          throw submitErr;
        }
        throw retryErr;
      }

      if (this._isUnauthenticated(res)) {
        const authErr = new Error('Flow authentication expired or invalid (401 UNAUTHENTICATED)');
        authErr.code = 'UNAUTHENTICATED';
        authErr.status = 401;
        throw authErr;
      }
    }

    if (res.error) {
      const norm = normalizeUpstreamError(res);
      const opErr = new Error(norm.message);
      opErr.code = norm.code;
      opErr.status = typeof norm.code === 'number' ? norm.code : (res.status || 500);
      opErr.raw = res;
      throw opErr;
    }

    if (res.status && res.status !== 200) {
      const norm = normalizeUpstreamError(res);
      const opErr = new Error(norm.message);
      opErr.code = norm.code;
      opErr.status = res.status;
      opErr.raw = res;
      throw opErr;
    }

    if (clientId && this.bridge.clientPool) {
      this.bridge.clientPool.recordSuccess(clientId);
    }

    return res.data !== undefined ? res.data : res;
  }

  /**
   * Get user credits and account tier info
   * @param {object} [options]
   * @param {string} [options.clientId]
   * @param {string} [options.projectId]
   * @returns {Promise<{ credits: number|null, tier: string|null, selectedClientId: string, selectedProjectId: string|null, raw: object }>}
   */
  async getCredits(options = {}) {
    const { clientId, projectId } = this.resolveClientAndProject(options);
    const payload = projectId ? { projectId } : {};
    const data = await this._executeWithAuthRetry('get_credits', payload, { ...options, clientId }, false);

    let credits = null;
    if (typeof data.credits === 'number') {
      credits = data.credits;
    } else if (typeof data.remainingCredits === 'number') {
      credits = data.remainingCredits;
    } else if (typeof data.credits === 'string' && !isNaN(Number(data.credits))) {
      credits = Number(data.credits);
    }

    return {
      credits,
      tier: data.sku || data.userPaygateTier || null,
      selectedClientId: clientId,
      selectedProjectId: projectId,
      raw: data,
    };
  }

  /**
   * Generate images via batchGenerateImages
   *
   * @param {object} params
   * @param {string} [params.projectId]
   * @param {string} params.prompt
   * @param {string} [params.model]
   * @param {string} [params.aspectRatio]
   * @param {number} [params.count=1]
   * @param {string[]} [params.refMediaIds]
   * @param {number} [params.seed]
   * @param {object} [options]
   * @returns {Promise<{ images: Array<{ upstreamMediaId: string, remoteUrl: string, model: string }>, remainingCredits?: number, selectedClientId: string, selectedProjectId: string, raw: object }>}
   */
  async generateImage(params, options = {}) {
    const { clientId, projectId } = this.resolveClientAndProject({
      ...options,
      projectId: params.projectId || options.projectId,
      clientId: params.clientId || options.clientId,
    });
    if (!projectId) throw new Error('projectId is required for generateImage');

    const imageReq = buildImageRequest({ ...params, projectId });
    const payload = {
      endpoint: imageReq.endpoint,
      body: imageReq.body,
      captchaAction: imageReq.captchaAction,
      projectId,
    };

    const data = await this._executeWithAuthRetry('generate_image', payload, {
      ...options,
      clientId,
      meta: { ...(options.meta || {}), prompt: params.prompt, count: params.count },
    }, true);

    const images = parseImageResponse(data);
    if (!images || images.length === 0) {
      const err = new Error('No images returned in upstream response');
      err.code = 'NO_IMAGES_RETURNED';
      err.raw = data;
      throw err;
    }

    const targetModel = imageReq.body.requests?.[0]?.imageModelName || 'GEM_PIX_2';
    const enrichedImages = images.map(img => ({
      ...img,
      model: targetModel,
    }));

    return {
      images: enrichedImages,
      remainingCredits: data.remainingCredits !== undefined ? Number(data.remainingCredits) : undefined,
      selectedClientId: clientId,
      selectedProjectId: projectId,
      raw: data,
    };
  }

  /**
   * Upload an image to Google Flow
   *
   * @param {object} params
   * @param {string} [params.projectId]
   * @param {string|Buffer} params.imageBase64OrBuffer - base64 string or Buffer
   * @param {string} [params.mimeType='image/png']
   * @param {object} [options]
   * @returns {Promise<{ mediaId: string, selectedClientId: string, selectedProjectId: string, raw: object }>}
   */
  async uploadImage(params, options = {}) {
    const { clientId, projectId } = this.resolveClientAndProject({
      ...options,
      projectId: params.projectId || options.projectId,
      clientId: params.clientId || options.clientId,
    });
    if (!projectId) throw new Error('projectId is required for uploadImage');

    let imageBase64;
    if (Buffer.isBuffer(params.imageBase64OrBuffer)) {
      imageBase64 = params.imageBase64OrBuffer.toString('base64');
    } else if (typeof params.imageBase64OrBuffer === 'string') {
      imageBase64 = params.imageBase64OrBuffer.replace(/^data:image\/[a-zA-Z]+;base64,/, '');
    } else {
      throw new Error('imageBase64OrBuffer must be a Buffer or base64 string');
    }

    const payload = {
      projectId,
      imageBase64,
      mimeType: params.mimeType || 'image/png',
    };

    const data = await this._executeWithAuthRetry('upload_image', payload, { ...options, clientId }, false);

    const mediaId = data.mediaId || data.name || (data.media && data.media.name);
    if (!mediaId) {
      const err = new Error('Upload succeeded but no mediaId was returned');
      err.code = 'NO_MEDIA_ID';
      err.raw = data;
      throw err;
    }

    return {
      mediaId,
      selectedClientId: clientId,
      selectedProjectId: projectId,
      raw: data,
    };
  }

  /**
   * Submit video generation request (t2v, i2v, first_last, reference, edit)
   *
   * @param {object} params
   * @param {object} [options]
   * @returns {Promise<{ mediaIds: string[], remainingCredits?: number, selectedClientId: string, selectedProjectId: string, raw: object }>}
   */
  async submitVideo(params, options = {}) {
    const { clientId, projectId } = this.resolveClientAndProject({
      ...options,
      projectId: params.projectId || options.projectId,
      clientId: params.clientId || options.clientId,
    });
    if (!projectId) throw new Error('projectId is required for submitVideo');

    const videoReq = buildVideoSubmitRequest({ ...params, projectId });
    const payload = {
      mode: videoReq.mode,
      endpoint: videoReq.endpoint,
      body: videoReq.body,
      captchaAction: videoReq.captchaAction,
      projectId,
    };

    const data = await this._executeWithAuthRetry('submit_video', payload, {
      ...options,
      clientId,
      meta: { ...(options.meta || {}), prompt: params.prompt, mode: videoReq.mode },
    }, true);

    const mediaIds = parseSubmittedMediaIds(data);
    if (!mediaIds || mediaIds.length === 0) {
      const err = new Error('No media IDs returned in video submit response');
      err.code = 'NO_MEDIA_RETURNED';
      err.raw = data;
      throw err;
    }

    return {
      mediaIds,
      remainingCredits: data.remainingCredits !== undefined ? Number(data.remainingCredits) : undefined,
      selectedClientId: clientId,
      selectedProjectId: projectId,
      raw: data,
    };
  }

  /**
   * Poll video status for given media IDs
   *
   * @param {object} params
   * @param {string[]} params.mediaIds
   * @param {string} [params.projectId]
   * @param {object} [options]
   * @returns {Promise<{
   *   status: 'succeeded' | 'failed' | 'processing',
   *   media: Array<{ mediaId: string, status: string, isSuccess: boolean, isFailed: boolean, raw: object }>,
   *   selectedClientId: string,
   *   selectedProjectId: string,
   *   raw: object
   * }>}
   */
  async pollVideo(params, options = {}) {
    const { clientId, projectId } = this.resolveClientAndProject({
      ...options,
      projectId: params.projectId || options.projectId,
      clientId: params.clientId || options.clientId,
    });
    const { mediaIds } = params;

    if (!Array.isArray(mediaIds) || mediaIds.length === 0) {
      throw new Error('mediaIds must be a non-empty array');
    }
    if (!projectId) {
      throw new Error('projectId is required for pollVideo');
    }

    const pollReq = buildVideoPollRequest(mediaIds, projectId);
    const payload = {
      endpoint: pollReq.endpoint,
      body: pollReq.body,
      captchaAction: pollReq.captchaAction,
    };

    const data = await this._executeWithAuthRetry('poll_video', payload, { ...options, clientId }, false);
    const parsed = parseVideoPollResponse(data);

    return {
      status: parsed.status,
      media: parsed.media,
      selectedClientId: clientId,
      selectedProjectId: projectId,
      raw: data,
    };
  }

  /**
   * Download video data for a given mediaId via extension controlled download
   *
   * @param {object} params
   * @param {string} params.mediaId
   * @param {string} [params.projectId]
   * @param {object} [options]
   * @returns {Promise<{ buffer: Buffer, mimeType: string, selectedClientId: string, selectedProjectId: string|null, raw?: object }>}
   */
  async downloadVideo(params, options = {}) {
    const { mediaId } = params;
    if (!mediaId) throw new Error('mediaId is required for downloadVideo');

    const { clientId, projectId } = this.resolveClientAndProject({
      ...options,
      projectId: params.projectId || options.projectId,
      clientId: params.clientId || options.clientId,
    });

    const payload = {
      mediaId,
      projectId,
    };

    const data = await this._executeWithAuthRetry('download_video', payload, { ...options, clientId }, false);

    // If data is already a Buffer
    if (Buffer.isBuffer(data)) {
      return {
        buffer: data,
        mimeType: 'video/mp4',
        selectedClientId: clientId,
        selectedProjectId: projectId,
      };
    }

    // If data has videoBase64 or encodedVideo returned by extension
    let base64Str = '';
    if (typeof data === 'string') {
      base64Str = data;
    } else if (data.videoBase64) {
      base64Str = data.videoBase64;
    } else if (data.video && typeof data.video === 'object') {
      base64Str = data.video.encodedVideo || data.video.videoBase64 || '';
    } else if (data.encodedVideo) {
      base64Str = data.encodedVideo;
    } else if (data.base64) {
      base64Str = data.base64;
    }

    if (base64Str) {
      const cleanBase64 = base64Str.replace(/^data:video\/[a-zA-Z0-9]+;base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      return {
        buffer,
        mimeType: 'video/mp4',
        selectedClientId: clientId,
        selectedProjectId: projectId,
        raw: data,
      };
    }

    throw new Error('No video binary data found in extension download response');
  }

  /**
   * Download image data for a given mediaId or URL via extension controlled download
   *
   * @param {object} params
   * @param {string} [params.mediaId]
   * @param {string} [params.url]
   * @param {string} [params.projectId]
   * @param {object} [options]
   * @returns {Promise<{ buffer: Buffer, mimeType: string, selectedClientId: string, selectedProjectId: string|null, raw?: object }>}
   */
  async downloadImage(params, options = {}) {
    const { mediaId, url } = params;
    if (!mediaId && !url) throw new Error('mediaId or url is required for downloadImage');

    const { clientId, projectId } = this.resolveClientAndProject({
      ...options,
      projectId: params.projectId || options.projectId,
      clientId: params.clientId || options.clientId,
    });

    const payload = {
      mediaId,
      url,
      projectId,
    };

    const data = await this._executeWithAuthRetry('download_image', payload, { ...options, clientId }, false);

    if (Buffer.isBuffer(data)) {
      return {
        buffer: data,
        mimeType: 'image/png',
        selectedClientId: clientId,
        selectedProjectId: projectId,
      };
    }

    let base64Str = '';
    if (typeof data === 'string') {
      base64Str = data;
    } else if (data.imageBase64) {
      base64Str = data.imageBase64;
    } else if (data.image && typeof data.image === 'object') {
      base64Str = data.image.encodedImage || data.image.imageBase64 || '';
    } else if (data.encodedImage) {
      base64Str = data.encodedImage;
    } else if (data.base64) {
      base64Str = data.base64;
    }

    if (base64Str) {
      const cleanBase64 = base64Str.replace(/^data:image\/[a-zA-Z0-9]+;base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      return {
        buffer,
        mimeType: 'image/png',
        selectedClientId: clientId,
        selectedProjectId: projectId,
        raw: data,
      };
    }

    throw new Error('No image binary data found in extension download response');
  }
}

export const flowApiProvider = new FlowApiProvider();
export default flowApiProvider;
