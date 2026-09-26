/* sidecar/capability/wire-plan.js — planWireTools: which GRANTED tools ride the wire this run, and which wait
   behind tool.search. PURE (names in, names out) so the host and its tests share one split.

   planWireTools({ tools, deferred, deferralOff, withheld, maxTools, reserve, pinned, isConnector, deferConnectors })
     -> { core[], deferred[], spilled[], unreachable[] }
       tools        the run's grant set AFTER every authority/toolset filter (resolved.tools)
       deferred     CAP_REGISTRY `deferred: true` names (resolved.deferred)
       deferralOff  SKYNET_TOOL_SEARCH=0: no advertising deferral (a provider cap still applies)
       withheld     name -> bool (or a Set/array): off the wire AND out of tool.search this run
       maxTools     the provider chain's per-request tool ceiling; 0/absent = uncapped
       reserve      headroom kept under maxTools for tool.search reveals (only when tool.search is granted)
       pinned       names never moved or spilled (the Task Brief harness controls); tool.search always is
       isConnector  name -> bool (MCP connector tool)
       deferConnectors  the provider asked for connector schemas to wait behind tool.search
   wireToolCap(profiles) -> the smallest positive maxTools across a run's provider chain; 0 when none caps.
   wireToolLimit(profiles) -> { cap, providerId }: the same ceiling plus the id of the profile that set it (a
       fallback's limit must not be reported as the primary's); providerId is '' when nothing caps.
   describeDeferred(...) -> the prompt's deferred-name list, connector servers collapsed (see below).

   THREE STEPS, each a no-op unless asked for, so an uncapped provider without deferConnectors gets exactly the
   pre-cap split (core = tools − deferred − withheld; deferred = deferred − withheld):
   1. CONNECTOR DEFERRAL — only with tool.search granted (else the moved tools could never be reached) and never
      under the kill switch. Moves from the POST-authority core, so an ungranted connector is never advertised.
   2. CAP — xAI 400s a request carrying >350 tools. Spill connectors before built-ins (a built-in is what the
      harness prompt keys its guidance off), the tail of each first; tool.search and pinned never spill.
   3. REACHABILITY — a spilled tool is deferred (tool.search finds it) only when tool.search is granted;
      otherwise it is reported `unreachable` and appears nowhere the model could be told it may call it. */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; (root.SK.capability = root.SK.capability || {}).wirePlan = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SEARCH = 'tool.search';

  function predicate(p) {
    if (typeof p === 'function') return n => !!p(n);
    if (p && typeof p.has === 'function') return n => p.has(n);
    if (Array.isArray(p)) return n => p.indexOf(n) >= 0;
    return () => false;
  }
  const uniq = list => Array.from(new Set(Array.isArray(list) ? list : []));
  const posInt = v => { const n = Math.floor(Number(v)); return isFinite(n) && n > 0 ? n : 0; };

  function planWireTools(o) {
    o = o || {};
    const withheld = predicate(o.withheld);
    const isConnector = predicate(o.isConnector);
    const keep = new Set(uniq(o.pinned).concat([SEARCH]));
    const deferred = o.deferralOff ? [] : uniq(o.deferred).filter(n => !withheld(n));
    const baseDeferred = new Set(deferred);
    let core = uniq(o.tools).filter(n => !baseDeferred.has(n) && !withheld(n));
    const searchable = core.indexOf(SEARCH) >= 0;

    if (o.deferConnectors && searchable && !o.deferralOff) {
      const moved = core.filter(n => isConnector(n) && !keep.has(n));
      if (moved.length) {
        const m = new Set(moved);
        core = core.filter(n => !m.has(n));
        for (const n of moved) deferred.push(n);
      }
    }

    let spilled = [], unreachable = [];
    const maxTools = posInt(o.maxTools);
    if (maxTools) {
      const budget = Math.max(0, maxTools - (searchable ? posInt(o.reserve) : 0));
      let over = core.length - budget;
      if (over > 0) {
        const out = new Set();
        const tail = list => { for (let i = list.length - 1; i >= 0 && over > 0; i--) { out.add(list[i]); over--; } };
        tail(core.filter(n => !keep.has(n) && isConnector(n)));
        tail(core.filter(n => !keep.has(n) && !isConnector(n)));
        spilled = core.filter(n => out.has(n));
        core = core.filter(n => !out.has(n));
        if (searchable) for (const n of spilled) deferred.push(n);
        else unreachable = spilled.slice();
      }
    }
    return { core, deferred, spilled, unreachable };
  }

  function wireToolLimit(profiles) {
    let cap = 0, providerId = '';
    for (const p of (Array.isArray(profiles) ? profiles : [])) {
      const n = posInt(p && p.maxTools);
      if (n && (!cap || n < cap)) { cap = n; providerId = String((p && p.id) || ''); }
    }
    return { cap, providerId };
  }
  const wireToolCap = profiles => wireToolLimit(profiles).cap;

  /* The prompt's deferred-name list. Names beat a bare count (weaker models never searched for a counted-only
     tool), but a few hundred connector names is kilobytes of prompt every turn — so past `threshold` connector
     tools each server collapses to one "mcp__<id>__* (N tools)" entry, matching the host's connector wire names
     (mcp/translate.js). Built-in names always stay explicit.
     describeDeferred(names, connectorOf, threshold=40) -> { list[], collapsed } — connectorOf(name) -> id|null */
  function describeDeferred(names, connectorOf, threshold) {
    const of = typeof connectorOf === 'function' ? connectorOf : () => null;
    const limit = threshold == null ? 40 : threshold;
    const list = uniq(names);
    if (list.filter(n => of(n)).length <= limit) return { list, collapsed: 0 };
    const out = [], groups = new Map();
    for (const n of list) {
      const id = of(n);
      if (id) groups.set(id, (groups.get(id) || 0) + 1);
      else out.push(n);
    }
    for (const [id, count] of groups) out.push('mcp__' + id + '__* (' + count + (count === 1 ? ' tool)' : ' tools)'));
    return { list: out, collapsed: groups.size };
  }

  return { planWireTools, wireToolCap, wireToolLimit, describeDeferred };
});
