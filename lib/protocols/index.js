'use strict';
// hh-owned protocol codec. No SDK/runtime dependency; no tool execution here.
const crypto = require('crypto');
const { HHError } = require('../util');
const id = prefix => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
const fail = message => { throw new HHError('unsupported_protocol', message); };
const str = value => typeof value === 'string' ? value : JSON.stringify(value == null ? '' : value);
const arr = value => Array.isArray(value) ? value : [];
const safeToolName = key => /^[A-Za-z0-9_-]{1,64}$/.test(key) ? key : `hh_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
function textParts(value) {
  if (typeof value === 'string') return [{ type: 'text', text: value }];
  return arr(value).map(p => {
    if (['text', 'input_text', 'output_text'].includes(p.type)) return { type: 'text', text: p.text || '' };
    if (p.type === 'input_image' || p.type === 'image_url') return { type: 'image', url: typeof p.image_url === 'string' ? p.image_url : p.image_url?.url };
    if (p.type === 'image') return { type: 'image', url: p.source?.type === 'base64' ? `data:${p.source.media_type};base64,${p.source.data}` : p.source?.url };
    fail('暂不支持的内容类型');
  });
}
function toolRegistry(tools, wire) {
  const list = []; const map = new Map(); const omitted = [];
  function add(t, ns) {
    if (wire === 'responses' && t.type === 'namespace') { for (const child of arr(t.tools)) add(child, t.name); return; }
    if ((wire === 'responses' && !['function', 'custom'].includes(t.type)) || (wire === 'chat' && t.type !== 'function') || (wire === 'anthropic' && t.type && t.type !== 'custom')) fail('托管工具不能跨协议转换；请使用同协议端点');
    const source = wire === 'chat' ? t.function : t;
    if (!source || typeof source.name !== 'string') fail('工具缺少名称');
    const original = source.name; const key = ns ? `${ns}__${original}` : original;
    const name = safeToolName(key);
    if (map.has(name)) fail('重复或冲突的工具名称');
    const custom = wire === 'responses' && t.type === 'custom';
    let description = source.description || '';
    if (custom) {
      if (t.format && !['text', 'grammar'].includes(t.format.type)) fail('未知 custom 工具格式');
      description += '\n\nTransport instructions: Send the raw tool input unchanged as the JSON string field "input". The original freeform instructions above apply to the decoded input string, not the transport envelope. JSON escaping is only for transport; do not add markdown fences or another JSON wrapper inside the string.';
      if (t.format?.type === 'grammar') {
        if (typeof t.format.syntax !== 'string' || typeof t.format.definition !== 'string') fail('custom 工具 grammar 缺少 syntax 或 definition');
        // This is prompt guidance, not grammar enforcement by the target provider.
        // The originating CLI still parses and validates the restored raw input.
        description += `\nThe decoded input string must follow the original grammar below. This grammar is provided as model instructions, not enforced by the target provider server. The originating CLI tool parser validates the raw input before execution.\nGrammar syntax: ${t.format.syntax}\nGrammar definition (verbatim):\n${t.format.definition}`;
      }
    }
    const row = { name, original, namespace: ns, custom, description, strict: source.strict, parameters: custom ? { type: 'object', properties: { input: { type: 'string', description: 'Raw tool input, unchanged.' } }, required: ['input'], additionalProperties: false } : source.parameters || source.input_schema || { type: 'object', properties: {} } };
    list.push(row); map.set(name, row);
  }
  for (const t of arr(tools)) add(t);
  return { list, map, omitted };
}
function normalize(body, wire) {
  const registry = toolRegistry(body.tools, wire);
  const out = { model: body.model, messages: [], registry, stream: body.stream === true, maxTokens: body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens, effort: body.reasoning?.effort || body.output_config?.effort || body.reasoning_effort, choice: body.tool_choice, parallel: body.parallel_tool_calls, temperature: body.temperature, topP: body.top_p, topK: body.top_k, stop: body.stop_sequences ?? body.stop, tokenField: wire === 'chat' && body.max_completion_tokens === undefined ? 'max_tokens' : 'max_completion_tokens', penalties: { frequency_penalty: body.frequency_penalty, presence_penalty: body.presence_penalty, seed: body.seed } };
  if (body.n !== undefined && body.n !== 1) fail('多候选响应无法跨协议转换');
  if (wire === 'anthropic') {
    if (body.tool_choice?.disable_parallel_tool_use !== undefined) out.parallel = !body.tool_choice.disable_parallel_tool_use;
    out.format = body.output_config?.format;
  }
  const add = (role, parts) => { if (parts.length) out.messages.push({ role: role === 'developer' ? 'system' : role, parts }); };
  const toolName = item => {
    const key = item.namespace ? `${item.namespace}__${item.name}` : item.name;
    return registry.list.find(t => t.original === item.name && t.namespace === item.namespace)?.name || safeToolName(key);
  };
  if (wire === 'responses') {
    if (body.instructions) add('system', textParts(body.instructions));
    if (typeof body.input === 'string') add('user', textParts(body.input));
    else for (const item of arr(body.input)) {
      if (item.type === 'function_call' || item.type === 'custom_tool_call') add('assistant', [{ type: 'call', id: item.call_id, name: toolName(item), args: item.type === 'custom_tool_call' ? JSON.stringify({ input: item.input }) : str(item.arguments) }]);
      else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') add('tool', [{ type: 'result', id: item.call_id, content: item.output }]);
      else if (item.type === 'reasoning') {
        if (item.encrypted_content) fail('加密 reasoning 历史不能跨协议转换；请使用同协议端点或新会话');
        // Public reasoning summaries are retained as assistant context, not forged signatures.
        const text = arr(item.summary).map(p => p.text || '').join('\n');
        if (text) add('assistant', [{ type: 'text', text }]);
      } else if (item.type === 'message' || item.role) add(item.role, textParts(item.content));
      else fail('暂不支持的 Responses 输入');
    }
    if (body.text?.format && body.text.format.type !== 'text') out.format = body.text.format;
  } else if (wire === 'anthropic') {
    if (body.system) add('system', textParts(body.system));
    for (const message of arr(body.messages)) {
      let parts = [];
      const flush = () => { add(message.role, parts); parts = []; };
      for (const block of typeof message.content === 'string' ? textParts(message.content) : arr(message.content)) {
        if (block.type === 'tool_use') parts.push({ type: 'call', id: block.id, name: toolName(block), args: JSON.stringify(block.input || {}) });
        else if (block.type === 'tool_result') { flush(); add('tool', [{ type: 'result', id: block.tool_use_id, content: block.content || '', error: !!block.is_error }]); }
        else if (block.type === 'thinking') { if (block.thinking) parts.push({ type: 'reasoning', text: block.thinking }); }
        else if (block.type === 'redacted_thinking') fail('redacted thinking 仅支持同协议透传');
        else parts.push(...textParts([block]));
      }
      flush();
    }
  } else if (wire === 'chat') {
    for (const message of arr(body.messages)) {
      if (message.role === 'tool') { add('tool', [{ type: 'result', id: message.tool_call_id, content: message.content }]); continue; }
      const parts = message.content == null ? [] : textParts(message.content);
      for (const t of arr(message.tool_calls)) parts.push({ type: 'call', id: t.id, name: toolName(t.function), args: str(t.function.arguments) });
      add(message.role, parts);
    }
    out.format = body.response_format;
  } else fail(`未知协议 ${wire}`);
  return out;
}
function chatContent(parts) {
  return parts.filter(p => p.type === 'text' || p.type === 'image' || p.type === 'reasoning').map(p => p.type === 'image' ? { type: 'image_url', image_url: { url: p.url } } : { type: 'text', text: p.text });
}
function anthropicContent(parts) {
  return parts.map(p => {
    if (p.type === 'text' || p.type === 'reasoning') return { type: 'text', text: p.text };
    if (p.type === 'image') {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(p.url || '');
      return { type: 'image', source: m ? { type: 'base64', media_type: m[1], data: m[2] } : { type: 'url', url: p.url } };
    }
    if (p.type === 'call') { let input; try { input = JSON.parse(p.args); } catch { fail('工具参数不是 JSON'); } return { type: 'tool_use', id: p.id, name: p.name, input }; }
    return { type: 'tool_result', tool_use_id: p.id, content: toolResultContent(p.content, 'anthropic'), ...(p.error ? { is_error: true } : {}) };
  });
}
// Tool results carry wire-specific content parts too, not arbitrary JSON.
// Keep strings as strings, and encode arrays without discarding images or order.
function toolResultContent(value, wire) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  if (!Array.isArray(value)) fail('工具返回内容必须是字符串或内容块数组');
  const parts = textParts(value);
  if (wire === 'anthropic') return anthropicContent(parts);
  if (wire === 'responses') return parts.map(p => p.type === 'image'
    ? { type: 'input_image', image_url: p.url }
    : { type: 'input_text', text: p.text });
  // Standard Chat tool messages accept text parts only. Moving images to a user
  // turn would change tool-result semantics; fail instead of dropping the image.
  if (parts.some(p => p.type === 'image')) fail('Chat 工具返回内容不支持图片；请使用 Responses 或 Anthropic 端点');
  return chatContent(parts);
}
function encode(n, wire, model, maxTokens) {
  const body = { model, stream: true };
  const tools = n.registry.list;
  if (wire === 'chat') {
    body.messages = n.messages.flatMap(m => {
      if (m.role === 'tool') return m.parts.map(p => ({ role: 'tool', tool_call_id: p.id, content: toolResultContent(p.content, 'chat') }));
      const content = chatContent(m.parts); const calls = m.parts.filter(p => p.type === 'call');
      return [{ role: m.role, content: content.length === 1 && content[0].type === 'text' ? content[0].text : content.length ? content : null, ...(calls.length ? { tool_calls: calls.map(p => ({ id: p.id, type: 'function', function: { name: p.name, arguments: p.args } })) } : {}) }];
    });
    // Responses emits parallel calls as separate items; Chat requires one assistant turn.
    body.messages = body.messages.reduce((messages, message) => {
      const last = messages[messages.length - 1];
      if (last?.role === 'assistant' && message.role === 'assistant') {
        const parts = value => value == null ? [] : typeof value === 'string' ? [{ type: 'text', text: value }] : value;
        const content = [...parts(last.content), ...parts(message.content)];
        last.content = content.length ? content : null;
        if (message.tool_calls) last.tool_calls = [...(last.tool_calls || []), ...message.tool_calls];
      } else messages.push(message);
      return messages;
    }, []);
    if (tools.length) body.tools = tools.map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters, ...(t.strict !== undefined ? { strict: t.strict } : {}) } }));
    if (n.effort) body.reasoning_effort = n.effort;
    if (n.maxTokens !== undefined) body[n.tokenField || 'max_completion_tokens'] = n.maxTokens;
    if (n.format) body.response_format = n.format.type === 'json_schema' && n.format.name ? { type: 'json_schema', json_schema: { name: n.format.name, schema: n.format.schema, strict: !!n.format.strict } } : n.format;
    body.stream_options = { include_usage: true };
  } else if (wire === 'anthropic') {
    body.max_tokens = n.maxTokens ?? maxTokens ?? 8192;
    body.system = n.messages.filter(m => m.role === 'system').flatMap(m => anthropicContent(m.parts));
    body.messages = [];
    for (const m of n.messages.filter(m => m.role !== 'system')) {
      const role = m.role === 'assistant' ? 'assistant' : 'user'; const content = anthropicContent(m.parts);
      const last = body.messages[body.messages.length - 1];
      if (last?.role === role) last.content.push(...content); else body.messages.push({ role, content });
    }
    if (tools.length) body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (n.effort) body.output_config = { effort: n.effort };
    if (n.format) { if (n.format.type !== 'json_schema') fail('Anthropic 转换只支持 json_schema 结构化输出'); body.output_config = { ...body.output_config, format: { type: 'json_schema', schema: n.format.schema || n.format.json_schema?.schema } }; }
  } else if (wire === 'responses') {
    body.input = n.messages.flatMap(m => m.parts.map(p => {
      if (p.type === 'call') return { type: 'function_call', call_id: p.id, name: p.name, arguments: p.args };
      if (p.type === 'result') return { type: 'function_call_output', call_id: p.id, output: toolResultContent(p.content, 'responses') };
      return { type: 'message', role: m.role, content: [p.type === 'image' ? { type: 'input_image', image_url: p.url } : { type: m.role === 'assistant' ? 'output_text' : 'input_text', text: p.text }] };
    }));
    if (tools.length) body.tools = tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: t.strict ?? false }));
    if (n.maxTokens !== undefined) body.max_output_tokens = n.maxTokens;
    if (n.effort) body.reasoning = { effort: n.effort };
    if (n.format) body.text = { format: n.format.json_schema ? { type: 'json_schema', ...n.format.json_schema } : n.format };
    body.store = false;
  } else fail(`不支持出站协议 ${wire}`);
  if (n.choice && tools.length) {
    if (typeof n.choice === 'string') body.tool_choice = wire === 'anthropic' ? { type: n.choice === 'required' ? 'any' : n.choice } : n.choice;
    else {
      const name = n.choice.name || n.choice.function?.name;
      if (name) {
        const mapped = tools.find(t => t.name === name || (t.original === name && t.namespace === n.choice.namespace))?.name;
        if (!mapped) fail('tool_choice 引用了未声明的工具');
        body.tool_choice = wire === 'anthropic' ? { type: 'tool', name: mapped } : wire === 'chat' ? { type: 'function', function: { name: mapped } } : { type: 'function', name: mapped };
      } else if (n.choice.type) body.tool_choice = wire === 'anthropic' ? { type: n.choice.type } : n.choice.type === 'any' ? 'required' : n.choice.type;
    }
  }
  if (n.parallel !== undefined && tools.length) {
    if (wire === 'anthropic') body.tool_choice = { ...(body.tool_choice || { type: 'auto' }), disable_parallel_tool_use: !n.parallel };
    else body.parallel_tool_calls = n.parallel;
  }
  for (const [key, value] of Object.entries(n.penalties || {})) {
    if (value === undefined) continue;
    if (wire !== 'chat') fail('目标协议不支持 frequency/presence penalty 或 seed');
    body[key] = value;
  }
  if (n.temperature !== undefined) body.temperature = n.temperature;
  if (n.topP !== undefined) body.top_p = n.topP;
  if (n.topK !== undefined) {
    if (wire !== 'anthropic') fail('top_k 无法跨协议转换');
    body.top_k = n.topK;
  }
  if (n.stop !== undefined) {
    if (wire === 'responses') fail('Responses 不支持 stop sequences');
    body[wire === 'anthropic' ? 'stop_sequences' : 'stop'] = typeof n.stop === 'string' ? [n.stop] : n.stop;
  }
  return body;
}
async function* sse(response) {
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      size += value?.length || 0;
      if (size > 32 * 1024 * 1024 || buffer.length > 4 * 1024 * 1024) fail('模型流超出会话响应预算');
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        try { yield JSON.parse(data); } catch (e) { if (e instanceof HHError) throw e; fail('上游 SSE JSON 无效'); }
      }
      if (done) { if (buffer.trim() && !buffer.startsWith(':')) fail('上游 SSE 帧不完整'); break; }
    }
  } finally { await reader.cancel().catch(() => {}); }
}
function usage(u, wire) {
  return { input: u?.input_tokens ?? u?.prompt_tokens ?? 0, output: u?.output_tokens ?? u?.completion_tokens ?? 0, cached: u?.cache_read_input_tokens ?? u?.input_tokens_details?.cached_tokens ?? u?.prompt_tokens_details?.cached_tokens ?? 0 };
}
// Reconcile terminal snapshots with deltas: providers may send either or both.
async function* events(response, wire) {
  let completed = false;
  const seen = new Map();
  function* delta(event) {
    const key = `${event.type}:${event.key}`;
    if (event.type === 'call') {
      const previous = seen.get(key);
      if (previous) {
        if ((event.name && previous.name !== event.name) || (event.id && previous.id !== event.id)) fail('上游工具标识在流中改变');
        return;
      }
      seen.set(key, event);
    } else seen.set(key, (seen.get(key) || '') + event.text);
    yield event;
  }
  function* full(type, key, text) {
    text = text || '';
    const previous = seen.get(`${type}:${key}`) || '';
    if (!text.startsWith(previous)) fail('上游最终内容与流不一致');
    if (text.length > previous.length) yield* delta({ type, key, text: text.slice(previous.length) });
  }
  function* stop(reason, sequence) {
    const reasons = wire === 'anthropic' ? { end_turn: 'done', tool_use: 'done', max_tokens: 'length', model_context_window_exceeded: 'length', stop_sequence: 'stop_sequence', refusal: 'refusal' }
      : { stop: 'done', tool_calls: 'done', length: 'length', content_filter: 'refusal' };
    if (!Object.hasOwn(reasons, reason)) fail('上游结束原因无法跨协议转换');
    yield { type: 'stop', reason: reasons[reason], sequence };
  }
  function* item(item, index) {
    const key = item.id || `output-${index}`;
    if (item.type === 'function_call') {
      yield* delta({ type: 'call', key, id: item.call_id, name: item.name });
      yield* full('args', key, item.arguments);
    } else if (item.type === 'message') {
      for (const [i, part] of arr(item.content).entries()) {
        if (part.type === 'output_text') yield* full('text', `${key}:${i}`, part.text);
        else if (part.type === 'refusal') { yield* full('text', `${key}:${i}`, part.refusal); yield { type: 'stop', reason: 'refusal' }; }
        else fail('上游消息内容无法跨协议转换');
      }
    } else if (item.type === 'reasoning') {
      for (const [i, part] of arr(item.summary).entries()) yield* full('reasoning', `${key}:${i}`, part.text);
      if (item.encrypted_content) fail('加密 reasoning 无法跨协议转换');
    } else fail('上游托管工具或输出类型无法跨协议转换');
  }
  function* terminal(r) {
    if (r.error || r.status === 'failed' || r.status === 'cancelled') throw new HHError('upstream_stream', '上游模型报告错误');
    for (const [i, b] of arr(r.output).entries()) yield* item(b, i);
    if (r.status === 'incomplete') {
      const reason = r.incomplete_details?.reason;
      if (!['max_output_tokens', 'content_filter'].includes(reason)) fail('上游未完成原因无法跨协议转换');
      yield { type: 'stop', reason: reason === 'max_output_tokens' ? 'length' : 'refusal' };
    }
    yield { type: 'usage', ...usage(r.usage, wire) };
  }
  if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
    // Bound JSON responses using the same budget as SSE; never expose parser bodies.
    const reader = response.body.getReader(); const chunks = []; let size = 0;
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 32 * 1024 * 1024) fail('模型响应超出预算'); chunks.push(Buffer.from(value)); }
    } finally { await reader.cancel().catch(() => {}); }
    let r; try { r = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('上游 JSON 无效'); }
    if (!r || r.error) throw new HHError('upstream_stream', '上游模型报告错误');
    if (wire === 'responses') { yield* terminal(r); return; }
    yield { type: 'usage', ...usage(r.usage, wire) };
    if (wire === 'chat') {
      const c = r.choices?.[0]; if (!c?.message) fail('上游 Chat 响应无效');
      const m = c.message;
      if (m.content) yield* full('text', 'text', m.content);
      if (m.reasoning_content || m.reasoning) yield* full('reasoning', 'reasoning', m.reasoning_content || m.reasoning);
      if (m.refusal) yield* full('text', 'refusal', m.refusal);
      for (const [i, t] of arr(m.tool_calls).entries()) { yield* delta({ type: 'call', key: `call-${i}`, id: t.id, name: t.function?.name }); yield* full('args', `call-${i}`, t.function?.arguments); }
      yield* stop(c.finish_reason); return;
    }
    if (!Array.isArray(r.content)) fail('上游 Messages 响应无效');
    for (const [i, b] of r.content.entries()) {
      const key = `block-${i}`;
      if (b.type === 'tool_use') { yield* delta({ type: 'call', key, id: b.id, name: b.name }); yield* full('args', key, JSON.stringify(b.input || {})); }
      else if (b.type === 'text' || b.type === 'thinking') yield* full(b.type === 'text' ? 'text' : 'reasoning', key, b.text || b.thinking);
      else fail('上游 Messages 内容无法跨协议转换');
    }
    yield* stop(r.stop_reason, r.stop_sequence); return;
  }
  for await (const e of sse(response)) {
    if (e.error || ['error', 'response.failed'].includes(e.type)) throw new HHError('upstream_stream', '上游模型在流中报告错误；不会重放已经输出的任务');
    if (wire === 'chat') {
      if (e.usage) yield { type: 'usage', ...usage(e.usage, wire) };
      const c = e.choices?.[0]; if (!c) continue;
      if (c.delta?.content) yield* delta({ type: 'text', key: 'text', text: c.delta.content });
      if (c.delta?.refusal) yield* delta({ type: 'text', key: 'refusal', text: c.delta.refusal });
      if (c.delta?.reasoning_content || c.delta?.reasoning) yield* delta({ type: 'reasoning', key: 'reasoning', text: c.delta.reasoning_content || c.delta.reasoning });
      for (const t of arr(c.delta?.tool_calls)) {
        if (t.id || t.function?.name) yield* delta({ type: 'call', key: `call-${t.index}`, id: t.id, name: t.function?.name });
        if (t.function?.arguments) yield* delta({ type: 'args', key: `call-${t.index}`, text: t.function.arguments });
      }
      if (c.finish_reason) { completed = true; yield* stop(c.finish_reason); }
    } else if (wire === 'anthropic') {
      if (e.type === 'message_start') yield { type: 'usage', ...usage(e.message?.usage, wire) };
      if (e.type === 'content_block_start') {
        const b = e.content_block; const key = `block-${e.index}`;
        if (b.type === 'tool_use') { yield* delta({ type: 'call', key, id: b.id, name: b.name }); if (b.input && Object.keys(b.input).length) yield* full('args', key, JSON.stringify(b.input)); }
        else if (b.type === 'text' || b.type === 'thinking') { if (b.text || b.thinking) yield* delta({ type: b.type === 'text' ? 'text' : 'reasoning', key, text: b.text || b.thinking }); }
        else fail('上游 Messages 内容无法跨协议转换');
      }
      if (e.type === 'content_block_delta') {
        const d = e.delta; const key = `block-${e.index}`;
        if (d.type === 'text_delta') yield* delta({ type: 'text', key, text: d.text });
        else if (d.type === 'thinking_delta') yield* delta({ type: 'reasoning', key, text: d.thinking });
        else if (d.type === 'input_json_delta') yield* delta({ type: 'args', key, text: d.partial_json });
        else if (d.type !== 'signature_delta') fail('上游 Messages 增量无法跨协议转换');
      }
      if (e.type === 'message_delta') { if (e.usage) yield { type: 'usage', output: e.usage.output_tokens ?? 0 }; if (e.delta?.stop_reason) yield* stop(e.delta.stop_reason, e.delta.stop_sequence); }
      if (e.type === 'message_stop') completed = true;
    } else {
      if (e.type === 'response.output_item.added' && e.item?.type === 'function_call') yield* delta({ type: 'call', key: e.item.id || `output-${e.output_index}`, id: e.item.call_id, name: e.item.name });
      if (e.type === 'response.function_call_arguments.delta') yield* delta({ type: 'args', key: e.item_id || `output-${e.output_index}`, text: e.delta });
      if (e.type === 'response.output_text.delta') yield* delta({ type: 'text', key: `${e.item_id || `output-${e.output_index}`}:${e.content_index ?? 0}`, text: e.delta });
      if (e.type === 'response.reasoning_summary_text.delta') yield* delta({ type: 'reasoning', key: `${e.item_id || `output-${e.output_index}`}:${e.summary_index ?? 0}`, text: e.delta });
      if (e.type === 'response.output_item.done') yield* item(e.item, e.output_index);
      if (e.type === 'response.completed' || e.type === 'response.incomplete') { completed = true; yield* terminal(e.response); }
    }
  }
  if (!completed) throw new HHError('upstream_truncated', '上游流未正常结束');
}
function collector(registry) {
  const state = { blocks: [], keys: new Map(), usage: { input: 0, output: 0, cached: 0 }, reason: 'done' };
  state.take = event => {
    if (event.type === 'usage') { for (const k of ['input', 'output', 'cached']) if (event[k] !== undefined) state.usage[k] = event[k]; return null; }
    if (event.type === 'stop') { state.reason = event.reason; state.stopSequence = event.sequence ?? null; return null; }
    let block = state.keys.get(event.key); let fresh = false;
    if (!block) {
      if (event.type === 'args') fail('上游工具参数先于工具名称');
      block = { type: event.type, index: state.blocks.length, toolIndex: state.blocks.filter(b => b.type === 'call').length, id: id('item'), callId: event.id || id('call'), name: event.name, text: '', args: '' };
      if (event.type === 'call') { block.tool = registry.map.get(event.name); if (!block.tool) fail('模型调用了未声明的工具'); }
      state.keys.set(event.key, block); state.blocks.push(block); fresh = true;
    }
    if (event.type === 'call' && event.name && block.name !== event.name) fail('工具名称在流中改变');
    if (event.type === 'args') block.args += event.text;
    if (event.type === 'text' || event.type === 'reasoning') block.text += event.text;
    return { block, fresh };
  };
  return state;
}
function responseItem(b, done = true) {
  const status = done ? 'completed' : 'in_progress';
  if (b.type === 'call') {
    const base = { id: b.id, call_id: b.callId, name: b.tool.original, ...(b.tool.namespace ? { namespace: b.tool.namespace } : {}), status };
    if (b.tool.custom) { let input = ''; if (done) { try { input = JSON.parse(b.args).input; } catch { fail('freeform 工具参数缺少 input 字符串'); } if (typeof input !== 'string') fail('freeform input 必须是字符串'); } return { ...base, type: 'custom_tool_call', input }; }
    if (done) { try { JSON.parse(b.args || '{}'); } catch { fail('模型工具参数不是有效 JSON'); } }
    return { ...base, type: 'function_call', arguments: done ? b.args || '{}' : '' };
  }
  if (b.type === 'reasoning') return { id: b.id, type: 'reasoning', summary: done ? [{ type: 'summary_text', text: b.text }] : [] };
  return { id: b.id, type: 'message', role: 'assistant', status, content: done ? [{ type: 'output_text', text: b.text, annotations: [] }] : [] };
}
module.exports = { id, str, arr, normalize, encode, sse, events, collector, responseItem };
