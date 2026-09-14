import axios from 'axios';
import config from '../config/config.js';
import { getAvailableModels } from '../api/client.js';
import {
  resolveOpenCodeConfigPath,
  loadOpenCodeDocument,
  extractProvidersFromOpenCode,
  summarizeCatalog,
  publicProviderView,
  deriveImageUpstreamFromProviders
} from '../utils/opencodeCatalog.js';

function catalogConfig() {
  return config.catalog || {};
}

export function getOpenCodeConfigPath() {
  return resolveOpenCodeConfigPath(catalogConfig().opencodeConfigPath);
}

export function resolveImageUpstream() {
  const configured = config.imageUpstream || {};
  let derived = {};
  try {
    const doc = loadOpenCodeDocument(getOpenCodeConfigPath());
    derived = deriveImageUpstreamFromProviders(extractProvidersFromOpenCode(doc));
  } catch {
    derived = {};
  }

  const codexUrl =
    configured.codex?.url ||
    process.env.CODEX_IMAGE_URL ||
    derived.codex?.url ||
    null;
  const codexKey =
    configured.codex?.apiKey ||
    process.env.CODEX_API_KEY ||
    derived.codex?.apiKey ||
    '';

  const doubaoUrl =
    configured.doubao?.url ||
    process.env.DOUBAO_IMAGE_URL ||
    derived.doubao?.url ||
    'https://ark.cn-beijing.volces.com/api/v3/images/generations';
  const doubaoKey =
    configured.doubao?.apiKey ||
    process.env.DOUBAO_API_KEY ||
    derived.doubao?.apiKey ||
    '';

  return {
    codex: { url: codexUrl, apiKey: codexKey },
    doubao: { url: doubaoUrl, apiKey: doubaoKey }
  };
}

async function probeEndpoint(baseURL, apiKey, timeoutMs = 2500) {
  if (!baseURL) {
    return { ok: false, status: null, modelCount: null, error: 'no baseURL', ms: 0 };
  }
  const started = Date.now();
  const url = `${String(baseURL).replace(/\/$/, '')}/models`;
  try {
    const res = await axios.get(url, {
      timeout: timeoutMs,
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
      },
      validateStatus: () => true
    });
    const list = Array.isArray(res.data?.data) ? res.data.data : (Array.isArray(res.data) ? res.data : []);
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      modelCount: list.length,
      error: res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}`,
      ms: Date.now() - started
    };
  } catch (error) {
    return {
      ok: false,
      status: error.response?.status || null,
      modelCount: null,
      error: error.code || error.message,
      ms: Date.now() - started
    };
  }
}

export async function buildModelCatalog({ probe = true } = {}) {
  const configPath = getOpenCodeConfigPath();
  const doc = loadOpenCodeDocument(configPath);
  const providers = extractProvidersFromOpenCode(doc);

  let liveAgyIds = [];
  let agyLiveError = null;
  try {
    const live = await getAvailableModels();
    liveAgyIds = (live?.data || []).map((m) => m.id).filter(Boolean);
  } catch (error) {
    agyLiveError = error.message;
  }

  const summary = summarizeCatalog(providers, { liveAgyIds });
  const publicProviders = providers.map(publicProviderView);

  let probes = [];
  if (probe) {
    probes = await Promise.all(
      providers.map(async (p) => {
        if (p.disabled) {
          return { providerId: p.id, ok: false, skipped: true, error: 'disabled' };
        }
        if (p.id === 'agy' || p.id === 'image') {
          return {
            providerId: p.id,
            ok: !agyLiveError,
            status: agyLiveError ? null : 200,
            modelCount: liveAgyIds.length,
            error: agyLiveError,
            ms: 0,
            source: 'local-agy'
          };
        }
        const result = await probeEndpoint(p.baseURL, p.apiKey);
        return { providerId: p.id, ...result };
      })
    );
  }

  const defaults = {
    model: doc.model || null,
    smallModel: doc.small_model || null
  };

  const listenHost = config.server.host;
  const listenPort = config.server.port;
  const agyProvider = providers.find((p) => p.id === 'agy');
  const publicFromOpenCode = agyProvider?.origin ? new URL(agyProvider.origin) : null;
  const publicHost =
    process.env.AGY_PUBLIC_HOST ||
    publicFromOpenCode?.hostname ||
    listenHost;
  const publicPort = Number.parseInt(
    process.env.AGY_PUBLIC_PORT ||
      process.env.RELAY_PORT ||
      publicFromOpenCode?.port ||
      '',
    10
  ) || listenPort;

  return {
    source: {
      path: configPath,
      defaultModel: defaults.model,
      smallModel: defaults.smallModel
    },
    gateway: {
      host: listenHost,
      port: listenPort,
      publicHost,
      publicPort,
      baseURL: `http://${publicHost}:${publicPort}/v1`,
      listenBaseURL: `http://${listenHost}:${listenPort}/v1`,
      liveModelCount: liveAgyIds.length,
      error: agyLiveError
    },
    totals: summary.totals,
    providers: publicProviders,
    models: summary.models,
    probes,
    imageUpstream: (() => {
      const resolved = resolveImageUpstream();
      return {
        codex: { url: resolved.codex.url, hasApiKey: !!resolved.codex.apiKey },
        doubao: { url: resolved.doubao.url, hasApiKey: !!resolved.doubao.apiKey }
      };
    })()
  };
}
