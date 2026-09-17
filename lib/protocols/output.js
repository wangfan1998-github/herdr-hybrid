'use strict';
const codec = require('./index');
async function write(res, text) {
  if (res.destroyed) throw new Error('client closed');
  if (!res.write(text)) await new Promise((resolve, reject) => {
    const clean = () => { res.off('drain', drain); res.off('close', close); res.off('error', error); };
    const drain = () => { clean(); resolve(); };
    const error = e => { clean(); reject(e); };
    const close = () => error(new Error('client closed'));
    res.once('drain', drain); res.once('close', close); res.once('error', error);
    if (res.destroyed) close();
  });
}
async function output(res, source, wire, n) {
  const state = codec.collector(n.registry); const rid = codec.id('hhresp'); let seq = 0;
  const emit = async (type, data) => write(res, `event: ${type}\ndata: ${JSON.stringify({ type, ...data, ...(wire === 'responses' ? { sequence_number: seq++ } : {}) })}\n\n`);
  const base = { id: rid, object: 'response', created_at: Math.floor(Date.now() / 1000), model: n.model, output: [], status: 'in_progress' };
  if (n.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (wire === 'responses') { await emit('response.created', { response: base }); await emit('response.in_progress', { response: base }); }
    if (wire === 'anthropic') await emit('message_start', { message: { id: rid, type: 'message', role: 'assistant', model: n.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  for await (const event of source) {
    const changed = state.take(event); if (!changed || !n.stream) continue;
    const { block: b, fresh } = changed;
    if (wire === 'responses') {
      if (fresh) {
        await emit('response.output_item.added', { output_index: b.index, item: codec.responseItem(b, false) });
        if (b.type === 'text') await emit('response.content_part.added', { item_id: b.id, output_index: b.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
        if (b.type === 'reasoning') await emit('response.reasoning_summary_part.added', { item_id: b.id, output_index: b.index, summary_index: 0, part: { type: 'summary_text', text: '' } });
      }
      const fields = { item_id: b.id, output_index: b.index, delta: event.text };
      if (event.type === 'text') await emit('response.output_text.delta', { ...fields, content_index: 0 });
      if (event.type === 'reasoning') await emit('response.reasoning_summary_text.delta', { ...fields, summary_index: 0 });
      if (event.type === 'args' && !b.tool.custom) await emit('response.function_call_arguments.delta', fields);
    } else if (wire === 'anthropic') {
      // Parallel upstream calls may interleave. Emit complete blocks sequentially
      // after collection, so no delta ever targets a closed Messages block.
      continue;
    } else {
      const delta = event.type === 'call' ? { tool_calls: [{ index: b.toolIndex, id: b.callId, type: 'function', function: { name: b.tool.original, arguments: '' } }] } : event.type === 'args' ? { tool_calls: [{ index: b.toolIndex, function: { arguments: event.text } }] } : { [event.type === 'reasoning' ? 'reasoning_content' : 'content']: event.text };
      await write(res, `data: ${JSON.stringify({ id: rid, object: 'chat.completion.chunk', model: n.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    }
  }
  const u = state.usage; const calls = state.blocks.some(b => b.type === 'call');
  const items = state.blocks.map(b => codec.responseItem(b));
  const result = { ...base, status: ['length', 'refusal'].includes(state.reason) ? 'incomplete' : 'completed', output: items, usage: { input_tokens: u.input, output_tokens: u.output, total_tokens: u.input + u.output, input_tokens_details: { cached_tokens: u.cached } }, ...(['length', 'refusal'].includes(state.reason) ? { incomplete_details: { reason: state.reason === 'length' ? 'max_output_tokens' : 'content_filter' } } : {}) };
  const anthropic = { id: rid, type: 'message', role: 'assistant', model: n.model, content: state.blocks.map(b => b.type === 'call' ? { type: 'tool_use', id: b.callId, name: b.tool.original, input: JSON.parse(b.args || '{}') } : { type: 'text', text: b.text }), stop_reason: state.reason === 'length' ? 'max_tokens' : state.reason === 'refusal' ? 'refusal' : state.reason === 'stop_sequence' ? 'stop_sequence' : calls ? 'tool_use' : 'end_turn', stop_sequence: state.stopSequence ?? null, usage: { input_tokens: u.input, output_tokens: u.output, cache_read_input_tokens: u.cached } };
  if (n.stream) {
    for (const b of state.blocks) {
      if (wire === 'anthropic') {
        await emit('content_block_start', { index: b.index, content_block: b.type === 'call' ? { type: 'tool_use', id: b.callId, name: b.tool.original, input: {} } : { type: 'text', text: '' } });
        await emit('content_block_delta', { index: b.index, delta: b.type === 'call' ? { type: 'input_json_delta', partial_json: b.args || '{}' } : { type: 'text_delta', text: b.text } });
        await emit('content_block_stop', { index: b.index });
      }
      if (wire === 'responses') {
        const fields = { item_id: b.id, output_index: b.index };
        if (b.type === 'text') { await emit('response.output_text.done', { ...fields, content_index: 0, text: b.text }); await emit('response.content_part.done', { ...fields, content_index: 0, part: items[b.index].content[0] }); }
        if (b.type === 'call' && !b.tool.custom) await emit('response.function_call_arguments.done', { ...fields, arguments: b.args || '{}' });
        if (b.type === 'call' && b.tool.custom) { await emit('response.custom_tool_call_input.delta', { ...fields, delta: items[b.index].input }); await emit('response.custom_tool_call_input.done', { ...fields, input: items[b.index].input }); }
        if (b.type === 'reasoning') { await emit('response.reasoning_summary_text.done', { ...fields, summary_index: 0, text: b.text }); await emit('response.reasoning_summary_part.done', { ...fields, summary_index: 0, part: items[b.index].summary[0] }); }
        await emit('response.output_item.done', { output_index: b.index, item: items[b.index] });
      }
    }
    if (wire === 'responses') await emit(['length', 'refusal'].includes(state.reason) ? 'response.incomplete' : 'response.completed', { response: result });
    if (wire === 'anthropic') { await emit('message_delta', { delta: { stop_reason: anthropic.stop_reason, stop_sequence: anthropic.stop_sequence }, usage: anthropic.usage }); await emit('message_stop', {}); }
    if (wire === 'chat') { await write(res, `data: ${JSON.stringify({ id: rid, object: 'chat.completion.chunk', model: n.model, choices: [{ index: 0, delta: {}, finish_reason: state.reason === 'length' ? 'length' : state.reason === 'refusal' ? 'content_filter' : calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output } })}\n\ndata: [DONE]\n\n`); }
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chat = { id: rid, object: 'chat.completion', model: n.model, choices: [{ index: 0, message: { role: 'assistant', content: state.blocks.filter(b => b.type !== 'call').map(b => b.text).join(''), ...(calls ? { tool_calls: state.blocks.filter(b => b.type === 'call').map(b => ({ id: b.callId, type: 'function', function: { name: b.tool.original, arguments: b.args || '{}' } })) } : {}) }, finish_reason: state.reason === 'length' ? 'length' : state.reason === 'refusal' ? 'content_filter' : calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: u.input, completion_tokens: u.output, total_tokens: u.input + u.output } };
    await write(res, JSON.stringify(wire === 'responses' ? result : wire === 'anthropic' ? anthropic : chat));
  }
  return { id: rid, state, result };
}
module.exports = { output, write };
