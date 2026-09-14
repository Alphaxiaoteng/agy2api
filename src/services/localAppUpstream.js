/**
 * Local Application (WorkBuddy & ZCode) Upstream Service
 *
 * 桥接本地运行且已登录的 WorkBuddy & ZCode 引擎：
 * 1. 自动发现与调用本地已认证的旗舰模型（GLM-5.3, GLM-5.2, DeepSeek-V4-Pro, Kimi-K3.1, MiniMax-M3, 混元等）
 * 2. 支持标准 OpenAI /v1/chat/completions 协议（流式 SSE 与非流式聚合）
 * 3. 完整支持 reasoning_content（思考流）与 content（正文流）
 * 4. 客户端断开自动终止子进程，杜绝孤儿进程与内存泄露
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import readline from "readline";
import crypto from "crypto";
import logger from "../utils/logger.js";

export const CODEBUDDY_BIN = "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy";

// WorkBuddy 专区模型定义 (以 DeepSeek V4.1 Flash 1000K 上下文为官方最高上限)
export const WORKBUDDY_MODELS = [
  { id: "workbuddy", target: "deepseek-v4.1-flash", effort: "medium", autocompact: "300k", display_name: "DeepSeek V4.1", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "workbuddy/deepseek-v4.1-flash", target: "deepseek-v4.1-flash", effort: "medium", autocompact: "300k", display_name: "DeepSeek V4.1", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "deepseek-v4.1-flash", target: "deepseek-v4.1-flash", effort: "medium", autocompact: "300k", display_name: "DeepSeek V4.1", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "workbuddy/hy4", target: "hy4-preview-f", effort: "medium", autocompact: "300k", display_name: "混元 4", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "hy4", target: "hy4-preview-f", effort: "medium", autocompact: "300k", display_name: "混元 4", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "hy4-preview", target: "hy4-preview-f", effort: "medium", autocompact: "300k", display_name: "混元 4", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "workbuddy/hy4-preview", target: "hy4-preview-f", effort: "medium", autocompact: "300k", display_name: "混元 4", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "workbuddy/hy3", target: "hy3", effort: "medium", autocompact: "262k", display_name: "混元 3", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "hy3", target: "hy3", effort: "medium", autocompact: "262k", display_name: "混元 3", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "workbuddy/deepseek-v4-pro", target: "deepseek-v4-pro", effort: "medium", autocompact: "300k", display_name: "DeepSeek V4 Pro", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "deepseek-v4-pro", target: "deepseek-v4-pro", effort: "medium", autocompact: "300k", display_name: "DeepSeek V4 Pro", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "workbuddy/kimi-k3-1", target: "kimi-k3-1", effort: "medium", autocompact: "300k", display_name: "Kimi K3.1", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "kimi-k3-1", target: "kimi-k3-1", effort: "medium", autocompact: "300k", display_name: "Kimi K3.1", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "workbuddy/kimi-k2.7", target: "kimi-k2.7", effort: "medium", autocompact: "300k", display_name: "Kimi K2.7", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "workbuddy/minimax-m3", target: "minimax-m3", effort: "medium", autocompact: "300k", display_name: "MiniMax M3", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "minimax-m3", target: "minimax-m3", effort: "medium", autocompact: "300k", display_name: "MiniMax M3", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "workbuddy/hy4-preview-f", target: "hy4-preview-f", effort: "medium", autocompact: "300k", display_name: "混元 4 Preview", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "hy4-preview-f", target: "hy4-preview-f", effort: "medium", autocompact: "300k", display_name: "混元 4 Preview", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "workbuddy/hy3-x", target: "hy3-x", effort: "medium", autocompact: "262k", display_name: "混元 3-X", vendor: "workbuddy", library: "workbuddy", reasoning: true },
  { id: "hy3-x", target: "hy3-x", effort: "medium", autocompact: "262k", display_name: "混元 3-X", vendor: "workbuddy", library: "workbuddy", reasoning: true }
];

// ZCode 专区模型定义 (以 GLM-5.3 Flash 智谱高思考为主力)
export const ZCODE_MODELS = [
  { id: "zcode", target: "glm-5.3-flash", effort: "high", display_name: "GLM-5.3 Flash", vendor: "zcode", library: "zcode", reasoning: true },
  { id: "zcode/glm-5.3-flash", target: "glm-5.3-flash", effort: "high", display_name: "GLM-5.3 Flash", vendor: "zcode", library: "zcode", reasoning: true },
  { id: "glm-5.3-flash", target: "glm-5.3-flash", effort: "high", display_name: "GLM-5.3 Flash", vendor: "zcode", library: "zcode", reasoning: true },
  { id: "zcode/glm-5.3", target: "glm-5.3", effort: "high", display_name: "GLM-5.3", vendor: "zcode", library: "zcode", reasoning: true },
  { id: "glm-5.3", target: "glm-5.3", effort: "high", display_name: "GLM-5.3", vendor: "zcode", library: "zcode", reasoning: true },
  { id: "zcode/glm-5.2", target: "glm-5.2", effort: "medium", display_name: "GLM-5.2", vendor: "zcode", library: "zcode", reasoning: true },
  { id: "glm-5.2", target: "glm-5.2", effort: "medium", display_name: "GLM-5.2", vendor: "zcode", library: "zcode", reasoning: true },
  { id: "zcode/glm-5.1", target: "glm-5.1", effort: "medium", display_name: "GLM-5.1", vendor: "zcode", library: "zcode", reasoning: true },
  { id: "glm-5.1", target: "glm-5.1", effort: "medium", display_name: "GLM-5.1", vendor: "zcode", library: "zcode", reasoning: true },
  { id: "zcode/glm-5v-turbo", target: "glm-5v-turbo", effort: "minimal", display_name: "GLM-5V Turbo", vendor: "zcode", library: "zcode", reasoning: false },
  { id: "glm-5v-turbo", target: "glm-5v-turbo", effort: "minimal", display_name: "GLM-5V Turbo", vendor: "zcode", library: "zcode", reasoning: false }
];

// QwenWork 千问办公专区模型定义 (以 Qwen3.8-Flash 1M 上下文为官方主力旗舰)
export const QWENWORK_MODELS = [
  { id: "qwen", target: "flash", effort: "high", display_name: "Qwen 3.8 Flash (千问办公)", vendor: "qwenwork", library: "qwenwork", reasoning: true },
  { id: "qwenwork", target: "flash", effort: "high", display_name: "Qwen 3.8 Flash (千问办公)", vendor: "qwenwork", library: "qwenwork", reasoning: true },
  { id: "qwen3.8-flash", target: "flash", effort: "high", display_name: "Qwen 3.8 Flash (千问办公)", vendor: "qwenwork", library: "qwenwork", reasoning: true },
  { id: "qwen3.8flash", target: "flash", effort: "high", display_name: "Qwen 3.8 Flash (千问办公)", vendor: "qwenwork", library: "qwenwork", reasoning: true },
  { id: "qwen/qwen3.8-flash", target: "flash", effort: "high", display_name: "Qwen 3.8 Flash (千问办公)", vendor: "qwenwork", library: "qwenwork", reasoning: true },
  { id: "qwenwork/qwen3.8-flash", target: "flash", effort: "high", display_name: "Qwen 3.8 Flash (千问办公)", vendor: "qwenwork", library: "qwenwork", reasoning: true },
  { id: "qwen-flash", target: "flash", effort: "high", display_name: "Qwen 3.8 Flash (千问办公)", vendor: "qwenwork", library: "qwenwork", reasoning: true },
  { id: "qwen/flash", target: "flash", effort: "high", display_name: "Qwen 3.8 Flash (千问办公)", vendor: "qwenwork", library: "qwenwork", reasoning: true },
  { id: "qwen3.8-max", target: "qwen3.8-max-preview", effort: "high", display_name: "Qwen 3.8 Max (千问办公)", vendor: "qwenwork", library: "qwenwork", reasoning: true },
  { id: "qwen/qwen3.8-max", target: "qwen3.8-max-preview", effort: "high", display_name: "Qwen 3.8 Max (千问办公)", vendor: "qwenwork", library: "qwenwork", reasoning: true },
  { id: "qwenwork/qwen3.8-max", target: "qwen3.8-max-preview", effort: "high", display_name: "Qwen 3.8 Max (千问办公)", vendor: "qwenwork", library: "qwenwork", reasoning: true }
];


export function getWorkBuddyModelsList() {
  const now = Math.floor(Date.now() / 1000);
  return WORKBUDDY_MODELS.map(m => ({
    id: m.id,
    object: "model",
    created: now,
    owned_by: "workbuddy",
    library: "workbuddy",
    display_name: m.display_name,
    reasoning: m.reasoning
  }));
}

export function getZCodeModelsList() {
  const now = Math.floor(Date.now() / 1000);
  return ZCODE_MODELS.map(m => ({
    id: m.id,
    object: "model",
    created: now,
    owned_by: "zcode",
    library: "zcode",
    display_name: m.display_name,
    reasoning: m.reasoning
  }));
}

export function getQwenWorkModelsList() {
  const now = Math.floor(Date.now() / 1000);
  return QWENWORK_MODELS.map(m => ({
    id: m.id,
    object: "model",
    created: now,
    owned_by: "qwenwork",
    library: "qwenwork",
    display_name: m.display_name,
    reasoning: m.reasoning
  }));
}

export function getLocalAppModelsList(libraryFilter = "") {
  const lib = String(libraryFilter || "").toLowerCase();
  if (lib === "workbuddy" || lib === "wb") return getWorkBuddyModelsList();
  if (lib === "zcode") return getZCodeModelsList();
  if (lib === "qwenwork" || lib === "qwen") return getQwenWorkModelsList();
  return [...getWorkBuddyModelsList(), ...getZCodeModelsList(), ...getQwenWorkModelsList()];
}

export function isLocalAppRoutableModel(rawModel) {
  if (typeof rawModel !== "string" || !rawModel.trim()) return false;
  const m = rawModel.trim().toLowerCase();
  if (m === "workbuddy" || m.startsWith("workbuddy/") || m.startsWith("wb/")) return true;
  if (m === "codebuddy" || m.startsWith("codebuddy/")) return true;
  if (m === "zcode" || m.startsWith("zcode/")) return true;
  if (m === "qwen" || m.startsWith("qwen/") || m === "qwenwork" || m.startsWith("qwenwork/") || m.includes("qwen3.8")) return true;
  for (const item of [...WORKBUDDY_MODELS, ...ZCODE_MODELS, ...QWENWORK_MODELS]) {
    if (item.id === m) return true;
  }
  return false;
}

export function resolveTargetConfig(rawModel, reqBody = {}) {
  let m = String(rawModel || "").trim().toLowerCase();
  const userEffort = reqBody.reasoning_effort || reqBody.effort || "";
  const userAutocompact = reqBody.autocompact || "";

  // 1. 检查精确预定义列表
  const allModels = [...WORKBUDDY_MODELS, ...ZCODE_MODELS, ...QWENWORK_MODELS];
  const exact = allModels.find(item => item.id.toLowerCase() === m);
  if (exact) {
    return {
      targetModel: exact.target,
      effort: userEffort || exact.effort || "high",
      autocompact: userAutocompact || exact.autocompact || "",
      library: exact.library,
      vendor: exact.vendor || exact.library,
      display_name: exact.display_name
    };
  }

  // 2. 剥除前缀
  let library = "workbuddy";
  if (m.startsWith("zcode/")) {
    m = m.slice(6);
    library = "zcode";
  } else if (m.startsWith("qwenwork/")) {
    m = m.slice(9);
    library = "qwenwork";
  } else if (m.startsWith("qwen/")) {
    m = m.slice(5);
    library = "qwenwork";
  } else if (m.startsWith("workbuddy/")) {
    m = m.slice(10);
    library = "workbuddy";
  } else if (m.startsWith("wb/")) {
    m = m.slice(3);
    library = "workbuddy";
  } else if (m.startsWith("codebuddy/")) {
    m = m.slice(10);
    library = "workbuddy";
  }

  if (m === "workbuddy" || m === "codebuddy" || m === "wb") {
    return {
      targetModel: "deepseek-v4.1-flash",
      effort: userEffort || "max",
      autocompact: userAutocompact || "300k",
      library: "workbuddy"
    };
  }

  if (m === "zcode") {
    return {
      targetModel: "glm-5.3-flash",
      effort: userEffort || "high",
      autocompact: userAutocompact || "",
      library: "zcode"
    };
  }

  if (m === "qwen" || m === "qwenwork" || m.includes("qwen3.8") || library === "qwenwork") {
    let target = "flash";
    if (m.includes("max")) target = "qwen3.8-max-preview";
    return {
      targetModel: target,
      effort: userEffort || "high",
      display_name: target === "flash" ? "Qwen 3.8 Flash" : "Qwen 3.8 Max",
      vendor: "qwenwork",
      library: "qwenwork",
      reasoning: true
    };
  }

  // 3. 常见模型模糊匹配
  if (m.includes("deepseek-v4.1")) {
    return {
      targetModel: "deepseek-v4.1-flash",
      effort: userEffort || "max",
      autocompact: userAutocompact || "300k",
      library: "workbuddy"
    };
  }
  if (m.includes("deepseek-v4-pro")) {
    return {
      targetModel: "deepseek-v4-pro",
      effort: userEffort || "max",
      autocompact: userAutocompact || "",
      library: "workbuddy"
    };
  }
  if (m.includes("glm-5.3-flash")) {
    return {
      targetModel: "glm-5.3-flash",
      effort: userEffort || "high",
      autocompact: userAutocompact || "",
      library: "zcode"
    };
  }
  if (m.includes("glm-5.3")) {
    return {
      targetModel: "glm-5.3",
      effort: userEffort || "high",
      autocompact: userAutocompact || "",
      library: "zcode"
    };
  }
  if (m.includes("glm-5.2")) {
    return {
      targetModel: "glm-5.2",
      effort: userEffort || "medium",
      autocompact: userAutocompact || "",
      library: "zcode"
    };
  }
  if (m.includes("glm-5.1")) {
    return {
      targetModel: "glm-5.1",
      effort: userEffort || "medium",
      autocompact: userAutocompact || "",
      library: "zcode"
    };
  }
  if (m.includes("glm-5v")) {
    return {
      targetModel: "glm-5v-turbo",
      effort: "minimal",
      autocompact: userAutocompact || "",
      library: "zcode"
    };
  }
  if (m.includes("kimi-k3")) {
    return {
      targetModel: "kimi-k3-1",
      effort: userEffort || "high",
      autocompact: userAutocompact || "",
      library: "workbuddy"
    };
  }
  if (m.includes("kimi-k2.7")) {
    return {
      targetModel: "kimi-k2.7",
      effort: userEffort || "medium",
      autocompact: userAutocompact || "",
      library: "workbuddy"
    };
  }
  if (m.includes("kimi-k2.6")) {
    return {
      targetModel: "kimi-k2.6",
      effort: userEffort || "medium",
      autocompact: userAutocompact || "",
      library: "workbuddy"
    };
  }
  if (m.includes("minimax")) {
    return {
      targetModel: "minimax-m3",
      effort: userEffort || "high",
      autocompact: userAutocompact || "",
      library: "workbuddy"
    };
  }
  if (m.includes("hy4")) {
    return {
      targetModel: "hy4-preview-f",
      effort: userEffort || "high",
      autocompact: userAutocompact || "",
      library: "workbuddy"
    };
  }
  if (m.includes("hy3-x")) {
    return {
      targetModel: "hy3-x",
      effort: userEffort || "medium",
      autocompact: userAutocompact || "",
      library: "workbuddy"
    };
  }
  if (m.includes("hy3") || m.includes("hunyuan")) {
    return {
      targetModel: "hy3",
      effort: userEffort || "medium",
      autocompact: userAutocompact || "",
      library: "workbuddy"
    };
  }

  return {
    targetModel: m,
    effort: userEffort || "high",
    autocompact: userAutocompact || "",
    library
  };
}

export function formatMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { prompt: "", system: "" };
  }
  let system = "";
  let parts = [];
  for (const msg of messages) {
    const role = msg.role || "user";
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content.map(c => {
        if (typeof c === "string") return c;
        if (c.text) return c.text;
        if (c.type === "text") return c.text || "";
        return "";
      }).join("");
    }

    if (role === "tool") {
      text = `[Tool Result ${msg.name || msg.tool_call_id || ""}: ${text || JSON.stringify(msg.content || "")}]`;
    } else if (role === "assistant" && msg.tool_calls) {
      const callsStr = JSON.stringify(msg.tool_calls);
      text = (text ? text + "\n" : "") + `[Calling Tool: ${callsStr}]`;
    }

    if (!text.trim()) continue;

    if (role === "system") {
      system += (system ? "\n\n" : "") + text.trim();
    } else if (role === "user") {
      parts.push("User: " + text.trim());
    } else if (role === "assistant") {
      parts.push("Assistant: " + text.trim());
    } else if (role === "tool") {
      parts.push("Tool Response: " + text.trim());
    }
  }

  if (parts.length === 1 && parts[0].startsWith("User: ") && !system) {
    return { prompt: parts[0].slice(6), system: "" };
  }

  return { prompt: parts.join("\n\n"), system };
}

/**
 * 解析 DeepSeek 原生 DSML 工具调用格式：
 * < | DSML | | calls>
 * < | DSML | | invoke name="ToolName">
 * < | DSML | | parameter name="param" string="true">value</ | DSML | | parameter>
 * </ | DSML | | invoke>
 * </ | DSML | | calls>
 *
  * 转换为 OpenAI 标准的 tool_calls 结构体
  */
