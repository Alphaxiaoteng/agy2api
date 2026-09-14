const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10000;

export default class SessionAffinity {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.bindings = new Map();
  }

  get(sessionKey) {
    if (!sessionKey) return null;
    const binding = this.bindings.get(sessionKey);
    if (!binding) return null;
    if (Date.now() - binding.lastUsed > this.ttlMs) {
      this.bindings.delete(sessionKey);
      return null;
    }
    binding.lastUsed = Date.now();
    return binding.tokenId;
  }

  set(sessionKey, tokenId) {
    if (!sessionKey || !tokenId) return;
    if (this.bindings.size >= this.maxEntries && !this.bindings.has(sessionKey)) {
      const oldestKey = this.bindings.keys().next().value;
      if (oldestKey) this.bindings.delete(oldestKey);
    }
    this.bindings.delete(sessionKey);
    this.bindings.set(sessionKey, { tokenId, lastUsed: Date.now() });
  }

  delete(sessionKey, tokenId = null) {
    if (!sessionKey) return;
    const binding = this.bindings.get(sessionKey);
    if (!binding || (tokenId && binding.tokenId !== tokenId)) return;
    this.bindings.delete(sessionKey);
  }

  deleteToken(tokenId) {
    if (!tokenId) return;
    for (const [sessionKey, binding] of this.bindings) {
      if (binding.tokenId === tokenId) this.bindings.delete(sessionKey);
    }
  }

  clear() {
    this.bindings.clear();
  }

  size() {
    return this.bindings.size;
  }
}
