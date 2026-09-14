// 测试图片模型严格隔离 thoughtSignature，以及思考模型仍保留 thoughtSignature
import assert from 'assert';
import { generateRequestBody } from '../src/utils/converters/openai.js';
import { generateClaudeRequestBody } from '../src/utils/converters/claude.js';
import { generateGeminiRequestBody } from '../src/utils/converters/gemini.js';
import { getSignatureContext, createFunctionCallPart } from '../src/utils/converters/common.js';
import { isImageModel } from '../src/utils/thoughtSignatureCache.js';
import { modelMapping } from '../src/utils/utils.js';

console.log('\n=== 开始验证图片模型隔离 thoughtSignature 与模型映射 ===\n');

// 1. 验证 isImageModel 识别
console.log('测试 1: 验证 isImageModel 识别规则');
const imageModelNames = [
  'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-image',
  'gpt-image-1',
  'gpt-image-2',
  'doubao-seedream-4.0',
  'doubao-5-pro',
  'seedream-v1',
  'my-vision-image-model'
];

for (const name of imageModelNames) {
  assert.strictEqual(isImageModel(name), true, `${name} 应该被识别为图片模型`);
}

const nonImageModelNames = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'claude-opus-4-5-thinking',
  'claude-sonnet-4-5',
  'gpt-4o'
];

for (const name of nonImageModelNames) {
  assert.strictEqual(isImageModel(name), false, `${name} 不应被识别为图片模型`);
}
console.log('✓ isImageModel 识别规则测试通过');

// 2. 验证 modelMapping
console.log('\n测试 2: 验证 modelMapping 别名映射');
assert.strictEqual(modelMapping('doubao-seedream-4.0'), 'doubao-seedream-4.0');
assert.strictEqual(modelMapping('doubao-5-pro'), 'doubao-5-pro');
assert.strictEqual(modelMapping('claude-sonnet-4-5-thinking'), 'claude-sonnet-4-5');
console.log('✓ modelMapping 别名映射测试���过');

// 3. 验证 getSignatureContext 与 createFunctionCallPart 对图片模型直接跳过/返回 null
console.log('\n测试 3: 验证 getSignatureContext 与 createFunctionCallPart 对图片模型返回 null');
for (const imgModel of ['gemini-3.1-flash-image-preview', 'gpt-image-1', 'doubao-seedream-4.0']) {
  const sigCtx = getSignatureContext('session-1', imgModel, true);
  assert.strictEqual(sigCtx.reasoningSignature, null, `${imgModel} 的 reasoningSignature 应为 null`);
  assert.strictEqual(sigCtx.toolSignature, null, `${imgModel} 的 toolSignature 应为 null`);

  const fcPart = createFunctionCallPart('call_1', 'my_func', {}, null, imgModel);
  assert.strictEqual(fcPart.thoughtSignature, undefined, `${imgModel} 的 functionCall 不应含有 thoughtSignature`);
}
console.log('✓ getSignatureContext 与 createFunctionCallPart 图片模型隔离测试通过');

// 4. 验证转换后 parts 中不含 thoughtSignature (OpenAI / Claude / Gemini)
console.log('\n测试 4: 验证图片模型转换后 parts 中不含 thoughtSignature');

const mockToken = {
  sessionId: 'test-session-img-' + Date.now(),
  projectId: 'test-project'
};

const openaiMessagesWithImage = [
  {
    role: 'user',
    content: 'Generate a picture of a cute cat'
  },
  {
    role: 'assistant',
    content: 'Sure!',
    tool_calls: [
      {
        id: 'call_draw',
        type: 'function',
        function: {
          name: 'draw',
          arguments: '{"prompt":"cat"}'
        }
      }
    ]
  }
];

const testImageModels = ['gemini-3.1-flash-image-preview', 'gpt-image-1', 'doubao-seedream-4.0'];

for (const model of testImageModels) {
  // OpenAI 转换
  const openaiResult = generateRequestBody(openaiMessagesWithImage, model, {}, [], mockToken);
  for (const content of openaiResult.request.contents) {
    if (content.parts) {
      for (const part of content.parts) {
        assert.strictEqual(part.thoughtSignature, undefined, `OpenAI 转换中 ${model} 的 part 不应含有 thoughtSignature`);
        assert.strictEqual(part.thought, undefined, `OpenAI 转换中 ${model} 的 part 不应含有 thought`);
      }
    }
  }

  // Gemini 格式转换
  const geminiBody = {
    contents: [
      {
        role: 'user',
        parts: [{ text: 'draw cat' }]
      },
      {
        role: 'model',
        parts: [
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
            }
          },
          {
            functionCall: {
              name: 'draw',
              args: { prompt: 'cat' }
            }
          }
        ]
      }
    ]
  };
  const geminiResult = generateGeminiRequestBody(geminiBody, model, mockToken);
  for (const content of geminiResult.request.contents) {
    if (content.parts) {
      for (const part of content.parts) {
        assert.strictEqual(part.thoughtSignature, undefined, `Gemini 转换中 ${model} 的 part 不应含有 thoughtSignature`);
        assert.strictEqual(part.thought, undefined, `Gemini 转换中 ${model} 的 part 不应含有 thought`);
      }
    }
  }

  // Claude 格式转换
  const claudeMessages = [
    {
      role: 'user',
      content: 'Draw something'
    },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_draw_1',
          name: 'draw',
          input: { prompt: 'landscape' }
        }
      ]
    }
  ];
  const claudeResult = generateClaudeRequestBody(claudeMessages, model, {}, [], 'System Prompt', mockToken);
  for (const content of claudeResult.request.contents) {
    if (content.parts) {
      for (const part of content.parts) {
        assert.strictEqual(part.thoughtSignature, undefined, `Claude 转换中 ${model} 的 part 不应含有 thoughtSignature`);
        assert.strictEqual(part.thought, undefined, `Claude 转换中 ${model} 的 part 不应含有 thought`);
      }
    }
  }
}
console.log('✓ 图片模型转换后 parts 完全不含 thoughtSignature / thought 验证通过');

// 5. 验证 thinking 模型仍含 thoughtSignature 以确保未回归
console.log('\n测试 5: 验证思考模型仍然正常携带 thoughtSignature (无回归)');

const thinkingModels = ['gemini-2.5-pro', 'claude-opus-4-5-thinking'];

for (const model of thinkingModels) {
  const openaiResult = generateRequestBody(openaiMessagesWithImage, model, {}, [], mockToken);
  const modelMsg = openaiResult.request.contents.find(c => c.role === 'model');
  assert(modelMsg, `思考模型 ${model} 应该存在 model 消息`);
  
  const fcPart = modelMsg.parts.find(p => p.functionCall);
  assert(fcPart, `思考模型 ${model} 应该包含 functionCall`);
  assert(fcPart.thoughtSignature, `思考模型 ${model} 的 functionCall 必须携带 thoughtSignature`);
}
console.log('✓ 思考模型仍然正常携带 thoughtSignature，未发生回归');

console.log('\n=== 所有隔离与思考模型测试全部通过！ ===\n');
