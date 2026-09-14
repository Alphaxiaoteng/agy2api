// 测试 OpenAI / Claude / Gemini 多轮工具调用时历史 functionCall 的 thoughtSignature 完整性
import assert from 'assert';
import { generateRequestBody } from '../src/utils/converters/openai.js';
import { generateClaudeRequestBody } from '../src/utils/converters/claude.js';
import { generateGeminiRequestBody } from '../src/utils/converters/gemini.js';
import { convertToGeminiCli } from '../src/utils/converters/geminicli.js';
import config from '../src/config/config.js';

// 保存原始配置
const originalUseCachedSignature = config.useCachedSignature;
const originalUseFallbackSignature = config.useFallbackSignature;

const mockToken = {
  sessionId: 'test-multi-turn-sig-' + Date.now(),
  projectId: 'test-project',
};

const isNonEmptyBase64 = (str) => {
  if (typeof str !== 'string' || str.length === 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(str);
};

console.log('\n=== 开始多轮工具调用 thoughtSignature 覆盖与兜底测试 ===\n');

// 强制关闭缓存与兜底开关，模拟最极端情况下客户端未传签名
config.useCachedSignature = false;
config.useFallbackSignature = false;

// 1. OpenAI 格式多轮测试（多字段签名提取与无签名兜底）
console.log('测试 1: OpenAI 格式多轮历史 tool_calls 转换');
const openaiMultiTurnMessages = [
  { role: 'user', content: 'Search weather and stocks' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
        thought_signature: 'RXVNQkNrZ0lDaEFDR0FJcVFLZGsvMnlyR0VTbmNKMXEyTFIrcWwyY2ozeHhoZHRPb0VOYWJ2VjZMSnE2MlBhcEQrUWdIM3ZWeHBBUG9rbGN1aXhEbXprZTcvcGlkbWRDQWs5MWcrTVNERnRhbWJFOU1vZWZGc1pWSGhvTUxsMXVLUzRoT3BIaWwyeXBJakNYa05EVElMWS9talprdUxvRjFtMmw5dnkrbENhSDNNM3BYNTM0K1lRZ0NaWTQvSUNmOXo4SkhZVzU2Sm1WcTZBcVNRUURBRGVMV1BQRXk1Q0JsS0dCZXlNdHp2NGRJQVlGbDFSMDBXNGhqNHNiSWNKeGY0UGZVQTBIeE1mZjJEYU5BRXdrWUJ4MmNzRFMrZGM1N1hnUlVNblpkZ0hTVHVNaGdod1lBUT09'
      },
      {
        id: 'call_2',
        type: 'function',
        function: { name: 'get_stock', arguments: '{"symbol":"GOOG"}' }
        // 故意不传任何签名
      }
    ]
  },
  { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: '{"weather":"sunny"}' },
  { role: 'tool', tool_call_id: 'call_2', name: 'get_stock', content: '{"price":"180"}' },
  {
    role: 'assistant',
    content: 'Here is the final info',
    tool_calls: [
      {
        id: 'call_3',
        type: 'function',
        function: { name: 'format_report', arguments: '{"title":"Report"}' },
        extra_content: {
          thought_signature: 'RXVNQkNrZ0lDaEFDR0FJcVFLZGsvMnlyR0VTbmNKMXEyTFIrcWwyY2ozeHhoZHRPb0VOYWJ2VjZMSnE2MlBhcEQrUWdIM3ZWeHBBUG9rbGN1aXhEbXprZTcvcGlkbWRDQWs5MWcrTVNERnRhbWJFOU1vZWZGc1pWSGhvTUxsMXVLUzRoT3BIaWwyeXBJakNYa05EVElMWS9talprdUxvRjFtMmw5dnkrbENhSDNNM3BYNTM0K1lRZ0NaWTQvSUNmOXo4SkhZVzU2Sm1WcTZBcVNRUURBRGVMV1BQRXk1Q0JsS0dCZXlNdHp2NGRJQVlGbDFSMDBXNGhqNHNiSWNKeGY0UGZVQTBIeE1mZjJEYU5BRXdrWUJ4MmNzRFMrZGM1N1hnUlVNblpkZ0hTVHVNaGdod1lBUT09'
        }
      }
    ]
  },
  { role: 'tool', tool_call_id: 'call_3', name: 'format_report', content: '{"status":"done"}' }
];

