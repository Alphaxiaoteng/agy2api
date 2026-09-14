import assert from 'node:assert/strict';
import SessionAffinity from '../src/auth/session_affinity.js';
import { getRequestSessionKey, scopeTokenToRequest } from '../src/utils/requestSession.js';

const affinity = new SessionAffinity({ ttlMs: 1000, maxEntries: 2 });
affinity.set('session-a', 'token-1');
assert.equal(affinity.get('session-a'), 'token-1');
affinity.set('session-b', 'token-2');
affinity.set('session-c', 'token-3');
assert.equal(affinity.get('session-a'), null);
assert.equal(affinity.get('session-c'), 'token-3');
affinity.deleteToken('token-3');
assert.equal(affinity.get('session-c'), null);

const reqWithHeader = { headers: { 'x-session-id': 'conversation-1' } };
const headerKey1 = getRequestSessionKey(reqWithHeader, 'openai', 'gemini-3.1-pro-low', {});
const headerKey2 = getRequestSessionKey(reqWithHeader, 'openai', 'gemini-3.1-pro-low', {});
assert.equal(headerKey1, headerKey2);

const bodyA = { messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'one' }] };
const bodyB = { messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'two' }] };
const bodyC = { messages: [{ role: 'user', content: 'another conversation' }] };
const fingerprintA = getRequestSessionKey({ headers: {} }, 'openai', 'gemini-3.1-pro-low', bodyA);
const fingerprintB = getRequestSessionKey({ headers: {} }, 'openai', 'gemini-3.1-pro-low', bodyB);
const fingerprintC = getRequestSessionKey({ headers: {} }, 'openai', 'gemini-3.1-pro-low', bodyC);
assert.equal(fingerprintA, fingerprintB);
assert.notEqual(fingerprintA, fingerprintC);

const originalToken = { sessionId: 'upstream-session', projectId: 'project' };
const scopedToken = scopeTokenToRequest(originalToken, fingerprintA);
assert.equal(originalToken.signatureSessionId, undefined);
assert.equal(scopedToken.sessionId, originalToken.sessionId);
assert.match(scopedToken.signatureSessionId, /^upstream-session:fingerprint:/);

console.log('session affinity tests passed');
