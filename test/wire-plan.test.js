/* node test/wire-plan.test.js — capability/wire-plan.js: the provider wire-tool cap and connector deferral.

   The claims: an uncapped provider without deferConnectorTools gets EXACTLY the pre-cap split; connector
   deferral only ever moves granted connector tools and only when tool.search can reach them; a cap never pushes
   tool.search or a Task Brief control off the wire, spills connectors before built-ins, and a spilled tool is
   either findable by tool.search or honestly reported unreachable — never silently advertised. */
'use strict';
const A = require('./_assert.js');
const { planWireTools, wireToolCap, wireToolLimit, describeDeferred } = require('../sidecar/capability/wire-plan.js');
const { MAX_HITS } = require('../sidecar/tools/builtin/toolsearch.js');
const factory = require('../sidecar/providers/factory.js');

const RESERVE = 2 * MAX_HITS;
const isConnector = n => /^mcp__/.test(n);
const BUILTIN = ['fs.read', 'fs.write', 'web_search', 'tool.search', 'browser.navigate', 'browser.network', 'browser.upload', 'team.dispatch'];
const DEFERRED = ['browser.network', 'browser.upload'];
const BRIEF = ['brief.ask', 'brief.proceed', 'brief.update'];
const conn = (id, n) => Array.from({ length: n }, (_, i) => 'mcp__' + id + '__t' + i);

// The split index.js used before wire-plan.js existed, verbatim — the identity baseline.
function legacy(tools, deferred, deferralOff, withheld) {
  const deferredNames = new Set((deferralOff ? [] : (deferred || [])).filter(n => !withheld(n)));
  return { core: tools.filter(n => !deferredNames.has(n) && !withheld(n)), deferred: Array.from(deferredNames) };
}

// ---- 1. no cap + no deferConnectors = today's split, byte for byte ----
{
  const tools = BUILTIN.concat(conn('notion', 5), BRIEF);
  const none = () => false;
  const domain = n => /^team\./.test(n) || /^browser\./.test(n) || n === 'web_search';
  for (const [label, off, wh] of [['plain', false, none], ['kill switch', true, none], ['withheld', false, domain], ['both', true, domain]]) {
    const want = legacy(tools, DEFERRED, off, wh);
    const got = planWireTools({ tools, deferred: DEFERRED, deferralOff: off, withheld: wh, isConnector, pinned: BRIEF });
    A.eq(got.core, want.core, 'identity core (' + label + ')');
    A.eq(got.deferred, want.deferred, 'identity deferred (' + label + ')');
    A.eq(got.spilled, [], 'nothing spilled without a cap (' + label + ')');
    A.eq(got.unreachable, [], 'nothing unreachable without a cap (' + label + ')');
  }
  // Absent/zero/garbage caps are "uncapped", not "cap at zero".
  for (const cap of [0, undefined, -5, NaN, 'x']) {
    A.eq(planWireTools({ tools, deferred: DEFERRED, maxTools: cap, reserve: RESERVE, isConnector }).core, legacy(tools, DEFERRED, false, none).core, 'maxTools ' + String(cap) + ' is uncapped');
  }
}

// ---- 2. deferConnectors: granted connectors only, and only when tool.search is granted ----
{
  const granted = BUILTIN.concat(conn('notion', 3));
  const p = planWireTools({ tools: granted, deferred: DEFERRED, isConnector, deferConnectors: true });
  A.eq(p.core, BUILTIN.filter(n => DEFERRED.indexOf(n) < 0), 'every granted connector left the wire; built-ins stay');
  A.eq(p.deferred, DEFERRED.concat(conn('notion', 3)), 'connectors join the deferred list tool.search searches');
  // POST-authority input: a connector the run was not granted is simply absent and can never be advertised.
  A.ok(p.deferred.indexOf('mcp__slack__t0') < 0 && p.core.indexOf('mcp__slack__t0') < 0, 'an ungranted connector appears nowhere');

  const noSearch = granted.filter(n => n !== 'tool.search');
  const q = planWireTools({ tools: noSearch, deferred: DEFERRED, isConnector, deferConnectors: true });
  A.ok(conn('notion', 3).every(n => q.core.indexOf(n) >= 0), 'without tool.search connectors stay advertised (deferring them would make them unreachable)');
  A.eq(q.deferred, DEFERRED, 'and nothing extra is deferred');

  const r = planWireTools({ tools: granted, deferred: DEFERRED, deferralOff: true, isConnector, deferConnectors: true });
  A.ok(conn('notion', 3).every(n => r.core.indexOf(n) >= 0), 'the SKYNET_TOOL_SEARCH=0 kill switch also disables connector deferral');
  A.eq(r.deferred, [], 'kill switch: nothing deferred');
}

