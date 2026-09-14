/**
 * Claude/Anthropic 流式响应状态管理器
 */

export class ClaudeStreamState {
  constructor(model) {
    this.model = model;
    this.messageId = `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
    this.blockIndex = 0;
    this.hasStarted = false;
    this.hasThinkingBlock = false;
    this.hasTextBlock = false;
  }

  createMessageStart() {
    this.hasStarted = true;
    return {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    };
  }

  createThinkingBlockStart(signature = null) {
    const contentBlock = { type: 'thinking', thinking: '' };
    if (signature) {
      contentBlock.signature = signature;
    }
    const event = {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: contentBlock
    };
    this.hasThinkingBlock = true;
    return event;
  }

  createThinkingDelta(thinking) {
    return {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: { type: 'thinking_delta', thinking }
    };
  }

  createBlockStop() {
    const event = {
      type: 'content_block_stop',
      index: this.blockIndex
    };
    this.blockIndex++;
    return event;
  }

  createTextBlockStart() {
    const event = {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: { type: 'text', text: '' }
    };
    this.hasTextBlock = true;
    return event;
  }

  createTextDelta(text) {
    return {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: { type: 'text_delta', text }
    };
  }

  createToolUseBlockStart(id, name) {
    const event = {
      type: 'content_block_start',
      index: this.blockIndex,
      content_block: { type: 'tool_use', id, name, input: {} }
    };
    return event;
  }

  createToolUseInputDelta(partialJson) {
    return {
      type: 'content_block_delta',
      index: this.blockIndex,
      delta: { type: 'input_json_delta', partial_json: partialJson }
    };
  }

  createMessageDelta(stopReason, outputTokens = 0) {
    return {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens }
    };
  }

  createMessageStop() {
    return { type: 'message_stop' };
  }
}
