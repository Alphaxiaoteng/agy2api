import assert from 'node:assert/strict';
import config from '../src/config/config.js';
import {
  clearThoughtSignatureCaches,
  getSignature,
  setSignature
} from '../src/utils/thoughtSignatureCache.js';

const originalCacheAll = config.cacheAllSignatures;
config.cacheAllSignatures = true;
clearThoughtSignatureCaches();

setSignature('session-a', 'gemini-3.1-pro-low', 'signature-a', 'thinking-a');
setSignature('session-b', 'gemini-3.1-pro-low', 'signature-b', 'thinking-b');

assert.deepEqual(getSignature('session-a', 'gemini-3.1-pro-low'), {
  signature: 'signature-a',
  content: 'thinking-a'
});
assert.deepEqual(getSignature('session-b', 'gemini-3.1-pro-low'), {
  signature: 'signature-b',
  content: 'thinking-b'
});
assert.equal(getSignature('session-c', 'gemini-3.1-pro-low'), null);

clearThoughtSignatureCaches();
config.cacheAllSignatures = originalCacheAll;
console.log('signature session isolation tests passed');
