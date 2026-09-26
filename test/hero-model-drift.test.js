/* node test/hero-model-drift.test.js — the Main agent (hero, id 'agent') must come back from a relaunch on the
   provider / model / reasoning effort it was saved with. Three drift paths, each run against the REAL functions:
     · a catalog 'model unavailable' verdict wrote a blank model + the transient provider onto the hero and pushed it;
     · boot / reentry / resumeInto applied the save ROOT (the global Harness selection) over the hero's own pin;
     · the dossier could clear the hero's model pin ('FOLLOW STATION DEFAULT' / empty SAVE MODEL).
   Plus the frontend mirrors of the sidecar registry (grok default effort, grok fallback roster). */
'use strict';
const A = require('./_assert.js');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const app = read('frontend/app/app.js'), ui = read('frontend/app/stationui.js'), harness = read('frontend/app/harness.js');
const fn = (src, header) => { const body = A.fnBody(src, header); if (!body) throw Error('Production function not found: ' + header); return body; };
const registry = require('../sidecar/providers/registry.js');

// A Harness double that scopes effort per provider exactly like harness.js (readScoped/writeScoped).
function harnessDouble(prov) {
  const h = { prov, model: '', efforts: {}, writes: [] };
  Object.assign(h, {
    setProv: p => { h.prov = p; h.writes.push('prov:' + p); },
    getProv: () => h.prov,
    setModel: m => { h.model = m; h.writes.push('model:' + m); },
    getModel: () => h.model,
    setReasoningEffort: e => { h.efforts[h.prov] = e; h.writes.push('effort:' + h.prov + '=' + e); },
    normalizeReasoningEffort: v => String(v || 'medium'),
    setTotals() {}, getKey: () => '', configured: () => true
  });
  return h;
}

/* ---- applyQuickModel: 'catalog_unavailable' notifies only ---- */
{
  const run = sel => {
    const hero = { id: 'agent', model: 'grok-4.7', provider: 'grok', reasoningEffort: 'low' };
    const H = harnessDouble('ollama');
    const seen = { pushRoster: 0, persist: 0, notes: [] };
    const ctx = {
      agent: hero, agents: new Map([['agent', hero]]), Harness: H,
      el: () => null, syncChannels() {}, pushRoster: () => seen.pushRoster++, persist: () => seen.persist++,
      providerLabel: p => String(p).toUpperCase(), effortLabel: e => String(e).toUpperCase(), shortModelLabel: m => String(m).toUpperCase(),
      StationUI: { notify: (m, tone) => seen.notes.push(m) }
    };
    vm.runInNewContext(fn(app, '  function normalizeProviderId(') + '\n' + fn(app, '  function applyQuickModel(') + '\napplyQuickModel(sel);', Object.assign(ctx, { sel }));
    return { hero, H, seen };
  };
  const r = run({ model: '', provider: 'ollama', effort: 'none', reason: 'catalog_unavailable', previousModel: 'grok-4.7' });
  A.eq([r.hero.model, r.hero.provider, r.hero.reasoningEffort], ['grok-4.7', 'grok', 'low'], 'a catalog verdict leaves the hero\'s model/provider/effort untouched');
  A.eq(r.seen.pushRoster, 0, 'a catalog verdict never pushes the roster');
  A.eq(r.seen.persist, 0, 'a catalog verdict never persists');
  A.eq(r.H.writes, [], 'a catalog verdict writes nothing into Harness');
  A.ok(r.seen.notes.length === 1 && /^MODEL UNAVAILABLE: grok-4\.7 is not in the OLLAMA catalog/.test(r.seen.notes[0]), 'the Commander is still told the model is unavailable');
  const picked = run({ model: 'qwen3:14b', provider: 'ollama', effort: 'none', reason: 'model' });
  A.eq([picked.hero.model, picked.hero.provider, picked.hero.reasoningEffort], ['qwen3:14b', 'ollama', 'none'], 'an explicit model pick still moves the hero');
  A.eq([picked.seen.pushRoster, picked.seen.persist], [1, 1], 'an explicit pick still pushes + persists');
}

