'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-native-edge-'));
process.env.HH_STATE_DIR = tmp;
const native = require('../lib/native');
const { fixture, configuration } = require('./native-fixture');
const post = (s, body, url = 'responses') => fetch(`${s.url}/v1/${url}`, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
test('native lifecycle, continuation, compaction and safety', async t => {
  const f = await fixture(); t.after(async () => { await f.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  async function session(c = configuration(f.url), limits) { const s = await native.start(c, 'native', undefined, limits); t.after(() => s.close()); return s; }
  await t.test('catalog consumes explicit metadata and intersects fallback capabilities', () => {
    const c = configuration(f.url);
    c.gateways.chat.contextWindow = 64000;
    c.gateways.chat.capabilities = { imageInput: true, parallelToolCalls: true, reasoningSummaries: true, reasoningEfforts: ['medium', 'high', 'max', 'ultra'] };
    c.gateways.anthropic.contextWindow = 16000;
    c.gateways.anthropic.capabilities = { imageInput: false, parallelToolCalls: true, reasoningSummaries: false, reasoningEfforts: ['low', 'high'] };
    const p = native.plan(c, 'native'); const main = p.catalog.models.find(m => m.slug === p.main); const alias = p.catalog.models.find(m => m.slug === p.worker);
    assert.deepEqual(main.input_modalities, ['text', 'image']); assert.equal(main.supports_reasoning_summaries, true);
    assert.deepEqual(main.supported_reasoning_levels.map(e => e.effort), ['medium', 'high']); assert.equal(main.default_reasoning_level, 'medium');
    assert.deepEqual(alias.input_modalities, ['text']); assert.equal(alias.supports_parallel_tool_calls, true); assert.equal(alias.supports_reasoning_summaries, false);
    assert.deepEqual(alias.supported_reasoning_levels.map(e => e.effort), ['high']); assert.equal(alias.default_reasoning_level, 'high');
    assert.equal(alias.context_window, 16000); assert.equal(alias.max_context_window, 16000); assert.equal(alias.auto_compact_token_limit, 12800);
    delete c.gateways.anthropic.capabilities; delete c.gateways.anthropic.contextWindow;
    const unknown = native.plan(c, 'native').catalog.models.find(m => m.slug === p.worker);
    assert.deepEqual(unknown.supported_reasoning_levels, []); assert.equal(unknown.default_reasoning_level, null); assert.equal(unknown.supports_parallel_tool_calls, false); assert.equal(unknown.context_window, 64000);
    c.profiles.native.orchestration.effort = 'high'; assert.equal(native.plan(c, 'native').effort, 'high');
    c.gateways.anthropic.capabilities = { reasoningEfforts: [] }; assert.throws(() => native.plan(c, 'native'), e => e.code === 'bad_effort');
  });
  await t.test('effort mismatch fails before upstream; common effort survives fallback unchanged', async () => {
    const c = configuration(f.url); c.profiles.native.orchestration = { mode: 'native', workerModel: 'chat/primary', fallback: ['anthropic/worker'] };
    c.gateways.chat.capabilities = { reasoningEfforts: ['medium', 'high'] }; c.gateways.anthropic.capabilities = { reasoningEfforts: ['high', 'max'] };
    const s = await session(c); const before = f.requests.length;
    const invalid = await post(s, { model: s.worker, reasoning: { effort: 'medium' }, input: 'hi' }); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, 'bad_effort'); assert.equal(f.requests.length, before);
    // The main route still has its own capabilities, independent of worker intersection.
    const main = await post(s, { model: s.main, reasoning: { effort: 'medium' }, input: 'hi' }); assert.equal(main.status, 200); await main.json(); assert.equal(f.requests.at(-1).body.reasoning_effort, 'medium');
    f.state.status = 429;
    try { const r = await post(s, { model: s.worker, reasoning: { effort: 'high' }, input: 'hi' }); assert.equal(r.status, 200); await r.json(); assert.equal(f.requests.at(-1).body.output_config.effort, 'high'); } finally { f.state.status = 0; }
    const marked = await post(s, { model: s.main, system: `<!-- hh-route: ${s.worker} -->\n<!-- hh-effort: ultra -->`, messages: [] }, 'messages'); assert.equal(marked.status, 400);
    const chat = await post(s, { model: s.worker, reasoning_effort: 'medium', messages: [] }, 'chat/completions'); assert.equal(chat.status, 400);
    const direct = await post(s, { model: 'anthropic/worker', output_config: { effort: 'medium' }, messages: [] }, 'messages'); assert.equal(direct.status, 400);
    const explicitMax = await post(s, { model: 'anthropic/worker', output_config: { effort: 'max' }, messages: [], stream: true }, 'messages'); assert.equal(explicitMax.status, 200); await explicitMax.text(); assert.equal(f.requests.at(-1).body.output_config.effort, 'max');
  });
  await t.test('CLI automatic effort with unknown metadata reaches upstream without catalog claims', async () => {
    const s = await session(); const before = f.requests.length;
    const responses = await post(s, { model: s.main, reasoning: { effort: 'medium' }, input: 'hi' });
    assert.equal(responses.status, 200); await responses.json(); assert.equal(f.requests.at(-1).body.reasoning_effort, 'medium');
    const claude = await post(s, { model: 'anthropic/worker', output_config: { effort: 'high' }, stream: true, max_tokens: 1024, messages: [{ role: 'user', content: 'hi' }] }, 'messages');
    assert.equal(claude.status, 200); await claude.text(); assert.equal(f.requests.at(-1).body.output_config.effort, 'high');
    assert.equal(f.requests.length, before + 2);
    const model = s.catalog.models.find(m => m.slug === s.main);
    assert.deepEqual(model.input_modalities, ['text']); assert.deepEqual(model.supported_reasoning_levels, []); assert.equal(model.supports_reasoning_summaries, false); assert.equal(model.supports_parallel_tool_calls, false);
    assert.equal(model.context_window, 128000); assert.equal(model.auto_compact_token_limit, 102400);
    const c = configuration(f.url); c.profiles.native.orchestration.effort = 'high'; assert.equal(native.plan(c, 'native').effort, 'high');
  });
  await t.test('unknown fallback accepts effort without claiming support; empty declaration rejects', async () => {
    const c = configuration(f.url); c.profiles.native.orchestration = { mode: 'native', workerModel: 'chat/primary', fallback: ['anthropic/worker'], effort: 'high' };
    c.gateways.chat.capabilities = { reasoningEfforts: ['high'] };
    const s = await session(c); const alias = s.catalog.models.find(m => m.slug === s.worker);
    assert.deepEqual(alias.supported_reasoning_levels, []); assert.equal(alias.default_reasoning_level, null);
    f.state.status = 429;
    try { const r = await post(s, { model: s.worker, reasoning: { effort: 'high' }, input: 'hi' }); assert.equal(r.status, 200); await r.json(); assert.equal(f.requests.at(-1).body.output_config.effort, 'high'); assert.equal(f.requests.at(-1).body.model, 'worker'); } finally { f.state.status = 0; }
    c.gateways.anthropic.capabilities = { reasoningEfforts: [] }; delete c.profiles.native.orchestration.effort;
    const blocked = await session(c); const before = f.requests.length;
    const r = await post(blocked, { model: blocked.worker, reasoning: { effort: 'high' }, input: 'hi' }); assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'bad_effort'); assert.equal(f.requests.length, before);
  });
  await t.test('oversized cache entry is skipped and later small continuations remain usable', async () => {
    const s = await session(undefined, { responseBytes: 1024 });
    const large = await (await post(s, { model: s.main, input: 'x'.repeat(4096) })).json(); assert.equal(large.status, 'completed');
    assert.equal((await post(s, { model: s.main, previous_response_id: large.id, input: 'next' })).status, 400);
    const small = await (await post(s, { model: s.main, input: 'small' })).json(); assert.equal(small.status, 'completed');
    const next = await post(s, { model: s.main, previous_response_id: small.id, input: 'next' }); assert.equal(next.status, 200); assert.equal((await next.json()).status, 'completed');
  });
  await t.test('concurrent catalogs remain private and independently owned', async () => {
    const [a, b] = await Promise.all([session(), session()]);
    assert.notEqual(a.catalogPath, b.catalogPath); assert.equal(fs.statSync(a.catalogPath).mode & 0o777, 0o600);
    await Promise.all([a.close(), a.close()]); assert(!fs.existsSync(a.catalogPath)); assert(fs.existsSync(b.catalogPath));
  });
  await t.test('replacement instructions and tool registry, omitted tools inherit, empty tools clear', async () => {
    const s = await session();
    const first = await (await post(s, { model: s.main, instructions: 'OLD', input: 'goal', tools: [{ type: 'function', name: 'first' }] })).json();
    const second = await (await post(s, { model: s.main, instructions: 'NEW', previous_response_id: first.id, input: 'next', tools: [{ type: 'function', name: 'second' }] })).json();
    let sent = f.requests.at(-1).body;
    assert.equal(sent.messages.filter(m => m.role === 'system').length, 1); assert.equal(sent.messages[0].content, 'NEW'); assert.equal(sent.tools[0].function.name, 'second');
    const third = await (await post(s, { model: s.main, previous_response_id: second.id, input: 'again' })).json();
    sent = f.requests.at(-1).body; assert(!sent.messages.some(m => m.role === 'system')); assert.equal(sent.tools[0].function.name, 'second');
    await (await post(s, { model: s.main, previous_response_id: third.id, input: 'end', tools: [] })).json(); assert.equal(f.requests.at(-1).body.tools, undefined);
  });
  await t.test('expired state fails before calling upstream', async () => {
    const s = await session(undefined, { cacheTTL: 1 });
    const first = await (await post(s, { model: s.main, input: 'hi' })).json();
    await new Promise(resolve => setTimeout(resolve, 5)); const before = f.requests.length;
    assert.equal((await post(s, { model: s.main, input: 'next', previous_response_id: first.id })).status, 400); assert.equal(f.requests.length, before);
  });
  await t.test('cross-protocol compaction returns a reusable plain checkpoint without tools', async () => {
    const s = await session();
    const r = await post(s, { model: s.main, input: 'preserve task and completed work', tools: [{ type: 'function', name: 'danger' }] }, 'responses/compact');
    assert.equal(r.status, 200); assert.equal(r.headers.get('x-hh-compaction'), 'plain-summary'); const compact = await r.json();
    assert.equal(compact.object, 'response.compaction'); assert.equal(compact.output[0].type, 'message'); assert(!JSON.stringify(compact).includes('encrypted_content')); assert.equal(f.requests.at(-1).body.tools, undefined);
    assert.equal((await post(s, { model: s.main, input: compact.output })).status, 200);
    f.state.truncated = true;
    try { assert.equal((await post(s, { model: s.main, input: 'hi' }, 'responses/compact')).status, 502); } finally { f.state.truncated = false; }
    assert.equal((await post(s, { model: s.main, input: 'x'.repeat(530000) }, 'responses/compact')).status, 413);
  });
  await t.test('fallback is observable and does not replay emitted tools', async () => {
    const c = configuration(f.url); c.profiles.native.orchestration = { mode: 'native', workerModel: 'chat/primary', fallback: ['anthropic/worker'] }; const s = await session(c);
    f.state.status = 429;
    try { const r = await post(s, { model: s.worker, input: 'hi' }); assert.equal(r.headers.get('x-hh-fallback-count'), '1'); assert.equal(r.headers.get('x-hh-model'), 'anthropic/worker'); await r.text(); } finally { f.state.status = 0; }
    f.state.mode = 'tool'; f.state.truncated = true; const before = f.requests.length;
    try { const r = await post(s, { model: s.worker, input: 'hi', stream: true, tools: [{ type: 'function', name: 'execute' }] }); const text = await r.text(); assert(text.includes('function_call')); assert(text.includes('upstream_truncated')); assert(!text.includes('response.completed')); assert.equal(f.requests.length, before + 1); } finally { f.state.mode = 'text'; f.state.truncated = false; }
    f.state.status = 401;
    try { const r = await post(s, { model: s.worker, input: 'hi' }); assert.equal(r.status, 401); assert(!(await r.text()).includes('secret-never-print')); } finally { f.state.status = 0; }
  });
  await t.test('failed catalog creation closes its listener', async () => {
    const config = require('../lib/config'); const original = config.STATE_DIR;
    const file = path.join(tmp, 'not-a-directory'); fs.writeFileSync(file, 'x');
    config.STATE_DIR = file;
    try { await assert.rejects(native.start(configuration(f.url), 'native'), { code: 'ENOTDIR' }); }
    finally { config.STATE_DIR = original; }
  });
  await t.test('request budget and explicit token estimate', async () => {
    const s = await session(undefined, { requestBytes: 256 });
    const big = await post(s, { model: s.main, input: 'x'.repeat(300) }); assert.equal(big.status, 413);
    const r = await post(s, { model: s.main, messages: [{ role: 'user', content: 'hi' }] }, 'messages/count_tokens'); assert.equal(r.headers.get('x-hh-token-count'), 'estimated'); assert.equal((await r.json()).estimated, true);
    const malformed = await fetch(s.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': s.token }, body: '{' }); assert.equal(malformed.status, 400); assert.equal((await malformed.json()).type, 'error');
  });
});
test('Messages real count, error redaction, timeout and disconnect', async t => {
  let last; let mode = 'count'; let disconnected;
  const upstream = http.createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk; last = { url: req.url, headers: req.headers, body: JSON.parse(text) };
    if (mode === 'hang') { res.once('close', () => disconnected?.()); return; }
    if (mode === 'large') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ value: 'x'.repeat(2048) })); return; }
    if (mode === 'error') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: error\ndata: {"type":"error","error":{"message":"SECRET"}}\n\n'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":123}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const s = await native.start(configuration(`http://127.0.0.1:${upstream.address().port}`, 'anthropic'), 'native', undefined, { timeoutMs: 150, responseBytes: 1024 }); t.after(() => s.close());
  const counted = await post(s, { model: s.main, messages: [{ role: 'user', content: 'hi' }] }, 'messages/count_tokens'); assert.deepEqual(await counted.json(), { input_tokens: 123 }); assert.equal(last.url, '/v1/messages/count_tokens'); assert.equal(last.headers['x-api-key'], 'secret-anthropic'); assert.equal(last.body.model, 'primary');
  mode = 'large'; assert.equal((await post(s, { model: s.main, messages: [] }, 'messages')).status, 502);
  // A stalled request upload is covered by the same deadline as upstream work.
  const slowStatus = await new Promise((resolve, reject) => { const req = http.request(s.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': s.token, 'content-type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode); req.destroy(); }); req.on('error', reject); req.write('{'); });
  assert.equal(slowStatus, 504);
  mode = 'error'; const err = await post(s, { model: s.main, stream: true, messages: [] }, 'messages'); const errText = await err.text(); assert(errText.includes('event: error')); assert(!errText.includes('SECRET'));
  mode = 'hang'; assert.equal((await post(s, { model: s.main, messages: [] }, 'messages')).status, 504);
  const closed = new Promise(resolve => { disconnected = resolve; });
  const ac = new AbortController(); const request = fetch(s.url + '/v1/messages', { method: 'POST', headers: { 'x-api-key': s.token }, body: JSON.stringify({ model: s.main, messages: [] }), signal: ac.signal }).catch(() => {});
  setTimeout(() => ac.abort(), 30); await request; await closed;
  await s.close();
});