// ---- 3. cap: tool.search + pinned kept, connectors spill first, |core| <= maxTools - reserve ----
{
  const tools = BRIEF.concat(BUILTIN, conn('notion', 30), conn('linear', 30));   // 3 + 8 + 60 = 71
  const maxTools = 40;
  const p = planWireTools({ tools, deferred: DEFERRED, maxTools, reserve: RESERVE, pinned: BRIEF, isConnector });
  A.ok(p.core.length <= maxTools - RESERVE, '|core| ' + p.core.length + ' <= maxTools - reserve (' + (maxTools - RESERVE) + ')');
  A.eq(p.core.length, maxTools - RESERVE, 'and it fills the budget rather than over-spilling');
  A.ok(p.core.indexOf('tool.search') >= 0, 'tool.search never spills');
  A.ok(BRIEF.every(n => p.core.indexOf(n) >= 0), 'Task Brief controls never spill');
  A.ok(BUILTIN.filter(n => DEFERRED.indexOf(n) < 0).every(n => p.core.indexOf(n) >= 0), 'built-ins survive while a connector can spill instead');
  A.ok(p.spilled.every(isConnector), 'only connectors spilled');
  A.ok(p.spilled.every(n => p.deferred.indexOf(n) >= 0), 'spilled ⊆ deferred when tool.search is granted');
  A.eq(p.unreachable, [], 'nothing unreachable when tool.search is granted');
  A.ok(p.spilled.indexOf('mcp__linear__t29') >= 0 && p.core.indexOf('mcp__notion__t0') >= 0, 'the tail spills first; earlier tools keep their place');
  const order = tools.filter(n => p.core.indexOf(n) >= 0);
  A.eq(p.core, order, 'core preserves the original order');
  A.eq(new Set(p.core.concat(p.deferred)).size, p.core.length + p.deferred.length, 'no tool is both advertised and deferred');

  // Built-ins spill only once every connector is gone — and still never the pinned ones.
  const tight = planWireTools({ tools, deferred: DEFERRED, maxTools: RESERVE + 6, reserve: RESERVE, pinned: BRIEF, isConnector });
  A.ok(tight.core.length <= 6 || tight.core.every(n => n === 'tool.search' || BRIEF.indexOf(n) >= 0), 'the tight budget holds unless only pinned remain');
  A.ok(tight.core.indexOf('tool.search') >= 0 && BRIEF.every(n => tight.core.indexOf(n) >= 0), 'pinned + tool.search survive a tight cap');
  A.ok(tight.spilled.filter(isConnector).length === 60, 'every connector spilled before a built-in did');
  A.ok(tight.spilled.some(n => !isConnector(n)), 'then built-ins spill');
  A.ok(tight.core.indexOf('fs.read') >= 0, 'the earliest built-in outlasts the later ones');

  // A cap the core already fits is a no-op.
  const fits = planWireTools({ tools: BUILTIN, deferred: DEFERRED, maxTools: 340, reserve: RESERVE, isConnector });
  A.eq(fits, Object.assign(legacy(BUILTIN, DEFERRED, false, () => false), { spilled: [], unreachable: [] }), 'a cap the core fits changes nothing');
}

// ---- 4. no tool.search: spilled tools are unreachable, off the wire and out of deferred ----
{
  const tools = BUILTIN.filter(n => n !== 'tool.search').concat(conn('notion', 40));
  const p = planWireTools({ tools, deferred: DEFERRED, maxTools: 30, reserve: RESERVE, isConnector });
  A.eq(p.core.length, 30, 'no reveals possible, so no reserve is held back: the full cap is usable');
  A.ok(p.unreachable.length > 0, 'the overflow is reported unreachable');
  A.eq(p.unreachable, p.spilled, 'unreachable = spilled when tool.search is not granted');
  A.ok(p.unreachable.every(n => p.deferred.indexOf(n) < 0 && p.core.indexOf(n) < 0), 'unreachable tools are neither advertised nor findable');
}

// ---- 5. deferralOff disables base deferral, but a provider cap still applies ----
{
  const tools = BUILTIN.concat(conn('notion', 50));
  const p = planWireTools({ tools, deferred: DEFERRED, deferralOff: true, maxTools: 40, reserve: RESERVE, isConnector });
  A.ok(DEFERRED.every(n => p.core.indexOf(n) >= 0), 'kill switch: the base-deferred tools are advertised');
  A.ok(p.core.length <= 40 - RESERVE, 'but the provider cap still holds');
  A.ok(p.spilled.length > 0 && p.spilled.every(n => p.deferred.indexOf(n) >= 0), 'the overflow stays findable through tool.search (a cap cannot be switched off)');
}

