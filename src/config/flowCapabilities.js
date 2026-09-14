/**
 * Google Flow Capabilities & Parameter Matrix
 * 严格基于官方 UI 确认的控件与模型矩阵进行参数校验与映射。
 */

export const FLOW_MODELS = {
  // === 图像模型 ===
  'nano-banana-pro': {
    id: 'nano-banana-pro',
    displayName: 'Nano Banana Pro',
    type: 'image',
    aliases: ['nano-banana-pro', 'nano banana pro'],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    defaultAspectRatio: '16:9',
    supportedCounts: [1, 2, 3, 4],
    defaultCount: 1,
    supportedModes: [],
    supportedDurations: [],
    allowsDuration: false
  },
  'nano-banana-2': {
    id: 'nano-banana-2',
    displayName: 'Nano Banana 2',
    type: 'image',
    aliases: ['nano-banana-2', 'nano banana 2'],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    defaultAspectRatio: '16:9',
    supportedCounts: [1, 2, 3, 4],
    defaultCount: 1,
    supportedModes: [],
    supportedDurations: [],
    allowsDuration: false
  },
  'nano-banana-2-lite': {
    id: 'nano-banana-2-lite',
    displayName: 'Nano Banana 2 Lite',
    type: 'image',
    aliases: ['nano-banana-2-lite', 'nano-banana-lite', 'nano banana 2 lite', 'nano banana lite'],
    supportedAspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
    defaultAspectRatio: '16:9',
    supportedCounts: [1, 2, 3, 4],
    defaultCount: 1,
    supportedModes: [],
    supportedDurations: [],
    allowsDuration: false
  },

  // === 视频模型 ===
  'omni-flash': {
    id: 'omni-flash',
    displayName: 'Omni Flash',
    type: 'video',
    aliases: ['omni-flash', 'omni', 'omni flash'],
    supportedAspectRatios: ['9:16', '16:9'],
    defaultAspectRatio: '16:9',
    supportedCounts: [1, 2, 3, 4],
    defaultCount: 1,
    supportedModes: ['frames', 'ingredients'],
    defaultMode: 'frames',
    supportedDurations: [4, 6, 8, 10],
    defaultDuration: 6,
    allowsDuration: true
  },
  'veo-3.1-fast': {
    id: 'veo-3.1-fast',
    displayName: 'Veo 3.1 Fast',
    type: 'video',
    aliases: ['veo-3.1-fast', 'veo-fast', 'veo-2-fast', 'veo-3-fast', 'veo fast', 'veo 3.1 fast'],
    supportedAspectRatios: ['9:16', '16:9'],
    defaultAspectRatio: '16:9',
    supportedCounts: [1, 2, 3, 4],
    defaultCount: 1,
    supportedModes: ['frames', 'ingredients'],
    defaultMode: 'frames',
    supportedDurations: [], // Veo Fast 官方 UI 不展示/不支持自定义时长
    allowsDuration: false
  },
  'veo-3.1-lite': {
    id: 'veo-3.1-lite',
    displayName: 'Veo 3.1 Lite',
    type: 'video',
    aliases: ['veo-3.1-lite', 'veo-lite', 'veo 3.1 lite', 'veo lite'],
    supportedAspectRatios: ['9:16', '16:9'],
    defaultAspectRatio: '16:9',
    supportedCounts: [1, 2, 3, 4],
    defaultCount: 1,
    supportedModes: ['frames', 'ingredients'],
    defaultMode: 'frames',
    supportedDurations: [], // 未验证时长，严禁放开
    allowsDuration: false
  },
  'veo-3.1-quality': {
    id: 'veo-3.1-quality',
    displayName: 'Veo 3.1 Quality',
    type: 'video',
    aliases: ['veo-3.1-quality', 'veo-quality', 'veo 3.1 quality', 'veo quality'],
    supportedAspectRatios: ['9:16', '16:9'],
    defaultAspectRatio: '16:9',
    supportedCounts: [1, 2, 3, 4],
    defaultCount: 1,
    supportedModes: ['frames', 'ingredients'],
    defaultMode: 'frames',
    supportedDurations: [], // 未验证时长，严禁放开
    allowsDuration: false
  }
};

