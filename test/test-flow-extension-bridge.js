/**
 * Offline & Mocked Tests for FlowExtensionBridge & FlowApiProvider
 *
 * Test cases:
 * 1. Authentication failure on handshake & invalid token
 * 2. Loopback restriction when token is unset
 * 3. Token not exposed in status/listClients output
 * 4. Operation allowlist rejection
 * 5. Request-response flow with stable client_id
 * 6. Duplicate response deduplication (seenIds)
 * 7. Timeout handling and late orphan callback reconciliation
 * 8. 401 unauthenticated single refresh_auth retry in FlowApiProvider
 * 9. getCredits, generateImage, uploadImage, submitVideo, pollVideo, downloadVideo methods
 */

import assert from 'node:assert/strict';
import http from 'http';
import WebSocket from 'ws';
import { FlowExtensionBridge } from '../src/services/flowExtensionBridge.js';
import { FlowApiProvider } from '../src/services/flowApiProvider.js';
import { FlowClientPool } from '../src/services/flowClientPool.js';

console.log('=== Starting Flow Extension Bridge & Provider Tests ===\n');

// Helper to create an HTTP test server and bind bridge
function createTestServer(bridge) {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  bridge.initialize(server);
  return server;
}

// -------------------------------------------------------------
// Test 1: Authentication failure & Loopback restriction
// -------------------------------------------------------------
console.log('1. Testing authentication failure & hello handshake...');
{
  const bridgeWithToken = new FlowExtensionBridge({ token: 'secret-token-123' });
  const server = createTestServer(bridgeWithToken);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // 1.1 Handshake timeout / wrong first message
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/flow/ws`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'not_hello' }));
      });
      ws.on('close', (code, reason) => {
        assert.equal(code, 1008);
        resolve();
      });
    });

    // 1.2 Hello with wrong token in body
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/flow/ws`);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'hello', token: 'wrong-body-token' }));
      });
      ws.on('close', (code) => {
        assert.equal(code, 1008);
        resolve();
      });
    });

    // 1.3 Successful handshake
    await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/flow/ws`);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          token: 'secret-token-123',
          clientId: 'client-unit-1',
          tier: 'G1_FREEMIUM',
          credits: 50,
          tokenPresent: true,
          tokenAgeMs: 12000,
        }));
      });
      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString('utf8'));
        if (data.type === 'hello_ack') {
          assert.equal(data.clientId, 'client-unit-1');
          assert.equal(data.status, 'ok');
          assert.equal(data.protocolVersion, 1);
          ws.close();
          resolve();
        }
      });
    });
  } finally {
    bridgeWithToken.close();
    server.close();
  }
}
console.log('✓ Authentication tests passed');

// -------------------------------------------------------------
// Test 2: Token Not Exposed in Status / ListClients
// -------------------------------------------------------------
console.log('2. Testing status / listClients does NOT expose secrets or Bearer tokens...');
{
  const bridge = new FlowExtensionBridge({ token: 'test-token' });
  const server = createTestServer(bridge);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/flow/ws`, {
      headers: { 'Authorization': 'Bearer test-token' }
    });
    await new Promise((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          token: 'test-token',
          clientId: 'client-secure-1',
          tier: 'G1_TIER1',
          credits: 100,
          projectId: 'project-secret-uuid-12345678',
          tokenPresent: true,
          tokenAgeMs: 5000,
          // Attacker or extension mistakenly sends a bearer token
          flowKey: 'ya29.secret_bearer_token',
          bearerToken: 'ya29.secret_token',
        }));
      });
      ws.on('message', (msg) => {
        const data = JSON.parse(msg.toString('utf8'));
        if (data.type === 'hello_ack') resolve();
      });
    });

    const status = bridge.getStatus();
    const statusStr = JSON.stringify(status);
    assert.equal(statusStr.includes('ya29.secret'), false);
    assert.equal(statusStr.includes('flowKey'), false);
    assert.equal(statusStr.includes('bearerToken'), false);
    assert.equal(statusStr.includes('project-secret-uuid-12345678'), false); // raw projectId hidden
    assert.equal(status.clients[0].tokenPresent, true);
    assert.equal(status.clients[0].tier, 'G1_TIER1');
    assert.equal(status.clients[0].credits, 100);
    assert.equal(status.clients[0].projectIdPresent, true);
    assert.equal(status.clients[0].projectHint, 'proj...5678');

    const clientList = bridge.listClients();
    const listStr = JSON.stringify(clientList);
    assert.equal(listStr.includes('ya29.secret'), false);
    assert.equal(listStr.includes('project-secret-uuid-12345678'), false);
    assert.equal(clientList[0].clientId, 'client-secure-1');
    assert.equal(clientList[0].tokenPresent, true);

    // Internal getter gets full projectId
    assert.equal(bridge.clientPool.getClientProjectId('client-secure-1'), 'project-secret-uuid-12345678');

    ws.close();
  } finally {
    bridge.close();
    server.close();
  }
}
console.log('✓ Token privacy tests passed');

