'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const backend = fs.readFileSync(path.join(__dirname, '../sidecar/index.js'), 'utf8');
const frontend = fs.readFileSync(path.join(__dirname, '../frontend/app/harness.js'), 'utf8');
function region(source, marker, closing) {
  const start = source.indexOf(marker), end = source.indexOf(closing, start);
  if (start < 0 || end < start) throw Error('Production function not found: ' + marker);
  return source.slice(start, end + closing.length);
}
let models = [], failure = null;
const sandbox = {
  ensureCodexAccessToken: async () => { if (failure) throw failure; return 'fixture-token'; },
  forceRefreshCodexAccessToken: async () => 'fixture-token',
  ensureOAuthAccessToken: async () => { if (failure) throw failure; return 'fixture-token'; },
  selectProvider: () => ({ listModels: async () => models }),
  oauthProviders: { grok: {}, kimi: {} },
  listModelsForProvider: async () => { if (failure) throw failure; return models; },
  globalThis: {},
};
const publicBody = region(backend, 'function publicModel(m)', '\n}\n');
const codexBody = region(backend, 'async function handleCodexModels(', '\n}\n');
const oauthBody = region(backend, 'async function handleOAuthModels(', '\n}\n');
const api = vm.runInNewContext(publicBody + codexBody + oauthBody + '\n({publicModel,handleCodexModels,handleOAuthModels})', sandbox);
async function response(handler, id) {
  let status, body;
  await handler({}, { writeHead(value) { status = value; }, end(value) { body = JSON.parse(value); } }, id);
  return { status, body };
}
module.exports = (async () => {
  models = [{ id: 'offline-seed', fallback: true }, { id: 'live-model' }];
  A.eq(api.publicModel(models[0]).fallback, true, 'generic catalog serialization retains offline provenance');
  A.eq(api.publicModel(models[1]).fallback, false, 'live generic model is not marked as fallback');
  for (const provider of ['codex', 'grok', 'kimi']) {
    const handler = provider === 'codex' ? api.handleCodexModels : api.handleOAuthModels;
    const good = await response(handler, provider);
    A.eq(good.status, 200, provider + ' catalog contract stays HTTP 200');
    A.eq(good.body.models[0].fallback, true, provider + ' serialized seed remains unconfirmed');
    A.eq(good.body.models[1].fallback, false, provider + ' serialized live model retains live provenance');
    failure = new Error('temporary authentication/catalog outage');
    const failed = await response(handler, provider);
    A.eq(failed.status, 200, provider + ' failure still uses the HTTP 200 error contract');
    A.eq(failed.body.error, failure.message, provider + ' failure carries its error body');
    failure = null;
  }
  // listModelsForProvider through the REAL registry + adapters (only the network is faked): a profile that documents
  // `reasoning_effort` fills an undeclared row from the adapter's own per-model efforts, so the dock stops serving
  // live grok rows as OFF-only; wire-less providers (kimi) are served unchanged; fallback provenance survives.
  {
    const factory = require('../sidecar/providers/factory.js');
    let wire = [], fetchImpl;
    const liveFetch = async url => new Response(JSON.stringify({ data: wire }), { status: String(url).endsWith('/models') ? 200 : 500 });
    const failFetch = async () => new Response('forbidden', { status: 403 });
    const list = vm.runInNewContext(region(backend, 'async function listModelsForProvider(', '\n}\n') + publicBody + '\n({listModelsForProvider,publicModel})', {
      normalizeProvider: v => factory.normalizeProviderId(v, 'openrouter'),
      getProviderProfile: factory.getProviderProfile,
      providerRuntimeBaseUrl: () => '', providerRuntimeKey: () => 'fixture-only',
      providerRequiresKey: factory.providerRequiresKey, providerRequiresBaseUrl: factory.providerRequiresBaseUrl,
      providerCredentialError: id => id + ' not configured',
      providerUsesCodex: factory.providerUsesCodex, providerUsesDeviceOAuth: factory.providerUsesDeviceOAuth,
      ensureOAuthAccessToken: async () => 'fixture-token', oauthInferenceHeaders: () => ({}),
      selectProvider: o => factory.selectProvider(Object.assign({}, o, { fetch: fetchImpl })),
      ImageTask: require('../sidecar/image-task.js'), globalThis: {}
    });
    const served = async id => (await list.listModelsForProvider(id, {})).map(list.publicModel);
    const WIRE = ['none', 'minimal', 'low', 'medium', 'high'];
    fetchImpl = liveFetch;
    wire = [{ id: 'grok-4.7' }, { id: 'grok-declared', reasoningEfforts: ['low', 'high'] }];
    let rows = await served('grok');
    A.eq(rows[0].reasoningEfforts, WIRE, 'a live grok row without declared efforts carries the adapter\'s wire efforts');
    A.eq(rows[0].supportsReasoning, false, 'supportsReasoning stays catalog-truthful (unknown → false); the efforts carry the dial');
    A.eq(rows[0].fallback, false, 'a live grok row is not fallback');
    A.eq(rows[1].reasoningEfforts, ['low', 'high'], 'declared per-model efforts are never overwritten');
    wire = [{ id: 'grok-4.3' }];
    A.eq((await served('xai'))[0].reasoningEfforts, WIRE, 'keyed xai (documents reasoning_effort) gets the same fill');
    wire = [{ id: 'kimi-for-coding' }];
    A.eq((await served('kimi'))[0].reasoningEfforts, [], 'kimi (no reasoning_effort wire param) is served unchanged');
    wire = [{ id: 'gpt-5.5' }];
    A.eq((await served('openai'))[0].reasoningEfforts, WIRE, 'keyed openai rows expose the efforts its adapter sends');
    // Ollama documents the wire param but its profile asserts supportsReasoning:false — a non-thinking local model
    // 400s on ANY effort, so its rows stay OFF-only (the pre-fill behaviour) instead of offering MIN..HIGH.
    wire = [{ id: 'llama3.1:8b', object: 'model' }, { id: 'qwen3:14b', object: 'model' }];
    A.eq((await served('ollama')).map(r => r.reasoningEfforts), [[], []], 'ollama rows are served without an effort dial');
    fetchImpl = failFetch;
    rows = await served('grok');
    A.eq(rows.map(r => r.id), ['grok-4.7', 'grok-4', 'grok-3', 'grok-code-fast-1'], 'a failed grok /models serves the static roster');
    A.ok(rows.every(r => r.fallback === true), 'grok seed rows keep fallback provenance through serialization');
    A.eq(rows[0].reasoningEfforts, WIRE, 'grok seed rows carry the same effort dial');
    A.eq(rows[1].reasoningEfforts, WIRE, 'grok-4 (supportsReasoning:true) seed row carries the dial');
    A.eq([rows[2].reasoningEfforts, rows[3].reasoningEfforts], [[], []], 'grok-3 / grok-code-fast-1 (registry supportsReasoning:false) are never filled');
    const sonar = await served('perplexity');
    const byId = id => sonar.find(r => r.id === id);
    A.eq([byId('sonar').reasoningEfforts, byId('sonar-pro').reasoningEfforts], [[], []], 'perplexity sonar / sonar-pro (supportsReasoning:false) are never filled');
    A.eq(byId('sonar-reasoning-pro').reasoningEfforts, WIRE, 'perplexity sonar-reasoning-pro keeps its dial');
    rows = await served('kimi');
    A.ok(rows.length && rows.every(r => r.fallback === true && r.reasoningEfforts.length === 0), 'kimi seed rows are fallback and effort-less');
  }
  let payload;
  const browser = vm.runInNewContext(
    region(frontend, '  function normalizeModel(m)', '\n  }\n') +
    'const MODEL_CATALOG_TIMEOUT_MS=6000;\n' +
    region(frontend, '  async function fetchModelCatalog(', '\n  }\n') + '\n({fetchModelCatalog})',
    { AbortController, setTimeout, clearTimeout, fetch: async () => ({ ok: true, json: async () => payload }) });
  payload = { models: [{ id: 'seed', fallback: true }] };
  A.eq((await browser.fetchModelCatalog('/api/models/custom', 'models'))[0].fallback, true, 'Harness keeps row fallback metadata');
  payload = { fallback: true, models: [{ id: 'seed' }] };
  A.eq((await browser.fetchModelCatalog('/api/models/custom', 'models'))[0].fallback, true, 'Harness keeps response fallback metadata');
  payload = { models: [], error: 'catalog unavailable' };
  let error;
  try { await browser.fetchModelCatalog('/api/models/custom', 'models'); } catch (e) { error = e; }
  A.eq(error && error.message, 'catalog unavailable', 'Harness rejects an error envelope instead of proving an empty catalog');
  payload = { models: [] };
  A.eq((await browser.fetchModelCatalog('/api/models/custom', 'models')).length, 0, 'a successful empty catalog remains a real empty result');
  A.report('model-catalog-truth.test');
})().catch(error => { console.error(error); process.exitCode = 1; });