/**
 * 根据模型 ID、别名或显示名称获取模型定义
 * @param {string} nameOrId
 * @returns {object|null}
 */
export function getModel(nameOrId) {
  if (!nameOrId || typeof nameOrId !== 'string') return null;
  const key = nameOrId.trim().toLowerCase();
  
  if (FLOW_MODELS[key]) {
    return FLOW_MODELS[key];
  }
  
  for (const model of Object.values(FLOW_MODELS)) {
    if (model.id.toLowerCase() === key || model.displayName.toLowerCase() === key) {
      return model;
    }
    if (model.aliases && model.aliases.some(alias => alias.toLowerCase() === key)) {
      return model;
    }
  }
  
  return null;
}

/**
 * Estimate operation credits cost based on UI-verified values or caller-provided cost.
 * Note: Only UI-verified values are configured:
 * - veo-3.1-lite: 10
 * - omni-flash: 4 (4s/default lower durations), 7 (6s/7s), 12 (8s/10s)
 * - Images or unverified models: return 0 if unknown (does not enforce credits threshold, but clientPool still creates an active reservation slot).
 *
 * @param {object} params
 * @param {string} [params.type] 'image' | 'video'
 * @param {string} [params.model]
 * @param {number} [params.duration]
 * @param {number} [params.cost] Explicit cost override from caller
 * @param {number} [params.estimated_cost] Explicit estimated_cost override from caller
 * @param {number} [params.estimatedCost] Explicit estimatedCost override from caller
 * @returns {number} estimated credits cost (>= 0)
 */
export function estimateCost(params = {}) {
  if (typeof params.cost === 'number' && params.cost >= 0) {
    return params.cost;
  }
  if (typeof params.estimated_cost === 'number' && params.estimated_cost >= 0) {
    return params.estimated_cost;
  }
  if (typeof params.estimatedCost === 'number' && params.estimatedCost >= 0) {
    return params.estimatedCost;
  }

  const modelId = (params.model || '').toLowerCase().trim();
  const duration = Number(params.duration);

  // Veo 3.1 Lite: verified cost = 10
  if (modelId === 'veo-3.1-lite' || modelId === 'veo-lite' || modelId === 'veo 3.1 lite' || modelId === 'veo lite') {
    return 10;
  }

  // Omni-flash: verified cost based on duration: <=4s -> 4, 6s..7s -> 7, >=8s -> 12
  if (modelId === 'omni-flash' || modelId === 'omni' || modelId === 'omni flash') {
    if (duration <= 4) {
      return 4;
    }
    if (duration <= 7) {
      return 7;
    }
    return 12;
  }

  // Images and other unverified models: 0 cost threshold (unverified boundary: no artificial credits cost assumed)
  return 0;
}
export function listModels() {
  return Object.values(FLOW_MODELS).map(model => ({
    id: model.id,
    object: 'model',
    type: model.type,
    display_name: model.displayName,
    supported_aspect_ratios: model.supportedAspectRatios,
    supported_counts: model.supportedCounts,
    supported_modes: model.supportedModes,
    supported_durations: model.supportedDurations,
    allows_duration: model.allowsDuration
  }));
}

/**
 * 获取完整能力矩阵
 */
export function getCapabilities() {
  return {
    image: {
      defaultModel: 'nano-banana-pro',
      models: Object.values(FLOW_MODELS).filter(m => m.type === 'image'),
      aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'],
      counts: [1, 2, 3, 4]
    },
    video: {
      defaultModel: 'omni-flash',
      models: Object.values(FLOW_MODELS).filter(m => m.type === 'video'),
      aspectRatios: ['9:16', '16:9'],
      modes: ['frames', 'ingredients'],
      counts: [1, 2, 3, 4],
      durations: {
        'omni-flash': [4, 6, 8, 10]
      }
    }
  };
}

/**
 * 校验并规范化请求参数
 * @param {'image'|'video'} expectedType
 * @param {object} rawParams
 * @returns {object} normalizedParams
 */
