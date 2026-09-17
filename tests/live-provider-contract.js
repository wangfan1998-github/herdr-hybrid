'use strict';
// Opt-in, real paid calls. No configuration, credentials, bodies or CLI transcripts are saved.
// node tests/live-provider-contract.js --live --primary-profile gemini --primary-model claude-sonnet-4-6 --worker-profile 0821 --failure-profile gemini --failure-model gemini-3.8-flash-high
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const options = {};
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i].replace(/^--/, '');
  if (['live', 'help', 'external', 'self-test'].includes(key)) options[key] = true;
  else if (['primary-profile', 'primary-model', 'worker-profile', 'worker-model', 'failure-profile', 'failure-model', 'agents', 'cases', 'timeout', 'subscription-profile', 'min-interval-ms'].includes(key) && process.argv[i + 1]) options[key] = process.argv[++i];
  else throw new Error('Unknown or incomplete option');
}
if (options['self-test']) { selfTest(); process.exit(0); }
if (!options.live || options.help) {
  console.log('Opt in with --live. Options: --primary-profile o50 --worker-profile gemini; optional --primary-model MODEL --worker-model MODEL --failure-profile PROFILE --failure-model MODEL; --agents claude,codex --cases native,fallback,external --subscription-profile codex --timeout 180 --min-interval-ms 0. --self-test runs evidence regression checks without config or network access. Timeout is capped at 180 seconds/case; 12 upstream calls/case, 1200 output tokens/request. Only sanitized evidence is printed.');
  process.exit(0);
}
const config = require('../lib/config');
const original = config.load(); // Credentials stay in process memory, never save this clone.
const timeout = Math.min(180000, Math.max(1000, Number(options.timeout || 180) * 1000));
if (!Number.isFinite(timeout)) throw new Error('Invalid timeout');
const minInterval = Math.min(10000, Math.max(0, Number(options['min-interval-ms'] || 0)));
if (!Number.isFinite(minInterval)) throw new Error('Invalid request interval');
const lastRequests = new Map();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-real-provider-'));
const previousLoad = config.load;
const previousState = config.STATE_DIR;
config.STATE_DIR = path.join(tmp, 'state');
let current;
config.load = () => current;
const api = require('../lib/api');
const native = require('../lib/native');
const fetchOriginal = global.fetch;
const http = require('node:http');
const createServerOriginal = http.createServer;
const children = new Set();
const sessions = new Set();
let calls = [];
let localCalls = [];
const requestContext = new AsyncLocalStorage();
const requestIds = new WeakMap();
let requestSequence = 0;
let results = [];
let cleaning;
const authHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const secrets = Object.values(original.gateways).map(g => g.secret?.startsWith('env:') ? process.env[g.secret.slice(4)] : g.secret).filter(Boolean);
function select(name, model) {
  const p = original.profiles[name];
  if (!p?.gateway || !original.gateways[p.gateway]) throw new Error('Selected profile needs a configured gateway');
  return { gateway: p.gateway, model: model || p.model };
}
function selector(p) { return `${p.gateway}/${p.model}`; }
global.fetch = async (url, init) => {
  if (calls.length >= 12) throw new Error('Live request budget exhausted');
  const body = JSON.parse(init.body);
  body.max_tokens = Math.min(body.max_tokens || 1200, 1200);
  const target = `${url}:${body.model}`;
  const scheduled = Math.max(Date.now(), (lastRequests.get(target) || 0) + minInterval);
  const delay = Math.max(0, scheduled - Date.now());
  lastRequests.set(target, scheduled);
  if (delay) await require('node:timers/promises').setTimeout(delay, undefined, { signal: init.signal });
  const call = { requestId: requestContext.getStore(), model: body.model, path: new URL(url).pathname, status: null };
  calls.push(call);
  try { const response = await fetchOriginal(url, { ...init, body: JSON.stringify(body) }); call.status = response.status; return response; }
  catch { call.status = 'network-error'; throw new Error('Upstream request failed'); }
};
http.createServer = (...args) => {
  const wrapped = args.map(arg => typeof arg !== 'function' ? arg : function (req, res) {
    const id = `request${++requestSequence}`; requestIds.set(req, id);
    return requestContext.run(id, () => arg(req, res));
  });
  const server = createServerOriginal(...wrapped);
  server.on('request', (req, res) => {
    const pathname = String(req.url || '').split('?')[0];
    res.once('finish', () => localCalls.push({ requestId: requestIds.get(req), path: pathname, status: res.statusCode }));
  });
  return server;
};
function kill(child, signal = 'SIGTERM') { try { process.kill(-child.pid, signal); } catch {} }
async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    for (const child of children) kill(child, 'SIGKILL');
    await Promise.allSettled([...sessions].map(s => s.close()));
    global.fetch = fetchOriginal; http.createServer = createServerOriginal; config.load = previousLoad; config.STATE_DIR = previousState;
    fs.rmSync(tmp, { recursive: true, force: true });
  })();
  return cleaning;
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup().finally(() => process.exit(130)); });
process.once('exit', () => { for (const child of children) kill(child, 'SIGKILL'); fs.rmSync(tmp, { recursive: true, force: true }); });
function evidence(agent, ev, proof) {
  proof.events[ev.type || 'unknown'] = (proof.events[ev.type || 'unknown'] || 0) + 1;
  // Structural evidence only: opaque IDs become stable per-case aliases, never text.
  const alias = id => {
    if (typeof id !== 'string' || !id) return undefined;
    if (!proof.aliases.has(id)) proof.aliases.set(id, `id${proof.aliases.size + 1}`);
    return proof.aliases.get(id);
  };
  const shape = (value, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 5) return undefined;
    if (Array.isArray(value)) return value.slice(0, 20).map(v => shape(v, depth + 1)).filter(Boolean);
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      if (/^(id|uuid|.*_id)$/.test(key)) out[key] = alias(val);
      else if (['type', 'subtype', 'status', 'stop_reason', 'tool', 'name'].includes(key) && typeof val === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(val)) out[key] = val;
      else if (['text', 'result', 'content', 'summary', 'output', 'message'].includes(key) && typeof val === 'string') out[`${key}MarkerPresent`] = val.includes(proof.marker);
      else if (key === 'receiver_thread_ids' && Array.isArray(val)) out[key] = val.map(alias);
      else if (key === 'agents_states' && val && typeof val === 'object') out[key] = Object.fromEntries(Object.entries(val).map(([id, state]) => [alias(id), shape(state, depth + 1)]));
      else if (['message', 'content', 'item', 'data', 'tool_use_result'].includes(key) && val && typeof val === 'object') out[key] = shape(val, depth + 1);
      else if (key === 'is_error') out.is_error = !!val;
    }
    return out;
  };
  const structure = shape(ev);
  if (proof.structures.length < 400 && (ev.type !== 'system' || !['status', 'thinking_tokens', 'background_tasks_changed'].includes(ev.subtype))) proof.structures.push(structure);
  if (['error', 'turn.failed'].includes(ev.type) || ev.item?.type === 'error' || ev.is_error || ev.error) {
    const message = [typeof ev.message === 'string' ? ev.message : '', ev.error?.message, typeof ev.error === 'string' ? ev.error : '', ev.item?.message, ev.result, ...(Array.isArray(ev.message?.content) ? ev.message.content.map(b => b.text) : []), ...(Array.isArray(ev.errors) ? ev.errors : [])].filter(v => typeof v === 'string').join('\n');
    for (const term of ['400', '401', '403', '404', '429', '502', '503', '504', 'catalog', 'No such file', 'Unauthorized', 'API key', 'connection', 'stream', 'authentication', 'request_json', 'unknown_model', 'unsupported_protocol', 'bad_effort', 'JSON', '模型不在本会话的配置范围内', '托管工具不能跨协议转换', '带语法约束的 custom 工具无法跨协议转换', '工具缺少名称', '暂不支持的 Responses 输入', '暂不支持的内容类型', '未声明支持所请求的 reasoning effort']) if (message.toLowerCase().includes(term.toLowerCase())) proof.errorClasses.add(term);
  }
  if (agent === 'claude') {
    for (const b of ev.message?.content || []) {
      if (!ev.parent_tool_use_id && b.type === 'tool_use' && /^(Agent|Task)$/.test(b.name)) { proof.delegated = true; proof.ids.add(b.id); }
      if (b.type === 'tool_result' && !b.is_error && proof.ids.has(b.tool_use_id) && JSON.stringify(b.content).includes(proof.marker)) {
        proof.returned = true; proof.returnEvidence.push({ source: 'tool_result', callId: alias(b.tool_use_id), markerPresent: true });
      }
      if (ev.type === 'assistant' && b.type === 'text' && proof.ids.has(ev.parent_tool_use_id) && String(b.text || '').includes(proof.marker)) proof.childMarkers.add(ev.parent_tool_use_id);
    }
    if (ev.type === 'system' && ev.subtype === 'task_started' && proof.ids.has(ev.tool_use_id)) proof.tasks.set(ev.task_id, ev.tool_use_id);
    if (ev.type === 'system' && ev.subtype === 'task_notification' && ev.status === 'completed' && proof.ids.has(ev.tool_use_id) && proof.tasks.get(ev.task_id) === ev.tool_use_id && proof.childMarkers.has(ev.tool_use_id) && String(ev.summary || '').includes(proof.marker)) {
      proof.returned = true; proof.returnEvidence.push({ source: 'task_notification', callId: alias(ev.tool_use_id), taskId: alias(ev.task_id), childMarkerPresent: true, summaryMarkerPresent: true });
    }
    if (ev.type === 'result' && !ev.parent_tool_use_id) { proof.final = String(ev.result || '').includes(proof.marker); proof.finalAfterReturn = proof.final && proof.returned; proof.cliError = !!ev.is_error; proof.cost = ev.total_cost_usd; }
  } else {
    const item = ev.item || {};
    if (item.type === 'collab_tool_call') {
      proof.collabTools.add(item.tool);
      if (item.tool === 'spawn_agent') {
        proof.delegated = true;
        if (ev.type === 'item.completed') for (const id of item.receiver_thread_ids || []) proof.childThreads.set(id, item.id);
      }
      if (ev.type === 'item.completed' && ['wait', 'wait_agent'].includes(item.tool)) for (const [id, state] of Object.entries(item.agents_states || {})) {
        if (proof.childThreads.has(id) && state.status === 'completed' && String(state.message || '').includes(proof.marker)) {
          proof.returned = true; proof.returnEvidence.push({ source: 'wait', spawnCallId: alias(proof.childThreads.get(id)), waitCallId: alias(item.id), childThreadId: alias(id), markerPresent: true });
        }
      }
    }
    if (ev.type === 'item.completed' && item.type === 'agent_message') { proof.final = String(item.text || '').includes(proof.marker); proof.finalAfterReturn = proof.final && proof.returned; }
    if (['turn.failed', 'error'].includes(ev.type)) proof.cliError = true;
  }
}
function newProof(marker) {
  return { marker, aliases: new Map(), structures: [], ids: new Set(), tasks: new Map(), childMarkers: new Set(), childThreads: new Map(), returnEvidence: [], collabTools: new Set(), errorClasses: new Set(), events: {}, delegated: false, returned: false, final: false, finalAfterReturn: false, cliError: false };
}
function fallbackWasObserved(attempts, failedModel, fallbackModel) {
  return attempts.some((call, index) => call.requestId && call.model === failedModel && [408, 429, 500, 502, 503, 504].includes(call.status) && attempts.slice(index + 1).some(next => next.requestId === call.requestId && next.model === fallbackModel && next.status === 200));
}
function selfTest() {
  const assert = require('node:assert/strict');
  const proof = newProof('TEST_MARKER');
  const emit = ev => evidence('claude', ev, proof);
  emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', id: 'call1', input: { prompt: 'TEST_MARKER' } }] } });
  emit({ type: 'system', subtype: 'task_started', task_id: 'task1', tool_use_id: 'call1' });
  emit({ type: 'assistant', parent_tool_use_id: 'call1', message: { content: [{ type: 'text', text: 'TEST_MARKER' }] } });
  assert.equal(proof.returned, false);
  emit({ type: 'system', subtype: 'task_notification', task_id: 'task1', tool_use_id: 'wrong', status: 'completed', summary: 'TEST_MARKER' });
  assert.equal(proof.returned, false);
  emit({ type: 'system', subtype: 'task_notification', task_id: 'task1', tool_use_id: 'call1', status: 'failed', summary: 'TEST_MARKER' });
  assert.equal(proof.returned, false);
  emit({ type: 'system', subtype: 'task_notification', task_id: 'task1', tool_use_id: 'call1', status: 'completed', summary: 'TEST_MARKER' });
  assert.equal(proof.returned, true);
  assert.equal(proof.final, false);
  emit({ type: 'result', parent_tool_use_id: 'call1', result: 'TEST_MARKER', is_error: false });
  assert.equal(proof.final, false);
  emit({ type: 'result', result: 'TEST_MARKER', is_error: false });
  assert.equal(proof.final, true);
  assert.equal(proof.finalAfterReturn, true);
  assert.equal(JSON.stringify(proof.structures).includes('TEST_MARKER'), false);
  assert.equal(JSON.stringify(proof.structures).includes('call1'), false);
  const cx = newProof('TEST_MARKER');
  evidence('codex', { type: 'item.completed', item: { type: 'collab_tool_call', tool: 'spawn_agent', id: 'spawn1', receiver_thread_ids: ['child1'] } }, cx);
  const completedWait = child => ({ type: 'item.completed', item: { type: 'collab_tool_call', tool: 'wait', id: 'wait1', agents_states: { [child]: { status: 'completed', message: 'TEST_MARKER' } } } });
  evidence('codex', completedWait('wrong'), cx); assert.equal(cx.returned, false);
  evidence('codex', { type: 'item.completed', item: { type: 'collab_tool_call', tool: 'wait', id: 'wait1', agents_states: { child1: { status: 'errored', message: 'TEST_MARKER' } } } }, cx);
  assert.equal(cx.returned, false);
  evidence('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'TEST_MARKER' } }, cx);
  assert.equal(cx.finalAfterReturn, false);
  evidence('codex', completedWait('child1'), cx); assert.equal(cx.returned, true);
  assert.equal(cx.finalAfterReturn, false);
  evidence('codex', { type: 'item.completed', item: { type: 'agent_message', text: 'TEST_MARKER' } }, cx);
  assert.equal(cx.finalAfterReturn, true);
  evidence('codex', { type: 'error', uuid: 'opaque404', message: 'HTTP 429' }, cx);
  assert.equal(cx.errorClasses.has('429'), true);
  assert.equal(cx.errorClasses.has('404'), false);
  const attempts = [{ requestId: 'r1', model: 'bad', status: 429 }, { requestId: 'r2', model: 'good', status: 200 }];
  assert.equal(fallbackWasObserved(attempts, 'bad', 'good'), false);
  attempts[1].requestId = 'r1'; assert.equal(fallbackWasObserved(attempts, 'bad', 'good'), true);
  console.log('PASS linked async child completion, parent-only final marker, same-request fallback; negative controls reject wrong IDs and failed completion');
}
async function execute(agent, plan, prompt, isNative, marker, subscription) {
  const dir = fs.mkdtempSync(path.join(tmp, `${agent}-`));
  const home = path.join(dir, 'home'); fs.mkdirSync(home);
  const codexHome = path.join(home, '.codex'); fs.mkdirSync(codexHome);
  if (subscription && fs.existsSync(path.join(authHome, 'auth.json'))) fs.symlinkSync(path.join(authHome, 'auth.json'), path.join(codexHome, 'auth.json'));
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: dir, LANG: 'en_US.UTF-8', CODEX_HOME: codexHome, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', API_TIMEOUT_MS: '45000', CLAUDE_CODE_MAX_RETRIES: '0' };
  for (const [key, value] of Object.entries(plan.env)) if (/^(ANTHROPIC_|HH_CODEX_KEY$)/.test(key)) env[key] = value;
  if (isNative) for (const value of Object.values(env)) if (secrets.includes(value)) throw new Error('Credential isolation failed');
  const argv = [...plan.argv];
  const pluginIndex = argv.indexOf('--plugin-dir'); if (pluginIndex !== -1) argv.splice(pluginIndex, 2);
  if (agent === 'claude') argv.push('-p', prompt, '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--max-turns', '5', '--max-budget-usd', '0.60', '--tools', isNative ? 'Agent' : '', '--allowedTools', 'Agent', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--settings', '{"disableAllHooks":true}', '--setting-sources', '');
  else { argv.unshift('exec'); argv.push('--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only', '-c', 'features.enable_request_compression=false', '-c', 'features.shell_tool=false', '-c', 'features.apps=false', '-c', 'web_search="disabled"', prompt); }
  const proof = newProof(marker);
  const bin = plan.resolved.bin;
  return new Promise(resolve => {
    const child = spawn(bin, argv, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }); children.add(child);
    let buffer = ''; let stderrBytes = 0; const stderrClasses = new Set(); let timedOut = false;
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let at; while ((at = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, at); buffer = buffer.slice(at + 1); try { evidence(agent, JSON.parse(line), proof); } catch {} }
      if (buffer.length > 1024 * 1024) buffer = '';
    });
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; for (const label of ['unauthorized', 'rate limit', 'MCP', 'invalid', 'timeout', 'error']) if (chunk.toString().toLowerCase().includes(label.toLowerCase())) stderrClasses.add(label); });
    const timer = setTimeout(() => { timedOut = true; kill(child, 'SIGKILL'); }, timeout);
    const finish = code => { clearTimeout(timer); kill(child, 'SIGKILL'); children.delete(child); resolve({ code, timedOut, delegated: proof.delegated, returned: proof.returned, returnEvidence: proof.returnEvidence, final: proof.final, finalAfterReturn: proof.finalAfterReturn, cliError: proof.cliError, events: proof.events, structures: proof.structures, collabTools: [...proof.collabTools], errorClasses: [...proof.errorClasses], cost: proof.cost, stderrBytes, stderrClasses: [...stderrClasses] }); };
    child.once('error', () => finish(-1)); child.once('close', finish);
  });
}
async function runCase(agent, kind) {
  calls = []; localCalls = []; requestSequence = 0;
  current = structuredClone(original); current.viewer = 'none'; current.commonEnv = {}; current.claude.interactiveArgs = []; current.codex.interactiveArgs = [];
  const main = select(options['primary-profile'] || 'o50', options['primary-model']);
  const worker = select(kind === 'fallback' ? options['failure-profile'] || 'gemini' : options['worker-profile'] || 'gemini', kind === 'fallback' ? options['failure-model'] : options['worker-model']);
  for (const gateway of Object.values(current.gateways)) { gateway.wire = 'anthropic'; gateway.maxOutputTokens = 1200; }
  const marker = `HH_VERIFIED_${crypto.randomBytes(8).toString('hex')}`;
  let session; let result;
  try {
    const external = kind === 'external';
    const subscription = external && agent === 'codex';
    current.profiles.contract = external ? (subscription ? { ...original.profiles[options['subscription-profile'] || 'codex'], agent, args: [], env: {}, orchestration: { mode: 'plain' } } : { ...select(options['worker-profile'] || '0821', options['worker-model']), agent }) : { ...main, agent, orchestration: { mode: 'native', workerModel: selector(worker), fallback: kind === 'fallback' ? [selector(main)] : [], models: [] } };
    if (!external) { session = await native.start(current, 'contract', undefined, { timeoutMs: 45000 }); sessions.add(session); }
    const plan = api.launchPlan('contract', [], { mode: external ? 'plain' : 'native', nativeRuntime: session, herdr: false });
    const prompt = external ? `Reply exactly ${marker}. Do not use tools.` : `This is a tiny delegation contract. You MUST use ${agent === 'claude' ? 'Agent with subagent_type hh-worker, run_in_background false (omit model)' : `spawn_agent with model ${session.worker}, fork_turns none and a complete message`} exactly once. Ask the child to reply exactly ${marker}. ${agent === 'claude' ? 'If launched asynchronously, wait for the task completion notification before your final answer.' : 'Use wait to receive the completed child result before your final answer.'} Do not use unrelated tools or read files. Output only the completed child's exact answer. Never invent the answer if delegation fails.`;
    result = await execute(agent, plan, prompt, !external, marker, subscription);
    const successful = model => calls.some(c => c.model === model && c.path.endsWith('/messages') && c.status === 200);
    const fallbackObserved = fallbackWasObserved(calls, worker.model, main.model);
    result.ok = result.code === 0 && !result.cliError && result.final && (external || (result.delegated && result.returned && result.finalAfterReturn && successful(main.model) && (kind === 'fallback' ? fallbackObserved : successful(worker.model))));
    result.fallbackObserved = kind === 'fallback' ? fallbackObserved : undefined;
  } catch (error) { result = { ok: false, error: 'Case setup/execution failed; raw error suppressed', errorCode: /^[a-z_]{1,50}$/.test(error.code || '') ? error.code : undefined }; }
  finally { if (session) { await session.close(); sessions.delete(session); } }
  const summary = { agent, kind, ...result, calls, localCalls }; results.push(summary); console.log(JSON.stringify(summary));
}
(async () => {
  try {
    const agents = (options.agents || 'claude,codex').split(',');
    if (agents.some(a => !['claude', 'codex'].includes(a))) throw new Error('Unsupported agent');
    const cases = (options.cases || (options['failure-profile'] ? 'native,fallback' : 'native')).split(',');
    if (cases.some(c => !['native', 'fallback', 'external'].includes(c))) throw new Error('Unsupported case');
    for (const agent of agents) for (const kind of cases) await runCase(agent, kind);
    if (options.external) for (const agent of agents) await runCase(agent, 'external');
    process.exitCode = results.every(r => r.ok) ? 0 : 1;
  } finally { await cleanup(); }
})().catch(() => { console.error('Contract aborted; raw error suppressed'); process.exitCode = 1; });
