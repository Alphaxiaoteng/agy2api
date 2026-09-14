import assert from 'assert/strict';
import { LocalOAuthFlow } from '../src/auth/local_oauth_flow.js';

const oauthManager = {
  generateAuthUrl(port) {
    return `http://accounts.test/auth?state=state-${port}`;
  },
  async authenticate(code, port) {
    assert.equal(code, 'test-code');
    return { access_token: 'secret-access', refresh_token: 'secret-refresh', hasQuota: true };
  }
};

let addTokenCalls = 0;
const tokenManager = {
  async addToken(account) {
    addTokenCalls += 1;
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(account.access_token, 'secret-access');
    return { success: true };
  }
};

const flow = new LocalOAuthFlow({ oauthManager, tokenManager, logger: { error() {} } });
const started = await flow.start();
const reused = await flow.start();
assert.equal(reused.id, started.id);
assert.equal(reused.reused, true);
assert.equal('access_token' in started, false);
assert.equal('refresh_token' in started, false);

const callback = await fetch(`http://127.0.0.1:${started.callbackPort}/oauth-callback?code=test-code&state=state-${started.callbackPort}`);
assert.equal(callback.status, 200);
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(addTokenCalls, 1);
assert.equal(flow.getStatus(started.id).status, 'success');

await new Promise(resolve => flow.activeFlow?.server.close(resolve));
console.log('local OAuth flow tests passed');