// ---- 6. withheld is excluded everywhere ----
{
  const withheld = n => /^team\./.test(n) || /^browser\./.test(n) || n === 'mcp__notion__t1';
  const tools = BUILTIN.concat(conn('notion', 50));
  for (const opts of [{}, { deferConnectors: true }, { maxTools: 30, reserve: RESERVE }, { deferralOff: true, maxTools: 20, reserve: RESERVE }]) {
    const p = planWireTools(Object.assign({ tools, deferred: DEFERRED, withheld, isConnector }, opts));
    const all = p.core.concat(p.deferred, p.spilled, p.unreachable);
    A.ok(!all.some(withheld), 'withheld appears in no list (' + JSON.stringify(opts) + ')');
  }
  // A Set/array works as the withheld list too.
  A.ok(planWireTools({ tools: BUILTIN, deferred: DEFERRED, withheld: new Set(['fs.write']) }).core.indexOf('fs.write') < 0, 'Set-shaped withheld');
  A.ok(planWireTools({ tools: BUILTIN, deferred: DEFERRED, withheld: ['fs.write'] }).core.indexOf('fs.write') < 0, 'array-shaped withheld');
}

// ---- 7. grok: connector deferral + cap together ----
{
  const tools = BRIEF.concat(BUILTIN, conn('notion', 200), conn('linear', 180));   // the live 482-ish shape
  const p = planWireTools({ tools, deferred: DEFERRED, maxTools: 340, reserve: RESERVE, pinned: BRIEF, isConnector, deferConnectors: true });
  A.ok(p.core.every(n => !isConnector(n)), 'grok: no connector schema rides the wire');
  A.eq(p.spilled, [], 'grok: deferral alone brings the list under the cap');
  A.eq(p.deferred.filter(isConnector).length, 380, 'every granted connector is findable');
}

// ---- 8. wireToolCap: the smallest positive maxTools across the provider chain ----
{
  A.eq(wireToolCap([]), 0, 'no providers, no cap');
  A.eq(wireToolCap([null, undefined, {}]), 0, 'unknown/unflagged providers, no cap');
  A.eq(wireToolCap([{ maxTools: 340 }]), 340, 'a single capped provider');
  A.eq(wireToolCap([{}, { maxTools: 340 }]), 340, 'an uncapped primary with a capped fallback is still capped (the fallback reuses the list)');
  A.eq(wireToolCap([{ maxTools: 340 }, { maxTools: 128 }, { maxTools: 0 }, { maxTools: -1 }]), 128, 'the smallest positive cap wins; 0/negative mean none');
  const g = factory.getProviderProfile('grok'), o = factory.getProviderProfile('openrouter');
  A.eq(wireToolCap([o, g]), 340, 'openrouter primary + grok fallback caps at the xAI budget');
  A.eq(wireToolCap([o]), 0, 'openrouter alone is uncapped');
  A.eq(wireToolLimit([o, g]), { cap: 340, providerId: 'grok' }, 'the limit names the FALLBACK that set it, not the uncapped primary');
  A.eq(wireToolLimit([{ id: 'a', maxTools: 340 }, { id: 'b', maxTools: 128 }]), { cap: 128, providerId: 'b' }, 'the smallest cap names its own profile');
  A.eq(wireToolLimit([o]), { cap: 0, providerId: '' }, 'no cap, no owner');
}

// ---- 9. describeDeferred: collapse connector servers past the threshold, built-ins stay explicit ----
{
  const of = n => { const m = /^mcp__(.+?)__/.exec(n); return m ? m[1] : null; };
  const few = ['browser_network'].concat(conn('notion', 5));
  A.eq(describeDeferred(few, of), { list: few, collapsed: 0 }, 'under the threshold every name is listed');
  const many = ['browser_network', 'browser_upload'].concat(conn('notion', 37), conn('linear', 4), conn('x', 1));
  const d = describeDeferred(many, of);
  A.eq(d.list, ['browser_network', 'browser_upload', 'mcp__notion__* (37 tools)', 'mcp__linear__* (4 tools)', 'mcp__x__* (1 tool)'], 'collapsed per server, built-ins explicit');
  A.eq(d.collapsed, 3, 'collapsed server count');
  A.eq(describeDeferred(conn('a', 3), of, 2).collapsed, 1, 'threshold is configurable');
}

A.report('wire-plan.test');
