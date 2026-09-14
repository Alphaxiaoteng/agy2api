import assert from 'node:assert/strict';
import { isEnableThinking, modelMapping } from '../src/utils/utils.js';

for (const cursorModel of ['gpt-5.5', 'gpt-5.6-sol']) {
  const upstreamModel = modelMapping(cursorModel);
  assert.equal(upstreamModel, 'gemini-3.7-flash-tiered');
  assert.equal(isEnableThinking(upstreamModel), true);
}

assert.equal(modelMapping('gemini-3.1-pro-high'), 'gemini-pro-agent');
assert.equal(isEnableThinking('gemini-pro-agent'), true);

console.log('Cursor OpenAI model routing to Gemini passed');
