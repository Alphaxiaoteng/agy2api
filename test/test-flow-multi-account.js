import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { FlowClientPool } from '../src/services/flowClientPool.js';
import { FlowExtensionBridge } from '../src/services/flowExtensionBridge.js';
import { estimateCost, validateParams } from '../src/config/flowCapabilities.js';
import { flowApiRouter } from '../src/routes/flowApi.js';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

console.log('=== Starting Flow Multi-Account & Reservation Unit/Integration Tests ===\n');

// 1. Estimate Cost & Capability Tests
console.log('1. Testing cost estimation and capability validation...');
assert.equal(estimateCost({ model: 'veo-3.1-lite' }), 10);
assert.equal(estimateCost({ model: 'omni-flash', duration: 4 }), 4);
assert.equal(estimateCost({ model: 'omni-flash', duration: 6 }), 7);
assert.equal(estimateCost({ model: 'omni-flash', duration: 7 }), 7);
assert.equal(estimateCost({ model: 'omni-flash', duration: 8 }), 12);
assert.equal(estimateCost({ model: 'omni-flash', duration: 10 }), 12);
assert.equal(estimateCost({ model: 'nano-banana-pro' }), 0); // Image model
assert.equal(estimateCost({ model: 'omni-flash', duration: 5, estimatedCost: 25 }), 25); // Explicit override

const validatedImg = validateParams('image', {
  prompt: 'Test prompt',
  account_label: 'work-profile',
  estimated_cost: 15,
});
assert.equal(validatedImg.accountLabel, 'work-profile');
assert.equal(validatedImg.estimatedCost, 15);
console.log('✓ Cost estimation and param validation passed');

// 2. FlowClientPool unit tests (UUID, Hint, Label, Reservation, Balancing)
console.log('\n2. Testing FlowClientPool (profileUuid, profileHint, reservations, label selection)...');
const pool = new FlowClientPool({ strategy: 'least-busy' });

// Add Client A: credits=50, label='profile-work'
pool.upsertClient('flow_client_a', { readyState: 1 }, {
  tier: 'PAYGATE_TIER_ONE',
  credits: 50,
  projectId: 'proj_a',
  profileUuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  accountLabel: 'profile-work',
  tokenPresent: true,
  apiKeyPresent: true,
  activeProjectCount: 1,
});

// Add Client B: credits=100, label='profile-personal'
pool.upsertClient('flow_client_b', { readyState: 1 }, {
  tier: 'PAYGATE_TIER_ONE',
  credits: 100,
  projectId: 'proj_b',
  profileUuid: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  accountLabel: 'profile-personal',
  tokenPresent: true,
  apiKeyPresent: true,
  activeProjectCount: 2,
});

const clientA = pool.getClient('flow_client_a');
assert.ok(clientA);
assert.equal(clientA.profileUuid, 'a1b2c3d4-e5f6-7890-abcd-ef1234567890');
assert.ok(clientA.profileHint.length > 0);
assert.notEqual(clientA.profileHint, clientA.profileUuid); // Redacted hint
assert.equal(clientA.accountLabel, 'profile-work');
assert.equal(clientA.activeProjectCount, 1);
assert.equal(clientA.reservedCredits, 0);

// Find by label
const labelResult = pool.findClientByLabel('profile-personal');
assert.ok(labelResult.match);
assert.equal(labelResult.duplicate, false);
assert.equal(labelResult.match.clientId, 'flow_client_b');

// Test listClients (ensure profileUuid is NOT in the public output)
const listed = pool.listClients();
assert.equal(listed.length, 2);
for (const item of listed) {
  assert.equal(item.profileUuid, undefined, 'profileUuid must never be exposed');
  assert.ok(item.profileHint, 'profileHint should be present');
  assert.ok(item.availableCredits !== undefined);
}

// Test credit reservation
const resId = pool.reserveCredits('flow_client_a', 20);
assert.ok(resId && typeof resId === 'string');
assert.equal(pool.getClient('flow_client_a').reservedCredits, 20);

// Attempt reserving more than available credits (available = 50 - 20 = 30)
assert.equal(pool.reserveCredits('flow_client_a', 40), null); // Fails due to insufficient available credits

// Selection with minCredits
const selectedLowReq = pool.selectClient({ minCredits: 25 });
assert.ok(selectedLowReq); // Could be client_a (30 avail) or client_b (100 avail)

// Selection requiring 40 credits should skip client_a (only 30 available) and pick client_b
const selectedHighReq = pool.selectClient({ minCredits: 40 });
assert.equal(selectedHighReq, 'flow_client_b');

// Release reservation
assert.equal(pool.releaseReservation(resId), true);
assert.equal(pool.getClient('flow_client_a').reservedCredits, 0);
console.log('✓ FlowClientPool multi-account & credit reservation passed');

// 3. WS Bridge Duplicate Connection Takeover Protection
console.log('\n3. Testing WS Bridge duplicate clientId takeover & busy protection...');
const bridge = new FlowExtensionBridge({
  token: 'test-secret',
});
const bridgeServer = http.createServer((req, res) => {
  res.writeHead(404);
  res.end();
});
bridge.initialize(bridgeServer);

await new Promise((resolve) => {
  bridgeServer.listen(0, '127.0.0.1', () => {
    resolve();
  });
});

const bridgePort = bridgeServer.address().port;
const wsUrl = `ws://127.0.0.1:${bridgePort}/internal/flow/ws`;

