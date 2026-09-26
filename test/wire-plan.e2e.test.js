/* node test/wire-plan.e2e.test.js — the provider wire-tool cap and grok connector deferral, on the real sidecar.

   One fake MCP server exposes 380 tools (the live shape that sent xAI 482 tools and a 400). Two real /api/run
   streams against a fake OpenAI-compatible upstream:
     GROK (deferConnectorTools): no connector schema rides the wire; the prompt names the server collapsed;
       tool_search reveals mcp__demo__lookup and the model then calls it for real.
     XAI (maxTools 340, no deferral): the wire stays under the cap minus the reveal reserve, the overflow
       connectors are findable through tool_search, and a reveal never pushes a request past the cap.
   The openrouter paths (connectors on the wire, uncapped) are held by e2e.mcp-connector and friends. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');
const { MAX_HITS } = require('../sidecar/tools/builtin/toolsearch.js');

const HOST = '127.0.0.1';
const CONNECTOR_TOOLS = 380;
const XAI_CAP = 340;
// A far-future JWT so the grok run never attempts a refresh (same shape as oauth-status.e2e).
const ACCESS = 'eyJhbGciOiJSUzI1NiJ9.eyJleHAiOjE5MDAwMDAwMDB9.ZmFrZS1zaWduYXR1cmUtZm9yLXRlc3Q';

function readJson(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}
const listen = server => new Promise(r => server.listen(0, HOST, () => r('http://' + HOST + ':' + server.address().port)));

function mcpTools() {
  const tools = [{ name: 'lookup', description: 'Lookup demo data', annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } } }];
  for (let i = 1; i < CONNECTOR_TOOLS; i++) {
    tools.push({ name: 'extra_' + i, description: 'Extra demo tool number ' + i, annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {} } });
  }
  return tools;
}

async function startMcp() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') { res.writeHead(204); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(404); return res.end(); }
    const msg = await readJson(req);
    const headers = { 'Content-Type': 'application/json' };
    if (msg.method === 'initialize') headers['Mcp-Session-Id'] = 'sess-wireplan';
    if (msg.method === 'notifications/initialized') { res.writeHead(202, headers); return res.end(); }
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo-mcp' } }
      : msg.method === 'tools/list' ? { tools: mcpTools() }
      : msg.method === 'tools/call' ? { content: [{ type: 'text', text: 'result of ' + msg.params.name + ' for ' + JSON.stringify(msg.params.arguments || {}) }], isError: false }
      : null;
    res.writeHead(200, headers);
    res.end(JSON.stringify(result ? { jsonrpc: '2.0', id: msg.id, result } : { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } }));
  });
  return { server, url: (await listen(server)) + '/mcp' };
}

/* Scripted model: search for the flow's target, then call it once revealed, then finish. Every request is
   recorded with its declared tool names and system text so the assertions read the actual wire. */
async function startLlm() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.url.indexOf('/models') >= 0) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: 'grok-4.7', context_length: 256000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    }
    const body = await readJson(req);
    const msgs = body.messages || [];
    const names = (body.tools || []).map(t => t.function.name);
    const system = msgs.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
    const user = msgs.filter(m => m.role === 'user').map(m => String(m.content)).join('\n');
    const toolMsgs = msgs.filter(m => m.role === 'tool');
    const flow = /GROKFLOW/.test(user) ? 'grok' : 'xai';
    requests.push({ flow, names, system, toolMsgs });
    const target = flow === 'grok' ? 'mcp__demo__lookup' : 'mcp__demo__extra_' + (CONNECTOR_TOOLS - 1);
    let delta;
    if (toolMsgs.length === 0) delta = { tool_calls: [{ index: 0, id: 'search_1', type: 'function', function: { name: 'tool_search', arguments: JSON.stringify({ query: flow === 'grok' ? 'lookup' : 'extra_' + (CONNECTOR_TOOLS - 1) }) } }] };
    else if (toolMsgs.length === 1 && names.indexOf(target) >= 0) delta = { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: target, arguments: JSON.stringify({ query: 'alpha' }) } }] };
    else delta = { content: flow + ' done' };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 4 } }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  return { server, requests, base: await listen(server) };
}

async function drive(fixture, body) {
  const res = await fixture.request('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  A.eq(res.status, 200, body.provider + ': /api/run returns a stream');
  const reader = res.body.getReader(), dec = new TextDecoder();
  let buf = '', runId = '';
  const out = { calls: [], results: [], errors: [], end: null };
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
      if (ev.name === 'agent.run.start') runId = ev.payload.runId;
      if (ev.name === 'agent.tool_call') out.calls.push(ev.payload.name);
      if (ev.name === 'agent.tool_result') out.results.push(ev.payload);
      if (ev.name === 'agent.run.error') out.errors.push(ev.payload.message);
      if (ev.name === 'agent.run.end') out.end = ev.payload;
      if (ev.name === 'permission.prompt') {
        fixture.json('POST', '/api/consent', { runId, promptId: ev.payload.promptId, decision: 'once' }).catch(() => {});
      }
    }
  }
  return out;
}

