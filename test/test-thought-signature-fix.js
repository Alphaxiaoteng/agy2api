// 测试思考模型下 tool_calls / functionCall 100% 携带 thoughtSignature
import assert from 'assert';
import { generateRequestBody } from '../src/utils/converters/openai.js';
import { generateClaudeRequestBody } from '../src/utils/converters/claude.js';
import { generateGeminiRequestBody } from '../src/utils/converters/gemini.js';
import { convertToGeminiCli } from '../src/utils/converters/geminicli.js';
import config from '../src/config/config.js';

// 保存原始配置
const originalUseCachedSignature = config.useCachedSignature;
const originalUseFallbackSignature = config.useFallbackSignature;

// 模拟 token 对象
const mockToken = {
  sessionId: 'test-session-fix-' + Date.now(),
  projectId: 'test-project',
};

const isNonEmptyBase64 = (str) => {
  if (typeof str !== 'string' || str.length === 0) return false;
  // Base64 pattern (with padding optionally)
  return /^[A-Za-z0-9+/]+={0,2}$/.test(str);
};

console.log('\n=== 开始验证 Function Call 必须 100% 携带有效 thoughtSignature ===\n');

// 场景 1: useFallbackSignature = false 且无缓存签名，客户端发送不带 signature 的 tool_calls (OpenAI 格式)
console.log('测试 1: OpenAI 格式多轮不带 signature 的 tool_calls');
config.useCachedSignature = false;
config.useFallbackSignature = false;

const openaiMessages = [
  {
    role: 'user',
    content: 'What is the weather in Tokyo?'
  },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_123',
        type: 'function',
        function: {
          name: 'get_weather',
          arguments: '{"city": "Tokyo"}'
        }
      },
      {
        id: 'call_456',
        type: 'function',
        function: {
          name: 'get_time',
          arguments: '{"city": "Tokyo"}'
        }
      }
    ]
  },
  {
    role: 'tool',
    tool_call_id: 'call_123',
    name: 'get_weather',
    content: '{"weather": "sunny"}'
  },
  {
    role: 'tool',
    tool_call_id: 'call_456',
    name: 'get_time',
    content: '{"time": "12:00"}'
  }
];

const openaiTools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } }
    }
  }
];

// 对比思考模型与非思考模型
for (const model of ['gemini-2.5-flash', 'claude-opus-4-5-thinking', 'gemini-2.5-pro']) {
  const result = generateRequestBody(openaiMessages, model, {}, openaiTools, mockToken);
  const modelMessage = result.request.contents.find(m => m.role === 'model');
  assert(modelMessage, `Model message should exist for model ${model}`);
  
  const functionCallParts = modelMessage.parts.filter(p => p.functionCall);
  assert.strictEqual(functionCallParts.length, 2, 'Should have 2 function calls');
  
  for (const part of functionCallParts) {
    assert(part.thoughtSignature, `functionCall part must have thoughtSignature for model ${model}`);
    assert(isNonEmptyBase64(part.thoughtSignature), `thoughtSignature must be valid non-empty Base64: ${part.thoughtSignature}`);
  }
  console.log(`✓ OpenAI 转换器验证通过 [${model}]: functionCalls 均携带合法 Base64 thoughtSignature`);
}

// 场景 2: Claude 格式多轮不带 signature 的 tool_use
console.log('\n测试 2: Claude 格式多轮不带 signature 的 tool_use');
const claudeMessages = [
  {
    role: 'user',
    content: 'Check system info'
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'text',
        text: 'Checking system info...'
      },
      {
        type: 'tool_use',
        id: 'toolu_123',
        name: 'get_system_info',
        input: { verbose: true }
      }
    ]
  },
  {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'toolu_123',
        content: 'System is running smoothly'
      }
    ]
  }
];

const claudeTools = [
  {
    name: 'get_system_info',
    description: 'Get info',
    input_schema: { type: 'object', properties: { verbose: { type: 'boolean' } } }
  }
];

for (const model of ['claude-opus-4-5-thinking', 'gemini-2.5-flash']) {
  const result = generateClaudeRequestBody(claudeMessages, model, {}, claudeTools, 'System Prompt', mockToken);
  const modelMessage = result.request.contents.find(m => m.role === 'model');
  assert(modelMessage, `Model message should exist for model ${model}`);
  
  const functionCallParts = modelMessage.parts.filter(p => p.functionCall);
  assert.strictEqual(functionCallParts.length, 1, 'Should have 1 function call');
  
  for (const part of functionCallParts) {
    assert(part.thoughtSignature, `functionCall part must have thoughtSignature for model ${model}`);
    assert(isNonEmptyBase64(part.thoughtSignature), `thoughtSignature must be valid non-empty Base64: ${part.thoughtSignature}`);
  }
  console.log(`✓ Claude 转换器验证通过 [${model}]: functionCalls 均携带合法 Base64 thoughtSignature`);
}

