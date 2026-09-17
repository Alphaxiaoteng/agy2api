// 签名缓存（文件存储版本）：
// - 按 model 维度缓存"最近 N 个"签名（环形队列）
// - 签名和思考内容绑定存储：{ signature, content }
// - 自动先进先出：超过容量自动挤掉最旧的
// - 存储在 data/signature-cache/ 目录下

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import config from '../config/config.js';
import log from './logger.js';

// 缓存目录路径
const CACHE_DIR = path.join(process.cwd(), 'data', 'signature-cache');

// 上限：每个模型保留的签名数量
const MAX_SIGNATURES_PER_MODEL = 3;

// 缓存文件是按 (model, sessionId) 建一个文件的，而环形队列只约束"单文件内"的条数。
// 于是每个新会话都会留下一个几乎不会再被读到的文件，目录随会话数无界增长
// （实测已累积 650 个 / 19MB），既占磁盘又让目录遍历变慢。这里加两道闸：
//   - 超过 TTL 未被写入的文件视为死会话，回收；
//   - 仍然超过 MAX_CACHE_FILES 时，按 mtime 从最旧开始回收。
const CACHE_FILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CACHE_FILES = 500;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
let lastPruneAt = 0;

/**
 * 回收过期/超量的签名缓存文件。带节流，最多每小时执行一次。
 * 导出仅为可测试性：生产路径由 writeModelCache 自动触发。
 * @returns {number} 删除的文件数
 */
export function pruneStaleCacheFiles() {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return 0;
  lastPruneAt = now;

  let entries;
  try {
    entries = fs.readdirSync(CACHE_DIR);
  } catch {
    return 0;
  }

  const stats = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(CACHE_DIR, name);
    try {
      stats.push({ filePath, mtimeMs: fs.statSync(filePath).mtimeMs });
    } catch {
      // 文件已被并发清理
    }
  }

  const doomed = stats.filter((s) => now - s.mtimeMs > CACHE_FILE_TTL_MS);
  // 仍然超量时，从最旧的开始接着删
  const survivors = stats.filter((s) => now - s.mtimeMs <= CACHE_FILE_TTL_MS);
  if (survivors.length > MAX_CACHE_FILES) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    doomed.push(...survivors.slice(0, survivors.length - MAX_CACHE_FILES));
  }

  let removed = 0;
  for (const { filePath } of doomed) {
    try {
      fs.unlinkSync(filePath);
      removed += 1;
    } catch {
      // 忽略
    }
  }
  if (removed > 0) {
    log.info(`签名缓存已回收 ${removed} 个过期文件（边界: TTL 7 天 / 上限 ${MAX_CACHE_FILES} 个）`);
  }
  return removed;
}

/**
 * 确保缓存目录存在
 */
function ensureCacheDir() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/**
 * 生成模型的缓存文件名（处理特殊字符）
 * @param {string} model - 模型名称
 * @returns {string} 安全的文件名
 */
function makeModelKey(model, sessionId = null) {
  if (!model) return null;
  const raw = String(model);
  // 生图模型会带分辨率后缀（例如 `-4K` / `-2K`），但实际请求时会被剥离为基础模型名。
  // 为避免缓存 miss，这里统一按"基础模型名"缓存。
  const baseModel = raw.replace(/-(?:1k|2k|4k|8k)$/i, '');
  // 将不安全的文件名字符替换为下划线
  const modelKey = baseModel.replace(/[<>:"/\\|?*]/g, '_');
  if (!sessionId) return modelKey;
  const sessionKey = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16);
  return `${modelKey}--${sessionKey}`;
}

/**
 * 获取模型缓存文件路径
 * @param {string} modelKey - 模型 key
 * @returns {string} 文件路径
 */
function getCacheFilePath(modelKey) {
  return path.join(CACHE_DIR, `${modelKey}.json`);
}

/**
 * 从文件读取模型的签名缓存
 * @param {string} modelKey - 模型 key
 * @returns {Array} 签名数组 [{ signature, content }, ...]
 */
function readModelCache(modelKey) {
  if (!modelKey) return [];
  
  try {
    const filePath = getCacheFilePath(modelKey);
    if (!fs.existsSync(filePath)) return [];
    
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data.signatures) ? data.signatures : [];
  } catch (e) {
    log.warn(`读取签名缓存失败 (${modelKey}):`, e?.message || e);
    return [];
  }
}

