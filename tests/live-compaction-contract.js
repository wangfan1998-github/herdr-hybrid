'use strict';
// Optional: node tests/live-compaction-contract.js [chat|anthropic]
// Real Codex app-server -> observed hh router -> loopback-only mock model.
// Requires Codex CLI (validated with 0.154.0); missing CLI/timeouts are failures.
// CODEX_BIN optionally selects the CLI executable. No global Codex config is read.
// Intentionally tests the v1 remote /responses/compact contract. Codex 0.154's
// default v2 compaction_trigger and grammar/hosted tools are separate contracts.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-live-compaction-'));
process.env.HH_CONFIG_DIR = path.join(tmp, 'hh-config');
process.env.HH_STATE_DIR = path.join(tmp, 'hh-state');
const native = require('../lib/native');
const { configuration } = require('./native-fixture');

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function closeServer(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function fixture(wire, checkpoint) {
  const requests = [];
  const state = { compact: false };
  const server = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, wire === 'chat' ? '/v1/chat/completions' : '/v1/messages');
      const input = JSON.parse(await body(req));
      requests.push(input);
      const text = state.compact ? checkpoint : 'FIRST_ASSISTANT_REPLY';
      const sse = event => res.write(`${wire === 'anthropic' ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (wire === 'chat') {
        sse({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
        sse({ id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
        res.write('data: [DONE]\n\n');
      } else {
        sse({ type: 'message_start', message: { id: 'mock', type: 'message', role: 'assistant', model: input.model, content: [], usage: { input_tokens: 100, output_tokens: 0 } } });
        sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
        sse({ type: 'content_block_stop', index: 0 });
        sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } });
        sse({ type: 'message_stop' });
      }
      res.end();
    } catch (error) { state.error = error; res.writeHead(500); res.end('fixture failure'); }
  });
  return { url: await listen(server), requests, state, close: () => closeServer(server) };
}
// Observe the exact Responses input emitted by Codex, before router normalization/cache.
async function observer(session) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const record = { path: req.url };
    requests.push(record);
    try {
      const bytes = await body(req);
      record.body = JSON.parse(bytes);
      const upstream = http.request(session.url + req.url, {
        method: req.method, headers: { ...req.headers, host: new URL(session.url).host },
      }, response => {
        record.status = response.statusCode;
        res.writeHead(response.statusCode, response.headers);
        const chunks = [];
        response.on('data', chunk => { if (req.url.endsWith('/compact')) chunks.push(chunk); });
        response.on('end', () => { if (chunks.length) { try { record.response = JSON.parse(Buffer.concat(chunks)); } catch { record.error = 'compact response was not JSON'; } } });
        response.pipe(res);
      });
      upstream.on('error', error => { record.error = error.message; res.destroy(error); });
      req.on('aborted', () => upstream.destroy());
      upstream.end(bytes);
    } catch (error) { record.error = error.message; res.destroy(error); }
  });
  return { url: await listen(server), requests, close: () => closeServer(server) };
}
function rpc(child) {
  let next = 0, failure;
  const pending = new Map(), events = [], waiters = new Set();
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const fail = error => {
    failure = error;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
    for (const check of waiters) check();
  };
  child.on('error', fail);
  child.on('exit', (code, signal) => fail(new Error(`app-server exited (${code}/${signal}): ${stderr}`)));
  child.stdin.on('error', fail);
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { fail(new Error('app-server emitted non-JSON stdout')); return; }
    if (message.id != null && !message.method) {
      const p = pending.get(message.id);
      if (p) { pending.delete(message.id); clearTimeout(p.timer); message.error ? p.reject(new Error(`${p.method}: ${JSON.stringify(message.error)}`)) : p.resolve(message.result); }
    } else if (message.id != null) {
      // This fixture must never run tools, approve actions, or ask for credentials.
      child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'Unexpected server request' } }) + '\n');
      fail(new Error(`unexpected app-server request: ${message.method}`));
    } else {
      events.push(message);
      for (const check of waiters) check();
    }
  });
  return {
    events,
    notify: method => child.stdin.write(JSON.stringify({ method }) + '\n'),
    call(method, params) {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} RPC timeout`)); }, 15000);
        pending.set(id, { resolve, reject, timer, method });
        child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      });
    },
    wait(predicate, since, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => done(new Error(`${label} notification timeout; methods=${events.slice(since).map(e => e.method).join(',')}; stderr=${stderr}`)), 20000);
        const done = (error, value) => { clearTimeout(timer); waiters.delete(check); error ? reject(error) : resolve(value); };
        const check = () => {
          if (failure) return done(failure);
          const error = events.slice(since).find(e => e.method === 'error');
          if (error) return done(new Error(`${label}: ${JSON.stringify(error.params)}`));
          const event = events.slice(since).find(predicate);
          if (event) done(null, event);
        };
        waiters.add(check); check();
      });
    },
    close() { lines.close(); fail(new Error('contract client closed')); },
  };
}
async function stop(child) {
  if (!child?.pid) return;
  const killGroup = signal => { try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; } };
  if (child.exitCode !== null || child.signalCode !== null) { killGroup('SIGKILL'); return; }
  await new Promise(resolve => {
    const timer = setTimeout(() => killGroup('SIGKILL'), 1500);
    child.once('exit', () => { clearTimeout(timer); killGroup('SIGKILL'); resolve(); });
    killGroup('SIGTERM');
  });
}
async function contract(wire) {
  const checkpoint = `CHECKPOINT_ONLY_FROM_COMPACTION_${crypto.randomBytes(12).toString('hex')}`;
  const original = `ORIGINAL_USER_HISTORY_${crypto.randomBytes(8).toString('hex')}`;
  const cwd = path.join(tmp, wire, 'workspace'), home = path.join(tmp, wire, 'home'), codexHome = path.join(home, '.codex');
  for (const dir of [cwd, codexHome]) fs.mkdirSync(dir, { recursive: true });
  let mock, session, tap, child, client;
  try {
    mock = await fixture(wire, checkpoint);
    const cfg = configuration(mock.url, wire);
    cfg.profiles.native.orchestration = { mode: 'native', workerModel: `${wire}/primary`, models: [], fallback: [] };
    session = await native.start(cfg, 'native', undefined, { timeoutMs: 10000 });
    tap = await observer(session);
    // This contract exercises context compaction, not grammar-constrained tools.
    // Disable the optional apply_patch tool through the isolated model catalog.
    const catalogPath = path.join(codexHome, 'models.json');
    const catalog = JSON.parse(fs.readFileSync(session.catalogPath, 'utf8'));
    for (const model of catalog.models) model.apply_patch_tool_type = null;
    fs.writeFileSync(catalogPath, JSON.stringify(catalog));
    // Entire config is temporary; no inherited credentials, proxies, hooks, or MCP servers.
    // Codex gates remote compaction on provider name OpenAI (a custom ID alone
    // uses local compaction). The URL and sole credential still target loopback.
    // Explicitly select v1: v2 sends compaction_trigger to /responses instead.
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "${wire}/primary"\nmodel_provider = "hh"\nmodel_catalog_json = ${JSON.stringify(catalogPath)}\ncheck_for_update_on_startup = false\nweb_search = "disabled"\n[model_providers.hh]\nname = "OpenAI"\nbase_url = "${tap.url}/v1"\nenv_key = "HH_CONTRACT_TOKEN"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n[features]\nremote_compaction_v2 = false\napps = false\nplugins = false\nshell_snapshot = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n`);
    child = spawn(process.env.CODEX_BIN || 'codex', ['app-server', '--strict-config'], {
      cwd, detached: true, env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: path.join(home, 'cache'), TMPDIR: tmp, HH_CONTRACT_TOKEN: session.token },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    client = rpc(child);
    await client.call('initialize', { clientInfo: { name: 'hh-compaction-contract', version: '1' }, capabilities: { experimentalApi: true } });
    client.notify('initialized');
    const started = await client.call('thread/start', { cwd, model: `${wire}/primary`, modelProvider: 'hh', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
    const threadId = started.thread.id;
    async function turn(text) {
      const since = client.events.length;
      const result = await client.call('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
      const complete = await client.wait(e => e.method === 'turn/completed' && e.params.threadId === threadId && e.params.turn.id === result.turn.id, since, 'turn completion');
      assert.equal(complete.params.turn.status, 'completed', JSON.stringify(complete.params.turn.error));
    }
    await turn(original);
    assert.equal(tap.requests.length, 1, 'unexpected requests before compaction');
    assert(!JSON.stringify(tap.requests[0].body).includes(checkpoint));
    mock.state.compact = true;
    const since = client.events.length;
    await client.call('thread/compact/start', { threadId });
    const compacted = await client.wait(e => e.method === 'item/completed' && e.params.threadId === threadId && e.params.item.type === 'contextCompaction', since, 'contextCompaction item completion');
    const compactTurn = await client.wait(e => e.method === 'turn/completed' && e.params.threadId === threadId && e.params.turn.id === compacted.params.turnId, since, 'compaction turn completion');
    assert.equal(compactTurn.params.turn.status, 'completed', JSON.stringify(compactTurn.params.turn.error));
    const compact = tap.requests.find(r => r.path === '/v1/responses/compact');
    assert(compact, 'Codex did not call remote compact endpoint');
    assert.equal(compact.status, 200);
    assert.equal(compact.response.object, 'response.compaction');
    const output = compact.response.output;
    assert(output.every(item => item.type === 'message'), 'expected ordinary checkpoint messages, not encrypted compaction items');
    assert(JSON.stringify(output).includes(checkpoint), 'compact response lost checkpoint sentinel');
    assert(JSON.stringify(mock.requests[1]).includes(original), 'summary model did not receive user history');
    assert(JSON.stringify(mock.requests[1]).includes('FIRST_ASSISTANT_REPLY'), 'summary model did not receive assistant history');
    mock.state.compact = false;
    const before = tap.requests.length;
    await turn('Continue from your saved context.');
    const next = tap.requests[before];
    assert.equal(next.path, '/v1/responses');
    assert(next.body.input.some(item => item.type === 'message' && item.role === 'user' && item.content?.some(part => part.text === output[0].content[0].text)), 'Codex changed or discarded the returned checkpoint message');
    assert(JSON.stringify(next.body.input).includes(checkpoint), 'Codex did not carry the returned checkpoint into its next request');
    assert(!JSON.stringify(next.body.input).includes(original), 'original history survived: context was not replaced by the checkpoint');
    assert(JSON.stringify(mock.requests.at(-1)).includes(checkpoint), 'checkpoint did not reach the upstream protocol');
    assert.equal(mock.state.error, undefined);
    assert.equal(tap.requests.length, 3, 'expected exactly first turn, remote compact, and continuation');
    assert.equal(mock.requests.length, 3, 'unexpected upstream calls or retries');
    console.log(`PASS ${wire}: real Codex accepted plain checkpoint, replaced history, and sent checkpoint in the next Responses and upstream request (${tap.requests.length} requests)`);
  } catch (error) {
    const diagnostics = (tap?.requests || []).map(r => ({ path: r.path, status: r.status,
      input: Array.isArray(r.body?.input) ? r.body.input.map(item => ({ type: item.type, role: item.role, keys: Object.keys(item), content: item.content?.map?.(part => ({ type: part.type, keys: Object.keys(part) })) })) : typeof r.body?.input,
      response: r.response,
    }));
    console.error(JSON.stringify({ wire, diagnostics }));
    throw error;
  } finally {
    await stop(child);
    if (client) client.close();
    if (tap) await tap.close();
    if (session) await session.close();
    if (mock) await mock.close();
  }
}
async function main() {
  try {
    const wires = process.argv[2] ? [process.argv[2]] : ['chat', 'anthropic'];
    for (const wire of wires) { assert(['chat', 'anthropic'].includes(wire), 'expected chat or anthropic'); await contract(wire); }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
