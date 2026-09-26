/* node test/provider.openai-compatible.test.js - generic chat/completions provider seam. */
'use strict';
const A = require('./_assert.js');
const { makeOpenAICompatibleProvider } = require('../sidecar/providers/openai-compatible.js');

const line = obj => 'data: ' + JSON.stringify(obj);
async function collect(provider, req) { const out = []; for await (const e of provider.stream(req)) out.push(e); return out; }

module.exports = (async () => {
  // Managed Claude must preserve the same continuation ordering as direct OpenRouter.
  {
    for (const model of ['anthropic/claude-sonnet-4.6', 'gpt-4o']) {
      const messages = [{ role: 'system', content: 'Policy' }, { role: 'user', content: 'Write' }, { role: 'assistant', content: 'Written' }, { role: 'system', content: '<verify_before_done>Check the file.</verify_before_done>' }];
      const original = JSON.stringify(messages);
      let wire;
      const fetch = async (url, init) => {
        if (!url.endsWith('/chat/completions')) return new Response('{"data":[]}');
        wire = JSON.parse(init.body);
        return new Response('data: [DONE]\n\n');
      };
      await collect(makeOpenAICompatibleProvider({ fetch, key: 'fixture-only', baseUrl: 'https://managed.example.test/v1' }), { model, messages });
      A.eq(wire.messages.at(-1).role, model.startsWith('anthropic/') ? 'user' : 'system', model + ': managed continuation is not hoisted into forbidden prefill');
      A.eq(wire.messages[0], messages[0], model + ': leading policy unchanged');
      A.eq(wire.messages.at(-1).content, messages.at(-1).content, model + ': reminder bytes unchanged');
      A.eq(JSON.stringify(messages), original, model + ': durable history unchanged');
    }
  }
  // Managed StarNet uses this adapter too. An interrupted history must get the same repair as
  // direct OpenRouter, before it reaches a strict Chat Completions upstream.
  {
    const input = [
      { role: 'user', content: 'continue' },
      { role: 'tool', tool_call_id: '', content: 'orphan evidence' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'pending', type: 'function', function: { name: 'fs_read', arguments: '{}' } }] },
      { role: 'user', content: 'resume after interruption' }
    ];
    const original = JSON.stringify(input);
    let wire;
    const p = makeOpenAICompatibleProvider({ key: 'fixture-only', baseUrl: 'https://managed.example.test/v1', fetch: async (_url, init) => {
      if (!init || !init.body) return new Response('{"data":[{"id":"m"}]}');
      wire = JSON.parse(init.body).messages;
      const pending = new Set();
      for (const m of wire) {
        if (m.role === 'tool') {
          if (!m.tool_call_id || !pending.delete(m.tool_call_id)) return new Response('{"error":{"message":"Tool message must have either name or tool_call_id"}}', { status: 400 });
        } else {
          if (pending.size) return new Response('{"error":{"message":"Missing tool results"}}', { status: 400 });
          for (const call of m.tool_calls || []) pending.add(call.id);
        }
      }
      if (pending.size) return new Response('{"error":{"message":"Missing tool results"}}', { status: 400 });
      return new Response(line({ choices: [{ delta: { content: 'recovered' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } });
    const events = await collect(p, { model: 'm', messages: input });
    A.eq(events.filter(e => e.type === 'text').map(e => e.delta).join(''), 'recovered', 'managed-compatible adapter completes against a strict pair validator');
    A.ok(wire.some(m => m.role === 'user' && m.content.includes('orphan evidence') && m.content.includes('[recovered tool result')), 'orphan content survives with an honest recovery label');
    A.ok(wire.some(m => m.role === 'tool' && m.tool_call_id === 'pending' && m.content.includes('[interrupted')), 'interrupted call gets a labeled missing-result record');
    A.eq(JSON.stringify(input), original, 'wire repair does not mutate the durable caller history');
    const valid = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: null, tool_calls: [{ id: 'ok', type: 'function', function: { name: 'fs_read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'ok', content: 'observed result' }];
    await collect(p, { model: 'm', messages: valid });
    A.eq(wire, valid, 'valid tool history reaches the compatible endpoint unchanged');
  }
  // text, usage, finish, and request/header shape
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const sse = [
        line({ choices: [{ delta: { content: 'Hel' } }] }),
        line({ choices: [{ delta: { content: 'lo' } }] }),
        line({ usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }),
        line({ choices: [{ finish_reason: 'stop', delta: {} }] }),
        'data: [DONE]', ''
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, key: 'KEY', baseUrl: 'https://example.test/v1/', includeUsage: true });
    const evs = await collect(p, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    A.eq(evs.filter(e => e.type === 'text').map(e => e.delta).join(''), 'Hello', 'text deltas stream');
    A.eq(evs.find(e => e.type === 'usage').usage.total_tokens, 5, 'usage event streams');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'stop', 'finish is normalized');
    A.eq(calls[0].url, 'https://example.test/v1/chat/completions', 'posts to chat/completions');
    A.eq(calls[0].init.headers.Authorization, 'Bearer KEY', 'api key is sent as bearer auth');
    A.eq(JSON.parse(calls[0].init.body).stream_options, { include_usage: true }, 'optional usage include is wired');
  }

  // tool-call streaming
  {
    const fetchImpl = async () => {
      const sse = [
        line({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"q":' } }] } }] }),
        line({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] }),
        line({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
        'data: [DONE]', ''
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    const evs = await collect(p, { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    A.eq(evs.find(e => e.type === 'tool_start').name, 'web_search', 'tool_start carries name');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"q":"x"}', 'tool args concatenate');
    A.eq(evs.find(e => e.type === 'done').finishReason, 'tool_calls', 'tool finish is normalized');
  }

  // parallel tool calls WITHOUT .index (non-streamed choice.message; some streaming servers too, e.g.
  // Mistral) must not collapse into one corrupt call — each id gets its own slot.
  {
    const fetchImpl = async () => {
      const sse = [
        line({ choices: [{ message: { tool_calls: [
          { id: 'a', function: { name: 'fs_read', arguments: '{"path":"x"}' } },
          { id: 'b', function: { name: 'fs_read', arguments: '{"path":"y"}' } }
        ] }, finish_reason: 'tool_calls' }] }),
        'data: [DONE]', ''
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    const evs = await collect(p, { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'fs_read' } }] });
    const starts = evs.filter(e => e.type === 'tool_start');
    A.eq(starts.length, 2, 'both index-less parallel calls start');
    A.eq(starts.map(s => s.id), ['a', 'b'], 'each call keeps its own id');
    A.eq(starts[0].index !== starts[1].index, true, 'the calls occupy distinct slots');
    const argsFor = idx => evs.filter(e => e.type === 'tool_args' && e.index === idx).map(e => e.chunk).join('');
    A.eq(argsFor(starts[0].index), '{"path":"x"}', 'first call args are intact');
    A.eq(argsFor(starts[1].index), '{"path":"y"}', 'second call args are not concatenated onto the first');
  }

  // index-less STREAMED call: a bare argument continuation chunk (no id, no name) stays on the
  // current slot instead of opening a phantom one.
  {
    const fetchImpl = async () => {
      const sse = [
        line({ choices: [{ delta: { tool_calls: [{ id: 'c1', function: { name: 'web_search', arguments: '{"q":' } }] } }] }),
        line({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"x"}' } }] } }] }),
        line({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
        'data: [DONE]', ''
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    const evs = await collect(p, { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'web_search' } }] });
    A.eq(evs.filter(e => e.type === 'tool_start').length, 1, 'continuation chunk opens no phantom call');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"q":"x"}', 'continuation args land on the same slot');
  }

  // NAME-ECHOING continuation deltas (no id, no index, name repeated per delta — several vLLM/Ollama/
  // LiteLLM builds): one call streamed across deltas stays ONE call while its args are incomplete JSON.
  {
    const fetchImpl = async () => {
      const sse = [
        line({ choices: [{ delta: { tool_calls: [{ function: { name: 'fs_read', arguments: '{"path":' } }] } }] }),
        line({ choices: [{ delta: { tool_calls: [{ function: { name: 'fs_read', arguments: '"a.txt"}' } }] } }] }),
        line({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
        'data: [DONE]', ''
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    const evs = await collect(p, { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'fs_read' } }] });
    A.eq(evs.filter(e => e.type === 'tool_start').length, 1, 'a name-echoing continuation opens NO second call');
    A.eq(evs.filter(e => e.type === 'tool_args').map(e => e.chunk).join(''), '{"path":"a.txt"}', 'the args reassemble into one valid call');
  }

  // ...but two SEQUENTIAL whole-call deltas with the same name (each with COMPLETE args) are two calls.
  {
    const fetchImpl = async () => {
      const sse = [
        line({ choices: [{ delta: { tool_calls: [{ function: { name: 'fs_read', arguments: '{"path":"x"}' } }] } }] }),
        line({ choices: [{ delta: { tool_calls: [{ function: { name: 'fs_read', arguments: '{"path":"y"}' } }] } }] }),
        line({ choices: [{ finish_reason: 'tool_calls', delta: {} }] }),
        'data: [DONE]', ''
      ].join('\n');
      return new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    const evs = await collect(p, { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'fs_read' } }] });
    const starts = evs.filter(e => e.type === 'tool_start');
    A.eq(starts.length, 2, 'complete-args same-name deltas are DISTINCT calls (never arg-concatenated)');
    const argsFor2 = idx => evs.filter(e => e.type === 'tool_args' && e.index === idx).map(e => e.chunk).join('');
    A.eq(argsFor2(starts[0].index), '{"path":"x"}', 'first call keeps its own args');
    A.eq(argsFor2(starts[1].index), '{"path":"y"}', 'second call keeps its own args');
  }

  // model catalog parsing and no-auth local shape
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ id: 'local-model', context_length: 1234, supported_parameters: ['tools'] }] }), { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://127.0.0.1:11434/v1' });
    const models = await p.listModels();
    A.eq(calls[0].url, 'http://127.0.0.1:11434/v1/models', 'lists /models');
    A.eq(calls[0].init.headers.Authorization, undefined, 'no auth header when no key');
    A.eq(models[0].id, 'local-model', 'catalog id parsed');
    A.eq(p.contextLimit('local-model'), 1234, 'context length from catalog');
    A.eq(p.supportsTools('local-model'), true, 'tool support from supported_parameters');
  }

  // provider profile paths can override the default /chat/completions and /models endpoints
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (init && init.method === 'POST') {
        return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'https://example.test/root/', chatPath: 'responses', modelsPath: 'catalog/models' });
    await collect(p, { model: 'm', messages: [] });
    await p.listModels();
    A.eq(calls[0].url, 'https://example.test/root/responses', 'custom chat path is honored');
    A.eq(calls[1].url, 'https://example.test/root/catalog/models', 'custom models path is honored');
  }

  // usage reporting defaults ON (no includeUsage passed) and can be opted out explicitly
  {
    const mkFetch = (calls) => async (url, init) => {
      calls.push({ url, init });
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const onCalls = [];
    const pOn = makeOpenAICompatibleProvider({ fetch: mkFetch(onCalls), baseUrl: 'http://local/v1' });
    await collect(pOn, { model: 'm', messages: [] });
    A.eq(JSON.parse(onCalls[0].init.body).stream_options, { include_usage: true }, 'usage include defaults ON');

    const offCalls = [];
    const pOff = makeOpenAICompatibleProvider({ fetch: mkFetch(offCalls), baseUrl: 'http://local/v1', includeUsage: false });
    await collect(pOff, { model: 'm', messages: [] });
    A.eq(JSON.parse(offCalls[0].init.body).stream_options, undefined, 'usage include opts out with explicit false');
  }

  // reasoning_effort wiring: profile hint sends it (clamped to the wire scale), no hint omits it,
  // and effort 'none' always omits it
  {
    const mkFetch = (calls) => async (url, init) => {
      calls.push({ url, init });
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const hinted = [];
    const pHint = makeOpenAICompatibleProvider({ fetch: mkFetch(hinted), baseUrl: 'http://local/v1', reasoningEffort: 'max', sendReasoningEffort: true });
    await collect(pHint, { model: 'm', messages: [] });
    A.eq(JSON.parse(hinted[0].init.body).reasoning_effort, 'high', 'profile-hinted reasoning effort is sent, clamped to the wire scale');

    const perReq = [];
    const pReq = makeOpenAICompatibleProvider({ fetch: mkFetch(perReq), baseUrl: 'http://local/v1', reasoningEffort: 'medium', sendReasoningEffort: true });
    await collect(pReq, { model: 'm', messages: [], reasoningEffort: 'low' });
    A.eq(JSON.parse(perReq[0].init.body).reasoning_effort, 'low', 'per-request effort overrides the instance default');

    const unhinted = [];
    const pNo = makeOpenAICompatibleProvider({ fetch: mkFetch(unhinted), baseUrl: 'http://local/v1', reasoningEffort: 'medium' });
    await collect(pNo, { model: 'm', messages: [] });
    A.eq(JSON.parse(unhinted[0].init.body).reasoning_effort, undefined, 'no hint and no catalog proof -> reasoning_effort stays off the wire');

    const offCalls = [];
    const pOff = makeOpenAICompatibleProvider({ fetch: mkFetch(offCalls), baseUrl: 'http://local/v1', reasoningEffort: 'none', sendReasoningEffort: true });
    await collect(pOff, { model: 'm', messages: [] });
    A.eq(JSON.parse(offCalls[0].init.body).reasoning_effort, undefined, 'effort none omits the param entirely');
  }

  // catalog-proven reasoning model sends the effort even without a profile hint
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (init && init.method === 'POST') return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(JSON.stringify({ data: [{ id: 'thinky', supportsReasoning: true }] }), { status: 200 });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1', reasoningEffort: 'medium' });
    await p.listModels();
    await collect(p, { model: 'thinky', messages: [] });
    const post = calls.find(c => c.init && c.init.method === 'POST');
    A.eq(JSON.parse(post.init.body).reasoning_effort, 'medium', 'catalog-declared reasoning model gets the effort param');
    A.eq(p.reasoningEfforts('thinky').indexOf('high') >= 0, true, 'reasoningEfforts(id) exposes the wire scale for a reasoning model');
    A.eq(p.reasoningEfforts('unknown'), ['none'], 'unknown model exposes only reasoning off');
  }

  // unsupported-param self-heal: a 400 naming an optional param retries without it and is remembered per model
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      const body = JSON.parse(init.body);
      if (body.stream_options !== undefined) {
        return new Response(JSON.stringify({ error: { message: 'Unknown parameter: stream_options' } }), { status: 400 });
      }
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    await collect(p, { model: 'm', messages: [] });
    const posts = () => calls.filter(c => c.init && c.init.method === 'POST');   // catalog re-warm GETs interleave
    A.eq(posts().length, 2, 'rejected optional param retries once without it');
    A.eq(JSON.parse(posts()[1].init.body).stream_options, undefined, 'retry body dropped the rejected param');
    await collect(p, { model: 'm', messages: [] });
    A.eq(posts().length, 3, 'drop is remembered per model - later calls skip the param up front');
    A.eq(JSON.parse(posts()[2].init.body).stream_options, undefined, 'remembered drop keeps the param off the wire');
  }

  // tools are NEVER silently dropped - a provider that rejects tools must fail the run honestly
  {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ error: { message: 'tools is not supported' } }), { status: 400 });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    let err = null;
    try { await collect(p, { model: 'm', messages: [], tools: [{ type: 'function', function: { name: 'x' } }] }); }
    catch (e) { err = e; }
    A.eq(!!err, true, 'tools rejection surfaces as an error, never a silent degrade');
    const toolPosts = calls.filter(c => c.init && c.init.method === 'POST');
    A.eq(toolPosts.every(c => JSON.parse(c.init.body).tools !== undefined), true, 'no retry ever removed the tools payload');
  }

  // profile-level tool capability is the fallback when the catalog is silent; catalog booleans win
  {
    const fetchImpl = async (url, init) => {
      if (init && init.method === 'POST') return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      return new Response(JSON.stringify({ data: [{ id: 'tooly', supported_parameters: ['tools'] }, { id: 'bare' }] }), { status: 200 });
    };
    const pDeny = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1', supportsTools: false });
    A.eq(pDeny.supportsTools('anything'), false, 'cold catalog falls back to the profile assertion');
    await pDeny.listModels();
    A.eq(pDeny.supportsTools('tooly'), true, 'catalog-declared tool support beats the profile fallback');
    A.eq(pDeny.supportsTools('bare'), false, 'catalog silence falls back to the profile assertion');
    const pNull = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1' });
    A.eq(pNull.supportsTools('anything'), null, 'no profile assertion stays honestly unknown');
  }

  // static catalog fallback: fills in only when the live endpoint yields nothing; a real catalog wins
  {
    const statics = [{ id: 'sonar', context_length: 128000, supportsTools: false, supportsReasoning: false }];
    const emptyFetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
    const pEmpty = makeOpenAICompatibleProvider({ fetch: emptyFetch, baseUrl: 'http://api/v1', staticModels: statics });
    const fromStatic = await pEmpty.listModels();
    A.eq(fromStatic.length, 1, 'empty live catalog falls back to the static roster');
    A.eq(pEmpty.contextLimit('sonar'), 128000, 'static roster carries context limits (compaction works)');
    A.eq(pEmpty.supportsTools('sonar'), false, 'static roster carries capability facts');
    A.eq(pEmpty.priceOf('sonar'), null, 'static roster stays honestly unpriced');

    const liveFetch = async () => new Response(JSON.stringify({ data: [{ id: 'real-model' }] }), { status: 200 });
    const pLive = makeOpenAICompatibleProvider({ fetch: liveFetch, baseUrl: 'http://api/v1', staticModels: statics });
    const fromLive = await pLive.listModels();
    A.eq(fromLive.map(m => m.id).join(','), 'real-model', 'a live catalog always wins over the static roster');
    A.eq(fromStatic[0].fallback, undefined, 'an authoritative static roster (Perplexity) is a real catalog, not an offline seed');

    // staticModelsFallback (grok/kimi OAuth): the roster only seeds a FAILED live /models, so substituted rows carry
    // the fallback marker — the probe and the model dock must never read them as a confirmed catalog.
    const failFetch = async () => new Response('forbidden', { status: 403 });
    for (const [label, fetch] of [['empty', emptyFetch], ['failed', failFetch]]) {
      const pSeed = makeOpenAICompatibleProvider({ fetch, baseUrl: 'http://api/v1', staticModels: statics, staticModelsFallback: true });
      const seeded = await pSeed.listModels();
      A.eq(seeded.map(m => [m.id, m.fallback]), [['sonar', true]], label + ' live catalog serves the seed roster marked fallback');
      A.eq(pSeed.contextLimit('sonar'), 128000, label + ' fallback rows still carry context limits');
    }
    const pSeedLive = makeOpenAICompatibleProvider({ fetch: liveFetch, baseUrl: 'http://api/v1', staticModels: statics, staticModelsFallback: true });
    A.eq((await pSeedLive.listModels()).map(m => [m.id, m.fallback]), [['real-model', undefined]], 'live rows never carry the fallback marker');

    // the registry wiring: grok/kimi seed rosters are fallbacks, Perplexity's roster is authoritative
    const { selectProvider } = require('../sidecar/providers/factory.js');
    for (const [id, expected] of [['grok', true], ['kimi', true], ['perplexity', undefined]]) {
      const p = selectProvider({ provider: id, fetch: failFetch, key: 'fixture-only', token: 'fixture-only' });
      const rows = await p.listModels();
      A.ok(rows.length > 0, id + ' serves its static roster when /models fails');
      A.ok(rows.every(m => m.fallback === expected), id + ' static rows fallback=' + expected);
    }
  }

  /* ---- a FAILED boot probe must not become a permanent cache hit ----
     `if (catalog) return catalog` treated the [] a failure stores as a hit, so maybeRewarmCatalog — added
     precisely because "an empty catalog stays empty forever" — called straight into that early return. One
     offline launch then zeroed priceOf() for the life of the process (every turn 'unpriced', the ledger
     recording $0 for real spend, the day/global caps never firing) and contextLimit() (no compaction
     threshold). Asserted here for the generic adapter; gemini.js and anthropic.js share the exact shape. ---- */
  {
    let calls = 0, healthy = false, t = 0;
    const fetchImpl = async (url) => {
      if (!String(url).endsWith('/models')) throw new Error('unexpected ' + url);
      calls++;
      if (!healthy) return { ok: false, status: 500, statusText: 'boom', json: async () => ({}), text: async () => '' };
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'gpt-x', context_length: 128000, pricing: { prompt: '0.000003', completion: '0.000015' } }] }) };
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, key: 'k', baseUrl: 'http://api/v1', clock: { now: () => t } });
    A.eq((await p.listModels()).length, 0, 'a failed boot probe yields an empty catalog');
    A.eq(p.contextLimit('gpt-x'), 0, 'and no context limit');
    A.eq(p.priceOf('gpt-x'), null, 'and no price — every turn would be unpriced');
    healthy = true; t = 10 * 60 * 1000;                 // endpoint recovers, the rewarm throttle expires
    A.eq((await p.listModels()).length, 1, 'a later call RE-FETCHES instead of returning the cached empty array');
    A.ok(calls >= 2, 'the /models endpoint was actually probed again');
    A.eq(p.contextLimit('gpt-x'), 128000, 'the context limit recovers');
    A.eq(p.priceOf('gpt-x').in, 3, 'and so does pricing, so the ledger stops recording $0');
  }

  /* ---- NO silent default endpoint (2026-08-25 stranded-user incident) ----
     The adapter used to default an empty baseUrl to https://api.openai.com/v1. starnet's baseUrl resolves
     dynamically from the device link, so the moment the link failed to resolve, a "starnet" run silently
     left for OpenAI's real API — bearer token and all — and died with OpenAI's bare "invalid model ID".
     An endpointless provider must refuse at construction, loudly, naming the problem. ---- */
  {
    let threw = null;
    try { makeOpenAICompatibleProvider({ fetch: async () => { throw new Error('must never be called'); } }); }
    catch (e) { threw = e; }
    A.ok(threw, 'an empty baseUrl refuses at construction instead of defaulting to api.openai.com');
    A.ok(/no endpoint configured/i.test(String(threw && threw.message)), 'the refusal names the missing endpoint');
  }

  /* ---- routed-catalog id on a vendor endpoint gets a way back ----
     A vendor API 400ing "invalid model ID" for a slash-prefixed id means a STARNET/OpenRouter catalog id
     (e.g. openai/gpt-…) reached a direct vendor endpoint — the provider/model pair crossed. The bare vendor
     message is a dead end; the error must name the mismatch and the fix (switch provider in the picker). ---- */
  {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'invalid model ID', code: 400 } }), { status: 400 });
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, key: 'k', baseUrl: 'https://api.vendor.test/v1' });
    let err = null;
    try { await collect(p, { model: 'openai/gpt-5.6-terra', messages: [{ role: 'user', content: 'hi' }] }); }
    catch (e) { err = e; }
    A.ok(err, 'the 400 still fails the run (no silent recovery)');
    A.ok(/routed-catalog model id/.test(String(err && err.message)), 'the error names the catalog/endpoint mismatch');
    A.ok(/Switch the provider/i.test(String(err && err.message)), 'and points at the model-picker remedy');
    // a slashless unknown model on the same endpoint keeps the vendor's own message untouched
    const p2 = makeOpenAICompatibleProvider({ fetch: fetchImpl, key: 'k', baseUrl: 'https://api.vendor.test/v1' });
    let err2 = null;
    try { await collect(p2, { model: 'gpt-nonexistent', messages: [{ role: 'user', content: 'hi' }] }); }
    catch (e) { err2 = e; }
    A.ok(err2 && !/routed-catalog/.test(String(err2.message)), 'a slashless model id gets no mismatch hint (not a crossing)');
  }

  /* ---- managed upstream failures retain safe diagnostic identity ----
     OpenRouter can answer only "Provider returned error" at the top level while carrying the provider, code,
     and a StarNet correlation id separately. Those fields must survive into diagnostics; raw metadata must not. */
  {
    const fetchImpl = async () => new Response(JSON.stringify({
      error: {
        message: 'Provider returned error', type: 'upstream_error', code: 'provider_rejected',
        provider: 'Anthropic', request_id: 'req_body_7',
        metadata: { raw: 'secret prompt-shaped upstream body' }
      }
    }), { status: 400, headers: { 'x-starnet-request-id': 'req_header_ignored' } });
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, key: 'k', baseUrl: 'https://managed.test/v1', label: 'starnet' });
    let err = null;
    try { await collect(p, { model: 'anthropic/claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }] }); }
    catch (e) { err = e; }
    A.ok(err, 'upstream 400 still fails the run');
    A.ok(/Provider returned error/.test(err.message), 'safe upstream message survives');
    A.ok(/code provider_rejected/.test(err.message), 'upstream code survives');
    A.ok(/provider Anthropic/.test(err.message), 'upstream provider identity survives');
    A.ok(/request req_body_7/.test(err.message), 'body request id survives for support correlation');
    A.eq(err.requestId, 'req_body_7', 'request id is also structured on the error');
    A.ok(!/secret prompt-shaped/.test(err.message), 'unbounded raw provider metadata is never exposed');
  }

  // If the body has no request id, the managed proxy response header is retained; token-shaped strings redact.
  {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: 'bad Bearer abcdefghijklmnop sk-secretsecret' } }), {
      status: 400, headers: { 'x-starnet-request-id': 'starnet_req_9' }
    });
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'https://managed.test/v1' });
    let err = null;
    try { await collect(p, { model: 'm', messages: [] }); } catch (e) { err = e; }
    A.ok(/request starnet_req_9/.test(err && err.message), 'proxy correlation header is retained');
    A.ok(!/abcdefghijklmnop|sk-secretsecret/.test(err && err.message), 'obvious credential-shaped text is redacted');
  }

  {
    const { makeDiagnostics } = require('../sidecar/diagnostics.js');
    const { redact } = require('../sidecar/context.js');
    const fetchImpl = async () => new Response(JSON.stringify({ error: {
      message: 'Provider rejected the request. '.repeat(40), request_id: 'relay-correlation-123',
      upstream_request_id: 'upstream-correlation-456', metadata: { raw: 'PRIVATE PROMPT MUST NOT LEAK' }
    } }), { status: 400 });
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'https://managed.test/v1' });
    let err;
    try { await collect(p, { model: 'anthropic/claude-sonnet-5', messages: [] }); } catch (e) { err = e; }
    const receipt = makeDiagnostics({ redact }).assemble({ errors: [{ message: err.message, runId: 'local-run-789' }] });
    A.ok(receipt.text.includes('relay-correlation-123'), 'relay id survives diagnostic truncation');
    A.ok(receipt.text.includes('upstream-correlation-456'), 'upstream id survives diagnostic truncation');
    A.ok(receipt.text.includes('local-run-789'), 'local run remains correlated to this error');
    A.ok(!receipt.text.includes('PRIVATE PROMPT'), 'raw upstream payload is not copied');
  }

  /* ---- FLAT xAI error bodies: {code, error:"<sentence>"} ----
     A spent SuperGrok allowance answered 429 with a flat body. Reading only error.{message,code} left providerCode
     '' and the raw JSON as the message, so the classifier saw a plain 429 (rate_limit) and the adapter retried a
     meter no wait refills. Now: ONE request, a non-transient error, the code structured, the sentence human. */
  {
    let posts = 0;
    const fetchImpl = async (url, init) => {
      if (!init || init.method !== 'POST') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      posts++;
      return new Response(JSON.stringify({ code: 'subscription:free-usage-exhausted', error: "You've used all the included free usage for model grok-4.7. Enable Extra Usage to continue." }), { status: 429 });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, key: 'k', baseUrl: 'https://cli-chat-proxy.example.test/v1', label: 'Grok (xAI)' });
    let err = null;
    try { await collect(p, { model: 'grok-4.7', messages: [{ role: 'user', content: 'hi' }] }); }
    catch (e) { err = e; }
    A.ok(err, 'the spent allowance fails the run');
    A.eq(posts, 1, 'exactly ONE request — a spent allowance is never retried with backoff');
    A.eq(err.transient, false, 'the error is marked non-transient');
    A.ok(!err.preStreamRetriesExhausted, 'and was not treated as an exhausted transient ladder');
    A.eq(err.providerCode, 'subscription:free-usage-exhausted', 'the flat top-level code is lifted into providerCode');
    A.ok(/^Grok \(xAI\) http 429 - \[code subscription:free-usage-exhausted\] You've used all the included free usage/.test(err.message),
      'the message is the human sentence (with its code), labeled with the provider: ' + err.message);
    A.ok(!/[{}"]/.test(err.message), 'no raw JSON reaches the user');
    // a flat {message, code} body reads the same way
    const p2 = makeOpenAICompatibleProvider({ baseUrl: 'https://flat.example.test/v1', fetch: async (url, init) => {
      if (!init || init.method !== 'POST') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({ code: 'invalid_argument', message: 'Maximum tools limit reached' }), { status: 400 });
    } });
    let err2 = null;
    try { await collect(p2, { model: 'm', messages: [] }); } catch (e) { err2 = e; }
    A.eq(err2 && err2.providerCode, 'invalid_argument', 'flat {message, code}: code lifted');
    A.ok(/\[code invalid_argument\] Maximum tools limit reached$/.test(err2 && err2.message), 'flat {message, code}: message is the sentence');
    // an object-shaped body without a code gains no invented one
    const p3 = makeOpenAICompatibleProvider({ baseUrl: 'https://obj.example.test/v1', fetch: async (url, init) => {
      if (!init || init.method !== 'POST') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(JSON.stringify({ code: 'top_level_ignored', error: { message: 'nested wins' } }), { status: 400 });
    } });
    let err3 = null;
    try { await collect(p3, { model: 'm', messages: [] }); } catch (e) { err3 = e; }
    A.eq(err3 && err3.providerCode, '', 'object-shaped error bodies keep reading error.code only');
    A.ok(/http 400 - nested wins$/.test(err3 && err3.message), 'object-shaped error bodies keep their exact message');
    // a string `error` that is only a CODE TOKEN must not hide the sentence beside it (base showed the sentence
    // for {error, message} and the raw JSON — description included — for OAuth-style {error, error_description})
    const { responseErrorDetail } = require('../sidecar/providers/openai-compatible.js')._internals;
    const bodyRes = (obj, status) => new Response(JSON.stringify(obj), { status: status || 401 });
    const tokMsg = await responseErrorDetail(bodyRes({ error: 'unauthorized', message: 'Your device link expired — re-link this station.' }));
    A.eq(tokMsg.detail, 'Your device link expired — re-link this station.', 'flat {error:<code>, message:<sentence>}: the top-level message wins over the code token');
    const tokDesc = await responseErrorDetail(bodyRes({ error: 'invalid_token', error_description: 'The access token expired' }));
    A.eq(tokDesc.detail, 'invalid_token: The access token expired', 'flat {error, error_description}: the description rides with the token');
    const xaiFlat = await responseErrorDetail(bodyRes({ code: 'subscription:free-usage-exhausted', error: "You've used all the included free usage" }, 429));
    A.eq(xaiFlat.detail, "[code subscription:free-usage-exhausted] You've used all the included free usage", "xAI's {code, error:<sentence>} (no message) still reads the sentence");
  }
  // an in-stream flat error keeps its sentence (and code) instead of collapsing to 'provider stream error'
  {
    const fetchImpl = async (url, init) => {
      if (!init || init.method !== 'POST') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(line({ code: 'subscription:free-usage-exhausted', error: "You've used all the included free usage" }) + '\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'https://stream.example.test/v1' });
    let err = null;
    try { await collect(p, { model: 'm', messages: [] }); } catch (e) { err = e; }
    A.eq(err && err.message, "openai-compatible stream error: You've used all the included free usage", 'the in-stream string error keeps its text, labeled');
    A.eq(err && err.providerCode, 'subscription:free-usage-exhausted', 'and its code');
    // labeled like the pre-stream error, so the UI can see a GROK OAUTH in-stream failure came from grok
    const pg = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'https://stream.example.test/v1', label: 'Grok (xAI)' });
    let errG = null;
    try { await collect(pg, { model: 'm', messages: [] }); } catch (e) { errG = e; }
    A.ok(/^Grok \(xAI\) stream error: You've used all the included free usage$/.test(errG && errG.message), 'a labeled adapter names itself on an in-stream error: ' + (errG && errG.message));
    const { friendlyError } = require('../frontend/app/friendlyerror.js');
    const fv = friendlyError(errG);
    A.eq(fv.kind, 'quota_exhausted', 'the labeled grok in-stream spent allowance reads as quota_exhausted in the UI');
    A.eq(fv.provider, 'grok', 'and carries the grok copy');
    // in-stream {error:<code>, message:<sentence>}: the sentence wins, as it does pre-stream
    const pm = makeOpenAICompatibleProvider({ baseUrl: 'https://stream.example.test/v1', fetch: async (url, init) => {
      if (!init || init.method !== 'POST') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      return new Response(line({ error: 'overloaded', message: 'The model is at capacity right now' }) + '\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    } });
    let errM = null;
    try { await collect(pm, { model: 'm', messages: [] }); } catch (e) { errM = e; }
    A.eq(errM && errM.message, 'openai-compatible stream error: The model is at capacity right now', 'in-stream flat {error, message}: the sentence wins');
  }

  // OUTPUT CEILING (issue #17): off by default, on when the profile declares it, explicit req.max_tokens wins,
  // and an endpoint that 400s on the legacy param name self-heals through the droppable list.
  {
    const wireOf = async (opts, req) => {
      let wire = null;
      const p = makeOpenAICompatibleProvider(Object.assign({ baseUrl: 'http://local/v1', fetch: async (url, init) => {
        if (init && init.method === 'POST') { wire = JSON.parse(init.body); return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } }); }
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      } }, opts));
      await collect(p, Object.assign({ model: 'm', messages: [] }, req || {}));
      return wire;
    };
    A.eq((await wireOf({})).max_tokens, undefined, 'no ceiling on the wire unless a profile or caller asks for one');
    A.eq((await wireOf({ maxTokens: 4096 })).max_tokens, 4096, 'a profile-declared ceiling rides every request as max_tokens');
    A.eq((await wireOf({ maxTokens: 4096 }, { max_tokens: 512 })).max_tokens, 512, 'an explicit per-request max_tokens beats the profile ceiling');
    A.eq((await wireOf({ maxTokens: 4096, maxChatTokens: 512 }, { isTask: false })).max_tokens, 512, 'explicit casual chat uses the smaller profile allowance');
    A.eq((await wireOf({ maxTokens: 4096, maxChatTokens: 512 }, { isTask: true })).max_tokens, 4096, 'tasks retain their full allowance even without tool definitions');
    A.eq((await wireOf({ maxTokens: 4096, maxChatTokens: 512 })).max_tokens, 4096, 'unclassified auxiliary calls retain their full allowance');
    A.eq((await wireOf({ maxTokens: 256, maxChatTokens: 512 }, { isTask: false })).max_tokens, 256, 'casual allowance never raises a smaller configured ceiling');
    A.eq((await wireOf({}, { isTask: false })).max_tokens, undefined, 'hosted chat is unchanged without a profile cap');
    A.eq((await wireOf({ maxTokens: 4096 }, { max_tokens: Infinity })).max_tokens, 4096, 'a non-finite request cannot disable the output ceiling');
    A.eq((await wireOf({ maxTokens: 0 })).max_tokens, undefined, 'a zero/absent profile ceiling sends nothing');
    A.eq((await wireOf({ maxTokens: 'nope' })).max_tokens, undefined, 'a junk profile ceiling sends nothing');
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      if (!init || init.method !== 'POST') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      const body = JSON.parse(init.body);
      if (body.max_tokens !== undefined) return new Response(JSON.stringify({ error: { message: 'Unsupported parameter: max_tokens is not supported with this model. Use max_completion_tokens instead.' } }), { status: 400 });
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };
    const p = makeOpenAICompatibleProvider({ fetch: fetchImpl, baseUrl: 'http://local/v1', maxTokens: 4096 });
    await collect(p, { model: 'strict', messages: [] });
    const posts = calls.filter(c => c.init && c.init.method === 'POST');
    A.eq(posts.length, 2, 'an endpoint that rejects max_tokens gets one retry without it');
    A.eq(JSON.parse(posts[1].init.body).max_tokens, undefined, 'the retry dropped max_tokens instead of failing the run');
  }

  A.report('provider.openai-compatible.test');
})();
