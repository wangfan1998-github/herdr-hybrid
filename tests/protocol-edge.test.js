'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const codec = require('../lib/protocols');
const { output } = require('../lib/protocols/output');
const tool = { type: 'function', name: 'f', parameters: { type: 'object' } };
const normalized = (stream = false) => codec.normalize({ input: '', tools: [tool], stream }, 'responses');
const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const stream = frames => new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
async function collect(response, wire) { const state = codec.collector(normalized().registry); for await (const e of codec.events(response, wire)) state.take(e); return state; }
async function render(events, wire, streaming = true) {
  let text = ''; const res = { writeHead() {}, write(s) { text += s; return true; } };
  await output(res, (async function* () { yield* events; })(), wire, normalized(streaming));
  return streaming ? text.split('\n').filter(s => s.startsWith('data: ') && s !== 'data: [DONE]').map(s => JSON.parse(s.slice(6))) : JSON.parse(text);
}
test('stream defaults, sampling, token limits and unsupported stop translation', () => {
  for (const wire of ['chat', 'anthropic', 'responses']) assert.equal(codec.normalize({}, wire).stream, false);
  const n = codec.normalize({ max_completion_tokens: 17, temperature: 0, top_p: 0.4, stop: 'END' }, 'chat');
  const a = codec.encode(n, 'anthropic', 'm');
  assert.equal(a.max_tokens, 17); assert.equal(a.temperature, 0); assert.equal(a.top_p, 0.4); assert.deepEqual(a.stop_sequences, ['END']);
  assert.equal(codec.encode(n, 'chat', 'm').max_completion_tokens, 17);
  assert.throws(() => codec.encode(n, 'responses', 'm'), /stop sequences/);
  assert.throws(() => codec.encode(codec.normalize({ top_k: 4 }, 'anthropic'), 'chat', 'm'), /top_k/);
});
test('all histories use the same sanitized tool name as declarations and choice', () => {
  const name = 'tool.with.dots';
  for (const wire of ['chat', 'anthropic', 'responses']) {
    const body = wire === 'chat' ? { tools: [{ type: 'function', function: { name } }], messages: [{ role: 'assistant', tool_calls: [{ id: 'c', function: { name, arguments: '{}' } }] }], tool_choice: { type: 'function', function: { name } } }
      : wire === 'anthropic' ? { tools: [{ name, input_schema: {} }], messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'c', name, input: {} }] }], tool_choice: { type: 'tool', name, disable_parallel_tool_use: true } }
      : { tools: [{ type: 'function', name }], input: [{ type: 'function_call', call_id: 'c', name, arguments: '{}' }], tool_choice: { type: 'function', name } };
    const n = codec.normalize(body, wire); const c = codec.encode(n, 'chat', 'm');
    assert.match(c.tools[0].function.name, /^hh_/); assert.equal(c.messages[0].tool_calls[0].function.name, c.tools[0].function.name); assert.equal(c.tool_choice.function.name, c.tools[0].function.name);
    if (wire === 'anthropic') assert.equal(c.parallel_tool_calls, false);
  }
});
test('Anthropic choice modes and parallel restriction round-trip', () => {
  for (const [type, choice] of [['auto', 'auto'], ['any', 'required'], ['none', 'none']]) {
    const n = codec.normalize({ tools: [{ name: 'f', input_schema: {} }], tool_choice: { type, disable_parallel_tool_use: true } }, 'anthropic');
    const c = codec.encode(n, 'chat', 'm'); assert.equal(c.tool_choice, choice); assert.equal(c.parallel_tool_calls, false);
    const a = codec.encode(n, 'anthropic', 'm'); assert.deepEqual(a.tool_choice, { type, disable_parallel_tool_use: true });
  }
});
test('hosted tools fail explicitly without leaking names or data', () => {
  for (const [wire, tools] of [['responses', [{ type: 'web_search' }]], ['anthropic', [{ type: 'computer_20250124', name: 'secret' }]], ['chat', [{ type: 'custom', custom: { name: 'secret' } }]]]) assert.throws(() => codec.normalize({ tools }, wire), /托管工具/);
  assert.throws(() => codec.normalize({ input: [{ type: 'secret-value' }] }, 'responses'), e => !e.message.includes('secret-value'));
});
test('JSON upstream text, calls and usage work for all protocols', async () => {
  const bodies = {
    chat: { choices: [{ message: { content: '你好', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
    anthropic: { content: [{ type: 'text', text: '你好' }, { type: 'tool_use', id: 'c', name: 'f', input: {} }], stop_reason: 'tool_use', usage: { input_tokens: 7, output_tokens: 3 } },
    responses: { status: 'completed', output: [{ id: 'm', type: 'message', content: [{ type: 'output_text', text: '你好' }] }, { id: 't', type: 'function_call', name: 'f', call_id: 'c', arguments: '{}' }], usage: { input_tokens: 7, output_tokens: 3 } }
  };
  for (const [wire, body] of Object.entries(bodies)) { const s = await collect(json(body), wire); assert.equal(s.blocks[0].text, '你好'); assert.equal(s.blocks[1].args, '{}'); assert.equal(s.usage.input, 7); assert.equal(s.usage.output, 3); }
});
test('Responses terminal-only output and mixed deltas are reconciled once', async () => {
  const item = { id: 'm', type: 'message', content: [{ type: 'output_text', text: 'hello' }] };
  const call = { id: 't', type: 'function_call', name: 'f', call_id: 'c', arguments: '{"x":1}' };
  const terminal = { type: 'response.completed', response: { status: 'completed', output: [item, call] } };
  for (const frames of [[terminal], [{ type: 'response.output_text.delta', item_id: 'm', delta: 'he' }, { type: 'response.output_item.added', item: { ...call, arguments: '' } }, { type: 'response.function_call_arguments.delta', item_id: 't', delta: '{"x":' }, { type: 'response.output_item.done', item }, terminal]]) {
    const s = await collect(stream(frames), 'responses'); assert.equal(s.blocks.length, 2); assert.equal(s.blocks[0].text, 'hello'); assert.equal(s.blocks[1].args, '{"x":1}');
  }
});
test('parallel calls produce sequential Messages blocks and contiguous Chat tool indices', async () => {
  const events = [{ type: 'text', key: 'text', text: 'working' }, { type: 'call', key: 'a', name: 'f', id: 'a' }, { type: 'call', key: 'b', name: 'f', id: 'b' }, { type: 'args', key: 'b', text: '{"b":' }, { type: 'args', key: 'a', text: '{}' }, { type: 'args', key: 'b', text: '2}' }, { type: 'text', key: 'text', text: '!' }];
  const a = await render(events, 'anthropic'); let active = null; const indices = [];
  for (const e of a) {
    if (e.type === 'content_block_start') { assert.equal(active, null); active = e.index; indices.push(e.index); }
    if (e.type === 'content_block_delta') assert.equal(e.index, active);
    if (e.type === 'content_block_stop') { assert.equal(e.index, active); active = null; }
  }
  assert.equal(active, null); assert.deepEqual(indices, [0, 1, 2]);
  const c = await render(events, 'chat'); const tools = c.flatMap(e => e.choices[0].delta.tool_calls || []);
  assert.deepEqual(tools.filter(t => t.id).map(t => t.index), [0, 1]);
  assert.deepEqual(tools.filter(t => !t.id).map(t => t.index), [1, 0, 1]);
});
test('stop sequences, length and refusal are not silently treated as successful completion', async () => {
  const s = await collect(stream([{ type: 'message_delta', delta: { stop_reason: 'stop_sequence', stop_sequence: 'END' } }, { type: 'message_stop' }]), 'anthropic');
  assert.equal(s.reason, 'stop_sequence'); assert.equal(s.stopSequence, 'END');
  const a = await render([{ type: 'stop', reason: 'stop_sequence', sequence: 'END' }], 'anthropic', false); assert.equal(a.stop_reason, 'stop_sequence'); assert.equal(a.stop_sequence, 'END');
  for (const [reason, expected] of [['max_output_tokens', 'length'], ['content_filter', 'refusal']]) {
    const s = await collect(stream([{ type: 'response.incomplete', response: { status: 'incomplete', output: [], incomplete_details: { reason } } }]), 'responses'); assert.equal(s.reason, expected);
  }
  await assert.rejects(collect(json({ content: [], stop_reason: 'pause_turn' }), 'anthropic'), /结束原因/);
});
test('upstream malformed JSON and error details stay sanitized', async () => {
  await assert.rejects(collect(new Response('{secret-never-print'), 'chat'), e => !e.message.includes('secret-never-print'));
  await assert.rejects(collect(json({ error: { message: 'secret-never-print' } }), 'responses'), e => !e.message.includes('secret-never-print'));
  await assert.rejects(collect(stream([{ choices: [{ finish_reason: 'secret-never-print' }] }]), 'chat'), e => !e.message.includes('secret-never-print'));
});
test('Chat sampling controls and legacy token field are preserved or explicitly rejected', () => {
  const n = codec.normalize({ max_tokens: 9, frequency_penalty: 0.5, presence_penalty: 0, seed: 0 }, 'chat');
  const c = codec.encode(n, 'chat', 'm'); assert.equal(c.max_tokens, 9); assert.equal(c.frequency_penalty, 0.5); assert.equal(c.presence_penalty, 0); assert.equal(c.seed, 0);
  assert.throws(() => codec.encode(n, 'anthropic', 'm'), /penalty/);
  assert.throws(() => codec.normalize({ n: 2 }, 'chat'), /多候选/);
  assert.throws(() => codec.normalize({ tools: [{ type: 'custom', name: 'f', format: { type: 'unknown' } }] }, 'responses'), /未知 custom/);
});
test('Anthropic custom declarations remain JSON tools and removed historical tools keep stable names', () => {
  const body = { tools: [{ type: 'custom', name: 'f', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }] };
  const n = codec.normalize(body, 'anthropic'); assert.equal(n.registry.list[0].custom, false); assert.deepEqual(codec.encode(n, 'chat', 'm').tools[0].function.parameters, body.tools[0].input_schema);
  const input = [{ type: 'function_call', name: 'f.with.dots', call_id: 'c', arguments: '{}' }];
  const history = codec.normalize({ input }, 'responses'); const declared = codec.normalize({ input, tools: [{ ...tool, name: 'f.with.dots' }] }, 'responses');
  assert.equal(history.messages[0].parts[0].name, declared.registry.list[0].name);
});

// Captured from installed Codex CLI request on 2026-09-17; no credentials or user content.
const codexApplyPatch = {
  "type": "custom",
  "name": "apply_patch",
  "description": "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
  "format": {
    "type": "grammar",
    "syntax": "lark",
    "definition": "start: begin_patch hunk+ end_patch\nbegin_patch: \"*** Begin Patch\" LF\nend_patch: \"*** End Patch\" LF?\n\nhunk: add_hunk | delete_hunk | update_hunk\nadd_hunk: \"*** Add File: \" filename LF add_line+\ndelete_hunk: \"*** Delete File: \" filename LF\nupdate_hunk: \"*** Update File: \" filename LF change_move? change?\n\nfilename: /(.+)/\nadd_line: \"+\" /(.*)/ LF -> line\n\nchange_move: \"*** Move to: \" filename LF\nchange: (change_context | change_line)+ eof_line?\nchange_context: (\"@@\" | \"@@ \" /(.+)/) LF\nchange_line: (\"+\" | \"-\" | \" \") /(.*)/ LF\neof_line: \"*** End of File\" LF\n\n%import common.LF\n"
  }
};
test('real Codex apply_patch grammar wraps raw input and survives two tool-result rounds', async () => {
  const patches = ['*** Begin Patch\n*** Add File: hello.txt\n+你好 "world" \\ path\n*** End Patch\n', '*** Begin Patch\n*** Update File: hello.txt\n@@\n-你好 "world" \\ path\n+done\n*** End Patch\n'];
  for (const wire of ['chat', 'anthropic', 'responses']) for (const streaming of [false, true]) {
    const history = [{ role: 'user', content: 'Create hello.txt and then update it.' }];
    const tools = [{ type: 'namespace', name: 'functions', tools: [codexApplyPatch] }];
    for (let round = 0; round < 2; round++) {
      const n = codec.normalize({ tools, input: history, stream: streaming }, 'responses');
      const outbound = codec.encode(n, wire, 'm');
      const declaration = wire === 'chat' ? outbound.tools[0].function : outbound.tools[0];
      assert.equal(outbound.tools.length, 1); assert.equal(declaration.name, 'functions__apply_patch');
      assert(declaration.description.startsWith(codexApplyPatch.description));
      assert(declaration.description.endsWith(codexApplyPatch.format.definition));
      assert(declaration.description.includes('Grammar syntax: lark'));
      assert(declaration.description.includes('not enforced by the target provider server'));
      assert(declaration.description.includes('CLI tool parser validates'));
      assert.deepEqual((declaration.parameters || declaration.input_schema).required, ['input']);
      assert.equal((declaration.parameters || declaration.input_schema).properties.input.type, 'string');
      assert.equal(declaration.format, undefined);
      const args = JSON.stringify({ input: patches[round] }); const callId = `patch-${round}`;
      const upstream = wire === 'chat' ? { choices: [{ message: { tool_calls: [{ id: callId, type: 'function', function: { name: declaration.name, arguments: args } }] }, finish_reason: 'tool_calls' }] }
        : wire === 'anthropic' ? { content: [{ type: 'tool_use', id: callId, name: declaration.name, input: { input: patches[round] } }], stop_reason: 'tool_use' }
        : { status: 'completed', output: [{ type: 'function_call', id: `item-${round}`, call_id: callId, name: declaration.name, arguments: args }] };
      let text = ''; const res = { writeHead() {}, write(s) { text += s; return true; } };
      const { result } = await output(res, codec.events(json(upstream), wire), 'responses', n);
      const call = result.output[0];
      assert.equal(call.type, 'custom_tool_call'); assert.equal(call.name, 'apply_patch'); assert.equal(call.namespace, 'functions'); assert.equal(call.call_id, callId); assert.equal(call.input, patches[round]);
      if (streaming) {
        const frames = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
        assert.equal(frames.find(e => e.type === 'response.custom_tool_call_input.delta').delta, patches[round]);
        assert.equal(frames.find(e => e.type === 'response.custom_tool_call_input.done').input, patches[round]);
      } else assert.equal(JSON.parse(text).output[0].input, patches[round]);
      history.push(call, { type: 'custom_tool_call_output', call_id: callId, output: `Success round ${round}` });
      const replay = codec.encode(codec.normalize({ tools, input: history }, 'responses'), wire, 'm');
      const calls = wire === 'chat' ? replay.messages.flatMap(m => m.tool_calls || []).map(t => ({ id: t.id, name: t.function.name, input: JSON.parse(t.function.arguments).input }))
        : wire === 'anthropic' ? replay.messages.flatMap(m => m.content).filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input.input }))
        : replay.input.filter(i => i.type === 'function_call').map(i => ({ id: i.call_id, name: i.name, input: JSON.parse(i.arguments).input }));
      assert.deepEqual(calls, patches.slice(0, round + 1).map((input, i) => ({ id: `patch-${i}`, name: declaration.name, input })));
      const results = wire === 'chat' ? replay.messages.filter(m => m.role === 'tool').map(m => [m.tool_call_id, m.content])
        : wire === 'anthropic' ? replay.messages.flatMap(m => m.content).filter(b => b.type === 'tool_result').map(b => [b.tool_use_id, b.content])
        : replay.input.filter(i => i.type === 'function_call_output').map(i => [i.call_id, i.output]);
      assert.deepEqual(results, Array.from({ length: round + 1 }, (_, i) => [`patch-${i}`, `Success round ${i}`]));
    }
  }
});
test('Anthropic parallel text/image tool results round-trip through Responses without content loss', () => {
  const content = [
    { type: 'text', text: '截图之前：你好' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
    { type: 'text', text: '截图之后' },
  ];
  const body = { tools: [{ name: 'f', input_schema: { type: 'object' } }], messages: [
    { role: 'assistant', content: ['plain', 'screenshot'].map(id => ({ type: 'tool_use', id, name: 'f', input: {} })) },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'plain', content: [{ type: 'text', text: 'text-only result' }] },
      { type: 'tool_result', tool_use_id: 'screenshot', content },
    ] },
  ] };
  const original = JSON.stringify(body);
  const n = codec.normalize(body, 'anthropic');
  const r = codec.encode(n, 'responses', 'm');
  const results = r.input.filter(i => i.type === 'function_call_output');
  assert.deepEqual(results, [
    { type: 'function_call_output', call_id: 'plain', output: [{ type: 'input_text', text: 'text-only result' }] },
    { type: 'function_call_output', call_id: 'screenshot', output: [
      { type: 'input_text', text: content[0].text },
      { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0KGgo=' },
      { type: 'input_text', text: content[2].text },
    ] },
  ]);
  const restored = codec.encode(codec.normalize(r, 'responses'), 'anthropic', 'm');
  assert.deepEqual(restored.messages, body.messages);
  const again = codec.encode(codec.normalize(restored, 'anthropic'), 'responses', 'm');
  assert.deepEqual(again.input, r.input);
  assert.equal(JSON.stringify(body), original, 'encoding must not mutate source content');
  for (const source of [n, codec.normalize(r, 'responses')]) {
    assert.throws(() => codec.encode(source, 'chat', 'm'), e => e.code === 'unsupported_protocol' && /Chat.*不支持图片/.test(e.message));
  }
});

