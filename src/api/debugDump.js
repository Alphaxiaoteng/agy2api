import fs from 'fs/promises';
import path from 'path';
import config from '../config/config.js';
import logger from '../utils/logger.js';

export const DEBUG_DUMP_FILE = path.join(process.cwd(), 'data', 'debug-dump.log');

export function isDebugDumpEnabled() {
  return config.debugDumpRequestResponse === true;
}

let dumpDirEnsured = false;
async function ensureDumpDir() {
  if (dumpDirEnsured) return;
  await fs.mkdir(path.dirname(DEBUG_DUMP_FILE), { recursive: true });
  dumpDirEnsured = true;
}

function getTimestamp() {
  const now = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ` +
    `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}.${pad3(now.getMilliseconds())}`;
}

export function createDumpId(prefix = 'dump') {
  const rand = Math.random().toString(16).slice(2, 10);
  return `${prefix}-${rand}`;
}

async function appendDumpLog(content) {
  await ensureDumpDir();
  await fs.appendFile(DEBUG_DUMP_FILE, content, 'utf8');
}

export function createStreamCollector() {
  return { chunks: [] };
}

export function collectStreamChunk(collector, chunk) {
  if (collector) collector.chunks.push(chunk);
}

export async function dumpFinalRequest(dumpId, requestBody) {
  if (!isDebugDumpEnabled()) return;
  try {
    const json = JSON.stringify(requestBody, null, 2);
    const header = `\n${'='.repeat(80)}\n[${getTimestamp()}] REQUEST ${dumpId}\n${'='.repeat(80)}\n`;
    await appendDumpLog(header + json + '\n');
    logger.warn(`[DEBUG_DUMP ${dumpId}] 已写入请求体到: ${DEBUG_DUMP_FILE}`);
  } catch (e) {
    logger.error(`[DEBUG_DUMP ${dumpId}] 写入请求体失败:`, e?.message || e);
  }
}

export async function dumpStreamResponse(dumpId, collector) {
  if (!isDebugDumpEnabled() || !collector) return;
  try {
    const header = `\n${'-'.repeat(80)}\n[${getTimestamp()}] RESPONSE ${dumpId} (STREAM)\n${'-'.repeat(80)}\n`;
    const rawContent = collector.chunks.join('');
    const jsonObjects = [];
    const lines = rawContent.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:')) {
        const dataStr = trimmed.slice(5).trim();
        if (dataStr && dataStr !== '[DONE]') {
          try {
            const parsed = JSON.parse(dataStr);
            jsonObjects.push(parsed);
          } catch {
            jsonObjects.push({ raw: dataStr });
          }
        }
      }
    }

    const jsonOutput = JSON.stringify(jsonObjects, null, 2);
    const footer = `\n[${getTimestamp()}] END ${dumpId}\n`;

    await appendDumpLog(header + jsonOutput + footer);
    logger.warn(`[DEBUG_DUMP ${dumpId}] 响应记录完成 (${jsonObjects.length} 条数据)`);
  } catch (e) {
    logger.error(`[DEBUG_DUMP ${dumpId}] 写入流式响应失败:`, e?.message || e);
  }
}

export async function dumpFinalRawResponse(dumpId, rawText) {
  if (!isDebugDumpEnabled()) return;
  try {
    const header = `\n${'-'.repeat(80)}\n[${getTimestamp()}] RESPONSE ${dumpId} (NO-STREAM)\n${'-'.repeat(80)}\n`;
    const footer = `\n[${getTimestamp()}] END ${dumpId}\n`;
    await appendDumpLog(header + (rawText ?? '') + footer);
    logger.warn(`[DEBUG_DUMP ${dumpId}] 响应记录完成`);
  } catch (e) {
    logger.error(`[DEBUG_DUMP ${dumpId}] 写入响应失败:`, e?.message || e);
  }
}