/* ---- resumeInto: the hero's own provider/effort win over the save root ---- */
function resume(saved) {
  const H = harnessDouble('openrouter');
  const noop = () => {};
  const ctx = {
    saved: JSON.parse(JSON.stringify(saved)), agent: null, Harness: H,
    agentDocs: noop, stripLegacyVoiceBlock: noop, stripLegacySoloClause: noop, composeSystemPrompt: () => 'fixture',
    registerHero: noop, rehydrateRoster: noop, recomposeOrchestrators: noop, Workstreams: { init: noop }, enterGame: noop, persist: noop,
    pendingStationDoc: null, pendingStationStats: null, pendingGrowthSyncAt: 0, pendingRatingSyncAt: 0, pendingProfile: null, pendingWorkSignal: null, pendingDossier: null
  };
  vm.runInNewContext(fn(app, '  function resumeInto(') + '\nresumeInto(saved);', ctx);
  return { hero: ctx.agent, H };
}
{
  let r = resume({ prov: 'ollama', reasoningEffort: 'none', agent: { id: 'agent', name: 'HERO', model: 'grok-4.7', provider: 'grok', reasoningEffort: 'low', onboarded: true } });
  A.eq([r.H.prov, r.H.efforts.grok, r.H.model], ['grok', 'low', 'grok-4.7'], 'resume lands on the hero\'s grok / low / model, not the root ollama / none');
  A.ok(!r.H.writes.includes('effort:grok=none'), 'the root effort is never written into the hero provider\'s scope');
  r = resume({ prov: 'ollama', reasoningEffort: 'none', agent: { id: 'agent', name: 'HERO', model: 'grok-4.7', provider: 'grok', onboarded: true } });
  A.eq(r.H.prov, 'grok', 'a hero with no saved effort still resumes on its own provider');
  A.eq(r.H.efforts.grok, undefined, 'another provider\'s root effort is not backfilled (grok keeps its own default)');
  A.eq(r.hero.reasoningEffort, undefined, 'the hero is not stamped with a foreign provider\'s effort');
  r = resume({ prov: 'codex', reasoningEffort: 'high', agent: { id: 'agent', name: 'HERO', model: 'gpt-5.5', onboarded: true } });
  A.eq([r.hero.provider, r.hero.reasoningEffort, r.H.prov, r.H.efforts.codex], ['codex', 'high', 'codex', 'high'], 'a legacy hero (root-only save) still backfills provider + effort');
}

/* ---- reentry + boot pre-resume selection: hero-first, root only as the legacy fallback ---- */
{
  const saved = { prov: 'ollama', reasoningEffort: 'none', agent: { id: 'agent', name: 'HERO', model: 'grok-4.7', provider: 'grok', reasoningEffort: 'low' } };
  const H = harnessDouble('openrouter');
  let resumed = null;
  vm.runInNewContext(fn(app, '  function reentry(') + '\nreentry();', {
    Harness: H, Save: { isFuture: () => false, has: () => true, load: () => saved }, resumingSaved: null,
    resumeInto: s => { resumed = s; }, show() {}, initConnect() {}, el: () => ({}), startCreation() {}, showFutureSaveGate() {}
  });
  A.eq([H.prov, H.efforts.grok, H.efforts.ollama], ['grok', 'low', undefined], 'reentry selects the hero\'s provider/effort before the credential gate');
  A.ok(resumed === saved, 'reentry still resumes the save');
  const start = app.indexOf('const bootProv');
  const end = app.indexOf('if (saved && saved.agent) {', start);
  A.ok(start > 0 && end > start && end - start < 1200, 'boot carries the hero-first selection right before its resume gate');
  for (const [label, doc, prov, effort] of [
    ['hero pin', saved, 'grok', 'low'],
    ['legacy root', { prov: 'codex', reasoningEffort: 'high', agent: { id: 'agent' } }, 'codex', 'high'],
    ['foreign root effort', { prov: 'ollama', reasoningEffort: 'none', agent: { id: 'agent', provider: 'grok' } }, 'grok', undefined]
  ]) {
    const B = harnessDouble('openrouter');
    vm.runInNewContext(app.slice(start, end), { saved: doc, Harness: B });
    A.eq([B.prov, B.efforts[prov]], [prov, effort], 'boot pre-resume selection: ' + label);
  }
}