export function parseDsmlToolCalls(raw, expectedTools = []) {
  if (!raw || typeof raw !== "string") {
    return { text: raw || "", toolCalls: [] };
  }

  const toolCalls = [];
  let cleanText = raw;
  let idx = 0;

  // 1. 匹配 DeepSeek 原生及畸形 DSML 格式 (< | DSML | | invoke name="..."> 或 < | | DSML | | calls> ... </invoke>)
  if (raw.includes("DSML")) {
    const dsmlBlockRegex = /<[\s|｜]*DSML[\s|｜]*(?:calls|invoke)(?:\s+name=["']([^"']+)["'])?\s*>([\s\S]*?)<\/(?:[\s|｜]*DSML[\s|｜]*)?(?:calls|invoke)>/gi;
    let match;
    let matchedBlocks = [];
    while ((match = dsmlBlockRegex.exec(raw)) !== null) {
      matchedBlocks.push(match[0]);
      let fnName = match[1] || (expectedTools.includes("exec") ? "exec" : "exec_command");
      const body = match[2];
      const args = {};
      const paramRegex = /<(?:[\s|｜]*DSML[\s|｜]*)?parameter\s+name=["']([^"']+)["'](?:\s+string=["'](true|false)["'])?\s*>([\s\S]*?)<\/(?:[\s|｜]*DSML[\s|｜]*)?parameter\s*>/gi;
      let pMatch;
      while ((pMatch = paramRegex.exec(body)) !== null) {
        const pName = pMatch[1];
        const isString = pMatch[2] === "true";
        let val = pMatch[3].trim();
        if (!isString) {
          try { val = JSON.parse(val); } catch {}
        }
        args[pName] = val;
      }
      normalizeAndPush(fnName, args);
    }
    for (const b of matchedBlocks) {
      cleanText = cleanText.replace(b, "").trim();
    }
    // 兜底清洗任何遗漏的单独 DSML 标签
    cleanText = cleanText.replace(/<[\s|｜]*\/?[\s|｜]*DSML[\s|｜]*(?:calls|invoke|parameter)?[^>]*>/gi, "").trim();
  }

  // 2. 匹配 XML/标签格式 (<tool_call> ... </tool_call>)
  const xmlToolRegex = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let xMatch;
  while ((xMatch = xmlToolRegex.exec(raw)) !== null) {
    cleanText = cleanText.replace(xMatch[0], "").trim();
    try {
      const parsed = JSON.parse(xMatch[1].trim());
      if (parsed.name) {
        normalizeAndPush(parsed.name, parsed.arguments || parsed.parameters || parsed.input || {});
      }
    } catch {}
  }

  // 3. 匹配 Markdown 代码块格式 (```tool_call 或 ```json:tool_call)
  const mdToolRegex = /```(?:tool_call|tool-call|json:tool_call)\s*\n([\s\S]*?)\n```/gi;
  let mMatch;
  while ((mMatch = mdToolRegex.exec(raw)) !== null) {
    cleanText = cleanText.replace(mMatch[0], "").trim();
    try {
      const parsed = JSON.parse(mMatch[1].trim());
      if (parsed.name) {
        normalizeAndPush(parsed.name, parsed.arguments || parsed.parameters || parsed.input || {});
      }
    } catch {}
  }

  // 4. 匹配纯文本伪工具调用格式 (Tool: exec_command\n\n{"cmd":"..."} 或 Action: ...\nAction Input: {...})
  const textToolRegex = /(?:^|\n)(?:Tool|Action|Tool Call):\s*([a-zA-Z0-9_-]+)\s*(?:\n+|\s+)(?:Action Input:\s*)?(\{[\s\S]*?\})(?=\n*(?:(?:Tool|Action|Tool Call):|$))/gi;
  let tMatch;
  let matchedTextSections = [];
  while ((tMatch = textToolRegex.exec(raw)) !== null) {
    matchedTextSections.push(tMatch[0]);
    const fnName = tMatch[1].trim();
    const rawArgs = tMatch[2].trim();
    let parsedArgs = {};
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      try {
        parsedArgs = JSON.parse(rawArgs.replace(/'/g, '"'));
      } catch {
        parsedArgs = { cmd: rawArgs };
      }
    }
    normalizeAndPush(fnName, parsedArgs);
  }

  for (const sec of matchedTextSections) {
    cleanText = cleanText.replace(sec, "").trim();
  }

  // 5. 匹配 <<<TOOL_CALL: name>>>\nargs\n<<<END_TOOL_CALL>>> 格式 (DeepSeek/WorkBuddy 文本泄露格式)
  const angleToolRegex = /<<<TOOL_CALL:\s*([a-zA-Z0-9_.-]+)\s*>>>([\s\S]*?)(?:<<<END_TOOL_CALL>>>|(?=<<<TOOL_CALL)|$)/gi;
  let aMatch;
  let matchedAngleSections = [];
  while ((aMatch = angleToolRegex.exec(raw)) !== null) {
    if (!aMatch[1] || !aMatch[2].trim()) continue;
    matchedAngleSections.push(aMatch[0]);
    const fnName = aMatch[1].trim();
    const rawArgs = aMatch[2].trim();
    let parsedArgs = {};
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      try {
        parsedArgs = JSON.parse(rawArgs.replace(/'/g, '"'));
      } catch {
        parsedArgs = { cmd: rawArgs };
      }
    }
    normalizeAndPush(fnName, parsedArgs);
  }
  for (const sec of matchedAngleSections) {
    cleanText = cleanText.replace(sec, "").trim();
  }

  function normalizeAndPush(fnName, args) {
    const lowerFn = fnName.toLowerCase();
    let finalArgs = { ...args };
    if (lowerFn === "bash" || lowerFn === "exec" || lowerFn === "exec_command") {
      const commandStr = args.cmd || args.command || args.code || "";
      if (expectedTools.includes("exec")) {
        fnName = "exec";
      } else {
        fnName = "exec_command";
      }
      finalArgs = { cmd: commandStr };
    } else if (lowerFn === "websearch" || lowerFn === "web_search") {
      const queryStr = args.query || args.search_query || args.q || "";
      fnName = "web_search";
      finalArgs = { query: queryStr };
    } else if (lowerFn === "edit" || lowerFn === "write" || lowerFn === "apply_patch") {
      if (expectedTools.includes("apply_patch")) {
        fnName = "apply_patch";
        finalArgs = { patch: args.patch || args.diff || args.content || "" };
      }
    }

    toolCalls.push({
      index: idx++,
      id: "call_tool_" + crypto.randomBytes(6).toString("hex"),
      type: "function",
      function: {
        name: fnName,
        arguments: JSON.stringify(finalArgs)
      }
    });
  }

  return { text: cleanText, toolCalls };
}

export async function proxyLocalAppChat(req, res) {
  const rawModel = req.body?.model;
  const config = resolveTargetConfig(rawModel, req.body || {});

  // 彻底阻断千问办公，避免任何应用弹窗或界面污染
  if (config.library === "qwenwork" || (typeof config.vendor === "string" && config.vendor === "qwenwork") || (typeof rawModel === "string" && rawModel.toLowerCase().includes("qwen"))) {
    return res.status(403).json({
      error: {
        message: "千问办公已根据用户设定全局禁用，请切换至 gemini-3.8-flash 或 glm-5.3-flash",
        type: "permission_denied",
        code: "qwen_disabled_by_user"
      }
    });
  }

  // 严格隔离：凡是 ZCode / GLM 智谱模型，绝对禁止落入 WorkBuddy CLI
  if (config.library === "zcode" || (typeof config.targetModel === "string" && config.targetModel.toLowerCase().includes("glm"))) {
    return proxyZCodeChat(req, res, config);
  }

  const stream = !!req.body?.stream;
  const incomingTools = Array.isArray(req.body?.tools) ? req.body.tools : [];
  const expectedToolNames = incomingTools.map(t => t.function?.name || t.name).filter(Boolean);
  const { prompt, system } = formatMessages(req.body?.messages);

  if (!fs.existsSync(CODEBUDDY_BIN)) {
    return res.status(503).json({
      error: {
        message: "本地 WorkBuddy CLI 未找到: " + CODEBUDDY_BIN + "，请确保 WorkBuddy.app 处于安装状态",
        type: "service_unavailable",
        code: "workbuddy_cli_not_found"
      }
    });
  }

  if (!prompt) {
    return res.status(400).json({
      error: {
        message: "messages 不能为空或缺少文本内容",
        type: "invalid_request_error",
        code: "empty_messages"
      }
    });
  }

  const reqId = "chatcmpl-" + config.library + "-" + crypto.randomBytes(12).toString("hex");
  const created = Math.floor(Date.now() / 1000);

  logger.info(`[LocalAppUpstream] 路由模型: raw=${rawModel} -> target=${config.targetModel}, library=${config.library}, effort=${config.effort}, autocompact=${config.autocompact || "default"}, stream=${stream}, tools=${expectedToolNames.length}`);

  // 创建临时 System Prompt 文件，彻底物理覆盖 WorkBuddy 内置的庞大 Agent 人设
  let sysPromptFile = "";
  try {
    const cleanSystem = system || "You are an expert AI programming assistant. Strictly follow user instructions, write clean code, and output standard tool calls when required.";
    sysPromptFile = path.join(os.tmpdir(), `wb_sys_${reqId}.txt`);
    fs.writeFileSync(sysPromptFile, cleanSystem, "utf8");
  } catch (e) {
    logger.warn("[LocalAppUpstream] 写入系统提示词临时文件失败:", e.message);
  }

  const cliArgs = [
    "--model", config.targetModel,
    "--effort", config.effort || "medium",
    "--no-session-persistence",
    "--tools", "",
    "--output-format=stream-json"
  ];

  if (sysPromptFile && fs.existsSync(sysPromptFile)) {
    cliArgs.push("--system-prompt-file", sysPromptFile);
  }

  if (config.autocompact) {
    cliArgs.push("--autocompact", config.autocompact);
  }

  // 纯净 prompt 写入 stdin，由于 system 已经由 --system-prompt-file 接管，此处不再精神分裂
  const fullPrompt = prompt;

  let cp;
  try {
    cp = spawn(CODEBUDDY_BIN, cliArgs, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    cp.stdin.write(fullPrompt);
    cp.stdin.end();
  } catch (err) {
    logger.error("[LocalAppUpstream] 启动子进程失败:", err.message);
    return res.status(500).json({
      error: {
        message: "启动本地代理进程失败: " + err.message,
        type: "internal_server_error",
        code: "spawn_failed"
      }
    });
  }

  let keepAliveTimer = null;

  // 客户端连接断开时回收子进程并清理临时文件
  const cleanupProcess = () => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    if (sysPromptFile && fs.existsSync(sysPromptFile)) {
      try { fs.unlinkSync(sysPromptFile); } catch {}
    }
    if (!cp.killed) {
      try { cp.kill("SIGTERM"); } catch {}
    }
  };

  res.on("close", () => {
    if (!res.writableEnded) cleanupProcess();
  });
  cp.on("exit", () => {
    if (sysPromptFile && fs.existsSync(sysPromptFile)) {
      try { fs.unlinkSync(sysPromptFile); } catch {}
    }
  });

  const rl = readline.createInterface({ input: cp.stdout });

  if (stream) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // 初始第一个空分块
    const firstChunk = {
      id: reqId,
      object: "chat.completion.chunk",
      created,
      model: rawModel,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
    };
    res.write("data: " + JSON.stringify(firstChunk) + "\n\n");

    // 每 1.5 秒发送 SSE 保活注释，防止 DSH / Cursor 8秒 transport timeout
    keepAliveTimer = setInterval(() => {
      if (!res.writableEnded) {
        try {
          res.write(": keep-alive\n\n");
        } catch {}
      }
    }, 1500);

    let hasToolCalls = false;
    let collectedToolCalls = [];

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const d = JSON.parse(line);
        if (d.type === "assistant" && d.message?.content) {
          for (const item of d.message.content) {
            if (item.type === "thinking" && item.thinking) {
              const chunk = {
                id: reqId,
                object: "chat.completion.chunk",
                created,
                model: rawModel,
                choices: [{ index: 0, delta: { reasoning_content: item.thinking }, finish_reason: null }]
              };
              res.write("data: " + JSON.stringify(chunk) + "\n\n");
            } else if (item.type === "text" && item.text) {
              const { text, toolCalls } = parseDsmlToolCalls(item.text, expectedToolNames);
              if (text) {
                const chunk = {
                  id: reqId,
                  object: "chat.completion.chunk",
                  created,
                  model: rawModel,
                  choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
                };
                res.write("data: " + JSON.stringify(chunk) + "\n\n");
              }
              if (toolCalls && toolCalls.length > 0) {
                hasToolCalls = true;
                collectedToolCalls.push(...toolCalls);
                const chunk = {
                  id: reqId,
                  object: "chat.completion.chunk",
                  created,
                  model: rawModel,
                  choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }]
                };
                res.write("data: " + JSON.stringify(chunk) + "\n\n");
              }
            } else if (item.type === "tool_use") {
              // 支持 WorkBuddy CLI 原生 tool_use 事件转换
              hasToolCalls = true;
              let fnName = item.name || "exec_command";
              let finalArgs = item.input || {};
              const lowerFn = fnName.toLowerCase();
              if (lowerFn === "bash" || lowerFn === "exec" || lowerFn === "exec_command") {
                fnName = expectedToolNames.includes("exec") ? "exec" : "exec_command";
                finalArgs = { cmd: finalArgs.command || finalArgs.cmd || "" };
              }
              const nativeToolCall = {
                index: collectedToolCalls.length,
                id: item.id || ("call_" + crypto.randomBytes(6).toString("hex")),
                type: "function",
                function: {
                  name: fnName,
                  arguments: JSON.stringify(finalArgs)
                }
              };
              collectedToolCalls.push(nativeToolCall);
              const chunk = {
                id: reqId,
                object: "chat.completion.chunk",
                created,
                model: rawModel,
                choices: [{ index: 0, delta: { tool_calls: [nativeToolCall] }, finish_reason: null }]
              };
              res.write("data: " + JSON.stringify(chunk) + "\n\n");
            }
          }
        }
      } catch {}
    });

    rl.on("close", () => {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }
      const finishReason = hasToolCalls ? "tool_calls" : "stop";
      const finalChunk = {
        id: reqId,
        object: "chat.completion.chunk",
        created,
        model: rawModel,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
      };
      res.write("data: " + JSON.stringify(finalChunk) + "\n\n");
      res.write("data: [DONE]\n\n");
      res.end();
      logger.info(`[LocalAppUpstream] 流式会话完成: ${rawModel}, finishReason=${finishReason}, toolCalls=${collectedToolCalls.length}`);
    });

    cp.on("error", (err) => {
      logger.error("[LocalAppUpstream] 进程异常:", err.message);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: err.message } });
      } else {
        res.end();
      }
    });

  } else {
    // 非流式聚合
    let fullReasoning = "";
    let fullContent = "";
    let hasResult = false;
    let finalResultText = "";
    let nativeToolCalls = [];

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const d = JSON.parse(line);
        if (d.type === "assistant" && d.message?.content) {
          for (const item of d.message.content) {
            if (item.type === "thinking" && item.thinking) {
              fullReasoning += item.thinking;
            } else if (item.type === "text" && item.text) {
              fullContent += item.text;
            } else if (item.type === "tool_use") {
              let fnName = item.name || "exec_command";
              let finalArgs = item.input || {};
              const lowerFn = fnName.toLowerCase();
              if (lowerFn === "bash" || lowerFn === "exec" || lowerFn === "exec_command") {
                fnName = expectedToolNames.includes("exec") ? "exec" : "exec_command";
                finalArgs = { cmd: finalArgs.command || finalArgs.cmd || "" };
              }
              nativeToolCalls.push({
                index: nativeToolCalls.length,
                id: item.id || ("call_" + crypto.randomBytes(6).toString("hex")),
                type: "function",
                function: {
                  name: fnName,
                  arguments: JSON.stringify(finalArgs)
                }
              });
            }
          }
        }
        if (d.type === "result" && typeof d.result === "string") {
          hasResult = true;
          finalResultText = d.result;
        }
      } catch {}
    });

    rl.on("close", () => {
      const outText = fullContent.trim() || (hasResult ? finalResultText.trim() : "");
      const { text, toolCalls } = parseDsmlToolCalls(outText, expectedToolNames);
      const allToolCalls = [...nativeToolCalls, ...(toolCalls || [])];
      const finishReason = (allToolCalls && allToolCalls.length > 0) ? "tool_calls" : "stop";

      const messageObj = {
        role: "assistant",
        content: text || null
      };
      if (fullReasoning.trim()) {
        messageObj.reasoning_content = fullReasoning.trim();
      }
      if (allToolCalls && allToolCalls.length > 0) {
        messageObj.tool_calls = allToolCalls;
      }

      const responsePayload = {
        id: reqId,
        object: "chat.completion",
        created,
        model: rawModel,
        choices: [
          {
            index: 0,
            message: messageObj,
            finish_reason: finishReason
          }
        ],
        usage: {
          prompt_tokens: prompt.length,
          completion_tokens: outText.length + fullReasoning.length,
          total_tokens: prompt.length + outText.length + fullReasoning.length
        }
      };
      res.json(responsePayload);
      logger.info(`[LocalAppUpstream] 非流式请求响应完成，模型: ${config.targetModel}, finishReason=${finishReason}`);
    });

    cp.on("error", (err) => {
      logger.error("[LocalAppUpstream] 进程错误:", err.message);
      if (!res.headersSent) {
        res.status(502).json({
          error: {
            message: "本地代理执行失败: " + err.message,
            type: "upstream_error",
            code: "process_error"
          }
        });
      }
    });
  }
}

