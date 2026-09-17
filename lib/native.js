'use strict';
// Session-owned model router and lifecycle. Reads hh gateways, not another product's config.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HHError, writeJson } = require('./util');
const config = require('./config');
const policy = require('./orchestration');
const codec = require('./protocols');
const compaction = require('./compaction');
const { output, write } = require('./protocols/output');
const WIRES = ['responses', 'anthropic', 'chat'];
function route(c, selector) {
  const slash = typeof selector === 'string' ? selector.indexOf('/') : -1;
  if (slash < 1 || slash === selector.length - 1) throw new HHError('bad_route', '模型必须是 gateway/model');
  const name = selector.slice(0, slash); const model = selector.slice(slash + 1);
  const gateway = config.getGateway(c, name);
  config.validateGateway(name, gateway);
  if (!WIRES.includes(gateway.wire)) throw new HHError('no_wire', `网关 ${name} 需要 --wire responses|anthropic|chat`);
  const secret = gateway.secret.startsWith('env:') ? process.env[gateway.secret.slice(4)] : gateway.secret;
  if (!secret) throw new HHError('no_secret', `网关 ${name} 的凭证引用未设置`);
  const url = new URL(gateway.url);
  if (url.username || url.password || url.search || url.hash) throw new HHError('bad_route', `网关 ${name} URL 不能含凭证、query 或 fragment`);
  return { name, model, gateway, secret };
}
// Missing metadata is unknown, never an affirmative capability claim.
function capabilities(c, selectors) {
  const gateways = selectors.map(selector => route(c, selector).gateway);
  const caps = gateways.map(gateway => gateway.capabilities || {});
  return {
    imageInput: caps.every(cap => cap.imageInput === true),
    parallelToolCalls: caps.every(cap => cap.parallelToolCalls === true),
    reasoningSummaries: caps.every(cap => cap.reasoningSummaries === true),
    reasoningEfforts: (caps[0].reasoningEfforts || []).filter(effort => caps.every(cap => cap.reasoningEfforts?.includes(effort))),
    // Admission constraints are distinct from catalog claims: unknown targets defer to upstream.
    declaredReasoningEfforts: caps.filter(cap => cap.reasoningEfforts !== undefined).map(cap => cap.reasoningEfforts),
    // hh default session budget, not a claim about the provider's physical limit.
    contextWindow: Math.min(...gateways.map(gateway => gateway.contextWindow || 128000)),
  };
}
function checkEffort(caps, effort) {
  if (effort !== undefined && effort !== null && caps.declaredReasoningEfforts.some(allowed => !allowed.includes(effort)))
    throw failure('bad_effort', '模型或回退目标显式声明不支持所请求的 reasoning effort', 400);
}
function plan(c, profileName, override) {
  const p = config.getProfile(c, profileName);
  const selected = { ...(p.orchestration || {}), ...override, mode: 'native' };
  const result = policy.plan(profileName, selected);
  const main = p.gateway ? `${p.gateway}/${p.model || ''}` : p.model;
  route(c, main);
  const concrete = [...new Set([main, ...result.targets, ...(selected.models || [])])];
  for (const model of concrete) route(c, model);
  const models = [...new Set([main, ...result.models])];
  if (result.effort) for (const model of result.models) checkEffort(capabilities(c, model === result.worker ? result.targets : [model]), result.effort);
  const catalog = { models: models.map((slug, index) => {
    const caps = capabilities(c, slug === result.worker ? result.targets : [slug]);
    const context = caps.contextWindow;
    // Codex catalog enums are narrower than gateway effort labels (e.g. max/ultra).
    const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh'].filter(e => caps.reasoningEfforts.includes(e));
    return { slug, display_name: slug, description: 'herdr-hybrid routed model', priority: result.models.includes(slug) ? result.models.indexOf(slug) : 10 + index,
      experimental_supported_tools: [], visibility: 'list', supported_in_api: true, multi_agent_version: 'v1', shell_type: 'shell_command', context_window: context,
      max_context_window: context, auto_compact_token_limit: Math.floor(context * 0.8), effective_context_window_percent: 95,
      base_instructions: 'You are a coding assistant. Use the provided tools to inspect and edit the workspace, follow developer and user instructions, verify changes and report results accurately.',
      default_reasoning_level: efforts.includes('medium') ? 'medium' : efforts[0] || null, supported_reasoning_levels: efforts.map(effort => ({ effort, description: effort })),
      supports_reasoning_summaries: caps.reasoningSummaries, supports_verbosity: false, default_verbosity: null, support_verbosity: false,
      supports_parallel_tool_calls: caps.parallelToolCalls, supports_image_detail_original: false, input_modalities: caps.imageInput ? ['text', 'image'] : ['text'],
      prefer_websockets: false, apply_patch_tool_type: 'freeform', truncation_policy: { mode: 'tokens', limit: 10000 },
    };
  }) };
  return { ...result, main, concrete, catalog, catalogPath: path.join(config.STATE_DIR, 'native', `${policy.hash({ profileName, main, selected })}-${process.pid}-${crypto.randomBytes(12).toString('hex')}.json`) };
}
function endpoint(r, suffix) {
  let base = r.gateway.url.replace(/\/+$/, '');
  if (!/\/v\d+(?:beta\d*)?$/.test(base)) base += '/v1';
  return `${base}/${suffix || (r.gateway.wire === 'responses' ? 'responses' : r.gateway.wire === 'anthropic' ? 'messages' : 'chat/completions')}`;
}
function bodyOf(req, signal, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    const clean = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', aborted); signal.removeEventListener('abort', aborted); };
    const error = e => { clean(); req.resume(); reject(e); };
    const aborted = () => error(new HHError('request_timeout', '请求超时或连接已关闭'));
    const data = chunk => { size += chunk.length; if (size > limit) error(new HHError('request_size', '请求超过会话字节预算')); else chunks.push(chunk); };
    const end = () => { clean(); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HHError('request_json', '请求 JSON 无效')); } };
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', aborted); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
function failure(code, message, status) { const e = new HHError(code, message); e.status = status; return e; }
function errorBody(wire, code, message, status) {
  const type = wire === 'anthropic' ? ({ authentication_error: 'authentication_error', request_size: 'request_too_large', upstream_http: 'api_error', busy: 'overloaded_error' }[code] || (['request_json', 'unknown_model', 'expired_response', 'unsupported_protocol', 'unsafe_continuation', 'compaction_size'].includes(code) ? 'invalid_request_error' : 'api_error')) : code;
  const statusType = wire === 'anthropic' && ({ 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 404: 'not_found_error', 413: 'request_too_large', 429: 'rate_limit_error', 503: 'overloaded_error' }[status]);
  return { ...(wire === 'anthropic' ? { type: 'error' } : {}), error: { type: statusType || type, code, message } };
}
function json(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); }
function headers(r) { return { 'content-type': 'application/json', ...(r.gateway.wire === 'anthropic' ? { 'anthropic-version': '2023-06-01', ...(r.gateway.auth === 'apikey' ? { 'x-api-key': r.secret } : { authorization: `Bearer ${r.secret}` }) } : { authorization: `Bearer ${r.secret}` }) }; }
async function start(c, profileName, override, limits = {}) {
  const timeoutMs = limits.timeoutMs ?? 180000, requestBytes = limits.requestBytes ?? 16 * 1024 * 1024;
  const responseBytes = limits.responseBytes ?? 32 * 1024 * 1024, cacheTTL = limits.cacheTTL ?? 20 * 60 * 1000;
  const session = plan(c, profileName, override); const token = crypto.randomBytes(32).toString('hex');
  const active = new Set(); const cache = new Map(); let cacheBytes = 0;
  const origins = new Map(); let originBytes = 0; let closing = false; let closePromise;
  function prune() {
    for (const [key, entry] of cache) if (entry.expires <= Date.now()) { cacheBytes -= entry.bytes; cache.delete(key); }
  }
  function remember(key, value) {
    prune();
    if (cache.has(key)) { cacheBytes -= cache.get(key).bytes; cache.delete(key); }
    const budget = Math.min(responseBytes, 32 * 1024 * 1024);
    const bytes = Buffer.byteLength(JSON.stringify(value)); if (bytes > Math.min(budget, 8 * 1024 * 1024)) return;
    while (cache.size && (cache.size >= 32 || cacheBytes + bytes > budget)) { const first = cache.keys().next().value; cacheBytes -= cache.get(first).bytes; cache.delete(first); }
    cache.set(key, { value, bytes, expires: Date.now() + cacheTTL }); cacheBytes += bytes;
  }
  // Keep bounded identity tombstones until session close: expiring/evicting an owner
  // must not let a later provider reuse its ID and silently steal old continuations.
  // Store only a digest and target, never response bodies or credentials.
  const originKey = id => crypto.createHash('sha256').update(id).digest('hex');
  function rememberOrigin(id, target) {
    if (typeof id !== 'string' || !id || id.length > 512) return;
    const key = originKey(id); const old = origins.get(key);
    if (old) {
      if (old.target !== target) { old.ambiguous = true; old.expires = 0; }
      else if (!old.ambiguous) old.expires = Date.now() + cacheTTL;
      return;
    }
    const bytes = 64 + Buffer.byteLength(target) + 64;
    if (origins.size >= 1024 || originBytes + bytes > Math.min(responseBytes, 1024 * 1024)) return;
    origins.set(key, { target, expires: Date.now() + cacheTTL, ambiguous: false }); originBytes += bytes;
  }
  const server = http.createServer(async (req, res) => {
    let ac; let timer;
    const url = req.url?.split('?')[0];
    const wire = url?.includes('/messages') ? 'anthropic' : url?.includes('/chat/') ? 'chat' : 'responses';
    try {
      const authorization = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.headers['x-api-key'];
      if (authorization !== token) return json(res, 401, errorBody(wire, 'authentication_error', 'hh session token required'));
      if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ready: !closing, service: 'herdr-hybrid', active: active.size });
      if (req.method === 'GET' && url === '/v1/models') return json(res, 200, { object: 'list', data: session.catalog.models.map(m => ({ id: m.slug, type: 'model', display_name: m.slug, object: 'model', created: 0, owned_by: 'herdr-hybrid' })), has_more: false });
      if (req.method !== 'POST' || !['/v1/responses', '/v1/messages', '/v1/messages/count_tokens', '/v1/chat/completions', '/v1/responses/compact'].includes(url)) return json(res, 404, errorBody(wire, 'not_found_error', 'unsupported hh endpoint'));
      if (active.size >= 16 || closing) return json(res, 503, errorBody(wire, 'busy', 'hh session is busy or closing'));
      ac = new AbortController(); active.add(ac);
      timer = setTimeout(() => { ac.abort(); if (res.headersSent) res.destroy(); }, timeoutMs);
      res.once('close', () => { if (!res.writableEnded) ac.abort(); });
      const body = await bodyOf(req, ac.signal, requestBytes);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HHError('request_json', '请求必须是对象');
      const system = typeof body.system === 'string' ? body.system : codec.arr(body.system).map(b => b.text || '').join('\n');
      const marker = /<!--\s*hh-route:\s*([^\s]+)\s*-->/.exec(system);
      const effort = /<!--\s*hh-effort:\s*([^\s]+)\s*-->/.exec(system);
      let selector = marker?.[1] || body.model;
      // Claude strips the context-window hint from model ids; resolve only declared aliases.
      if (wire === 'anthropic' && ![session.main, ...session.models, ...session.targets].includes(selector)) {
        const aliases = [...new Set([session.main, ...session.models, ...session.targets])].filter(m => m.endsWith('[1m]') && m.slice(0, -4) === selector);
        if (aliases.length === 1) selector = aliases[0];
      }
      // No arbitrary proxy: the server only admits this session's declared roster.
      if (![session.main, ...session.models, ...session.targets].includes(selector)) throw new HHError('unknown_model', '模型不在本会话的配置范围内');
      let targets = selector === session.worker ? session.targets : [selector];
      const requestedEffort = effort?.[1] ?? (wire === 'responses' ? body.reasoning?.effort : wire === 'anthropic' ? body.output_config?.effort : body.reasoning_effort);
      const counting = url.endsWith('/count_tokens');
      if (counting && route(c, targets[0]).gateway.wire !== 'anthropic') {
        res.setHeader('x-hh-token-count', 'estimated');
        return json(res, 200, { input_tokens: Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 3), estimated: true });
      }
      const compact = url.endsWith('/compact');
      let summarizing = false;
      let normalized; let cached = false;
      prune();
      if (wire === 'responses' && body.previous_response_id != null) {
        const previous = body.previous_response_id;
        if (typeof previous !== 'string' || !previous || previous.length > 512) throw failure('unknown_response_source', '无效续接 ID；请发送完整历史', 400);
        const old = cache.get(previous); const origin = origins.get(originKey(previous));
        if (origin?.ambiguous || (origin && old)) throw failure('ambiguous_response_source', '续接 ID 来源冲突；请发送完整历史', 400);
        if (old) {
          if (body.tools === undefined) body.tools = old.value.tools;
          normalized = codec.normalize(body, wire);
          const instructionCount = body.instructions ? 1 : 0;
          normalized.messages = normalized.messages.slice(0, instructionCount).concat(old.value.messages, normalized.messages.slice(instructionCount)); cached = true;
        } else {
          if (!origin || origin.expires <= Date.now()) throw failure(previous.startsWith('hhresp_') ? 'expired_response' : 'unknown_response_source', '续接来源未知或已过期；请发送完整历史', 400);
          if (!targets.includes(origin.target)) throw failure('response_source_mismatch', '续接来源不属于所选模型路由；请使用原路由或发送完整历史', 400);
          // Both /responses and /responses/compact must use exactly this owner.
          targets = [origin.target];
        }
      }
      checkEffort(capabilities(c, targets), requestedEffort);
      let upstream; let selected; let passthrough = false;
      for (let attempt = 0; attempt < targets.length; attempt++) {
        const r = route(c, targets[attempt]);
        passthrough = r.gateway.wire === wire && !cached;
        if (body.previous_response_id && !cached && (attempt > 0 || !passthrough)) throw new HHError('unsafe_continuation', '上游 response id 不能跨模型回退；请发送完整历史');
        let outbound;
        if (counting) {
          if (r.gateway.wire !== 'anthropic') throw failure('upstream_http', '计数网关不可用；未替换为估算值', 503);
          outbound = { ...body, model: r.model };
        } else if (compact) {
          summarizing = r.gateway.wire !== 'responses' || cached;
          if (summarizing) { normalized ||= codec.normalize(body, wire); outbound = codec.encode(compaction.prepare(normalized), r.gateway.wire, r.model, r.gateway.maxOutputTokens); }
          else outbound = { ...body, model: r.model };
        } else if (passthrough) outbound = { ...body, model: r.model, ...(effort && wire === 'anthropic' ? { output_config: { ...body.output_config, effort: effort[1] } } : {}) };
        else {
          normalized ||= codec.normalize(body, wire); normalized.model = selector; normalized.stream = body.stream === true;
          if (effort) normalized.effort = effort[1];
          outbound = codec.encode(normalized, r.gateway.wire, r.model, r.gateway.maxOutputTokens);
        }
        try {
          upstream = await fetch(endpoint(r, counting ? 'messages/count_tokens' : compact && !summarizing ? 'responses/compact' : undefined), { method: 'POST', headers: headers(r), body: JSON.stringify(outbound), signal: ac.signal, redirect: 'error' });
        } catch {
          // A network failure is ambiguous: the upstream may already have accepted the call.
          throw failure(ac.signal.aborted ? 'request_timeout' : 'upstream_network', '上游连接失败或超时；未自动重放请求', ac.signal.aborted ? 504 : 502);
        }
        if (upstream.ok) { selected = r; break; }
        const status = upstream.status; await upstream.body?.cancel();
        if (![408, 429, 500, 502, 503, 504].includes(status) || attempt === targets.length - 1) throw failure('upstream_http', `上游返回 HTTP ${status}`, status);
        res.setHeader('x-hh-fallback-count', String(attempt + 1));
      }
      if (compact && summarizing) {
        res.setHeader('x-hh-model', `${selected.name}/${selected.model}`);
        res.setHeader('x-hh-compaction', 'plain-summary');
        return json(res, 200, await compaction.collect(codec.events(upstream, selected.gateway.wire), compaction.prepare(normalized)));
      }
      if (passthrough || compact || counting) {
        if (!(upstream.headers.get('content-type') || '').includes('text/event-stream')) {
          const chunks = []; let size = 0;
          for await (const chunk of upstream.body) { size += chunk.length; if (size > responseBytes) throw new HHError('response_size', '上游响应过大'); chunks.push(chunk); }
          let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HHError('upstream_json', '上游 JSON 无效'); }
          if (value?.error) throw new HHError('upstream_http', '上游返回错误');
          if (wire === 'responses' && !compact) rememberOrigin(value?.id, `${selected.name}/${selected.model}`);
          res.setHeader('x-hh-model', `${selected.name}/${selected.model}`);
          return json(res, upstream.status, value);
        }
        if (counting || compact || body.stream !== true) throw new HHError('upstream_protocol', '上游响应流类型与请求不符');
        res.setHeader('content-type', 'text/event-stream');
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-cache', 'x-hh-model': `${selected.name}/${selected.model}` });
        let bytes = 0; let completed = false; let responseId;
        for await (const event of codec.sse(upstream)) {
          if (event.error || ['error', 'response.failed'].includes(event.type)) throw new HHError('upstream_stream', '上游流失败；未重放请求');
          if (['response.completed', 'response.incomplete', 'message_stop'].includes(event.type) || event.choices?.some(choice => choice.finish_reason)) completed = true;
          if (wire === 'responses' && event.response?.id !== undefined) {
            const id = event.response.id;
            if (typeof id !== 'string' || !id || id.length > 512 || (responseId && responseId !== id)) throw new HHError('upstream_protocol', '上游响应 ID 不一致或无效');
            responseId = id;
          }
          const frame = `${wire === 'chat' ? '' : `event: ${event.type}\n`}data: ${JSON.stringify(event)}\n\n`;
          bytes += Buffer.byteLength(frame); if (bytes > responseBytes) throw new HHError('response_size', '上游响应过大');
          if (wire === 'responses' && ['response.completed', 'response.incomplete'].includes(event.type)) rememberOrigin(responseId, `${selected.name}/${selected.model}`);
          await write(res, frame);
        }
        if (!completed) throw new HHError('upstream_truncated', '上游流未正常结束');
        if (wire === 'chat') await write(res, 'data: [DONE]\n\n');
      } else {
        res.setHeader('x-hh-model', `${selected.name}/${selected.model}`);
        res.setHeader('content-type', normalized.stream ? 'text/event-stream' : 'application/json');
        const result = await output(res, codec.events(upstream, selected.gateway.wire), wire, normalized);
        if (wire === 'responses') {
          const parts = result.state.blocks.map(b => b.type === 'call' ? { type: 'call', id: b.callId, name: b.name, args: b.args || '{}' } : { type: 'text', text: b.text });
          remember(result.id, { tools: body.tools, messages: normalized.messages.slice(body.instructions ? 1 : 0).concat([{ role: 'assistant', parts }]) });
        }
      }
      res.end();
    } catch (error) {
      const code = ac?.signal.aborted ? 'request_timeout' : error instanceof HHError ? error.code : 'router_error';
      const message = code === 'request_timeout' ? '请求超时或连接已关闭' : error instanceof HHError ? error.message : 'hh 模型转换失败';
      const status = error.status || ({ request_json: 400, unknown_model: 400, expired_response: 400, unsafe_continuation: 400, unsupported_protocol: 400, request_size: 413, compaction_size: 413, request_timeout: 504 }[code] || 502);
      if (!res.headersSent && !res.destroyed) json(res, status, errorBody(wire, code, message, status));
      else if (!res.destroyed) {
        if (String(res.getHeader('content-type')).includes('text/event-stream')) {
          const data = wire === 'responses' ? { type: 'error', code, message, param: null } : errorBody(wire, code, message);
          res.end(`${wire === 'chat' ? '' : 'event: error\n'}data: ${JSON.stringify(data)}\n\n`);
        } else res.destroy();
      }
    } finally { clearTimeout(timer); if (ac) { ac.abort(); active.delete(ac); } }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try { fs.mkdirSync(path.dirname(session.catalogPath), { recursive: true, mode: 0o700 }); writeJson(session.catalogPath, session.catalog, 0o600); } catch (e) { await new Promise(resolve => server.close(resolve)); try { fs.unlinkSync(session.catalogPath); } catch {} throw e; }
  return { ...session, url: `http://127.0.0.1:${server.address().port}`, token,
    close: () => { if (closePromise) return closePromise; closing = true; closePromise = (async () => { for (const controller of active) controller.abort(); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); cache.clear(); cacheBytes = 0; origins.clear(); originBytes = 0; try { fs.unlinkSync(session.catalogPath); } catch {} })(); return closePromise; },
  };
}
module.exports = { WIRES, route, plan, start, endpoint };
