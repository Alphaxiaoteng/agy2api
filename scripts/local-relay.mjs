import http from 'http';
import net from 'net';

const listenHost = process.env.RELAY_HOST || '127.0.0.1';
const listenPort = Number.parseInt(process.env.RELAY_PORT || '8045', 10);
const backendHost = process.env.AGY_BACKEND_HOST || '127.0.0.1';
const backendPort = Number.parseInt(process.env.AGY_BACKEND_PORT || '8046', 10);
const retryWindowMs = Number.parseInt(process.env.RELAY_RETRY_WINDOW_MS || '15000', 10);
const retryIntervalMs = Number.parseInt(process.env.RELAY_RETRY_INTERVAL_MS || '250', 10);
const agent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64, keepAliveMsecs: 30000, scheduling: 'fifo' });

function proxyHttp(clientReq, clientRes) {
  clientReq.pause();
  const startedAt = Date.now();

  const attempt = () => {
    const probe = net.connect(backendPort, backendHost);
    probe.once('connect', () => {
      probe.destroy();
      const backendReq = http.request({
        host: backendHost,
        port: backendPort,
        method: clientReq.method,
        path: clientReq.url,
        headers: { ...clientReq.headers, host: `${backendHost}:${backendPort}` },
        agent
      });
      backendReq.on('response', backendRes => {
        clientRes.writeHead(backendRes.statusCode || 502, backendRes.headers);
        backendRes.pipe(clientRes);
      });
      backendReq.on('error', error => {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'content-type': 'application/json' });
        }
        clientRes.end(JSON.stringify({ error: 'AGY backend request failed', code: error.code || 'UPSTREAM_ERROR' }));
      });
      if (!clientReq.destroyed) {
        clientReq.pipe(backendReq);
        clientReq.resume();
      }
    });
    probe.once('error', error => {
      if (Date.now() - startedAt < retryWindowMs && !clientReq.destroyed) {
        setTimeout(attempt, retryIntervalMs);
        return;
      }
      if (!clientRes.headersSent) {
        clientRes.writeHead(503, { 'content-type': 'application/json', 'retry-after': '1' });
      }
      clientRes.end(JSON.stringify({ error: 'AGY backend unavailable', code: error.code || 'UPSTREAM_ERROR' }));
    });
  };

  attempt();
}

const server = http.createServer(proxyHttp);

server.on('upgrade', (req, clientSocket, head) => {
  const backendSocket = net.connect(backendPort, backendHost);
  backendSocket.once('connect', () => {
    const headers = Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n');
    backendSocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length) backendSocket.write(head);
    clientSocket.pipe(backendSocket).pipe(clientSocket);
  });
  backendSocket.once('error', () => clientSocket.destroy());
  clientSocket.once('error', () => backendSocket.destroy());
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 0;
server.listen(listenPort, listenHost, () => {
  console.log(`AGY relay listening on ${listenHost}:${listenPort} -> ${backendHost}:${backendPort}`);
});

const shutdown = signal => {
  console.log(`AGY relay shutting down: ${signal}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
