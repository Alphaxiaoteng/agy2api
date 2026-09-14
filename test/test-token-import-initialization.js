import assert from 'node:assert/strict';
import { initializeImportedTokens } from '../src/routes/admin.js';

const tokens = [
  { refresh_token: 'refresh-one', email: 'one@example.com' },
  { refresh_token: 'refresh-two', projectId: 'existing-project' }
];

const calls = [];
const manager = {
  async getTokenId(token) {
    return token.refresh_token === 'refresh-one' ? 'token-one' : 'token-two';
  },
  async refreshTokenById(tokenId) {
    calls.push(`refresh:${tokenId}`);
    if (tokenId === 'token-two') throw new Error('refresh failed');
  },
  async fetchProjectIdForToken(tokenId) {
    calls.push(`project:${tokenId}`);
  },
  async refreshSubscriptionAndCreditsById(tokenId) {
    calls.push(`quota:${tokenId}`);
  }
};

const results = await initializeImportedTokens(tokens, manager);

assert.deepEqual(calls, [
  'refresh:token-one',
  'project:token-one',
  'quota:token-one',
  'refresh:token-two'
]);
assert.deepEqual(results, [
  {
    email: 'one@example.com',
    success: true,
    refreshed: true,
    projectIdFetched: true,
    subscriptionRefreshed: true
  },
  {
    tokenId: 'token-two',
    success: false,
    refreshed: false,
    projectIdFetched: false,
    subscriptionRefreshed: false,
    error: 'refresh failed'
  }
]);

console.log('Token import initialization test passed');
process.exit(0);
