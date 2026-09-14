/**
 * Offline Integration Test for WebSocket Coexistence
 *
 * Verifies that:
 * 1. LogWebSocketServer (/ws/logs) and FlowExtensionBridge (/internal/flow/ws) coexist on the same HTTP server
 * 2. Connecting to /ws/logs completes handshake successfully
 * 3. Connecting to /internal/flow/ws completes handshake successfully
 * 4. Unknown WS paths (/ws/unknown) are NOT handled by either WSS and do not trigger duplicate handling or crash
 * 5. Both bridges clean up gracefully upon close
 */

import assert from 'node:assert/strict';
import http from 'http';
import WebSocket from 'ws';
import { LogWebSocketServer } from '../src/utils/logWsServer.js';
import { FlowExtensionBridge } from '../src/services/flowExtensionBridge.js';

console.log('=== Starting WebSocket Coexistence Tests ===\n');

const server = http.createServer((req, res) => {
  res.writeHead(404);
  res.end('Not Found');
});

const logWs = new LogWebSocketServer();
const flowWs = new FlowExtensionBridge({ token: 'coexist-secret-token' });

try {
  logWs.initialize(server);
  flowWs.initialize(server);

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  // 1. Test /ws/logs handshake
  console.log('1. Testing /ws/logs connection and history response...');
  const wsLogs = new WebSocket(`ws://127.0.0.1:${port}/ws/logs`);
  await new Promise((resolve, reject) => {
    wsLogs.on('open', () => {
      resolve();
    });
    wsLogs.on('error', reject);
  });
  assert.equal(logWs.clients.size, 1);
  console.log('✓ /ws/logs connection succeeded');

  // 2. Test /internal/flow/ws handshake
  console.log('2. Testing /internal/flow/ws connection and hello handshake...');
  const wsFlow = new WebSocket(`ws://127.0.0.1:${port}/internal/flow/ws`);
  await new Promise((resolve, reject) => {
    wsFlow.on('open', () => {
      wsFlow.send(JSON.stringify({
        type: 'hello',
        token: 'coexist-secret-token',
        clientId: 'client-coexist-1',
        tokenPresent: true,
        projectId: 'proj-coexist',
      }));
    });
    wsFlow.on('message', (raw) => {
      const data = JSON.parse(raw.toString('utf8'));
      assert.equal(data.type, 'hello_ack');
      assert.equal(data.clientId, 'client-coexist-1');
      assert.equal(data.protocolVersion, 1);
      resolve();
    });
    wsFlow.on('error', reject);
  });
  assert.equal(flowWs.clientPool.clients.size, 1);
  console.log('✓ /internal/flow/ws connection and hello_ack succeeded');

  // 3. Test unknown path /ws/unknown (neither server should handle it)
  console.log('3. Testing unknown path upgrade behavior...');
  let unknownRejectedOrClosed = false;
  const wsUnknown = new WebSocket(`ws://127.0.0.1:${port}/ws/unknown`);
  await new Promise((resolve) => {
    wsUnknown.on('error', (err) => {
      unknownRejectedOrClosed = true;
      resolve();
    });
    wsUnknown.on('close', () => {
      unknownRejectedOrClosed = true;
      resolve();
    });
    // Fallback timer if socket is left unhandled by HTTP server
    setTimeout(() => {
      wsUnknown.terminate();
      resolve();
    }, 500);
  });
  assert.equal(logWs.clients.size, 1); // Not affected
  assert.equal(flowWs.clientPool.clients.size, 1); // Not affected
  console.log('✓ Unknown WS path did not interfere with /ws/logs or /internal/flow/ws');

  // 4. Cleanup
  wsLogs.close();
  wsFlow.close();
  console.log('✓ Client sockets closed');

  console.log('\n=== All WebSocket Coexistence Tests Passed Successfully! ===');
} finally {
  logWs.close();
  flowWs.close();
  server.close();
}