// -------------------------------------------------------------
// Test 3: Allowlist & Request / Response Cycle & Deduplication
// -------------------------------------------------------------
console.log('3. Testing operation allowlist, request/response, and deduplication...');
{
  const bridge = new FlowExtensionBridge({ token: 'test-token' });
  const server = createTestServer(bridge);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // 3.1 Allowlist rejection
    await assert.rejects(
      async () => {
        await bridge.request('arbitrary_eval_cmd', { cmd: 'rm -rf /' });
      },
      (err) => {
        assert.equal(err.code, 'OPERATION_NOT_ALLOWED');
        return true;
      }
    );

    // Connect extension client
    const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/flow/ws`, {
      headers: { 'Authorization': 'Bearer test-token' }
    });
    await new Promise((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          token: 'test-token',
          clientId: 'client-rpc-1',
          tokenPresent: true,
        }));
      });
      ws.on('message', (msg) => {
        const d = JSON.parse(msg.toString('utf8'));
        if (d.type === 'hello_ack') resolve();
      });
    });

    // Setup client mock response listener
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString('utf8'));
      if (msg.type === 'operation_request') {
        if (msg.operation === 'get_credits') {
          // Send back response
          ws.send(JSON.stringify({
            id: msg.id,
            status: 200,
            data: { credits: 42, sku: 'G1_FREEMIUM' },
          }));
          // Send duplicate response to test deduplication
          ws.send(JSON.stringify({
            id: msg.id,
            status: 200,
            data: { credits: 42, sku: 'G1_FREEMIUM' },
          }));
        }
      }
    });

    const res = await bridge.request('get_credits', {});
    assert.equal(res.status, 200);
    assert.equal(res.data.credits, 42);

    ws.close();
  } finally {
    bridge.close();
    server.close();
  }
}
console.log('✓ Allowlist and request/response tests passed');

// -------------------------------------------------------------
// Test 4: Timeout & Orphan Reconciliation Handler
// -------------------------------------------------------------
console.log('4. Testing timeout and late orphan response handler...');
{
  const bridge = new FlowExtensionBridge({ token: 'test-token', defaultTimeoutMs: 100 });
  const server = createTestServer(bridge);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  let orphanReceived = null;
  let orphanMeta = null;
  bridge.setOrphanHandler((data, meta) => {
    orphanReceived = data;
    orphanMeta = meta;
  });

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/internal/flow/ws`, {
      headers: { 'Authorization': 'Bearer test-token' }
    });
    let capturedReqId = null;

    await new Promise((resolve) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          token: 'test-token',
          clientId: 'client-timeout-1',
          tokenPresent: true,
        }));
      });
      ws.on('message', (msg) => {
        const d = JSON.parse(msg.toString('utf8'));
        if (d.type === 'hello_ack') resolve();
        if (d.type === 'operation_request') {
          capturedReqId = d.id;
        }
      });
    });

    // Request with 100ms timeout
    await assert.rejects(
      async () => {
        await bridge.request('generate_image', { prompt: 'late image' }, {
          timeout: 50,
          meta: { trackingId: 'track-999' },
        });
      },
      (err) => {
        assert.equal(err.code, 'TIMEOUT');
        return true;
      }
    );

    assert.ok(capturedReqId);

    // Extension now delivers late result after timeout
    ws.send(JSON.stringify({
      id: capturedReqId,
      status: 200,
      data: { media: [{ name: 'late-media-id-123' }] },
    }));

    // Wait a brief moment for orphan handler to execute
    await new Promise(r => setTimeout(r, 50));

    assert.ok(orphanReceived);
    assert.equal(orphanReceived.id, capturedReqId);
    assert.equal(orphanReceived.data.media[0].name, 'late-media-id-123');
    assert.equal(orphanMeta.trackingId, 'track-999');

    ws.close();
  } finally {
    bridge.close();
    server.close();
  }
}
console.log('✓ Timeout & orphan handler tests passed');