const openaiTools = [
  { type: 'function', function: { name: 'get_weather', description: 'desc', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_stock', description: 'desc', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'format_report', description: 'desc', parameters: { type: 'object', properties: {} } } }
];

for (const model of ['gemini-2.5-pro', 'claude-opus-4-5-thinking', 'gemini-2.5-flash']) {
  const result = generateRequestBody(openaiMultiTurnMessages, model, {}, openaiTools, mockToken);
  const modelMessages = result.request.contents.filter(m => m.role === 'model');
  assert.strictEqual(modelMessages.length, 2, 'Should have 2 model messages');
  
  let functionCallCount = 0;
  for (const m of modelMessages) {
    for (const part of m.parts) {
      if (part.functionCall) {
        functionCallCount++;
        assert(part.thoughtSignature, `Part functionCall [${part.functionCall.name}] missing thoughtSignature in ${model}`);
        assert(isNonEmptyBase64(part.thoughtSignature), `Part functionCall [${part.functionCall.name}] has invalid Base64 thoughtSignature`);
      }
    }
  }
  assert.strictEqual(functionCallCount, 3, 'Should have checked 3 function calls');
  console.log(`✓ OpenAI 多轮测试通过 [${model}]`);
}

// 2. Claude 格式多轮测试
console.log('\n测试 2: Claude 格式多轮历史 tool_use 转换');
const claudeMultiTurnMessages = [
  { role: 'user', content: 'Run commands' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Running first step' },
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'exec_cmd',
        input: { cmd: 'ls' },
        extra_content: {
          thought_signature: 'RXVNQkNrZ0lDaEFDR0FJcVFLZGsvMnlyR0VTbmNKMXEyTFIrcWwyY2ozeHhoZHRPb0VOYWJ2VjZMSnE2MlBhcEQrUWdIM3ZWeHBBUG9rbGN1aXhEbXprZTcvcGlkbWRDQWs5MWcrTVNERnRhbWJFOU1vZWZGc1pWSGhvTUxsMXVLUzRoT3BIaWwyeXBJakNYa05EVElMWS9talprdUxvRjFtMmw5dnkrbENhSDNNM3BYNTM0K1lRZ0NaWTQvSUNmOXo4SkhZVzU2Sm1WcTZBcVNRUURBRGVMV1BQRXk1Q0JsS0dCZXlNdHp2NGRJQVlGbDFSMDBXNGhqNHNiSWNKeGY0UGZVQTBIeE1mZjJEYU5BRXdrWUJ4MmNzRFMrZGM1N1hnUlVNblpkZ0hTVHVNaGdod1lBUT09'
        }
      }
    ]
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'file1.txt' }]
  },
  {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'tool_2',
        name: 'read_file',
        input: { file: 'file1.txt' }
        // 故意不传 signature
      }
    ]
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tool_2', content: 'hello world' }]
  }
];

const claudeTools = [
  { name: 'exec_cmd', description: 'desc', input_schema: { type: 'object', properties: {} } },
  { name: 'read_file', description: 'desc', input_schema: { type: 'object', properties: {} } }
];

for (const model of ['claude-opus-4-5-thinking', 'gemini-2.5-flash']) {
  const result = generateClaudeRequestBody(claudeMultiTurnMessages, model, {}, claudeTools, '', mockToken);
  const modelMessages = result.request.contents.filter(m => m.role === 'model');
  assert.strictEqual(modelMessages.length, 2, 'Should have 2 model messages');
  
  let functionCallCount = 0;
  for (const m of modelMessages) {
    for (const part of m.parts) {
      if (part.functionCall) {
        functionCallCount++;
        assert(part.thoughtSignature, `Part functionCall [${part.functionCall.name}] missing thoughtSignature in ${model}`);
        assert(isNonEmptyBase64(part.thoughtSignature), `Part functionCall [${part.functionCall.name}] has invalid Base64 thoughtSignature`);
      }
    }
  }
  assert.strictEqual(functionCallCount, 2, 'Should have checked 2 function calls');
  console.log(`✓ Claude 多轮测试通过 [${model}]`);
}

