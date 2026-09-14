import assert from 'node:assert/strict';
import { TokenManager, RotationStrategy } from '../src/auth/token_manager.js';
import { StrategyFactory } from '../src/auth/token_rotation_strategy.js';

const manager = new TokenManager('/tmp/unused-session-affinity-accounts.json');
const tokens = [
  { refresh_token: 'refresh-a', access_token: 'access-a', sessionId: 'upstream-a', enable: true, hasQuota: true },
  { refresh_token: 'refresh-b', access_token: 'access-b', sessionId: 'upstream-b', enable: true, hasQuota: true },
  { refresh_token: 'refresh-c', access_token: 'access-c', sessionId: 'upstream-c', enable: true, hasQuota: true }
];

manager._initialize = async () => {
  manager.pool.clear();
  manager.sessionAffinity.clear();
  await manager.pool.addAll(tokens);
  manager.rotationStrategyName = RotationStrategy.ROUND_ROBIN;
  manager.strategy = StrategyFactory.create(RotationStrategy.ROUND_ROBIN);
};
manager.lifecycle.isExpired = () => false;
manager.validator.filterAvailableTokens = async entries => entries;

const sessionAFirst = await manager.getToken('gemini-3.1-pro-low', 'session-a');
const sessionBFirst = await manager.getToken('gemini-3.1-pro-low', 'session-b');
const sessionASecond = await manager.getToken('gemini-3.1-pro-low', 'session-a');

assert.equal(sessionAFirst.access_token, 'access-a');
assert.equal(sessionBFirst.access_token, 'access-b');
assert.equal(sessionASecond.access_token, 'access-a');
assert.equal(manager.getRotationConfig().sessionBindings, 2);

const previousTokenId = await manager.getTokenId(sessionAFirst);
const sessionARetry = await manager.getTokenForRetry('gemini-3.1-pro-low', previousTokenId, 'session-a');
assert.notEqual(sessionARetry.access_token, 'access-a');
assert.equal(await manager.getToken('gemini-3.1-pro-low', 'session-a'), sessionARetry);

await manager.disableToken(sessionARetry);
const sessionAAfterDisable = await manager.getToken('gemini-3.1-pro-low', 'session-a');
assert.notEqual(sessionAAfterDisable.access_token, sessionARetry.access_token);

console.log('token session affinity tests passed');