/**
 * 将签名缓存写入文件
 * @param {string} modelKey - 模型 key
 * @param {Array} signatures - 签名数组
 */
function writeModelCache(modelKey, signatures) {
  if (!modelKey) return;
  
  try {
    ensureCacheDir();
    // 写入路径顺带触发一次（带节流）的缓存回收，避免目录无界增长
    pruneStaleCacheFiles();
    const filePath = getCacheFilePath(modelKey);
    const data = {
      model: modelKey,
      signatures: signatures,
      lastModified: Date.now()
    };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    log.warn(`写入签名缓存失败 (${modelKey}):`, e?.message || e);
  }
}

/**
 * 获取最新的签名条目
 * @param {string} modelKey - 模型 key
 * @returns {{ signature: string, content: string } | null}
 */
function getLatestEntry(modelKey) {
  if (!modelKey) return null;
  
  const signatures = readModelCache(modelKey);
  if (signatures.length === 0) return null;
  
  return signatures[signatures.length - 1] || null;
}

/**
 * 添加新签名条目（FIFO 环形队列）
 * @param {string} modelKey - 模型 key
 * @param {Object} entry - 签名条目 { signature, content }
 */
function pushEntry(modelKey, entry) {
  if (!modelKey || !entry || !entry.signature) return;
  
  const signatures = readModelCache(modelKey);
  
  // 去重：避免同一个签名重复入队
  if (signatures.length > 0 && signatures[signatures.length - 1]?.signature === entry.signature) {
    return;
  }
  
  // 添加新条目
  signatures.push(entry);
  
  // 超过容量时移除最旧的
  while (signatures.length > MAX_SIGNATURES_PER_MODEL) {
    signatures.shift();
  }
  
  writeModelCache(modelKey, signatures);
}

/**
 * 判断是否应该缓存签名
 * @param {Object} options - 选项
 * @param {boolean} options.hasTools - 是否使用了工具
 * @param {boolean} options.isImageModel - 是否是图像模型
 * @returns {boolean}
 */
export function shouldCacheSignature({ hasTools = false, isImageModel = false } = {}) {
  // 全部缓存签名开启时，任何时候都缓存
  if (config.cacheAllSignatures) return true;
  
  // 工具签名开启且使用了工具
  if (config.cacheToolSignatures && hasTools) return true;
  
  // 图像签名开启且是图像模型
  if (config.cacheImageSignatures && isImageModel) return true;
  
  return false;
}

/**
 * 判断是否是图像模型
 * @param {string} model - 模型名称
 * @returns {boolean}
 */
export function isImageModel(model) {
  if (!model) return false;
  const lowerModel = model.toLowerCase();
  // 识别：model 含 image、gpt-image、seedream、doubao、vision-image 即为图片模型
  return (
    lowerModel.includes('image') ||
    lowerModel.includes('gpt-image') ||
    lowerModel.includes('seedream') ||
    lowerModel.includes('doubao') ||
    lowerModel.includes('vision-image')
  );
}

/**
 * 处理思考内容（根据 cacheThinking 配置）
 * @param {string} content - 原始思考内容
 * @returns {string} 处理后的内容
 */
function processThinkingContent(content) {
  if (!config.cacheThinking) {
    return ' '; // 不缓存思考内容时用空格替代
  }
  return content || ' ';
}