export function validateParams(expectedType, rawParams = {}) {
  if (expectedType !== 'image' && expectedType !== 'video') {
    const err = new Error(`Unsupported generation type: ${expectedType}`);
    err.status = 400;
    err.code = 'invalid_request_error';
    throw err;
  }

  // 1. 校验 Prompt
  const prompt = rawParams.prompt;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    const err = new Error('prompt is required and must be a non-empty string');
    err.status = 400;
    err.code = 'invalid_request_error';
    throw err;
  }
  if (prompt.length > 2000) {
    const err = new Error('prompt length exceeds maximum allowed limit (2000 characters)');
    err.status = 400;
    err.code = 'invalid_request_error';
    throw err;
  }

  // 2. 校验 Model
  const rawModel = rawParams.model || (expectedType === 'image' ? 'nano-banana-pro' : 'omni-flash');
  const model = getModel(rawModel);
  if (!model) {
    const err = new Error(`Unknown model: '${rawModel}'. Supported models: ${Object.keys(FLOW_MODELS).join(', ')}`);
    err.status = 400;
    err.code = 'invalid_request_error';
    throw err;
  }
  if (model.type !== expectedType) {
    const err = new Error(`Model '${model.id}' is a ${model.type} model, but requested on ${expectedType} endpoint`);
    err.status = 400;
    err.code = 'invalid_request_error';
    throw err;
  }

  // 3. 校验 Aspect Ratio
  const rawAspect = rawParams.aspect_ratio || rawParams.aspect || model.defaultAspectRatio;
  if (!model.supportedAspectRatios.includes(rawAspect)) {
    const err = new Error(`Aspect ratio '${rawAspect}' is not supported by model '${model.id}'. Supported: ${model.supportedAspectRatios.join(', ')}`);
    err.status = 400;
    err.code = 'invalid_request_error';
    throw err;
  }

  // 4. 校验 Count (n)
  let count = rawParams.n !== undefined ? rawParams.n : (rawParams.count !== undefined ? rawParams.count : model.defaultCount);
  count = Number(count);
  if (!Number.isInteger(count) || !model.supportedCounts.includes(count)) {
    const err = new Error(`Count (n) must be an integer in [${model.supportedCounts.join(', ')}], received: ${rawParams.n || rawParams.count}`);
    err.status = 400;
    err.code = 'invalid_request_error';
    throw err;
  }

  let mode = null;
  let duration = null;

  if (expectedType === 'image') {
    if (rawParams.duration !== undefined && rawParams.duration !== null) {
      const err = new Error(`Duration is not supported for image model '${model.id}'`);
      err.status = 400;
      err.code = 'invalid_request_error';
      throw err;
    }
    if (rawParams.mode !== undefined && rawParams.mode !== null) {
      const err = new Error(`Mode is not supported for image model '${model.id}'`);
      err.status = 400;
      err.code = 'invalid_request_error';
      throw err;
    }
  } else if (expectedType === 'video') {
    // 5. 校验 Mode
    const rawMode = rawParams.mode || model.defaultMode || 'frames';
    const validModes = ['frames', 'ingredients', 't2v', 'i2v', 'first_last', 'reference', 'edit'];
    if (!validModes.includes(rawMode)) {
      const err = new Error(`Mode '${rawMode}' is not supported. Supported: ${validModes.join(', ')}`);
      err.status = 400;
      err.code = 'invalid_request_error';
      throw err;
    }
    mode = rawMode;

    // 6. 校验 Duration
    if (rawParams.duration !== undefined && rawParams.duration !== null) {
      const parsedDuration = Number(rawParams.duration);
      if (!model.allowsDuration) {
        const err = new Error(`Duration selection is not supported or verified for model '${model.id}'`);
        err.status = 400;
        err.code = 'invalid_request_error';
        throw err;
      }
      if (!Number.isInteger(parsedDuration) || !model.supportedDurations.includes(parsedDuration)) {
        const err = new Error(`Duration '${rawParams.duration}' is invalid for model '${model.id}'. Supported durations: ${model.supportedDurations.map(d => `${d}s`).join(', ')}`);
        err.status = 400;
        err.code = 'invalid_request_error';
        throw err;
      }
      duration = parsedDuration;
    } else if (model.allowsDuration) {
      duration = model.defaultDuration || 6;
    }
  }

  // 7. 解析与校验资产字段
  let startAssetId = null;
  if (rawParams.start_asset_id !== undefined && rawParams.start_asset_id !== null) {
    if (typeof rawParams.start_asset_id !== 'string' || !rawParams.start_asset_id.trim()) {
      const err = new Error('start_asset_id must be a non-empty string');
      err.status = 400;
      err.code = 'invalid_request_error';
      throw err;
    }
    startAssetId = rawParams.start_asset_id.trim();
  }

  let endAssetId = null;
  if (rawParams.end_asset_id !== undefined && rawParams.end_asset_id !== null) {
    if (typeof rawParams.end_asset_id !== 'string' || !rawParams.end_asset_id.trim()) {
      const err = new Error('end_asset_id must be a non-empty string');
      err.status = 400;
      err.code = 'invalid_request_error';
      throw err;
    }
    endAssetId = rawParams.end_asset_id.trim();
  }

  let sourceVideoAssetId = null;
  if (rawParams.source_video_asset_id !== undefined && rawParams.source_video_asset_id !== null) {
    if (typeof rawParams.source_video_asset_id !== 'string' || !rawParams.source_video_asset_id.trim()) {
      const err = new Error('source_video_asset_id must be a non-empty string');
      err.status = 400;
      err.code = 'invalid_request_error';
      throw err;
    }
    sourceVideoAssetId = rawParams.source_video_asset_id.trim();
  }

  let referenceAssetIds = [];
  if (rawParams.reference_asset_ids !== undefined && rawParams.reference_asset_ids !== null) {
    if (!Array.isArray(rawParams.reference_asset_ids)) {
      const err = new Error('reference_asset_ids must be an array of strings');
      err.status = 400;
      err.code = 'invalid_request_error';
      throw err;
    }
    if (rawParams.reference_asset_ids.length > 5) {
      const err = new Error('reference_asset_ids cannot exceed 5 items');
      err.status = 400;
      err.code = 'invalid_request_error';
      throw err;
    }
    referenceAssetIds = rawParams.reference_asset_ids.map(id => {
      if (typeof id !== 'string' || !id.trim()) {
        const err = new Error('Each item in reference_asset_ids must be a non-empty string');
        err.status = 400;
        err.code = 'invalid_request_error';
        throw err;
      }
      return id.trim();
    });
  }

  // 保留并兼容 input_assets / input_asset
  const inputAssetIds = Array.isArray(rawParams.input_assets) 
    ? rawParams.input_assets.filter(id => typeof id === 'string' && id.trim()).map(id => id.trim())
    : (typeof rawParams.input_asset === 'string' && rawParams.input_asset.trim() ? [rawParams.input_asset.trim()] : []);

  if (inputAssetIds.length > 5) {
    const err = new Error('input_assets cannot exceed 5 items');
    err.status = 400;
    err.code = 'invalid_request_error';
    throw err;
  }

  // 8. 模式映射与必需输入校验
  let resolvedMode = mode;
  if (expectedType === 'video') {
    if (mode === 'frames') {
      const totalAssets = inputAssetIds.length + (startAssetId ? 1 : 0) + (endAssetId ? 1 : 0);
      if (totalAssets === 0) {
        resolvedMode = 't2v';
      } else if (totalAssets === 1) {
        resolvedMode = 'i2v';
        if (!startAssetId && inputAssetIds.length === 1) {
          startAssetId = inputAssetIds[0];
        }
      } else if (totalAssets === 2) {
        resolvedMode = 'first_last';
        if (!startAssetId && inputAssetIds.length >= 1) {
          startAssetId = inputAssetIds[0];
        }
        if (!endAssetId && inputAssetIds.length >= 2) {
          endAssetId = inputAssetIds[1];
        }
      } else {
        const err = new Error(`Mode 'frames' supports at most 2 input assets (start and end frames), received: ${totalAssets}`);
        err.status = 400;
        err.code = 'invalid_request_error';
        throw err;
      }
    } else if (mode === 'ingredients') {
      resolvedMode = 'reference';
      if (referenceAssetIds.length === 0 && inputAssetIds.length > 0) {
        referenceAssetIds = [...inputAssetIds];
      }
      if (referenceAssetIds.length === 0) {
        const err = new Error("Mode 'ingredients' requires at least 1 reference asset");
        err.status = 400;
        err.code = 'invalid_request_error';
        throw err;
      }
    } else if (mode === 't2v') {
      resolvedMode = 't2v';
    } else if (mode === 'i2v') {
      resolvedMode = 'i2v';
      if (!startAssetId && inputAssetIds.length > 0) {
        startAssetId = inputAssetIds[0];
      }
      if (!startAssetId) {
        const err = new Error("Mode 'i2v' requires 'start_asset_id' or 'input_assets'");
        err.status = 400;
        err.code = 'invalid_request_error';
        throw err;
      }
    } else if (mode === 'first_last') {
      resolvedMode = 'first_last';
      if (!startAssetId && inputAssetIds.length >= 1) startAssetId = inputAssetIds[0];
      if (!endAssetId && inputAssetIds.length >= 2) endAssetId = inputAssetIds[1];
      if (!startAssetId || !endAssetId) {
        const err = new Error("Mode 'first_last' requires both 'start_asset_id' and 'end_asset_id'");
        err.status = 400;
        err.code = 'invalid_request_error';
        throw err;
      }
    } else if (mode === 'reference') {
      resolvedMode = 'reference';
      if (referenceAssetIds.length === 0 && inputAssetIds.length > 0) {
        referenceAssetIds = [...inputAssetIds];
      }
      if (referenceAssetIds.length === 0) {
        const err = new Error("Mode 'reference' requires at least 1 reference asset in 'reference_asset_ids' or 'input_assets'");
        err.status = 400;
        err.code = 'invalid_request_error';
        throw err;
      }
    } else if (mode === 'edit') {
      resolvedMode = 'edit';
      if (!sourceVideoAssetId && inputAssetIds.length > 0) {
        sourceVideoAssetId = inputAssetIds[0];
      }
      if (!sourceVideoAssetId) {
        const err = new Error("Mode 'edit' requires 'source_video_asset_id'");
        err.status = 400;
        err.code = 'invalid_request_error';
        throw err;
      }
    }
  }

  // 9. 校验 client_id / project_id / account_id
  let clientId = null;
  if (rawParams.client_id !== undefined && rawParams.client_id !== null) {
    if (typeof rawParams.client_id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(rawParams.client_id.trim())) {
      const err = new Error('client_id must be a string matching ^[a-zA-Z0-9_-]{1,64}$');
      err.status = 400;
      err.code = 'invalid_request_error';
      throw err;
    }
    clientId = rawParams.client_id.trim();
  }

  let accountLabel = null;
  if (rawParams.account_label !== undefined && rawParams.account_label !== null) {
    if (typeof rawParams.account_label === 'string') {
      accountLabel = rawParams.account_label.trim().slice(0, 64);
    }
  }

  let projectId = null;
  if (rawParams.project_id !== undefined && rawParams.project_id !== null) {
    if (typeof rawParams.project_id !== 'string' || !rawParams.project_id.trim()) {
      const err = new Error('project_id must be a non-empty string');
      err.status = 400;
      err.code = 'invalid_request_error';
      throw err;
    }
    projectId = rawParams.project_id.trim();
  }

  let accountId = null;
  if (rawParams.account_id !== undefined && rawParams.account_id !== null && rawParams.account_id !== '') {
    // 无法与 extension client 可靠绑定时明确报错 unsupported_account_mapping
    const err = new Error('account_id mapping is not supported for Flow Extension bridge mode. Use client_id instead.');
    err.status = 400;
    err.code = 'unsupported_account_mapping';
    throw err;
  }

  const cost = estimateCost({
    type: expectedType,
    model: model.id,
    duration,
    cost: rawParams.cost,
    estimated_cost: rawParams.estimated_cost,
    estimatedCost: rawParams.estimatedCost,
  });

  return {
    type: expectedType,
    model: model.id,
    displayName: model.displayName,
    prompt: prompt.trim(),
    aspect: rawAspect,
    count,
    mode: resolvedMode,
    rawMode: mode,
    duration,
    inputAssetIds,
    startAssetId,
    endAssetId,
    referenceAssetIds,
    sourceVideoAssetId,
    clientId,
    accountLabel,
    projectId,
    accountId,
    estimatedCost: cost,
  };
}
