import http from 'http';
import { URL } from 'url';

const CALLBACK_PATH = '/oauth-callback';

export class LocalOAuthFlow {
  constructor({ oauthManager, tokenManager, logger }) {
    this.oauthManager = oauthManager;
    this.tokenManager = tokenManager;
    this.logger = logger;
    this.activeFlow = null;
  }

  async start(mode = 'antigravity') {
    if (this.activeFlow) {
      return { ...this.activeFlow.publicState, reused: true };
    }

    const server = http.createServer((req, res) => this.handleCallback(req, res));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const port = server.address().port;
    const id = cryptoRandomId();
    const publicState = { id, status: 'pending', mode };
    const authUrl = this.oauthManager.generateAuthUrl(port, mode);
    const state = new URL(authUrl).searchParams.get('state');
    this.activeFlow = { id, mode, port, server, state, publicState };
    return {
      ...publicState,
      authUrl,
      callbackPort: port
    };
  }

  getStatus(id) {
    if (!this.activeFlow || this.activeFlow.id !== id) {
      return { status: 'not_found' };
    }
    return { ...this.activeFlow.publicState };
  }

  async handleCallback(req, res) {
    const flow = this.activeFlow;
    if (!flow) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    const url = new URL(req.url, `http://127.0.0.1:${flow.port}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }

    if (flow.publicState.status !== 'pending') {
      res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('OAuth flow already completed');
      return;
    }

    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    const state = url.searchParams.get('state');
    if (state !== flow.state) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Invalid OAuth state');
      this.finish(flow, 'failed', 'OAuth校验失败，请重试');
      return;
    }
    flow.publicState.status = 'processing';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(error || !code ? '<h1>授权失败</h1><p>可以关闭此页面。</p>' : '<h1>授权处理中</h1><p>可以关闭此页面。</p>');

    if (error || !code) {
      this.finish(flow, 'failed', error || '未收到授权码');
      return;
    }

    try {
      const account = await this.oauthManager.authenticate(code, flow.port, flow.mode);
      const result = await this.tokenManager.addToken(account);
      if (!result?.success) throw new Error(result?.message || 'Token保存失败');
      this.finish(flow, 'success', account.hasQuota === false ? 'Token添加成功（该账号无资格，已自动使用随机ProjectId）' : 'Token添加成功');
    } catch (error) {
      this.logger.error(`[${flow.mode}] OAuth认证失败:`, error.message);
      this.finish(flow, 'failed', 'OAuth认证失败，请重试');
    }
  }

  finish(flow, status, message) {
    flow.publicState.status = status;
    flow.publicState.message = message;
    setTimeout(() => {
      if (this.activeFlow?.id === flow.id) {
        flow.server.close();
        this.activeFlow = null;
      }
    }, 1000);
  }
}

function cryptoRandomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