test('tool result strings and text arrays remain valid on all targets; Chat images fail explicitly', () => {
  for (const value of ['plain result', [{ type: 'input_text', text: 'first' }, { type: 'input_text', text: 'second' }]]) {
    const n = codec.normalize({ input: [{ type: 'function_call_output', call_id: 'c', output: value }] }, 'responses');
    const expected = typeof value === 'string' ? value : value.map(p => ({ type: 'text', text: p.text }));
    assert.deepEqual(codec.encode(n, 'chat', 'm').messages[0], { role: 'tool', tool_call_id: 'c', content: expected });
    assert.deepEqual(codec.encode(n, 'anthropic', 'm').messages[0].content[0].content, expected);
    assert.deepEqual(codec.encode(n, 'responses', 'm').input[0].output, value);
  }
  const image = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/' } };
  const n = codec.normalize({ messages: [{ role: 'tool', tool_call_id: 'c', content: [{ type: 'text', text: 'legacy gateway image' }, image] }] }, 'chat');
  assert.throws(() => codec.encode(n, 'chat', 'm'), /Chat.*不支持图片/);
  assert.deepEqual(codec.encode(n, 'responses', 'm').input[0].output, [{ type: 'input_text', text: 'legacy gateway image' }, { type: 'input_image', image_url: image.image_url.url }]);
  assert.deepEqual(codec.encode(n, 'anthropic', 'm').messages[0].content[0].content[1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } });
});