test('Responses passthrough continuation provenance', async t => {
  const calls = []; const state = { aStatus: 429, bStatus: 0, id: 'resp_from_b', truncated: false, padding: '' };
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); calls.push({ model: body.model, previous: body.previous_response_id, path: req.url });
    const status = body.model === 'primary' ? state.aStatus : state.bStatus;
    if (status) { res.writeHead(status); res.end('{"error":"private-body-and-key"}'); return; }
    if (req.url.endsWith('/compact')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'compact_result', object: 'response.compaction', output: [] })); return; }
    const response = { id: state.id, object: 'response', status: 'completed', output: [], padding: state.padding };
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(response)); return; }
    res.setHeader('content-type', 'text/event-stream');
    const send = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    send({ type: 'response.created', response: { id: state.id, status: 'in_progress' } });
    send({ type: 'response.output_item.added', item: { type: 'function_call', name: 'execute', call_id: 'call_1', arguments: '{}' } });
    if (!state.truncated) send({ type: 'response.completed', response });
    res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const c = configuration(`http://127.0.0.1:${upstream.address().port}`, 'responses');
  c.gateways.backup = { ...c.gateways.responses };
  c.profiles.native.orchestration = { mode: 'native', workerModel: 'responses/primary', fallback: ['backup/worker'] };
  async function session(limits) { const s = await native.start(c, 'native', undefined, limits); t.after(() => s.close()); return s; }
  for (const stream of [false, true]) await t.test(`${stream ? 'stream' : 'JSON'} pins continuation and compact to B after A429`, async () => {
    state.aStatus = 429; state.bStatus = 0; state.id = 'resp_from_b'; const s = await session();
    const first = await post(s, { model: s.worker, input: 'first', stream }); const text = await first.text();
    assert.equal(first.status, 200); assert(text.includes('resp_from_b')); assert.equal(first.headers.get('x-hh-model'), 'backup/worker');
    const before = calls.length;
    const next = await post(s, { model: s.worker, previous_response_id: 'resp_from_b', input: 'next', stream }); assert.equal(next.status, 200); await next.text();
    const compact = await post(s, { model: s.worker, previous_response_id: 'resp_from_b', input: [] }, 'responses/compact'); assert.equal(compact.status, 200); await compact.json();
    assert.deepEqual(calls.slice(before), [
      { model: 'worker', previous: 'resp_from_b', path: '/v1/responses' },
      { model: 'worker', previous: 'resp_from_b', path: '/v1/responses/compact' },
    ]);
    state.bStatus = 503; const count = calls.length;
    const failed = await post(s, { model: s.worker, previous_response_id: 'resp_from_b', input: 'no replay' }); assert.equal(failed.status, 503); assert(!(await failed.text()).includes('private-body-and-key')); assert.equal(calls.length, count + 1); assert.equal(calls.at(-1).model, 'worker'); state.bStatus = 0;
    const mismatch = calls.length;
    assert.equal((await post(s, { model: s.main, previous_response_id: 'resp_from_b', input: 'wrong model' })).status, 400); assert.equal(calls.length, mismatch);
  });
  await t.test('unknown and expired origins reject before either endpoint is contacted', async () => {
    const s = await session({ cacheTTL: 10 }); state.id = 'expiring';
    await (await post(s, { model: s.worker, input: 'first' })).json(); await new Promise(resolve => setTimeout(resolve, 20));
    const before = calls.length;
    for (const id of ['expiring', 'never-seen']) for (const url of ['responses', 'responses/compact']) {
      const r = await post(s, { model: s.worker, previous_response_id: id, input: 'next' }, url); assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'unknown_response_source');
    }
    assert.equal(calls.length, before);
  });
  await t.test('same ID from different models stays ambiguous, even after origin expiry', async () => {
    const s = await session({ cacheTTL: 10 }); state.id = 'collision'; state.aStatus = 0;
    await (await post(s, { model: s.main, input: 'A' })).json(); await new Promise(resolve => setTimeout(resolve, 20));
    await (await post(s, { model: 'backup/worker', input: 'B', stream: true })).text(); const before = calls.length;
    for (const model of [s.main, s.worker, 'backup/worker']) {
      const r = await post(s, { model, previous_response_id: state.id, input: 'next' }); assert.equal(r.status, 400); assert.equal((await r.json()).error.code, 'ambiguous_response_source');
    }
    assert.equal(calls.length, before); state.aStatus = 429;
  });
  await t.test('failed stream and over-budget JSON never install origins or replay tool output', async () => {
    const s = await session({ responseBytes: 1024 }); state.id = 'truncated'; state.truncated = true; const before = calls.length;
    const broken = await (await post(s, { model: s.worker, input: 'first', stream: true })).text(); assert(broken.includes('function_call')); assert(broken.includes('upstream_truncated')); assert.equal(calls.length, before + 2);
    assert.equal((await post(s, { model: s.worker, previous_response_id: state.id, input: 'next' })).status, 400);
    state.truncated = false; state.id = 'oversized'; state.padding = 'x'.repeat(2048);
    try { assert.equal((await post(s, { model: s.worker, input: 'large' })).status, 502); } finally { state.padding = ''; }
    const count = calls.length; assert.equal((await post(s, { model: s.worker, previous_response_id: state.id, input: 'next' })).status, 400); assert.equal(calls.length, count);
  });
  await t.test('bounded origin table retains owners instead of evicting into unsafe collisions', async () => {
    const s = await session({ responseBytes: 512 });
    for (let i = 0; i < 5; i++) { state.id = `bounded_${i}`; assert.equal((await post(s, { model: s.worker, input: 'first' })).status, 200); }
    const before = calls.length;
    assert.equal((await post(s, { model: s.worker, previous_response_id: 'bounded_4', input: 'unknown' })).status, 400); assert.equal(calls.length, before);
    const r = await post(s, { model: s.worker, previous_response_id: 'bounded_0', input: 'known' }); assert.equal(r.status, 200); await r.json(); assert.equal(calls.at(-1).model, 'worker');
    await s.close(); const other = await session(); const count = calls.length;
    assert.equal((await post(other, { model: other.worker, previous_response_id: 'bounded_0', input: 'new session' })).status, 400); assert.equal(calls.length, count);
  });
});