// Helper to establish a WS connection with hello handshake
function createWsClient(clientId, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    socket.on('open', () => {
      socket.send(JSON.stringify({
        type: 'hello',
        protocolVersion: 1,
        clientId,
        token: 'test-secret',
        profileUuid: opts.profileUuid || '11111111-2222-3333-4444-555555555555',
        accountLabel: opts.accountLabel || 'label-test',
        credits: opts.credits !== undefined ? opts.credits : 100,
        projectId: opts.projectId || 'test-proj',
        tier: 'PAYGATE_TIER_ONE',
        tokenPresent: true,
        apiKeyPresent: true,
      }));
    });
    socket.on('message', (msg) => {
      const parsed = JSON.parse(msg.toString());
      if (parsed.type === 'hello_ack') {
        resolve(socket);
      }
    });
    socket.on('error', reject);
  });
}

// Connect client-alpha
const socket1 = await createWsClient('client_alpha', { accountLabel: 'alpha-tab' });
assert.ok(bridge.clientPool.getClient('client_alpha'));

// Mark client_alpha as busy (activeRequests > 0)
const alphaEntry = bridge.clientPool.getClient('client_alpha');
alphaEntry.activeRequests = 1;

// Now attempt a second connection with the same clientId while it is busy
const rejectedSocket = new WebSocket(wsUrl);
const rejectionPromise = new Promise((resolve) => {
  rejectedSocket.on('close', (code, reason) => {
    resolve({ code, reason: reason.toString() });
  });
});
rejectedSocket.on('open', () => {
  rejectedSocket.send(JSON.stringify({
    type: 'hello',
    protocolVersion: 1,
    clientId: 'client_alpha',
    token: 'test-secret',
  }));
});

const rejectResult = await rejectionPromise;
assert.equal(rejectResult.code, 1008, 'Should reject duplicate busy client with 1008');
assert.ok(rejectResult.reason.includes('Client ID already connected with active requests'));

// Free client_alpha and verify idle replacement works
alphaEntry.activeRequests = 0;
const socket2 = await createWsClient('client_alpha', { accountLabel: 'alpha-tab-new' });
assert.ok(socket2);
assert.equal(bridge.clientPool.getClient('client_alpha').accountLabel, 'alpha-tab-new');

socket1.close();
socket2.close();
bridge.close();
await new Promise(r => bridgeServer.close(r));
console.log('✓ WS Bridge takeover & busy protection passed');

// 4. Verification Endpoint & Multi-Account Router Tests
console.log('\n4. Testing /accounts/verify and account inspection endpoints...');
const app = express();
app.use(express.json());

// Mock bridge & pool on express app for router integration
const mockTestPool = new FlowClientPool();
mockTestPool.upsertClient('client_work', { readyState: 1 }, {
  tier: 'PAYGATE_TIER_ONE',
  credits: 80,
  projectId: 'proj_work',
  profileUuid: '22222222-3333-4444-5555-666666666666',
  accountLabel: 'Work-Account',
  tokenPresent: true,
  apiKeyPresent: true,
  activeProjectCount: 1,
});

mockTestPool.upsertClient('client_degraded', { readyState: 1 }, {
  tier: 'PAYGATE_TIER_ONE',
  credits: 0,
  projectId: 'proj_degraded',
  profileUuid: '33333333-4444-5555-6666-777777777777',
  accountLabel: 'Degraded-Account',
  tokenPresent: false, // Missing token
  apiKeyPresent: true,
  activeProjectCount: 0,
});

const mockBridge = {
  clientPool: mockTestPool,
  listClients: () => mockTestPool.listClients(),
  getStatus: () => ({ poolSize: mockTestPool.size }),
};

// Temporarily attach mockBridge to flowExtensionBridge singleton for route testing
import { flowExtensionBridge as realBridge } from '../src/services/flowExtensionBridge.js';
const origClientPool = realBridge.clientPool;
realBridge.clientPool = mockTestPool;

app.use('/v1/flow', flowApiRouter);

const testHttpServer = http.createServer(app);
await new Promise(r => testHttpServer.listen(0, '127.0.0.1', r));
const testPort = testHttpServer.address().port;

// Test GET /v1/flow/accounts
const getAccResp = await fetch(`http://127.0.0.1:${testPort}/v1/flow/accounts`);
assert.equal(getAccResp.status, 200);
const getAccData = await getAccResp.json();
assert.equal(getAccData.data.length, 2);
assert.equal(getAccData.data[0].client_id, 'client_work');
assert.equal(getAccData.data[0].account_label, 'Work-Account');

// Test POST /v1/flow/accounts/verify (All accounts)
const verifyAllResp = await fetch(`http://127.0.0.1:${testPort}/v1/flow/accounts/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
});
assert.equal(verifyAllResp.status, 200);
const verifyAllData = await verifyAllResp.json();
assert.equal(verifyAllData.total, 2);
assert.equal(verifyAllData.healthy, 1);
const workResult = verifyAllData.data.find(d => d.clientId === 'client_work');
assert.equal(workResult.status, 'healthy');
assert.equal(workResult.authenticated, true);
const degradedResult = verifyAllData.data.find(d => d.clientId === 'client_degraded');
assert.equal(degradedResult.status, 'degraded');
assert.equal(degradedResult.reason, 'MISSING_BEARER_TOKEN');

// Test POST /v1/flow/accounts/verify with specific label
const verifyLabelResp = await fetch(`http://127.0.0.1:${testPort}/v1/flow/accounts/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ account_label: 'Work-Account' }),
});
assert.equal(verifyLabelResp.status, 200);
const verifyLabelData = await verifyLabelResp.json();
assert.equal(verifyLabelData.total, 1);
assert.equal(verifyLabelData.data[0].clientId, 'client_work');

// Cleanup
realBridge.clientPool = origClientPool;
await new Promise(r => testHttpServer.close(r));
console.log('✓ Account verification and route endpoints passed');

console.log('\n=== All Flow Multi-Account Tests Passed Successfully! ===');