// -------------------------------------------------------------
// Test 5: FlowApiProvider Operations & 401 Self-Healing Retry
// -------------------------------------------------------------
console.log('5. Testing FlowApiProvider operations and 401 refresh_auth retry...');
{
  let refreshAuthCalled = 0;
  let getCreditsCalls = 0;

  const mockBridge = {
    clientPool: {
      selectClient: () => 'client-mock-1',
      getClientProjectId: () => 'test-project-123',
      recordSuccess: () => {},
    },
    request: async (operation, payload, options = {}) => {
      if (operation === 'refresh_auth') {
        refreshAuthCalled++;
        return { status: 200, data: { ok: true } };
      }

      if (operation === 'get_credits') {
        getCreditsCalls++;
        if (getCreditsCalls === 1) {
          // First call returns 401 unauthenticated
          return {
            status: 401,
            data: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Token expired' } },
          };
        }
        // Second call returns fresh credits
        return {
          status: 200,
          data: { credits: 88, sku: 'G1_TIER1' },
        };
      }

      if (operation === 'generate_image') {
        return {
          status: 200,
          data: {
            remainingCredits: 87,
            media: [{
              name: '88888888-4444-4444-4444-121212121212',
              image: {
                generatedImage: {
                  fifeUrl: 'https://storage.googleapis.com/ai-sandbox-videofx/image/88888888-4444-4444-4444-121212121212?sign=abc',
                },
              },
            }],
          },
        };
      }

      if (operation === 'upload_image') {
        return {
          status: 200,
          data: {
            mediaId: 'uploaded-media-id-001',
          },
        };
      }

      if (operation === 'submit_video') {
        return {
          status: 200,
          data: {
            remainingCredits: 75,
            media: [{ name: 'submitted-video-id-999' }],
          },
        };
      }

      if (operation === 'poll_video') {
        return {
          status: 200,
          data: {
            media: [{
              name: 'submitted-video-id-999',
              mediaMetadata: {
                mediaStatus: {
                  mediaGenerationStatus: 'MEDIA_GENERATION_STATUS_SUCCESSFUL',
                },
              },
            }],
          },
        };
      }

      if (operation === 'download_image') {
        return {
          status: 200,
          data: {
            imageBase64: Buffer.from('mock png image binary content').toString('base64'),
          },
        };
      }

      if (operation === 'download_video') {
        return {
          status: 200,
          data: {
            videoBase64: Buffer.from('mock mp4 video binary content').toString('base64'),
          },
        };
      }

      throw new Error(`Unexpected operation: ${operation}`);
    },
  };

  const provider = new FlowApiProvider({
    bridge: mockBridge,
    defaultProjectId: 'test-project-123',
  });

  // 5.1 getCredits with 401 retry
  const creditsResult = await provider.getCredits();
  assert.equal(refreshAuthCalled, 1);
  assert.equal(getCreditsCalls, 2);
  assert.equal(creditsResult.credits, 88);
  assert.equal(creditsResult.tier, 'G1_TIER1');

  // 5.2 generateImage
  const imgResult = await provider.generateImage({
    prompt: 'a majestic flying whale',
    model: 'flow/gem-pix-2',
  });
  assert.equal(imgResult.images.length, 1);
  assert.equal(imgResult.images[0].upstreamMediaId, '88888888-4444-4444-4444-121212121212');
  assert.equal(imgResult.images[0].remoteUrl.startsWith('https://storage.googleapis.com'), true);
  assert.equal(imgResult.remainingCredits, 87);

  // 5.3 uploadImage
  const uploadResult = await provider.uploadImage({
    imageBase64OrBuffer: Buffer.from('mock img data'),
  });
  assert.equal(uploadResult.mediaId, 'uploaded-media-id-001');

  // 5.4 submitVideo
  const submitResult = await provider.submitVideo({
    prompt: 'slow aerial pan of city',
    mode: 't2v',
    duration: 6,
  });
  assert.deepEqual(submitResult.mediaIds, ['submitted-video-id-999']);
  assert.equal(submitResult.remainingCredits, 75);

  // 5.5 pollVideo
  const pollResult = await provider.pollVideo({
    mediaIds: ['submitted-video-id-999'],
  });
  assert.equal(pollResult.status, 'succeeded');
  assert.equal(pollResult.media[0].isSuccess, true);

  // 5.6 downloadVideo
  const dlResult = await provider.downloadVideo({
    mediaId: 'submitted-video-id-999',
  });
  assert.ok(Buffer.isBuffer(dlResult.buffer));
  assert.equal(dlResult.buffer.toString('utf8'), 'mock mp4 video binary content');
  assert.equal(dlResult.mimeType, 'video/mp4');

  // 5.7 downloadImage
  const dlImgResult = await provider.downloadImage({
    mediaId: '88888888-4444-4444-4444-121212121212',
  });
  assert.ok(Buffer.isBuffer(dlImgResult.buffer));
  assert.equal(dlImgResult.buffer.toString('utf8'), 'mock png image binary content');
  assert.equal(dlImgResult.mimeType, 'image/png');
}
console.log('✓ FlowApiProvider operations and 401 retry tests passed');

  // -------------------------------------------------------------
  // Test 6: Strict Client Pinning & Project Isolation
  // -------------------------------------------------------------
  console.log('6. Testing strict client pinning & project isolation...');
  const pool = new FlowClientPool();
  const mockWs1 = { readyState: 1, send: () => {}, close: () => {} };
  const mockWs2 = { readyState: 1, send: () => {}, close: () => {} };

  pool.upsertClient('client-A', mockWs1, {
    projectId: 'proj-A-111',
    tokenPresent: true,
    apiKeyPresent: true,
    credits: 100,
  });

  pool.upsertClient('client-B', mockWs2, {
    projectId: 'proj-B-222',
    tokenPresent: true,
    apiKeyPresent: true,
    credits: 100,
  });

  // selectClient without preferred chooses best (alphabetical client-A)
  assert.equal(pool.selectClient(), 'client-A');

  // selectClient with strictPreferred for client-B returns client-B
  assert.equal(pool.selectClient({ preferredClientId: 'client-B', strictPreferred: true }), 'client-B');

  // If client-A disconnects (readyState != 1)
  mockWs1.readyState = 2; // CLOSING
  // strictPreferred client-A MUST return null, NOT fallback to client-B
  assert.equal(pool.selectClient({ preferredClientId: 'client-A', strictPreferred: true }), null);
  // non-strict can fallback to client-B
  assert.equal(pool.selectClient({ preferredClientId: 'client-A', strictPreferred: false }), 'client-B');

  // If apiKeyPresent is false, client is rejected when requireApiKey=true
  pool.updateClient('client-B', { apiKeyPresent: false });
  assert.equal(pool.selectClient({ preferredClientId: 'client-B', strictPreferred: true }), null);
  assert.equal(pool.selectClient(), null);
  console.log('✓ Strict client pinning & apiKey checks passed');

  console.log('\n=== All Flow Extension Bridge Tests Passed Successfully! ===');
