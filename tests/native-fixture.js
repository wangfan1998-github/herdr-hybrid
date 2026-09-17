'use strict';
const http = require('http');
const frames = data => `data: ${JSON.stringify(data)}\n\n`;
async function fixture() {
  const requests = []; const state = { status: 0, truncated: false, mode: 'text', delegated: false };
  const server = http.createServer(async (req, res) => {
    let text = ''; for await (const c of req) text += c;
    const body = JSON.parse(text || '{}'); requests.push({ path: req.url, headers: req.headers, body });
    if (state.status && body.model === 'primary') { res.writeHead(state.status); res.end('{"error":"secret-never-print"}'); return; }
    const wire = req.url.endsWith('/messages') ? 'anthropic' : req.url.endsWith('/responses') ? 'responses' : 'chat';
    const selectedTool = body.tools?.find(t => /(?:^|__)spawn_agent$|^Agent$/.test(t.function?.name || t.name));
    const tool = selectedTool || body.tools?.[0]; const name = tool?.function?.name || tool?.name;
    const delegation = state.mode === 'delegate' && selectedTool && body.model === 'primary' && !state.delegated;
    if (delegation) state.delegated = true;
    const call = state.mode === 'tool' || delegation;
    const args = delegation ? (name === 'Agent' ? { subagent_type: 'hh-worker', description: 'Child model check', prompt: 'Reply pong only', model: 'haiku' } : { message: 'Reply pong only', model: 'anthropic/worker' }) : { input: '*** Begin Patch\n*** End Patch', city: '上海' };
    const answer = body.model === 'worker' ? 'pong from child' : '你好 pong';
    let events;
    if (wire === 'chat') {
      const chunk = delta => ({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] });
      events = call ? [chunk({ tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name, arguments: '' } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })] : [chunk({ content: answer })];
      if (!state.truncated) events.push({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5 } });
    } else if (wire === 'anthropic') {
      events = [{ type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, usage: { input_tokens: 12, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: call ? { type: 'tool_use', id: 'call_fixture', name, input: {} } : { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text: answer } }, { type: 'content_block_stop', index: 0 }];
      if (!state.truncated) events.push({ type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
    } else {
      const item = call ? { id: 'item_fixture', type: 'function_call', call_id: 'call_fixture', name, arguments: '' } : { id: 'item_fixture', type: 'message', role: 'assistant', content: [], status: 'in_progress' };
      events = [{ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } }, { type: 'response.output_item.added', output_index: 0, item }, call ? { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: JSON.stringify(args) } : { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: answer }];
      if (!state.truncated) events.push({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: [], usage: { input_tokens: 12, output_tokens: 5 } } });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const bytes = Buffer.from(events.map(e => (wire === 'chat' ? '' : `event: ${e.type}\n`) + frames(e)).join(''));
    // Split inside UTF-8 and JSON tokens to exercise incremental decoders.
    for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, requests, state, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
function configuration(url, wire = 'chat') {
  const c = require('../lib/config').defaults(); c.viewer = 'none'; c.claude.interactiveArgs = [];
  for (const w of ['chat', 'anthropic', 'responses']) c.gateways[w] = { url, wire: w, auth: 'apikey', secret: `secret-${w}` };
  c.profiles.native = { agent: 'codex', gateway: wire, model: 'primary', orchestration: { mode: 'native', workerModel: 'anthropic/worker', models: ['chat/primary'], fallback: ['chat/primary'] } };
  return c;
}
module.exports = { fixture, configuration };