(async () => {
  const mcp = await startMcp();
  const llm = await startLlm();
  const fixture = SidecarFixture.create({ prefix: 'sk-wireplan-e2e-', timeoutMs: 20000, env: { STARNET_FULL_ACCESS: '0', SKYNET_FULL_ACCESS: '0' } });
  fs.mkdirSync(path.join(fixture.workspace, 'grok'), { recursive: true });
  fs.writeFileSync(path.join(fixture.workspace, 'grok', 'tokens.json'), JSON.stringify({ access_token: ACCESS, refresh_token: 'rf-wireplan-e2e-refresh-token-abcdefghijklmnopqrstuvwxyz', expires_at: 1900000000000 }));
  try {
    await fixture.start();
    const up = await fixture.json('POST', '/api/connectors', { id: 'demo', label: 'Demo MCP', transport: 'http', url: mcp.url });
    A.eq(up.status, 200, 'configured the demo connector');
    A.eq(up.body.toolCount, CONNECTOR_TOOLS, 'the connector exposes the live-sized tool shelf');

    // ---- GROK: connector schemas stay off the wire until tool_search asks for one ----
    const grok = await drive(fixture, { provider: 'grok', baseUrl: llm.base, model: 'grok-4.7', agentId: 'grok-agent', isTask: true, messages: [{ role: 'user', content: 'GROKFLOW use the demo lookup for alpha' }] });
    A.eq(grok.errors, [], 'grok: the run raised no error');
    const g = llm.requests.filter(r => r.flow === 'grok');
    A.ok(g.length >= 3, 'grok: search, call and finish turns all reached the upstream');
    A.ok(g[0].names.indexOf('tool_search') >= 0, 'grok: tool_search is advertised');
    A.eq(g[0].names.filter(n => /^mcp__/.test(n)), [], 'grok: turn 1 carries NO connector schema');
    A.ok(g[0].system.indexOf('mcp__demo__* (' + CONNECTOR_TOOLS + ' tools)') >= 0, 'grok: the prompt names the deferred connector, collapsed per server');
    A.ok(g[0].system.indexOf('mcp__demo__extra_7,') < 0, 'grok: the prompt does not spell out hundreds of connector names');
    A.ok(/mcp__demo__lookup/.test(String(g[1].toolMsgs[0] && g[1].toolMsgs[0].content)), 'grok: tool_search found the connector tool (it searches the planned deferred list)');
    A.ok(g[1].names.indexOf('mcp__demo__lookup') >= 0, 'grok: the revealed connector tool is declared on the next turn');
    A.ok(g[1].names.filter(n => /^mcp__/.test(n)).length <= MAX_HITS, 'grok: a reveal adds only what matched');
    A.ok(grok.calls.indexOf('mcp__demo__lookup') >= 0, 'grok: the model called the revealed connector tool');
    A.ok(grok.results.some(r => r.callId === 'call_1' && r.ok === true), 'grok: the connector call succeeded');
    A.ok(/result of lookup/.test(String(g[2].toolMsgs[1] && g[2].toolMsgs[1].content)), 'grok: the model read the real MCP result back');
    A.eq(grok.end && grok.end.reason, 'done', 'grok: the run completed');

    // ---- XAI: no deferral, but the 340-tool cap holds and the overflow stays findable ----
    const xai = await drive(fixture, { provider: 'xai', key: 'xai-wireplan-fake-key', baseUrl: llm.base, model: 'grok-4.7', agentId: 'xai-agent', isTask: true, messages: [{ role: 'user', content: 'XAIFLOW use the last extra tool' }] });
    A.eq(xai.errors, [], 'xai: the run raised no error');
    const x = llm.requests.filter(r => r.flow === 'xai');
    A.ok(x.length >= 3, 'xai: search, call and finish turns all reached the upstream');
    A.ok(x[0].names.length <= XAI_CAP - 2 * MAX_HITS, 'xai: turn 1 declares ' + x[0].names.length + ' tools, within cap minus the reveal reserve');
    A.ok(x[0].names.filter(n => /^mcp__/.test(n)).length > 0, 'xai: connectors still ride the wire (no deferral on this profile)');
    A.ok(x[0].names.indexOf('tool_search') >= 0, 'xai: tool_search survives the cap');
    A.ok(x[0].names.indexOf('mcp__demo__extra_' + (CONNECTOR_TOOLS - 1)) < 0, 'xai: the tail connector spilled off the wire');
    A.ok(/mcp__demo__\* \(\d+ tools\)/.test(x[0].system), 'xai: the spilled connectors are named (collapsed) as findable');
    A.ok(x.every(r => r.names.length <= XAI_CAP), 'xai: no request ever exceeds the provider cap');
    A.ok(x[1].names.indexOf('mcp__demo__extra_' + (CONNECTOR_TOOLS - 1)) >= 0, 'xai: tool_search revealed the spilled connector tool');
    A.ok(xai.results.some(r => r.callId === 'call_1' && r.ok === true), 'xai: the spilled-then-revealed tool call succeeded');
    A.ok(/result of extra_/.test(String(x[2].toolMsgs[1] && x[2].toolMsgs[1].content)), 'xai: the model read the real MCP result back');
    A.eq(xai.end && xai.end.reason, 'done', 'xai: the run completed');
    A.ok((fixture.output().match(/\[tools\] xai wire cap 340/g) || []).length === 1, 'xai: the spill is logged once');
  } finally {
    await fixture.dispose();
    mcp.server.close(); llm.server.close();
  }
  A.report('wire-plan.e2e.test');
})().catch(e => { console.log('THREW', e && e.stack || e); process.exit(1); });
