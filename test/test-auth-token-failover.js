import assert from 'node:assert/strict';
import config from '../src/config/config.js';
import { with429Retry } from '../src/server/handlers/common/retry.js';

const originalRetryIntervalMs = config.retryIntervalMs;
config.retryIntervalMs = 1;

let attempts = 0;
let disabledToken = null;
let switchedFrom = null;

try {
  const result = await with429Retry(
    async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('invalid OAuth credentials');
        error.statusCode = 401;
        throw error;
      }
      return 'ok';
    },
    1,
    {
      loggerPrefix: 'test.auth ',
      modelId: 'gemini-3.8-flash',
      getTokenId: () => 'invalid-token',
      getToken: () => ({ refresh_token: 'invalid-refresh-token' }),
      tokenManager: {
        async disableToken(token) {
          disabledToken = token;
        }
      },
      onBeforeRetry: async ({ previousTokenId }) => {
        switchedFrom = previousTokenId;
        return true;
      }
    }
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.equal(disabledToken.refresh_token, 'invalid-refresh-token');
  assert.equal(switchedFrom, 'invalid-token');
  console.log('auth token failover passed');
} finally {
  config.retryIntervalMs = originalRetryIntervalMs;
}