// 3. Gemini 格式多轮测试
console.log('\n测试 3: Gemini 格式多轮历史 functionCall 转换');
const geminiMultiTurnBody = {
  contents: [
    { role: 'user', parts: [{ text: 'Step 1' }] },
    {
      role: 'model',
      parts: [
        {
          thought_signature: 'RXVNQkNrZ0lDaEFDR0FJcVFLZGsvMnlyR0VTbmNKMXEyTFIrcWwyY2ozeHhoZHRPb0VOYWJ2VjZMSnE2MlBhcEQrUWdIM3ZWeHBBUG9rbGN1aXhEbXprZTcvcGlkbWRDQWs5MWcrTVNERnRhbWJFOU1vZWZGc1pWSGhvTUxsMXVLUzRoT3BIaWwyeXBJakNYa05EVElMWS9talprdUxvRjFtMmw5dnkrbENhSDNNM3BYNTM0K1lRZ0NaWTQvSUNmOXo4SkhZVzU2Sm1WcTZBcVNRUURBRGVMV1BQRXk1Q0JsS0dCZXlNdHp2NGRJQVlGbDFSMDBXNGhqNHNiSWNKeGY0UGZVQTBIeE1mZjJEYU5BRXdrWUJ4MmNzRFMrZGM1N1hnUlVNblpkZ0hTVHVNaGdod1lBUT09',
          functionCall: { name: 'f1', args: {} }
        }
      ]
    },
    { role: 'user', parts: [{ functionResponse: { name: 'f1', response: { res: 'ok' } } }] },
    {
      role: 'model',
      parts: [
        {
          functionCall: { name: 'f2', args: {} } // 没有任何签名
        }
      ]
    },
    { role: 'user', parts: [{ functionResponse: { name: 'f2', response: { res: 'ok' } } }] }
  ],
  tools: [{ functionDeclarations: [{ name: 'f1', parameters: { type: 'OBJECT', properties: {} } }, { name: 'f2', parameters: { type: 'OBJECT', properties: {} } }] }]
};

for (const model of ['gemini-2.5-pro', 'claude-opus-4-5-thinking']) {
  const result = generateGeminiRequestBody(geminiMultiTurnBody, model, mockToken);
  const modelMessages = result.request.contents.filter(m => m.role === 'model');
  assert.strictEqual(modelMessages.length, 2, 'Should have 2 model messages');
  
  for (const m of modelMessages) {
    for (const part of m.parts) {
      if (part.functionCall) {
        assert(part.thoughtSignature, `Gemini functionCall [${part.functionCall.name}] missing thoughtSignature in ${model}`);
        assert(isNonEmptyBase64(part.thoughtSignature), `Gemini functionCall [${part.functionCall.name}] has invalid Base64 thoughtSignature`);
      }
    }
  }
  console.log(`✓ Gemini 多轮测试通过 [${model}]`);
}

// 4. GeminiCli 格式多轮测试
console.log('\n测试 4: GeminiCli 多轮转换测试');
const cliOpenAIReq = {
  model: 'gemini-2.5-pro',
  messages: openaiMultiTurnMessages,
  tools: openaiTools
};
const cliResult = convertToGeminiCli(cliOpenAIReq);
const cliModelMessages = cliResult.geminiRequest.contents.filter(m => m.role === 'model');
for (const m of cliModelMessages) {
  for (const part of m.parts) {
    if (part.functionCall) {
      assert(part.thoughtSignature, `GeminiCli functionCall missing thoughtSignature`);
      assert(isNonEmptyBase64(part.thoughtSignature) || part.thoughtSignature.includes('validator'), `GeminiCli thoughtSignature must be valid`);
    }
  }
}
console.log('✓ GeminiCli 多轮测试通过');

// 恢复原始配置
config.useCachedSignature = originalUseCachedSignature;
config.useFallbackSignature = originalUseFallbackSignature;

console.log('\n=== 所有多轮历史工具调用签名验证全部通过！ ===\n');