/**
 * ZCode 专用转发实现
 * 绝对隔离：保证任何情况下绝不借道 WorkBuddy，直连 ZCode 认证与网关
 */
export async function proxyZCodeChat(req, res, config) {
  const rawModel = req.body?.model || "glm-5.3-flash";
  const stream = !!req.body?.stream;
  const { prompt } = formatMessages(req.body?.messages);
  const reqId = "chatcmpl-zcode-" + crypto.randomBytes(12).toString("hex");
  const created = Math.floor(Date.now() / 1000);

  logger.info(`[ZCodeUpstream] 路由智谱模型: raw=${rawModel} -> target=${config.targetModel}, effort=${config.effort}, stream=${stream}`);

  if (!prompt) {
    return res.status(400).json({
      error: {
        message: "messages 不能为空或缺少文本内容",
        type: "invalid_request_error",
        code: "empty_messages"
      }
    });
  }

  // 尝试通过本地 3002 zcode2api 网关转发
  try {
    const zcodePort = 3002;
    const anthropicPayload = {
      model: config.targetModel || "GLM-5.3-Flash",
      stream: false,
      max_tokens: req.body?.max_tokens || 4096,
      messages: req.body?.messages || [{ role: "user", content: prompt }]
    };

    const upstreamRes = await fetch(`http://127.0.0.1:${zcodePort}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(anthropicPayload),
      signal: AbortSignal.timeout(90000)
    });

    if (upstreamRes.ok) {
      const data = await upstreamRes.json();
      let text = "";
      if (Array.isArray(data.content)) {
        text = data.content.map(c => c.text || "").join("");
      } else if (typeof data.content === "string") {
        text = data.content;
      }

      if (stream) {
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        const firstChunk = {
          id: reqId,
          object: "chat.completion.chunk",
          created,
          model: rawModel,
          choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }]
        };
        res.write("data: " + JSON.stringify(firstChunk) + "\n\n");
        res.write("data: [DONE]\n\n");
        return res.end();
      }

      return res.json({
        id: reqId,
        object: "chat.completion",
        created,
        model: rawModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: text },
            finish_reason: "stop"
          }
        ],
        usage: data.usage || { prompt_tokens: prompt.length, completion_tokens: text.length, total_tokens: prompt.length + text.length }
      });
    }

    const errBody = await upstreamRes.text().catch(() => "");
    logger.warn(`[ZCodeUpstream] 3002 网关响应异常 (HTTP ${upstreamRes.status}): ${errBody.slice(0, 200)}`);
  } catch (err) {
    logger.warn(`[ZCodeUpstream] 3002 网关调用未完成: ${err.message}`);
  }

  // 严格隔离防护：由于智谱 Coding Plan 开启了人机校验（Captcha），且绝不回退至 WorkBuddy
  return res.status(503).json({
    error: {
      message: `[ZCode Channel] 智谱 ${config.targetModel || "GLM"} 专线正在由 ZCode.app 独占运行并等待人机验证通行。按照安全守则，已严密阻止借道 WorkBuddy 替跑。请在 ZCode 客户端内发起一次交互或稍后重试。`,
      type: "zcode_captcha_pending",
      code: "zcode_isolated"
    }
  });
}

/**
 * 格式化千问办公 Prompt
 */
export function formatQwenWorkPrompt(messages) {
  if (!messages || !messages.length) return "";
  if (messages.length === 1) {
    const m = messages[0];
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content.map(p => p.text || "").join("");
    }
  }

  let prompt = "";
  for (const msg of messages) {
    const role = msg.role;
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content.map(p => p.text || "").join("");
    } else if (msg.content) {
      content = JSON.stringify(msg.content);
    }

    if (role === "system" || role === "developer") {
      prompt += `[系统提示]\n${content}\n\n`;
    } else if (role === "user") {
      prompt += `[用户]\n${content}\n\n`;
    } else if (role === "assistant") {
      prompt += `[助手]\n${content}\n\n`;
    }
  }
  return prompt.trim();
}

/**
 * 千问办公专区代理处理器 (Qwen 3.8 Flash / Qwen 3.8 Max)
 * 直连千问办公本地应用 MCP 服务 (54365)，流式响应且自动静默清理历史任务
 */
export async function proxyQwenWorkChat(req, res, config) {
  const rawModel = req.body?.model || "qwen3.8-flash";
  const stream = !!req.body?.stream;
  const prompt = formatQwenWorkPrompt(req.body?.messages);
  const reqId = "chatcmpl-qwen-" + crypto.randomBytes(12).toString("hex");
  const created = Math.floor(Date.now() / 1000);
  const expectedToolNames = (req.body?.tools || [])
    .map(t => t.function?.name || t.name)
    .filter(Boolean);

  logger.info(`[QwenWorkUpstream] 路由千问办公模型: raw=${rawModel} -> target=${config.targetModel}, stream=${stream}, tools=${expectedToolNames.length}`);

  if (!prompt) {
    return res.status(400).json({
      error: {
        message: "messages 不能为空或缺少文本内容",
        type: "invalid_request_error",
        code: "empty_messages"
      }
    });
  }

  // 1. 读取千问办公本地 MCP 凭据，并在未运行时自动启动应用自愈
  const cfgPath = path.join(os.homedir(), ".qwenworkcn/mcp-adaptor.config");
  const ensureQwenWorkRunning = async () => {
    try {
      if (fs.existsSync(cfgPath)) {
        const testCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        const probeRes = await fetch(`${testCfg.url}/tools/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": testCfg.token },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
          signal: AbortSignal.timeout(1200)
        });
        if (probeRes.ok) return testCfg;
      }
    } catch (_) {}

    // 如果未启动或连接不上，自动唤起 QwenWorkCN 应用
    logger.info("[QwenWorkUpstream] 检测到千问办公未运行或接口离线，正在自动唤起 /Applications/QwenWorkCN.app...");
    try {
      const { exec } = await import("child_process");
      exec("open -a /Applications/QwenWorkCN.app");
      // 等待直到应用就绪并生成新凭据（最多等待 6 秒）
      for (let i = 0; i < 15; i++) {
        await new Promise(r => setTimeout(r, 400));
        if (fs.existsSync(cfgPath)) {
          const freshCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          try {
            const probe = await fetch(`${freshCfg.url}/tools/call`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "x-api-key": freshCfg.token },
              body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
              signal: AbortSignal.timeout(1000)
            });
            if (probe.ok) {
              logger.info("[QwenWorkUpstream] 千问办公桌面端已成功自愈启动！");
              return freshCfg;
            }
          } catch (_) {}
        }
      }
    } catch (e) {
      logger.warn("[QwenWorkUpstream] 自动启动千问办公异常: " + e.message);
    }

    if (fs.existsSync(cfgPath)) {
      return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
    }
    throw new Error(`凭据文件未找到且自动启动失败: ${cfgPath}`);
  };

  let qwenCfg;
  try {
    qwenCfg = await ensureQwenWorkRunning();
  } catch (err) {
    return res.status(503).json({
      error: {
        message: `千问办公未运行或 MCP 配置未生成: ${err.message}，请启动 QwenWorkCN 应用`,
        type: "service_unavailable",
        code: "qwenwork_not_ready"
      }
    });
  }

  // 2. 发起 task 创建
  let chatId;
  try {
    const createRes = await fetch(`${qwenCfg.url}/tools/call`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": qwenCfg.token
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
          name: "qwenwork_task_create",
          arguments: { prompt }
        }
      }),
      signal: AbortSignal.timeout(15000)
    });

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      throw new Error(`MCP task_create HTTP ${createRes.status}: ${errText.slice(0, 200)}`);
    }

    const createData = await createRes.json();
    const resultText = createData?.result?.content?.[0]?.text;
    if (!resultText) {
      throw new Error(`MCP task_create 未返回预期内容: ${JSON.stringify(createData)}`);
    }

    const parsedResult = JSON.parse(resultText);
    if (!parsedResult.success || !parsedResult.chatId) {
      throw new Error(`MCP task_create 失败: ${resultText}`);
    }
    chatId = parsedResult.chatId;
  } catch (err) {
    logger.error(`[QwenWorkUpstream] 创建千问任务失败:`, err.message);
    return res.status(500).json({
      error: {
        message: `创建千问办公任务失败: ${err.message}`,
        type: "upstream_error",
        code: "qwenwork_task_create_failed"
      }
    });
  }

  // 辅助函数：后台静默清理/归档任务，确保千问办公 UI 界面不被自动化调用刷屏
  const cleanupTask = () => {
    try {
      const dbPath = path.join(os.homedir(), "Library/Application Support/QwenWorkCN/data/agents.db");
      if (fs.existsSync(dbPath)) {
        spawn("/usr/bin/sqlite3", [dbPath, `UPDATE chats SET deleted_at = ${Date.now()} WHERE id = '${chatId}';`], {
          stdio: "ignore",
          detached: true
        }).unref();
      }
    } catch (_) {}
  };

  let isAborted = false;
  req.on("close", () => {
    isAborted = true;
  });

  // 3. 流式处理
  if (stream) {
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // 初始首包
    const initChunk = {
      id: reqId,
      object: "chat.completion.chunk",
      created,
      model: rawModel,
      choices: [{ index: 0, delta: { role: "assistant", content: "" } }]
    };
    res.write(`data: ${JSON.stringify(initChunk)}\n\n`);

    let sentLength = 0;
    const maxWaitMs = 180000;
    const startTime = Date.now();

    while (!isAborted && (Date.now() - startTime < maxWaitMs)) {
      await new Promise(r => setTimeout(r, 400));
      if (isAborted) break;

      try {
        const detailRes = await fetch(`${qwenCfg.url}/tools/call`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": qwenCfg.token
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: Date.now(),
            method: "tools/call",
            params: {
              name: "qwenwork_task_get_detail",
              arguments: { chatId }
            }
          }),
          signal: AbortSignal.timeout(6000)
        });

        if (detailRes.ok) {
          const detailData = await detailRes.json();
          const detailText = detailData?.result?.content?.[0]?.text;
          if (detailText) {
            const taskDetail = JSON.parse(detailText);
            const messages = taskDetail.messages || [];
            const assistantMsg = messages.find(m => m.role === "assistant");
            const currentText = assistantMsg?.text || "";

            if (currentText.length > sentLength) {
              const delta = currentText.slice(sentLength);
              sentLength = currentText.length;
              const chunk = {
                id: reqId,
                object: "chat.completion.chunk",
                created,
                model: rawModel,
                choices: [{ index: 0, delta: { content: delta } }]
              };
              res.write(`data: ${JSON.stringify(chunk)}\n\n`);
            }

            if (taskDetail.status === "completed" || taskDetail.status === "failed") {
              break;
            }
          }
        }
      } catch (err) {
        logger.warn(`[QwenWorkUpstream] 轮询任务状态警告: ${err.message}`);
      }
    }

    // 结尾包
    const finishChunk = {
      id: reqId,
      object: "chat.completion.chunk",
      created,
      model: rawModel,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
    };
    res.write(`data: ${JSON.stringify(finishChunk)}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
    cleanupTask();
    return;
  }

  // 4. 非流式处理
  let finalText = "";
  const maxWaitMs = 180000;
  const startTime = Date.now();

  while (!isAborted && (Date.now() - startTime < maxWaitMs)) {
    await new Promise(r => setTimeout(r, 600));
    try {
      const detailRes = await fetch(`${qwenCfg.url}/tools/call`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": qwenCfg.token
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: {
            name: "qwenwork_task_get_detail",
            arguments: { chatId }
          }
        }),
        signal: AbortSignal.timeout(6000)
      });

      if (detailRes.ok) {
        const detailData = await detailRes.json();
        const detailText = detailData?.result?.content?.[0]?.text;
        if (detailText) {
          const taskDetail = JSON.parse(detailText);
          const messages = taskDetail.messages || [];
          const assistantMsg = messages.find(m => m.role === "assistant");
          if (assistantMsg?.text) {
            finalText = assistantMsg.text;
          }
          if (taskDetail.status === "completed" || taskDetail.status === "failed") {
            break;
          }
        }
      }
    } catch (err) {
      logger.warn(`[QwenWorkUpstream] 轮询任务状态警告: ${err.message}`);
    }
  }

  cleanupTask();

  const { text, toolCalls } = parseDsmlToolCalls(finalText, expectedToolNames);
  const finishReason = (toolCalls && toolCalls.length > 0) ? "tool_calls" : "stop";

  const messageObj = {
    role: "assistant",
    content: text || null
  };
  if (toolCalls && toolCalls.length > 0) {
    messageObj.tool_calls = toolCalls;
  }

  return res.json({
    id: reqId,
    object: "chat.completion",
    created,
    model: rawModel,
    choices: [
      {
        index: 0,
        message: messageObj,
        finish_reason: finishReason
      }
    ],
    usage: {
      prompt_tokens: Math.ceil(prompt.length / 3),
      completion_tokens: Math.ceil(finalText.length / 3),
      total_tokens: Math.ceil((prompt.length + finalText.length) / 3)
    }
  });
}


