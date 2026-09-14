import { createHash } from 'crypto';

const SESSION_HEADERS = [
  'x-session-id',
  'x-conversation-id',
  'x-opencode-session',
  'x-client-session-id'
];

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (typeof part?.text === 'string') return part.text;
    if (part?.type === 'image_url' || part?.inlineData || part?.type === 'image') return '[image]';
    if (part?.type === 'tool_result') return '[tool-result]';
    return '';
  }).join('\n');
}

function getFirstUserText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : body?.contents;
  if (!Array.isArray(messages)) return '';
  const message = messages.find(item => item?.role === 'user') || messages[0];
  if (!message) return '';
  return contentToText(message.content ?? message.parts).trim();
}

export function getRequestSessionKey(req, protocol, model, body = {}) {
  for (const header of SESSION_HEADERS) {
    const value = req?.headers?.[header];
    if (typeof value === 'string' && value.trim()) {
      return `header:${createHash('sha256').update(value.trim()).digest('hex')}`;
    }
  }

  const explicit = body.session_id || body.sessionId || body.conversation_id ||
    body.conversationId || body.metadata?.session_id || body.metadata?.conversation_id;
  if (typeof explicit === 'string' && explicit.trim()) {
    return `body:${createHash('sha256').update(explicit.trim()).digest('hex')}`;
  }

  const firstUserText = getFirstUserText(body);
  if (!firstUserText) return null;
  const source = `${protocol || 'unknown'}\0${model || ''}\0${firstUserText.slice(0, 4096)}`;
  return `fingerprint:${createHash('sha256').update(source).digest('hex')}`;
}

export function scopeTokenToRequest(token, sessionKey) {
  if (!token || !sessionKey) return token;
  return {
    ...token,
    signatureSessionId: `${token.sessionId}:${sessionKey}`
  };
}
