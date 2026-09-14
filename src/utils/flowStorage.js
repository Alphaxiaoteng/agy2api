/**
 * Google Flow Storage & Manifest Manager
 * 职责：
 * 1. 管理基于 jobId 的落盘目录与 manifest.json（原子化写入）
 * 2. 映射安全 opaque mediaId，杜绝路径穿越
 * 3. 获取与流式输出文件
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const DEFAULT_JOBS_DIR = process.env.FLOW_JOBS_DIR || path.join(process.cwd(), 'output/flow/jobs');
export const DEFAULT_ARCHIVE_DIR = process.env.FLOW_ARCHIVE_DIR || path.join(process.cwd(), 'output/flow');

/**
 * Generate output slug following format: {topic}_{model}_{ratio}_{duration}_{shortId}.{ext}
 */
export function generateArchiveSlug({ prompt = 'prompt', model = 'model', aspect = '16-9', duration = 'static', shortId = '', ext = 'png' }) {
  const cleanPrompt = (prompt || 'output')
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 30) || 'output';
  const cleanModel = (model || 'model').replace(/[^\w-]/g, '-');
  const cleanAspect = (aspect || '16-9').replace(':', '-');
  const cleanDuration = typeof duration === 'number' ? `${duration}s` : (duration || 'static');
  const cleanShortId = (shortId || '').replace(/[^\w]/g, '').slice(-8) || crypto.randomBytes(4).toString('hex');
  const cleanExt = (ext || 'png').replace('.', '');
  return `${cleanPrompt}_${cleanModel}_${cleanAspect}_${cleanDuration}_${cleanShortId}.${cleanExt}`;
}

export class FlowStorage {
  constructor(baseDir = process.env.FLOW_STORAGE_DIR || DEFAULT_JOBS_DIR, archiveDir = process.env.FLOW_ARCHIVE_DIR || DEFAULT_ARCHIVE_DIR) {
    const resolvedPath = path.resolve(baseDir);
    this._ensureDir(resolvedPath);
    try {
      this.baseDir = fs.realpathSync(resolvedPath);
    } catch (_) {
      this.baseDir = resolvedPath;
    }
    const resolvedArchive = path.resolve(archiveDir);
    this._ensureDir(resolvedArchive);
    try {
      this.archiveDir = fs.realpathSync(resolvedArchive);
    } catch (_) {
      this.archiveDir = resolvedArchive;
    }
    this.mediaIndex = new Map(); // mediaId -> { jobId, filename, absolutePath, mimeType, upstreamMediaId, clientId, projectId, archivePath }
  }

