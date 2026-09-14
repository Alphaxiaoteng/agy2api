import fs from 'fs';
import os from 'os';
import path from 'path';

const SECRET_KEYS = new Set([
  'apikey', 'api_key', 'authorization', 'token', 'password', 'secret', 'access_token', 'refresh_token'
]);

export function resolveOpenCodeConfigPath(configuredPath) {
  const fromEnv = process.env.OPENCODE_CONFIG || process.env.OPENCODE_CONFIG_PATH;
  if (fromEnv && String(fromEnv).trim()) return path.resolve(String(fromEnv).trim());
  if (configuredPath && String(configuredPath).trim()) {
    const raw = String(configuredPath).trim();
    if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
    return path.resolve(raw);
  }
  return path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SECRET_KEYS.has(String(key).toLowerCase())) {
      out[key] = typeof val === 'string' && val ? '[redacted]' : null;
      continue;
    }
    out[key] = redactSecrets(val);
  }
  return out;
}

export function classifyModel(modelId, meta = {}) {
  const id = String(modelId || '');
  const lower = id.toLowerCase();
  const outMods = meta?.modalities?.output || [];
  const isImage =
    outMods.includes('image') ||
    lower.includes('image') ||
    lower.includes('seedream') ||
    lower.includes('dall-e') ||
    lower.startsWith('gpt-image');
  let family = 'other';
  if (lower.includes('gemini')) family = 'gemini';
  else if (lower.includes('claude')) family = 'claude';
  else if (lower.startsWith('gpt') || lower.includes('codex')) family = 'gpt';
  else if (lower.includes('deepseek')) family = 'deepseek';
  else if (lower.includes('doubao') || lower.includes('seed')) family = 'doubao';
  return {
    kind: isImage ? 'image' : 'chat',
    family
  };
}

export function parseBaseUrl(baseURL) {
  if (!baseURL || typeof baseURL !== 'string') {
    return { baseURL: null, origin: null, host: null, port: null, isLocal: false };
  }
  try {
    const u = new URL(baseURL);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    const host = u.hostname;
    const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1';
    return {
      baseURL: `${u.origin}${u.pathname.replace(/\/$/, '')}`,
      origin: u.origin,
      host,
      port,
      isLocal
    };
  } catch {
    return { baseURL: null, origin: null, host: null, port: null, isLocal: false };
  }
}

export function extractProvidersFromOpenCode(doc) {
  const providers = [];
  const rawProviders = doc?.provider && typeof doc.provider === 'object' ? doc.provider : {};
  const disabled = new Set(doc?.disabled_providers || []);

  for (const [id, conf] of Object.entries(rawProviders)) {
    if (!conf || typeof conf !== 'object') continue;
    const options = conf.options || {};
    const parsed = parseBaseUrl(options.baseURL);
    const models = [];
    const modelMap = conf.models && typeof conf.models === 'object' ? conf.models : {};
    for (const [modelId, meta] of Object.entries(modelMap)) {
      const cls = classifyModel(modelId, meta || {});
      models.push({
        id: modelId,
        name: meta?.name || modelId,
        providerId: id,
        ref: `${id}/${modelId}`,
        kind: cls.kind,
        family: cls.family,
        reasoning: !!meta?.reasoning,
        toolCall: meta?.tool_call !== false,
        attachment: !!meta?.attachment,
        modalities: meta?.modalities || null,
        limit: meta?.limit || null
      });
    }
    providers.push({
      id,
      name: conf.name || id,
      api: conf.api || 'openai',
      disabled: disabled.has(id),
      baseURL: parsed.baseURL,
      origin: parsed.origin,
      host: parsed.host,
      port: parsed.port,
      isLocal: parsed.isLocal,
      hasApiKey: typeof options.apiKey === 'string' && options.apiKey.length > 0,
      apiKey: typeof options.apiKey === 'string' ? options.apiKey : '',
      modelCount: models.length,
      models
    });
  }

  providers.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return providers;
}

export function summarizeCatalog(providers, { liveAgyIds = [] } = {}) {
  const liveSet = new Set(liveAgyIds);
  const flat = [];
  const byKind = { chat: 0, image: 0 };
  const byFamily = {};

  for (const p of providers) {
    for (const m of p.models) {
      const inLive = p.id === 'agy' || p.id === 'image' ? liveSet.has(m.id) : null;
      flat.push({
        ...m,
        providerName: p.name,
        baseURL: p.baseURL,
        host: p.host,
        port: p.port,
        providerDisabled: p.disabled,
        gatewayLive: inLive
      });
      byKind[m.kind] = (byKind[m.kind] || 0) + 1;
      byFamily[m.family] = (byFamily[m.family] || 0) + 1;
    }
  }

  const extras = [...liveSet].filter((id) => !flat.some((m) => m.providerId === 'agy' && m.id === id));
  for (const id of extras) {
    const cls = classifyModel(id);
    flat.push({
      id,
      name: id,
      providerId: 'agy',
      providerName: 'AGY gateway',
      ref: `agy/${id}`,
      kind: cls.kind,
      family: cls.family,
      reasoning: null,
      toolCall: null,
      attachment: null,
      modalities: null,
      limit: null,
      baseURL: null,
      host: null,
      port: null,
      providerDisabled: false,
      gatewayLive: true,
      source: 'agy-live'
    });
    byKind[cls.kind] = (byKind[cls.kind] || 0) + 1;
    byFamily[cls.family] = (byFamily[cls.family] || 0) + 1;
  }

  return {
    totals: {
      providers: providers.length,
      models: flat.length,
      chat: byKind.chat || 0,
      image: byKind.image || 0,
      byFamily
    },
    models: flat
  };
}

export function publicProviderView(provider) {
  const { apiKey, ...rest } = provider;
  return {
    ...rest,
    models: provider.models
  };
}

export function loadOpenCodeDocument(configPath) {
  if (!fs.existsSync(configPath)) {
    const err = new Error(`OpenCode config not found: ${configPath}`);
    err.code = 'ENOENT';
    throw err;
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

export function deriveImageUpstreamFromProviders(providers) {
  const out = {};
  const codex = providers.find((p) => p.id === 'codex');
  if (codex?.baseURL) {
    out.codex = {
      url: `${codex.baseURL.replace(/\/$/, '')}/images/generations`,
      apiKey: codex.apiKey || ''
    };
  }
  const doubao = providers.find((p) => p.id === 'doubao');
  if (doubao?.origin) {
    out.doubao = {
      url: `${doubao.origin.replace(/\/$/, '')}/api/v3/images/generations`,
      apiKey: doubao.apiKey || ''
    };
  }
  return out;
}
