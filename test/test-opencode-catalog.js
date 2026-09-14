import assert from 'node:assert/strict';
import {
  classifyModel,
  parseBaseUrl,
  extractProvidersFromOpenCode,
  summarizeCatalog,
  redactSecrets,
  resolveOpenCodeConfigPath,
  publicProviderView,
  deriveImageUpstreamFromProviders
} from '../src/utils/opencodeCatalog.js';

assert.equal(classifyModel('gpt-5.6-sol').family, 'gpt');
assert.equal(classifyModel('gemini-3.1-flash-image', { modalities: { output: ['text', 'image'] } }).kind, 'image');
assert.equal(classifyModel('doubao-seedream-5-0-pro-260628').kind, 'image');

const parsed = parseBaseUrl('http://127.0.0.1:61175/v1');
assert.equal(parsed.host, '127.0.0.1');
assert.equal(parsed.port, '61175');
assert.equal(parsed.isLocal, true);
assert.equal(parsed.baseURL, 'http://127.0.0.1:61175/v1');

const doc = {
  disabled_providers: ['alibaba'],
  provider: {
    agy: {
      name: 'AGY',
      options: { apiKey: 'sk-secret', baseURL: 'http://127.0.0.1:8045/v1' },
      models: {
        'gemini-3.7-flash-tiered': { name: 'Gemini Flash', reasoning: true, tool_call: true }
      }
    },
    codex: {
      name: 'Codex',
      options: { apiKey: 'agt_secret', baseURL: 'http://127.0.0.1:61175/v1' },
      models: {
        'gpt-5.6-sol': { name: 'GPT Sol', reasoning: true }
      }
    },
    image: {
      name: 'Image',
      options: { apiKey: 'sk-secret', baseURL: 'http://127.0.0.1:8045/v1' },
      models: {
        'gemini-3.1-flash-image': {
          name: 'Flash Image',
          modalities: { input: ['text', 'image'], output: ['text', 'image'] }
        }
      }
    }
  }
};

const providers = extractProvidersFromOpenCode(doc);
assert.equal(providers.length, 3);
assert.equal(providers.find((p) => p.id === 'codex').port, '61175');
assert.equal(providers.find((p) => p.id === 'agy').hasApiKey, true);

const summary = summarizeCatalog(providers, { liveAgyIds: ['gemini-3.7-flash-tiered', 'claude-sonnet-4-6'] });
assert.ok(summary.totals.models >= 4);
assert.equal(summary.totals.image, 1);
assert.ok(summary.models.some((m) => m.id === 'claude-sonnet-4-6' && m.source === 'agy-live'));
assert.ok(summary.models.some((m) => m.ref === 'codex/gpt-5.6-sol'));

const pub = publicProviderView(providers.find((p) => p.id === 'codex'));
assert.equal('apiKey' in pub, false);
assert.equal(JSON.stringify(pub).includes('agt_secret'), false);

const redacted = redactSecrets({ options: { apiKey: 'sk-x', baseURL: 'http://x' } });
assert.equal(redacted.options.apiKey, '[redacted]');

const derived = deriveImageUpstreamFromProviders(providers);
assert.equal(derived.codex.url, 'http://127.0.0.1:61175/v1/images/generations');
assert.ok(derived.codex.apiKey);

const homePath = resolveOpenCodeConfigPath('');
assert.match(homePath, /opencode\.json$/);

console.log('opencode catalog tests passed');
process.exit(0);