  _ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  _verifyDirNotSymlink(dirPath) {
    try {
      const stat = fs.lstatSync(dirPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed for storage directory: ${dirPath}`);
      }
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  getJobDir(jobId) {
    if (!jobId || typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(jobId)) {
      throw new Error(`Invalid jobId: ${jobId}`);
    }
    const jobDir = path.join(this.baseDir, jobId);
    // 确保位于 baseDir 边界内
    if (!jobDir.startsWith(`${this.baseDir}${path.sep}`)) {
      throw new Error(`Job directory path escape detected: ${jobDir}`);
    }
    return jobDir;
  }

  createJobDir(jobId) {
    const jobDir = this.getJobDir(jobId);
    if (fs.existsSync(jobDir)) {
      const stat = fs.lstatSync(jobDir);
      if (stat.isSymbolicLink()) {
        throw new Error(`Existing job directory is a symbolic link: ${jobDir}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Job path exists but is not a directory: ${jobDir}`);
      }
    } else {
      this._ensureDir(jobDir);
    }
    return jobDir;
  }

  getManifestPath(jobId) {
    return path.join(this.getJobDir(jobId), 'manifest.json');
  }

  /**
   * 读取任务的 manifest.json
   */
  readManifest(jobId) {
    const manifestPath = this.getManifestPath(jobId);
    if (!fs.existsSync(manifestPath)) {
      return null;
    }
    try {
      const stat = fs.lstatSync(manifestPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return null;
      }
      const content = fs.readFileSync(manifestPath, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      console.error(`[FlowStorage] Failed to read manifest for ${jobId}:`, err);
      return null;
    }
  }

  /**
   * 原子化写入 manifest.json (先写临时文件再 rename)
   */
  writeManifest(jobId, manifestData) {
    const jobDir = this.createJobDir(jobId);
    const manifestPath = path.join(jobDir, 'manifest.json');
    const tmpName = `manifest.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const tmpPath = path.join(jobDir, tmpName);

    if (!manifestPath.startsWith(`${this.baseDir}${path.sep}`) || !tmpPath.startsWith(`${this.baseDir}${path.sep}`)) {
      throw new Error('Manifest path escape detected');
    }
    
    const serialized = JSON.stringify(manifestData, null, 2);
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    fs.renameSync(tmpPath, manifestPath);

    // 索引化 outputs 中的 mediaId
    if (manifestData.outputs && Array.isArray(manifestData.outputs)) {
      for (const item of manifestData.outputs) {
        if (item.mediaId && item.filename && typeof item.filename === 'string') {
          // 防穿越与文件名清洗
          const cleanFilename = path.basename(item.filename);
          if (cleanFilename !== item.filename || item.filename.includes('/') || item.filename.includes('\\') || item.filename.includes('..')) {
            continue;
          }
          const filePath = path.join(jobDir, cleanFilename);
          this.mediaIndex.set(item.mediaId, {
            jobId,
            filename: cleanFilename,
            absolutePath: filePath,
            mimeType: item.mimeType || (cleanFilename.endsWith('.mp4') ? 'video/mp4' : 'image/png'),
            upstreamMediaId: item.upstreamMediaId || null,
            clientId: manifestData.clientId || null,
            projectId: manifestData.projectId || null,
          });
        }
      }
    }
    return manifestData;
  }

  /**
   * 生成唯一 mediaId
   */
  generateMediaId(jobId, index, ext = 'png') {
    const raw = `${jobId}-${index}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
    return `media_${hash}`;
  }

  /**
   * 写入任务输出文件 (原子化：先写临时文件再 rename)
   */
  writeOutputFile(jobId, filename, data) {
    if (!filename || typeof filename !== 'string' || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error(`Invalid output filename: ${filename}`);
    }
    const cleanFilename = path.basename(filename);
    if (cleanFilename !== filename) {
      throw new Error(`Invalid output filename: ${filename}`);
    }

    const jobDir = this.createJobDir(jobId);
    const filePath = path.join(jobDir, cleanFilename);
    const tmpPath = path.join(jobDir, `${cleanFilename}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);

    if (!filePath.startsWith(`${this.baseDir}${path.sep}`) || !tmpPath.startsWith(`${this.baseDir}${path.sep}`)) {
      throw new Error('Output file path escape detected');
    }

    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
    return filePath;
  }

  /**
   * 保存安全上传的本地图片并返回 mediaId
   */
  saveUploadedImage(buffer, mimeType = 'image/png') {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw new Error('Empty or invalid upload buffer');
    }
    const ext = mimeType.includes('jpeg') || mimeType.includes('jpg') ? 'jpg'
      : mimeType.includes('gif') ? 'gif'
      : mimeType.includes('webp') ? 'webp'
      : 'png';
    const uploadId = `upload_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const cleanFilename = `upload_${uploadId}.${ext}`;
    const uploadDir = this.createJobDir(uploadId);
    const filePath = path.join(uploadDir, cleanFilename);
    const mediaId = this.generateMediaId(uploadId, 0, ext);

    fs.writeFileSync(filePath, buffer);
    const manifest = {
      jobId: uploadId,
      type: 'image',
      status: 'completed',
      createdAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      outputs: [
        {
          mediaId,
          filename: cleanFilename,
          mimeType,
          sizeBytes: buffer.length
        }
      ]
    };
    this.writeManifest(uploadId, manifest);
    return {
      mediaId,
      jobId: uploadId,
      filename: cleanFilename,
      mimeType,
      sizeBytes: buffer.length,
      absolutePath: filePath
    };
  }

  /**
   * 归档产物至日分区输出目录：/output/flow/YYYY-MM-DD/{image|video}/{slug}
   */
  archiveOutput({ jobId, type = 'image', filename, data, slugParams = {} }) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const typeSubdir = type === 'video' ? 'video' : 'image';
    const ext = filename.split('.').pop() || (type === 'video' ? 'mp4' : 'png');
    const slug = generateArchiveSlug({
      prompt: slugParams.prompt || 'output',
      model: slugParams.model || 'flow',
      aspect: slugParams.aspect || '16-9',
      duration: slugParams.duration || (type === 'video' ? '5s' : 'static'),
      shortId: slugParams.shortId || jobId,
      ext
    });

    const dateDir = path.join(this.archiveDir, today, typeSubdir);
    this._ensureDir(dateDir);
    const archiveFilePath = path.join(dateDir, slug);

    try {
      fs.writeFileSync(archiveFilePath, data);
      return {
        slug,
        archivePath: archiveFilePath,
        relativeDir: path.join('output', 'flow', today, typeSubdir, slug)
      };
    } catch (err) {
      console.warn(`[FlowStorage] Failed to archive output file ${slug}:`, err.message);
      return null;
    }
  }

  /**
   * 列出所有 job 目录名 (拒绝 symlink 目录)
   */
  listJobs() {
    if (!fs.existsSync(this.baseDir)) return [];
    try {
      return fs.readdirSync(this.baseDir).filter(dir => {
        if (!/^[a-zA-Z0-9_-]+$/.test(dir)) return false;
        const full = path.join(this.baseDir, dir);
        try {
          const lstat = fs.lstatSync(full);
          return lstat.isDirectory() && !lstat.isSymbolicLink();
        } catch (_) {
          return false;
        }
      });
    } catch (_) {
      return [];
    }
  }

  /**
   * 安全解析 mediaId 对应文件
   */
  resolveMedia(mediaId) {
    if (!mediaId || typeof mediaId !== 'string' || !/^media_[a-zA-Z0-9_-]+$/.test(mediaId)) {
      return null;
    }
    
    // 优先内存索引查找并进行安全重校验
    if (this.mediaIndex.has(mediaId)) {
      const item = this.mediaIndex.get(mediaId);
      if (item.absolutePath && item.absolutePath.startsWith(`${this.baseDir}${path.sep}`)) {
        try {
          const lstat = fs.lstatSync(item.absolutePath);
          if (lstat.isFile() && !lstat.isSymbolicLink()) {
            return item;
          }
        } catch (_) {}
      }
    }

    // 内存未命中，扫描本地 jobs 目录下的 manifest
    if (fs.existsSync(this.baseDir)) {
      const jobDirs = fs.readdirSync(this.baseDir);
      for (const dir of jobDirs) {
        if (!/^[a-zA-Z0-9_-]+$/.test(dir)) continue;
        const fullDir = path.join(this.baseDir, dir);
        try {
          const dirLstat = fs.lstatSync(fullDir);
          if (!dirLstat.isDirectory() || dirLstat.isSymbolicLink()) {
            continue;
          }
        } catch (_) {
          continue;
        }

        const manifestPath = path.join(fullDir, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          try {
            const mStat = fs.lstatSync(manifestPath);
            if (!mStat.isFile() || mStat.isSymbolicLink()) continue;

            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (manifest.outputs && Array.isArray(manifest.outputs)) {
              for (const out of manifest.outputs) {
                if (out.mediaId === mediaId && out.filename && typeof out.filename === 'string') {
                  const cleanFilename = path.basename(out.filename);
                  if (cleanFilename !== out.filename || out.filename.includes('/') || out.filename.includes('\\') || out.filename.includes('..')) {
                    continue;
                  }

                  const targetPath = path.resolve(this.baseDir, dir, cleanFilename);
                  // 防路径穿越与符号链接检查
                  if (targetPath.startsWith(`${this.baseDir}${path.sep}`) && fs.existsSync(targetPath)) {
                    const fStat = fs.lstatSync(targetPath);
                    if (!fStat.isFile() || fStat.isSymbolicLink()) {
                      continue;
                    }

                    const resolved = {
                      jobId: manifest.jobId || dir,
                      filename: cleanFilename,
                      absolutePath: targetPath,
                      mimeType: out.mimeType || (cleanFilename.endsWith('.mp4') ? 'video/mp4' : 'image/png'),
                      upstreamMediaId: out.upstreamMediaId || null,
                      clientId: manifest.clientId || null,
                      projectId: manifest.projectId || null,
                    };
                    this.mediaIndex.set(mediaId, resolved);
                    return resolved;
                  }
                }
              }
            }
          } catch (_) {}
        }
      }
    }

    return null;
  }
}

export const defaultFlowStorage = new FlowStorage();
