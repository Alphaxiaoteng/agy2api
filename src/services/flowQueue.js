/**
 * Google Flow In-Process Queue & Concurrency Manager
 * 职责：
 * 1. 保证并发度 concurrency = 1 (单工作器)
 * 2. 队列上限 maxQueue = 10，满载拒绝 (503 Service Unavailable / 429)
 * 3. 严格支持 Idempotency-Key 校验（hash 冲突 409，已完成复用结果）
 * 4. 客户端断开连接时，若尚未提交（queued 状态）允许及时撤销
 */

import crypto from 'crypto';
import EventEmitter from 'events';

export class FlowQueue extends EventEmitter {
  constructor({ concurrency = 1, maxQueue = 10, storage, workerRunner } = {}) {
    super();
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.storage = storage;
    this.workerRunner = workerRunner; // 异步执行函数: async (job, storage) => result

    this.queue = []; // Array of Job objects waiting
    this.activeJobs = new Map(); // jobId -> Job
    this.completedJobs = new Map(); // jobId -> result manifest
    this.idempotencyIndex = new Map(); // idempotencyKey -> { requestHash, jobId, status, result, error, manifest }

    this._hydrateFromStorage();
  }

  /**
   * Hydrate completed and unknown states from storage manifests on initialization
   */
  _hydrateFromStorage() {
    if (!this.storage || typeof this.storage.listJobs !== 'function') return;
    try {
      const jobIds = this.storage.listJobs();
      for (const jobId of jobIds) {
        const manifest = this.storage.readManifest(jobId);
        if (!manifest) continue;

        if (manifest.status === 'completed') {
          this.completedJobs.set(jobId, manifest);
        }

        // Only store idempotencyKeyHash, NEVER raw key
        const keyHash = manifest.idempotencyKeyHash;
        if (keyHash) {
          const reqHash = manifest.requestHash || (manifest.params ? this.calculateRequestHash(manifest.type, manifest.params) : null);
          this.idempotencyIndex.set(keyHash, {
            requestHash: reqHash,
            jobId,
            status: manifest.status,
            result: manifest.status === 'completed' ? manifest : null,
            error: manifest.error || null,
            manifest,
          });
        }
      }
    } catch (err) {
      console.warn('[FlowQueue] Failed to hydrate from storage:', err.message);
    }
  }

