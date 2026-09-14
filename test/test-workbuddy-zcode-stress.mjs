import http from "http";

const API_KEY = "sk-agy-proxy";
const HOST = "127.0.0.1";
const PORT = 8045;

function makeRequest({ model, prompt, stream = false }) {
  return new Promise((resolve) => {
    const start = Date.now();
    const payload = JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream
    });

    const options = {
      hostname: HOST,
      port: PORT,
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Length": Buffer.byteLength(payload)
      }
    };

    const req = http.request(options, (res) => {
      let data = "";
      let firstTokenTime = null;
      let chunkCount = 0;

      res.on("data", (chunk) => {
        if (!firstTokenTime) firstTokenTime = Date.now() - start;
        chunkCount++;
        data += chunk.toString();
      });

      res.on("end", () => {
        const totalTime = Date.now() - start;
        let success = res.statusCode === 200;
        let snippet = "";
        let hasReasoning = false;

        if (stream) {
          success = success && data.includes("[DONE]");
          hasReasoning = data.includes("reasoning_content");
          const lines = data.split("\n").filter(l => l.startsWith("data: ") && !l.includes("[DONE]"));
          if (lines.length > 0) {
            try {
              const last = JSON.parse(lines[lines.length - 1].slice(6));
              snippet = last.choices?.[0]?.delta?.content || "...";
            } catch {
              snippet = "stream-chunks";
            }
          }
        } else {
          try {
            const parsed = JSON.parse(data);
            snippet = parsed.choices?.[0]?.message?.content?.slice(0, 50) || "";
            hasReasoning = !!parsed.choices?.[0]?.message?.reasoning_content;
          } catch {
            success = false;
          }
        }

        resolve({
          model,
          stream,
          status: res.statusCode,
          success,
          totalTimeMs: totalTime,
          firstTokenMs: firstTokenTime,
          chunkCount,
          hasReasoning,
          snippet
        });
      });
    });

    req.on("error", (err) => {
      resolve({
        model,
        stream,
        status: 0,
        success: false,
        error: err.message,
        totalTimeMs: Date.now() - start
      });
    });

    req.write(payload);
    req.end();
  });
}

async function runStressTest() {
  console.log("==================================================");
  console.log("🚀 开始 WorkBuddy & ZCode 并发压测 (Port 8045)");
  console.log("==================================================");

  const testCases = [
    { model: "workbuddy", prompt: "计算 25 * 4 等于多少？只输出数字", stream: false },
    { model: "workbuddy", prompt: "用一句话解释什么是递归", stream: true },
    { model: "zcode", prompt: "计算 12 * 12 等于多少？只输出数字", stream: false },
    { model: "zcode", prompt: "用一句话解释什么是快速排序", stream: true },
    { model: "hy4", prompt: "计算 7 * 8 等于多少？只输出数字", stream: false },
    { model: "deepseek-v4.1-flash", prompt: "输出 Python 打印 Hello World 代码", stream: true }
  ];

  console.log(`⚡ 同时发起 ${testCases.length} 个并发请求 (含流式 SSE 与非流式)...`);
  const startTime = Date.now();

  const results = await Promise.all(testCases.map(tc => makeRequest(tc)));
  const totalDuration = Date.now() - startTime;

  console.log("\n📊 压测结果明细:");
  console.log("--------------------------------------------------");
  let allSuccess = true;
  for (const r of results) {
    const statusIcon = r.success ? "✅ 成功" : "❌ 失败";
    console.log(`[${statusIcon}] 模型: ${r.model.padEnd(22)} | 模式: ${r.stream ? "流式 SSE" : "非流式  "} | HTTP ${r.status} | 耗时: ${String(r.totalTimeMs).padStart(5)}ms | 思考: ${r.hasReasoning ? "有" : "无"}`);
    if (!r.success) {
      allSuccess = false;
      console.log(`   错误详情: ${r.error || r.status}`);
    } else {
      console.log(`   输出预览: ${r.snippet.replace(/\n/g, " ").trim()}`);
    }
  }

  console.log("--------------------------------------------------");
  console.log(`总耗时: ${totalDuration}ms`);
  const successCount = results.filter(r => r.success).length;
  console.log(`成功率: ${successCount} / ${results.length} (${((successCount / results.length) * 100).toFixed(1)}%)`);

  if (!allSuccess) {
    process.exit(1);
  }
  process.exit(0);
}

runStressTest();