/**
 * 设置签名和内容（通用接口）
 * @param {string} sessionId - 会话 ID（参与缓存 key，隔离并发会话）
 * @param {string} model - 模型名称
 * @param {string} signature - 签名
 * @param {string} content - 思考内容（可选）
 * @param {Object} options - 选项
 * @param {boolean} options.hasTools - 是否使用了工具
 * @param {boolean} options.isImageModel - 是否是图像模型
 */
export function setSignature(sessionId, model, signature, content = ' ', options = {}) {
  if (!signature || !model) return;
  
  // 判断是否应该缓存
  const isImage = options.isImageModel ?? isImageModel(model);
  const hasTools = options.hasTools ?? false;
  
  if (!shouldCacheSignature({ hasTools, isImageModel: isImage })) {
    return; // 不符合缓存条件
  }
  
  const processedContent = processThinkingContent(content);
  pushEntry(makeModelKey(model, sessionId), { signature, content: processedContent });
}

/**
 * 获取签名和内容
 * @param {string} sessionId - 会话 ID
 * @param {string} model - 模型名称
 * @param {Object} options - 选项
 * @param {boolean} options.hasTools - 是否使用了工具
 * @returns {{ signature: string, content: string } | null}
 */
export function getSignature(sessionId, model, options = {}) {
  if (!model) return null;

  let entry = getLatestEntry(makeModelKey(model, sessionId));
  if (!entry && sessionId) {
    entry = getLatestEntry(makeModelKey(model));
    if (entry) pushEntry(makeModelKey(model, sessionId), entry);
  }
  if (!entry) return null;
  
  // 根据 cacheThinking 配置处理返回的内容
  return {
    signature: entry.signature,
    content: config.cacheThinking ? entry.content : ' '
  };
}

// ========== 兼容旧 API ==========

/**
 * 设置思维链签名和内容（兼容旧 API）
 * @param {string} sessionId - 会话 ID
 * @param {string} model - 模型名称
 * @param {string} signature - 签名
 * @param {string} content - 思考内容
 * @param {Object} options - 选项
 */
export function setReasoningSignature(sessionId, model, signature, content = ' ', options = {}) {
  setSignature(sessionId, model, signature, content, options);
}

/**
 * 获取思维链签名和内容（兼容旧 API）
 * @param {string} sessionId - 会话 ID
 * @param {string} model - 模型名称
 * @param {Object} options - 选项
 * @returns {{ signature: string, content: string } | null}
 */
export function getReasoningSignature(sessionId, model, options = {}) {
  return getSignature(sessionId, model, options);
}

/**
 * 设置工具签名和内容（兼容旧 API，实际上现在统一存储）
 * @param {string} sessionId - 会话 ID
 * @param {string} model - 模型名称
 * @param {string} signature - 签名
 * @param {string} content - 思考内容
 * @param {Object} options - 选项
 */
export function setToolSignature(sessionId, model, signature, content = ' ', options = {}) {
  // 工具签名默认 hasTools = true
  setSignature(sessionId, model, signature, content, { ...options, hasTools: true });
}

/**
 * 获取工具签名和内容（兼容旧 API）
 * @param {string} sessionId - 会话 ID
 * @param {string} model - 模型名称
 * @param {Object} options - 选项
 * @returns {{ signature: string, content: string } | null}
 */
export function getToolSignature(sessionId, model, options = {}) {
  return getSignature(sessionId, model, options);
}

/**
 * 清理所有签名缓存（删除缓存目录下的所有文件）
 */
export function clearThoughtSignatureCaches() {
  try {
    if (fs.existsSync(CACHE_DIR)) {
      const files = fs.readdirSync(CACHE_DIR);
      for (const file of files) {
        if (file.endsWith('.json')) {
          fs.unlinkSync(path.join(CACHE_DIR, file));
        }
      }
    }
    log.info('签名缓存已清除');
  } catch (e) {
    log.warn('清除签名缓存失败:', e?.message || e);
  }
}

// 初始化时确保目录存在
ensureCacheDir();