  hashIdempotencyKey(key) {
    if (!key || typeof key !== 'string') return null;
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  calculateRequestHash(type, params = {}) {
    const payload = JSON.stringify({
      type,
      model: params.model,
      prompt: params.prompt,
      aspect: params.aspect || params.aspectRatio,
      count: params.count || params.n || 1,
      mode: params.mode,
      duration: params.duration,
      inputAssetIds: params.inputAssetIds || params.refMediaIds || [],
      startAssetId: params.startAssetId || null,
      endAssetId: params.endAssetId || null,
      referenceAssetIds: params.referenceAssetIds || [],
      sourceVideoAssetId: params.sourceVideoAssetId || null,
      accountId: params.accountId || null,
      spaceId: params.spaceId || null,
      clientId: params.clientId || null,
      projectId: params.projectId || null,
    });
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  getQueueStatus() {
    return {
      activeCount: this.activeJobs.size,
      queuedCount: this.queue.length,
      maxQueue: this.maxQueue,
      concurrency: this.concurrency,
      totalCompleted: this.completedJobs.size
    };
  }

  /**
   * 异步快速入队任务 (立刻返回 job 信息与状态，不等待 Worker 执行完毕)
   */
  async enqueueJob({ type, params, idempotencyKey = null, baseUrl = '' }) {
    const reqHash = this.calculateRequestHash(type, params);
    const keyHash = this.hashIdempotencyKey(idempotencyKey);

    // 1. 检查幂等性 (基于 sha256 keyHash)
    if (keyHash) {
      const existing = this.idempotencyIndex.get(keyHash);
      if (existing) {
        if (existing.requestHash !== reqHash) {
          const err = new Error(`Idempotency key was previously used with different parameters`);
          err.status = 409;
          err.code = 'idempotency_conflict';
          throw err;
        }

        // 如果之前的任务已完成，直接复用已保存的结果
        if (existing.status === 'completed' && existing.result) {
          return {
            jobId: existing.jobId,
            status: 'completed',
            isIdempotentReplay: true,
            manifest: existing.result,
            createdAt: existing.result.createdAt || new Date().toISOString()
          };
        }

        const postSubmitUnfinishedStates = new Set([
          'submitted',
          'polling',
          'downloading',
          'processing',
          'unknown',
          'unknown_after_submit',
          'failed_download',
        ]);
        if (postSubmitUnfinishedStates.has(existing.status)) {
          const err = new Error(`Previous job '${existing.jobId}' with this idempotency key ended in unfinished/unknown state (${existing.status}). Manual recovery required.`);
          err.status = 409;
          err.code = 'manual_recovery_required';
          err.jobId = existing.jobId;
          err.manifest = existing.manifest || (this.storage ? this.storage.readManifest(existing.jobId) : null);
          throw err;
        }

        if (existing.status === 'failed' || existing.status === 'canceled') {
          const err = new Error(existing.error?.message || existing.error || `Previous job with this idempotency key failed`);
          err.status = existing.error?.status || 500;
          err.code = existing.error?.code || 'idempotency_failed';
          err.jobId = existing.jobId;
          throw err;
        }

        if (existing.status === 'queued') {
          return {
            jobId: existing.jobId,
            status: 'queued',
            createdAt: new Date().toISOString()
          };
        }
      }
    }

    // 2. 检查队列是否满载
    if (this.queue.length >= this.maxQueue) {
      const err = new Error(`Flow queue is full (max queue size: ${this.maxQueue}). Please retry later.`);
      err.status = 503;
      err.code = 'queue_full';
      throw err;
    }

    // 3. 创建 Job
    const jobId = `flow_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const createdAt = new Date().toISOString();
    const job = {
      jobId,
      type,
      params,
      idempotencyKeyHash: keyHash,
      requestHash: reqHash,
      status: 'queued',
      createdAt,
      startedAt: null,
      completedAt: null,
      baseUrl,
      submittedToBrowser: false,
      canceled: false,
      signal: null
    };

    if (keyHash) {
      this.idempotencyIndex.set(keyHash, {
        requestHash: reqHash,
        jobId,
        status: 'queued',
        result: null,
        error: null,
        manifest: null
      });
    }

    // 4. 写入初态 manifest
    if (this.storage) {
      this.storage.writeManifest(jobId, {
        jobId,
        type,
        status: 'queued',
        params,
        idempotencyKeyHash: keyHash,
        requestHash: reqHash,
        clientId: job.clientId || null,
        projectId: job.projectId || null,
        createdAt: job.createdAt,
        outputs: []
      });
    }

    // 5. 入队并在后台触发调度
    this.queue.push(job);
    process.nextTick(() => {
      this._processNext();
    });

    return {
      jobId,
      status: 'queued',
      createdAt
    };
  }

  /**
   * 提交同步任务 (返回 Promise，直到完成、失败或取消)
   */
  async submitJob({ type, params, idempotencyKey = null, signal = null, baseUrl = '' }) {
    const reqHash = this.calculateRequestHash(type, params);
    const keyHash = this.hashIdempotencyKey(idempotencyKey);

    // 1. 检查幂等性 (基于 sha256 keyHash)
    if (keyHash) {
      const existing = this.idempotencyIndex.get(keyHash);
      if (existing) {
        if (existing.requestHash !== reqHash) {
          const err = new Error(`Idempotency key was previously used with different parameters`);
          err.status = 409;
          err.code = 'idempotency_conflict';
          throw err;
        }

        // 如果之前的任务已完成，直接复用已保存的结果
        if (existing.status === 'completed' && existing.result) {
          return {
            jobId: existing.jobId,
            status: 'completed',
            isIdempotentReplay: true,
            manifest: existing.result
          };
        }

        // 若处于 submitted / polling / downloading / processing / unknown / unknown_after_submit 等未确定/可能已扣费状态
        // 绝对禁止二次扣费重提，一律返回 409 manual_recovery_required
        const postSubmitUnfinishedStates = new Set([
          'submitted',
          'polling',
          'downloading',
          'processing',
          'unknown',
          'unknown_after_submit',
          'failed_download',
        ]);
        if (postSubmitUnfinishedStates.has(existing.status)) {
          const err = new Error(`Previous job '${existing.jobId}' with this idempotency key ended in unfinished/unknown state (${existing.status}). Manual recovery required.`);
          err.status = 409;
          err.code = 'manual_recovery_required';
          err.jobId = existing.jobId;
          err.manifest = existing.manifest || (this.storage ? this.storage.readManifest(existing.jobId) : null);
          throw err;
        }

        // 若 pre-submit 确认失败或取消，直接返回原失败，不自动重新提交
        if (existing.status === 'failed' || existing.status === 'canceled') {
          const err = new Error(existing.error?.message || existing.error || `Previous job with this idempotency key failed`);
          err.status = existing.error?.status || 500;
          err.code = existing.error?.code || 'idempotency_failed';
          err.jobId = existing.jobId;
          throw err;
        }

        // 如果还在排队中，挂钩到该任务的完成/失败/取消事件并绑定当前的 AbortSignal
        if (existing.status === 'queued') {
          return new Promise((resolve, reject) => {
            let settled = false;
            let onAbort = null;

            const cleanup = () => {
              this.off('job:completed', onDone);
              this.off('job:failed', onFail);
              this.off('job:canceled', onCancel);
              if (signal && onAbort) {
                signal.removeEventListener('abort', onAbort);
              }
            };

            const onDone = (jobId, result) => {
              if (jobId === existing.jobId && !settled) {
                settled = true;
                cleanup();
                resolve({ jobId, status: 'completed', isIdempotentReplay: true, manifest: result });
              }
            };

            const onFail = (jobId, err) => {
              if (jobId === existing.jobId && !settled) {
                settled = true;
                cleanup();
                reject(err);
              }
            };

            const onCancel = (jobId, err) => {
              if (jobId === existing.jobId && !settled) {
                settled = true;
                cleanup();
                reject(err || new Error(`Job '${jobId}' was canceled`));
              }
            };

            if (signal) {
              if (signal.aborted) {
                settled = true;
                const abortErr = new Error('Request aborted by client');
                abortErr.name = 'AbortError';
                abortErr.code = 'request_aborted';
                abortErr.status = 499;
                return reject(abortErr);
              }
              onAbort = () => {
                if (!settled) {
                  settled = true;
                  cleanup();
                  const abortErr = new Error('Request aborted by client');
                  abortErr.name = 'AbortError';
                  abortErr.code = 'request_aborted';
                  abortErr.status = 499;
                  reject(abortErr);
                }
              };
              signal.addEventListener('abort', onAbort, { once: true });
            }

            this.on('job:completed', onDone);
            this.on('job:failed', onFail);
            this.on('job:canceled', onCancel);
          });
        }
      }
    }

    // 2. 检查队列是否满载
    if (this.queue.length >= this.maxQueue) {
      const err = new Error(`Flow queue is full (max queue size: ${this.maxQueue}). Please retry later.`);
      err.status = 503;
      err.code = 'queue_full';
      throw err;
    }

    // 3. 创建 Job (只保存 idempotencyKeyHash，不存原始 key)
    const jobId = `flow_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const job = {
      jobId,
      type,
      params,
      idempotencyKeyHash: keyHash,
      requestHash: reqHash,
      status: 'queued',
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      baseUrl,
      submittedToBrowser: false,
      canceled: false,
      signal
    };

    if (keyHash) {
      this.idempotencyIndex.set(keyHash, {
        requestHash: reqHash,
        jobId,
        status: 'queued',
        result: null,
        error: null,
        manifest: null
      });
    }

    // 4. 监听客户端断开取消
    if (signal) {
      const onJobAbort = () => {
        if (job.status === 'queued' && !job.submittedToBrowser) {
          job.canceled = true;
          job.status = 'canceled';
          this.queue = this.queue.filter(j => j.jobId !== jobId);
          const cancelErr = new Error('Job canceled by client abort before execution');
          cancelErr.code = 'job_canceled';
          cancelErr.status = 499;

          if (keyHash && this.idempotencyIndex.has(keyHash)) {
            const entry = this.idempotencyIndex.get(keyHash);
            entry.status = 'canceled';
            entry.error = cancelErr;
          }

          if (this.storage) {
            try {
              this.storage.writeManifest(jobId, {
                jobId,
                type,
                status: 'canceled',
                params,
                idempotencyKeyHash: keyHash,
                requestHash: reqHash,
                clientId: job.clientId || null,
                projectId: job.projectId || null,
                createdAt: job.createdAt,
                failedAt: new Date().toISOString(),
                error: cancelErr.message,
                outputs: []
              });
            } catch (_) {}
          }

          console.log(`[FlowQueue] Job ${jobId} canceled by client abort before processing`);
          this.emit('job:canceled', jobId, cancelErr);
          this.emit('job:failed', jobId, cancelErr);
          if (job._reject) {
            job._reject(cancelErr);
          }
        }
      };

      if (signal.aborted) {
        onJobAbort();
      } else {
        signal.addEventListener('abort', onJobAbort, { once: true });
        job._onSignalAbort = onJobAbort;
      }
    }

    // 5. 写入初态 manifest
    if (this.storage) {
      this.storage.writeManifest(jobId, {
        jobId,
        type,
        status: 'queued',
        params,
        idempotencyKeyHash: keyHash,
        requestHash: reqHash,
        clientId: job.clientId || null,
        projectId: job.projectId || null,
        createdAt: job.createdAt,
        outputs: []
      });
    }

    // 6. 入队并触发处理
    return new Promise((resolve, reject) => {
      job._resolve = resolve;
      job._reject = reject;
      this.queue.push(job);
      this._processNext();
    });
  }

  _processNext() {
    if (this.activeJobs.size >= this.concurrency) {
      return;
    }

    const job = this.queue.shift();
    if (!job) {
      return;
    }

    if (job.canceled) {
      job._reject(new Error('Job canceled before execution'));
      this._processNext();
      return;
    }

    this.activeJobs.set(job.jobId, job);
    job.status = 'processing';
    job.startedAt = new Date().toISOString();

    if (job.idempotencyKeyHash && this.idempotencyIndex.has(job.idempotencyKeyHash)) {
      this.idempotencyIndex.get(job.idempotencyKeyHash).status = 'processing';
    }

    console.log(`[FlowQueue] Starting job ${job.jobId} (${job.type}, model: ${job.params.model})`);

    // 执行 Worker
    (async () => {
      try {
        if (!this.workerRunner) {
          throw new Error('Worker runner is not configured in FlowQueue');
        }

        const manifest = await this.workerRunner(job, this.storage);
        
        job.status = 'completed';
        job.completedAt = new Date().toISOString();
        this.activeJobs.delete(job.jobId);
        this.completedJobs.set(job.jobId, manifest);

        if (job.idempotencyKeyHash && this.idempotencyIndex.has(job.idempotencyKeyHash)) {
          const entry = this.idempotencyIndex.get(job.idempotencyKeyHash);
          entry.status = 'completed';
          entry.result = manifest;
        }

        this.emit('job:completed', job.jobId, manifest);
        if (typeof job._resolve === 'function') {
          job._resolve({
            jobId: job.jobId,
            status: 'completed',
            manifest
          });
        }
      } catch (err) {
        console.error(`[FlowQueue] Job ${job.jobId} failed:`, err);
        job.error = err.message || String(err);
        this.activeJobs.delete(job.jobId);

        // 如果任务在已提交后发生错误/超时，或者显式标记为 submittedToBrowser，置为 unknown_after_submit
        const isUnknown = job.submittedToBrowser || err.code === 'flow_timeout_after_submit' || err.submitted;

        // 区分 client abort / cancel 与真实失败 / 扣费后未知
        const isCanceled = (err.code === 'JOB_ABORTED' || err.code === 'job_canceled' || err.code === 'request_aborted' || err.name === 'AbortError');
        if (!job.submittedToBrowser && isCanceled) {
          job.status = 'canceled';
        } else if (isUnknown) {
          job.status = 'unknown_after_submit';
        } else {
          job.status = 'failed';
        }

        if (this.storage) {
          try {
            this.storage.writeManifest(job.jobId, {
              jobId: job.jobId,
              type: job.type,
              status: job.status,
              params: job.params,
              idempotencyKeyHash: job.idempotencyKeyHash || null,
              requestHash: job.requestHash || null,
              clientId: job.clientId || null,
              projectId: job.projectId || null,
              upstreamMediaIds: job.upstreamMediaIds || [],
              createdAt: job.createdAt,
              startedAt: job.startedAt,
              failedAt: new Date().toISOString(),
              error: job.error,
              outputs: []
            });
          } catch (_) {}
        }

        if (job.idempotencyKeyHash && this.idempotencyIndex.has(job.idempotencyKeyHash)) {
          const entry = this.idempotencyIndex.get(job.idempotencyKeyHash);
          entry.status = job.status;
          entry.error = err;
          if (isUnknown) {
            entry.manifest = this.storage ? this.storage.readManifest(job.jobId) : null;
          }
        }

        if (job.status === 'canceled') {
          this.emit('job:canceled', job.jobId, err);
        }
        this.emit('job:failed', job.jobId, err);
        if (typeof job._reject === 'function') {
          job._reject(err);
        }
      } finally {
        if (job.signal && job._onSignalAbort) {
          try {
            job.signal.removeEventListener('abort', job._onSignalAbort);
          } catch (_) {}
        }
        this._processNext();
      }
    })();
  }
}
