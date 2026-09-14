import { getLineBuffer, releaseLineBuffer, parseAndEmitStreamChunk } from './stream_parser.js';

export function createStreamLineProcessor({ state, onEvent, onRawChunk } = {}) {
  if (!state || typeof state !== 'object') throw new Error('createStreamLineProcessor: state is required');
  if (typeof onEvent !== 'function') throw new Error('createStreamLineProcessor: onEvent callback is required');

  const lineBuffer = getLineBuffer();

  const processChunk = (chunk) => {
    const text = typeof chunk === 'string' ? chunk : chunk?.toString?.('utf8') ?? String(chunk);
    if (typeof onRawChunk === 'function') onRawChunk(text);

    const lines = lineBuffer.append(text);
    for (let i = 0; i < lines.length; i++) {
      parseAndEmitStreamChunk(lines[i], state, onEvent);
    }
  };

  const close = () => {
    releaseLineBuffer(lineBuffer);
  };

  return { processChunk, close };
}
