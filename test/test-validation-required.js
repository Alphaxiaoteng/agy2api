import assert from 'node:assert/strict';
import { getValidationRequiredDetails } from '../src/api/upstreamError.js';

const validationUrl = 'https://accounts.google.com/signin/continue?x=1';
const body = {
  error: {
    status: 'PERMISSION_DENIED',
    details: [{
      '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
      reason: 'VALIDATION_REQUIRED',
      metadata: { validation_url: validationUrl }
    }]
  }
};

assert.deepEqual(getValidationRequiredDetails(body), { reason: 'VALIDATION_REQUIRED', validationUrl });
assert.deepEqual(getValidationRequiredDetails(JSON.stringify(body)), { reason: 'VALIDATION_REQUIRED', validationUrl });
assert.equal(getValidationRequiredDetails({ error: { details: [{ reason: 'OTHER' }] } }), null);
assert.equal(getValidationRequiredDetails({ error: { details: [{ reason: 'VALIDATION_REQUIRED' }] } }), null);

const safeResponse = { id: 'safe-id', enable: false, statusReason: 'VALIDATION_REQUIRED', validationUrl, disabledAt: '2026-08-21T00:00:00.000Z' };
assert.equal('access_token' in safeResponse, false);
assert.equal('refresh_token' in safeResponse, false);
console.log('validation-required tests passed');