/* ---- setAgentModelPin: the hero's model pin cannot be cleared ---- */
{
  const hero = { id: 'agent', model: 'grok-4.7', provider: 'grok', reasoningEffort: 'low' };
  const worker = { id: 'worker', model: 'gpt-5.5', provider: 'codex', reasoningEffort: 'high' };
  const H = harnessDouble('grok');
  const seen = { pushRoster: 0, persist: 0 };
  const ctx = { agent: hero, agents: new Map([['agent', hero], ['worker', worker]]), Harness: H, pushRoster: () => seen.pushRoster++, persist: () => seen.persist++ };
  vm.runInNewContext(fn(app, '  function setAgentModelPin('), ctx);
  A.eq(ctx.setAgentModelPin('agent', '', '', ''), false, 'clearing the hero pin is refused (the dossier shows the failure)');
  A.eq([hero.model, hero.provider, hero.reasoningEffort], ['grok-4.7', 'grok', 'low'], 'a refused clear leaves the hero intact');
  A.eq([seen.pushRoster, seen.persist, H.writes.length], [0, 0, 0], 'a refused clear pushes, persists and retargets nothing');
  A.eq(ctx.setAgentModelPin('worker', '', '', ''), true, 'a specialist can still follow the station default');
  A.eq(worker.model, null, 'the specialist pin is cleared');
  A.eq(ctx.setAgentModelPin('agent', 'grok-4', 'grok', 'medium'), true, 'the hero can still be re-pinned to another model');
  A.eq([hero.model, H.model, H.efforts.grok], ['grok-4', 'grok-4', 'medium'], 'a hero re-pin retargets the live harness');
  // SAVE MODEL with an advanced typed model and a blank provider field: the hero keeps a provider (a null one let
  // relaunch fall back to the save root's provider); a specialist's blank provider still means "follow".
  A.eq(ctx.setAgentModelPin('agent', 'grok-typed', '', ''), true, 'a typed hero model with a blank provider saves');
  A.eq([hero.model, hero.provider, H.prov], ['grok-typed', 'grok', 'grok'], 'the hero keeps its own provider');
  hero.provider = null;
  ctx.setAgentModelPin('agent', 'grok-typed-2', '', '');
  A.eq(hero.provider, 'grok', 'a provider-less hero takes the live provider rather than null');
  ctx.setAgentModelPin('worker', 'typed-worker-model', '', '');
  A.eq(worker.provider, null, 'a specialist\'s blank provider stays unset (follows the station)');
  const shell = o => '<picker inherit="' + o.inheritLabel + '">';
  const card = vm.runInNewContext(fn(ui, '  function modelCard(') + '\n({ hero: modelCard(h), worker: modelCard(w) })', { esc: String, ModelPicker: { shellHTML: shell }, h: hero, w: { id: 'worker', model: 'gpt-5.5', provider: 'codex' } });
  A.ok(!/id="ag-model-clear"/.test(card.hero), 'the hero dossier offers no FOLLOW STATION DEFAULT');
  A.ok(/id="ag-model-clear"/.test(card.worker), 'a pinned specialist keeps FOLLOW STATION DEFAULT');
  A.ok(!/Follow station default/i.test(card.hero), 'the hero picker and copy never offer "Follow station default"');
  A.ok(/inherit="Follow station default"/.test(card.worker) && /clears the pin/.test(card.worker), 'a specialist keeps the follow option and its copy');
  A.ok(/the Commander always needs a model/.test(fn(ui, '  function wireConfig(')), 'an empty hero SAVE MODEL names why instead of the generic failure');
}

/* ---- recovery WAKE: the effort picked on the connect screen rides the resumed hero ---- */
{
  const start = app.indexOf('    if (resumingSaved) {\n      const s = resumingSaved;');
  const tail = 'resumeInto(s); return true;';
  const end = app.indexOf(tail, start);
  A.ok(start > 0 && end > start && end - start < 1200, 'the WAKE resume branch is where the test expects it');
  const H = harnessDouble('grok');
  H.getReasoningEffort = () => H.efforts[H.prov];
  H.efforts.grok = 'low';   // the connect screen (overseer-setup) wrote the new provider's effort into Harness only
  let resumed = null;
  const saved = { prov: 'codex', reasoningEffort: 'high', agent: { id: 'agent', name: 'HERO', model: 'gpt-5.5', provider: 'codex', reasoningEffort: 'high', onboarded: true } };
  vm.runInNewContext('(function () {' + app.slice(start, end + tail.length) + '\n    }\n})()', { resumingSaved: saved, Harness: H, model: 'grok-4.7', resumeInto: s => { resumed = s; } });
  A.eq([resumed.agent.provider, resumed.agent.model, resumed.agent.reasoningEffort], ['grok', 'grok-4.7', 'low'], 'WAKE stamps the chosen provider, model AND effort onto the hero');
  const r = resume(resumed);
  A.eq([r.H.prov, r.H.efforts.grok], ['grok', 'low'], 'the resumed grok scope gets the picked LOW, not the old codex HIGH');
}

/* ---- frontend mirrors of the sidecar registry ---- */
{
  const defaults = vm.runInNewContext(fn(harness, '  function defaultReasoningEffortForProvider(') + '\ndefaultReasoningEffortForProvider', { normalizeProviderId: p => p });
  A.eq(defaults('grok'), 'low', 'the UI sends grok\'s registry default (low), not medium');
  for (const p of registry.listProviderProfiles()) A.eq(defaults(p.id), p.defaultReasoningEffort, 'UI default effort mirrors the sidecar registry: ' + p.id);
  const src = fn(app, '  const FALLBACK_MODELS = Object.freeze(');
  const fallback = vm.runInNewContext('(' + src.slice(src.indexOf('{')) + ')');
  for (const id of ['grok', 'kimi']) {
    A.eq(fallback[id], registry.getProviderProfile(id).staticModels.map(m => m.id), id + ' connect-screen fallback mirrors the sidecar staticModels (order included)');
  }
}

A.report('hero-model-drift.test');