// 场景 3: Gemini 格式直接转换（带有 functionCall 但无 thoughtSignature / 或者带 thought_signature 驼峰转换）
console.log('\n测试 3: Gemini 格式直接转换');
const geminiBody = {
  contents: [
    {
      role: 'user',
      parts: [{ text: 'Execute task' }]
    },
    {
      role: 'model',
      parts: [
        {
          functionCall: {
            name: 'do_task',
            args: { id: 1 }
          }
        },
        {
          thought_signature: 'RXVNQkNrZ0lDaEFDR0FJcVFLZGsvMnlyR0VTbmNKMXEyTFIrcWwyY2ozeHhoZHRPb0VOYWJ2VjZMSnE2MlBhcEQrUWdIM3ZWeHBBUG9rbGN1aXhEbXprZTcvcGlkbWRDQWs5MWcrTVNERnRhbWJFOU1vZWZGc1pWSGhvTUxsMXVLUzRoT3BIaWwyeXBJakNYa05EVElMWS9talprdUxvRjFtMmw5dnkrbENhSDNNM3BYNTM0K1lRZ0NaWTQvSUNmOXo4SkhZVzU2Sm1WcTZBcVNRUURBRGVMV1BQRXk1Q0JsS0dCZXlNdHp2NGRJQVlGbDFSMDBXNGhqNHNiSWNKeGY0UGZVQTBIeE1mZjJEYU5BRXdrWUJ4MmNzRFMrZGM1N1hnUlVNblpkZ0hTVHVNaGdod1lBUT09',
          functionCall: {
            name: 'do_task_2',
            args: { id: 2 }
          }
        }
      ]
    },
    {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: 'do_task',
            response: { result: 'ok' }
          }
        },
        {
          functionResponse: {
            name: 'do_task_2',
            response: { result: 'ok 2' }
          }
        }
      ]
    }
  ],
  tools: [
    {
      functionDeclarations: [
        { name: 'do_task', description: 'desc', parameters: { type: 'OBJECT', properties: {} } },
        { name: 'do_task_2', description: 'desc', parameters: { type: 'OBJECT', properties: {} } }
      ]
    }
  ]
};

for (const model of ['gemini-2.5-pro', 'claude-opus-4-5-thinking']) {
  const result = generateGeminiRequestBody(geminiBody, model, mockToken);
  const modelMessage = result.request.contents.find(m => m.role === 'model');
  assert(modelMessage, `Model message should exist for model ${model}`);
  
  const functionCallParts = modelMessage.parts.filter(p => p.functionCall);
  assert.strictEqual(functionCallParts.length, 2, 'Should have 2 function calls');
  
  for (const part of functionCallParts) {
    assert(part.thoughtSignature, `functionCall part must have thoughtSignature for model ${model}`);
    assert(isNonEmptyBase64(part.thoughtSignature), `thoughtSignature must be valid non-empty Base64: ${part.thoughtSignature}`);
  }
  console.log(`✓ Gemini 转换器验证通过 [${model}]: functionCalls 均携带合法 Base64 thoughtSignature`);
}

// 场景 4: GeminiCLI 转换测试
console.log('\n测试 4: GeminiCLI 转换测试');
const cliOpenAIReq = {
  model: 'gemini-2.5-pro',
  messages: openaiMessages,
  tools: openaiTools
};
const cliResult = convertToGeminiCli(cliOpenAIReq);
const cliModelMessage = cliResult.geminiRequest.contents.find(m => m.role === 'model');
const cliFunctionCallParts = cliModelMessage.parts.filter(p => p.functionCall);
assert.strictEqual(cliFunctionCallParts.length, 2, 'Should have 2 function calls in GeminiCli');
for (const part of cliFunctionCallParts) {
  assert(part.thoughtSignature, `functionCall part in GeminiCli must have thoughtSignature`);
  assert(isNonEmptyBase64(part.thoughtSignature) || part.thoughtSignature.includes('validator'), `thoughtSignature must be valid`);
}
console.log(`✓ GeminiCLI 转换器验证通过: functionCalls 均携带有效 thoughtSignature`);

// 恢复原始配置
config.useCachedSignature = originalUseCachedSignature;
config.useFallbackSignature = originalUseFallbackSignature;

console.log('\n=== 所有 Function Call thoughtSignature 验证通过！ ===\n');
