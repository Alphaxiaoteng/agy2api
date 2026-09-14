import http from "http";

function requestModel(provider, modelId) {
  const start = Date.now();
  const payload = JSON.stringify({
    model: modelId,
    messages: [{ role: "user", content: "ping" }],
    stream: true
  });

  return new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: 8045,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload)
      },
      timeout: 30000
    }, (res) => {
      let rawData = "";
      let firstByteTime = null;

      res.on("data", (chunk) => {
        if (!firstByteTime) {
          firstByteTime = ((Date.now() - start) / 1000).toFixed(2);
        }
        rawData += chunk.toString();
      });

      res.on("end", () => {
        const totalTime = ((Date.now() - start) / 1000).toFixed(2);
        let finalContent = "";
        let reasoningContent = "";
        let hasKeepAlive = rawData.includes(": keep-alive");

        const lines = rawData.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const delta = json.choices?.[0]?.delta;
              if (delta?.content) finalContent += delta.content;
              if (delta?.reasoning_content) reasoningContent += delta.reasoning_content;
            } catch {}
          }
        }

        const ok = res.statusCode === 200 && (finalContent.length > 0 || reasoningContent.length > 0);
        resolve({
          provider,
          modelId,
          statusCode: res.statusCode,
          ok,
          firstByteTime: firstByteTime || totalTime,
          totalTime,
          hasKeepAlive,
          content: finalContent.trim().replace(/\s+/g, " ").slice(0, 50),
          reasoning: reasoningContent.trim().replace(/\s+/g, " ").slice(0, 40)
        });
      });
    });

    req.on("error", (err) => {
      resolve({
        provider,
        modelId,
        statusCode: 0,
        ok: false,
        error: err.message,
        totalTime: ((Date.now() - start) / 1000).toFixed(2)
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve({
        provider,
        modelId,
        statusCode: 408,
        ok: false,
        error: "Timeout 30s",
        totalTime: ((Date.now() - start) / 1000).toFixed(2)
      });
    });

    req.write(payload);
    req.end();
  });
}

const models = [
  // Antigravity (AGY)
  { provider: "agy", model: "gemini-3.8-flash" },
  { provider: "agy", model: "gemini-3.7-flash" },
  { provider: "agy", model: "gemini-3.1-pro-high" },

  // WorkBuddy (WB) - 300K 上下文
  { provider: "workbuddy", model: "deepseek-v4.1-flash" },
  { provider: "workbuddy", model: "hy4" },
  { provider: "workbuddy", model: "hy3" },

  // ZCode (智谱)
  { provider: "zcode", model: "glm-5.3-flash" },
  { provider: "zcode", model: "glm-5.3" }
];

console.log("\n==================== DSH 全模型稳定性与时延基准测试 ====================");
for (const item of models) {
  const r = await requestModel(item.provider, item.model);
  if (r.ok) {
    console.log(`✅ [${item.provider.padEnd(9)}] ${item.model.padEnd(21)} | ${r.statusCode} OK | TTFT: ${r.firstByteTime}s, Total: ${r.totalTime}s | KeepAlive: ${r.hasKeepAlive ? "YES" : "NO "} | "${r.content || r.reasoning}"`);
  } else {
    console.log(`❌ [${item.provider.padEnd(9)}] ${item.model.padEnd(21)} | FAIL status: ${r.statusCode}, err: ${r.error || "empty"} in ${r.totalTime}s`);
  }
}
console.log("========================================================================\n");
