'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path'); const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-codecs-'));
process.env.HH_STATE_DIR = path.join(tmp, 'state'); process.env.HH_CONFIG_DIR = path.join(tmp, 'config');
const native = require('../lib/native'); const codec = require('../lib/protocols');
const { fixture, configuration } = require('./native-fixture');
const routes = { responses: '/v1/responses', anthropic: '/v1/messages', chat: '/v1/chat/completions' };
function request(wire, model, tools = false) {
  const tool = { name: 'weather', description: 'Weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } };
  if (wire === 'responses') return { model, stream: true, input: 'hello', ...(tools ? { tools: [{ type: 'function', ...tool }] } : {}) };
  if (wire === 'anthropic') return { model, stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'hello' }], ...(tools ? { tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }] } : {}) };
  return { model, stream: true, messages: [{ role: 'user', content: 'hello' }], ...(tools ? { tools: [{ type: 'function', function: tool }] } : {}) };
}
async function post(s, wire, body) { return fetch(s.url + routes[wire], { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
test('built-in protocol router', async t => {
  const f = await fixture(); t.after(async () => { await f.close(); fs.rmSync(tmp, { recursive: true, force: true }); });
  for (const upstream of ['chat', 'anthropic', 'responses']) for (const inbound of ['responses', 'anthropic', 'chat']) {
    await t.test(`${inbound} → ${upstream}: UTF-8 text, model and auth`, async () => {
      const c = configuration(f.url, upstream); const s = await native.start(c, 'native');
      try {
        const r = await post(s, inbound, request(inbound, s.main)); assert.equal(r.status, 200);
        const text = await r.text(); assert(text.includes('你好 pong')); assert(!text.includes('secret-'));
        const sent = f.requests.at(-1); assert.equal(sent.body.model, 'primary');
        assert.equal(upstream === 'anthropic' ? sent.headers['x-api-key'] : sent.headers.authorization, upstream === 'anthropic' ? 'secret-anthropic' : `Bearer secret-${upstream}`);
      } finally { await s.close(); }
    });
    if (inbound !== upstream) await t.test(`${inbound} → ${upstream}: streamed tool calls`, async () => {
      const s = await native.start(configuration(f.url, upstream), 'native'); f.state.mode = 'tool';
      try { const r = await post(s, inbound, request(inbound, s.main, true)); const text = await r.text(); assert.equal(r.status, 200); assert(text.includes('weather')); assert(text.includes('上海')); assert(!text.includes('event: error')); }
      finally { f.state.mode = 'text'; await s.close(); }
    });
  }
  await t.test('request-level fallback only before any bytes are emitted', async () => {
    const c = configuration(f.url); c.profiles.native.orchestration = { mode: 'native', workerModel: 'chat/primary', fallback: ['anthropic/worker'] };
    const s = await native.start(c, 'native'); f.state.status = 429;
    try { const r = await post(s, 'responses', request('responses', s.worker)); assert.equal(r.status, 200); assert.equal(r.headers.get('x-hh-model'), 'anthropic/worker'); assert((await r.text()).includes('pong from child')); }
    finally { f.state.status = 0; await s.close(); }
  });
  await t.test('authentication error is not silently switched to another provider', async () => {
    const c = configuration(f.url); c.profiles.native.orchestration = { mode: 'native', workerModel: 'chat/primary', fallback: ['anthropic/worker'] };
    const s = await native.start(c, 'native'); f.state.status = 401; const before = f.requests.length;
    try { const r = await post(s, 'responses', request('responses', s.worker)); assert.equal(r.status, 401); assert.equal(f.requests.length, before + 1); assert(!(await r.text()).includes('secret-never-print')); }
    finally { f.state.status = 0; await s.close(); }
  });
  await t.test('a truncated stream fails without trying a second model', async () => {
    const c = configuration(f.url); c.profiles.native.orchestration = { mode: 'native', workerModel: 'chat/primary', fallback: ['anthropic/worker'] };
    const s = await native.start(c, 'native'); f.state.truncated = true; const before = f.requests.length;
    try { const r = await post(s, 'responses', request('responses', s.worker)); const text = await r.text(); assert(text.includes('upstream_truncated')); assert.equal(f.requests.length, before + 1); assert(!text.includes('response.completed')); }
    finally { f.state.truncated = false; await s.close(); }
  });
  await t.test('namespace freeform call restoration and local continuation history', async () => {
    const s = await native.start(configuration(f.url), 'native'); f.state.mode = 'tool';
    try {
      const body = { model: s.main, stream: false, input: 'patch', tools: [{ type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'apply_patch' }] }] };
      const r = await post(s, 'responses', body); const first = await r.json();
      assert.equal(first.output[0].type, 'custom_tool_call'); assert.equal(first.output[0].namespace, 'functions'); assert(first.output[0].input.startsWith('*** Begin Patch'));
      f.state.mode = 'text';
      const next = await post(s, 'responses', { ...body, previous_response_id: first.id, input: [{ type: 'custom_tool_call_output', call_id: first.output[0].call_id, output: 'patched' }] });
      assert.equal(next.status, 200); await next.json();
      assert(f.requests.at(-1).body.messages.some(m => m.role === 'tool' && m.content === 'patched'));
      assert(f.requests.at(-1).body.messages.some(m => m.tool_calls?.[0]?.function.name === 'functions__apply_patch'));
    } finally { f.state.mode = 'text'; await s.close(); }
  });
  await t.test('session token, declared-model allowlist and cleanup', async () => {
    const s = await native.start(configuration(f.url), 'native'); const catalog = s.catalogPath;
    assert(fs.existsSync(catalog));
    assert.equal((await fetch(s.url + '/v1/models')).status, 401);
    assert.equal((await post(s, 'responses', request('responses', 'chat/not-allowed'))).status, 400);
    const r = await post(s, 'responses', { ...request('responses', s.main), previous_response_id: 'hhresp_missing' }); assert.equal(r.status, 400);
    await s.close(); assert(!fs.existsSync(catalog));
    await assert.rejects(fetch(s.url + '/health'));
  });
  await t.test('image and tool-result codecs, tool choice and structured output', () => {
    const n = codec.normalize({ model: 'x', input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,YQ==' }] }, { type: 'function_call', name: 'f', call_id: 'call_1', arguments: '{"a":1}' }, { type: 'function_call_output', call_id: 'call_1', output: 'ok' }], tools: [{ type: 'function', name: 'f', parameters: { type: 'object' } }], tool_choice: 'required', text: { format: { type: 'json_schema', name: 'out', schema: { type: 'object' } } } }, 'responses');
    const a = codec.encode(n, 'anthropic', 'm'); assert.equal(a.messages[0].content[0].source.data, 'YQ=='); assert.equal(a.messages.at(-1).content[0].tool_use_id, 'call_1'); assert.equal(a.tool_choice.type, 'any'); assert.equal(a.output_config.format.type, 'json_schema');
    assert.throws(() => codec.normalize({ input: [{ type: 'reasoning', encrypted_content: 'opaque' }] }, 'responses'));
  });
});

test('parallel Responses calls form one Chat assistant turn', () => {
  const input = ['a', 'b'].map(call_id => ({ type: 'function_call', name: 'f', call_id, arguments: '{}' }));
  input.push(...['a', 'b'].map(call_id => ({ type: 'function_call_output', call_id, output: 'ok' })));
  const n = codec.normalize({ input, tools: [{ type: 'function', name: 'f', parameters: { type: 'object' } }] }, 'responses');
  const messages = codec.encode(n, 'chat', 'm').messages;
  assert.equal(messages.length, 3); assert.equal(messages[0].tool_calls.length, 2);
  assert.deepEqual(messages.slice(1).map(m => m.tool_call_id), ['a', 'b']);
});

test('backpressured writer rejects on disconnect and removes listeners', async () => {
  const { EventEmitter } = require('events');
  const { write } = require('../lib/protocols/output');
  const res = new EventEmitter(); res.write = () => false;
  const pending = write(res, 'chunk'); res.emit('close');
  await assert.rejects(pending, /client closed/);
  for (const event of ['drain', 'error', 'close']) assert.equal(res.listenerCount(event), 0);
});
