'use strict';
// hh mcp：MCP stdio server（JSON-RPC 2.0，按行分隔）。让 Claude Code 把 dispatch / wait / read / send 当成原生工具调用。零依赖实现。
const api = require('./api');

const PROTOCOL = '2025-06-18';

const POLICY_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  mode: { type: 'string', enum: ['external', 'native', 'plain'] },
  workerModel: { type: 'string' }, models: { type: 'array', maxItems: 4, items: { type: 'string' } },
  fallback: { type: 'array', maxItems: 4, items: { type: 'string' } },
  prompt: { type: 'string', maxLength: 16000 }, effort: { type: 'string', enum: ['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
} };
const TOOLS = [
  { name: 'hh_policy', description: '读取 profile 的会话编排策略；不启动路由服务。', inputSchema: { type: 'object', additionalProperties: false, properties: { profile: { type: 'string' } }, required: ['profile'] } },
  { name: 'hh_policy_set', description: '原子更新会话编排策略；校验后保存，仅影响新会话。', inputSchema: { type: 'object', additionalProperties: false, properties: { profile: { type: 'string' }, changes: POLICY_SCHEMA }, required: ['profile', 'changes'] } },
  { name: 'hh_native_plan', description: '离线检查原生委派路由计划，不启动 Agent 或 HTTP 服务。', inputSchema: { type: 'object', additionalProperties: false, properties: { profile: { type: 'string' } }, required: ['profile'] } },
  {
    name: 'hh_dispatch',
    description: '派发一个子任务给某个角色（role）的 worker：在指定目录用该角色绑定的 profile（agent + 网关 + 模型）无头启动一个 agent（Claude Code 或 Codex）执行任务。立即返回 run id；之后用 hh_wait 等待、hh_result 取结论。',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '角色名，如 coder / executor / reviewer / researcher（hh_roles 查看）' },
        profile: { type: 'string', description: '直接指定 profile（可代替 role，与 role 同时给时改用该 profile 及其模型）' },
        task: { type: 'string', description: '任务全文：目标、参考文件、约束、验收命令。多行 Markdown' },
        cwd: { type: 'string', description: 'worker 的工作目录（绝对路径）' },
        label: { type: 'string', description: '短标签，用于 run id 和看板' },
        model: { type: 'string', description: '覆盖模型 id' },
        autonomy: { type: 'string', enum: ['full', 'workspace', 'readonly'], description: '覆盖自主级别' },
        view: { type: 'string', enum: ['auto', 'herdr', 'none'], description: '是否开 herdr 观察 tab' },
        timeout: { type: 'number', description: 'worker 时限（分钟，0 = 不限；默认看配置 limits）' },
      },
      required: ['task', 'cwd'],
    },
  },
  {
    name: 'hh_wait',
    description: '阻塞等待一个或多个 run 结束（done/failed/cancelled/crashed）。超时返回 settled=false，可再次调用。attention 列出需要处理的 run（blocked / 有问题 / 没交报告 / 验收失败）。',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' }, description: 'run id 列表（支持 label 或 id 前缀）' }, timeout: { type: 'number', description: '秒，默认 240，上限 300' } }, required: ['ids'] },
  },
  { name: 'hh_status', description: '列出 run：默认进行中的 + 最近 10 个已结束的。', inputSchema: { type: 'object', properties: { all: { type: 'boolean' }, limit: { type: 'number' } } } },
  { name: 'hh_read', description: '读某个 run 的最近 N 行 transcript（worker 说了什么、调了什么工具、stderr 尾部）。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, lines: { type: 'number', description: '默认 60' }, raw: { type: 'boolean', description: '原始事件 JSONL' } }, required: ['id'] } },
  { name: 'hh_result', description: '取 run 的最终结论（final）、状态、session_id、用量。', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'hh_send', description: '给已结束的 run 追加指令（返修 / 回答 worker 的问题）：恢复同一会话继续干，返回新的 run id。decision 非空时顺手记一条 Leader 的决定。', inputSchema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, decision: { type: 'string', description: '问题 → 结论：依据（记入 hh decisions）' }, timeout: { type: 'number', description: '时限（分钟）；默认沿用原任务' } }, required: ['id', 'text'] } },
  { name: 'hh_decide', description: '记一条 Leader 的决定，或上报给用户的问题（escalated=true），供用户事后抽查。', inputSchema: { type: 'object', properties: { text: { type: 'string' }, run: { type: 'string' }, escalated: { type: 'boolean' } }, required: ['text'] } },
  { name: 'hh_decisions', description: '列出最近的决定记录。', inputSchema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'hh_cancel', description: '终止一个进行中的 run。', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'hh_roles', description: '角色 → profile / agent / 网关 / 模型 / 自主级别 / 模板。', inputSchema: { type: 'object', properties: {} } },
  { name: 'hh_profiles', description: '已配置的 profile（agent + 网关 + 模型），密钥打码。', inputSchema: { type: 'object', properties: {} } },
  { name: 'hh_doctor', description: '体检：claude / codex、网关、profile、角色、技能、MCP、herdr。', inputSchema: { type: 'object', properties: {} } },
];

// Enforce the advertised subset of JSON Schema; clients cannot bypass validation.
function validateInput(value, schema, field = 'arguments') {
  const invalid = () => { throw Object.assign(new Error(`无效参数: ${field}`), { code: -32602 }); };
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
    for (const key of schema.required || []) if (value[key] === undefined) invalid();
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) invalid();
      validateInput(value[key], schema.properties[key], `${field}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || (schema.maxItems !== undefined && value.length > schema.maxItems)) invalid();
    value.forEach(v => validateInput(v, schema.items, field));
  } else if (typeof value !== schema.type || (schema.type === 'number' && !Number.isFinite(value))) invalid();
  if (schema.enum && !schema.enum.includes(value)) invalid();
  if (schema.maxLength !== undefined && value.length > schema.maxLength) invalid();
}

async function callTool(name, a) {
  a = a === undefined ? {} : a;
  const tool = TOOLS.find(t => t.name === name);
  if (tool) validateInput(a, tool.inputSchema);
  switch (name) {
    case 'hh_policy': { const p = api.profilesShow(a.profile).profile; return { profile: p.name, orchestration: p.orchestration }; }
    case 'hh_policy_set': return api.modeSet(a.profile, a.changes);
    case 'hh_native_plan': return api.nativePlan(a.profile);
    case 'hh_dispatch': return api.dispatch({ role: a.role, profile: a.profile, task: a.task, cwd: a.cwd, label: a.label, model: a.model, autonomy: a.autonomy, view: a.view, timeout: a.timeout });
    case 'hh_wait': return api.wait(a.ids || [], { timeout: Math.min(Number(a.timeout) || 240, 300), interval: 3 });
    case 'hh_status': return api.status({ all: !!a.all, limit: a.limit });
    case 'hh_read': return api.read(a.id, { lines: a.lines, raw: !!a.raw });
    case 'hh_result': return api.result(a.id);
    case 'hh_send': return api.send(a.id, a.text, { decision: a.decision, timeout: a.timeout });
    case 'hh_decide': return api.decide(a.text, { run: a.run, escalated: !!a.escalated });
    case 'hh_decisions': return api.decisions(a.limit);
    case 'hh_cancel': return api.cancel(a.id);
    case 'hh_roles': return api.roles();
    case 'hh_profiles': return api.profiles();
    case 'hh_doctor': return api.doctor();
    default: throw Object.assign(new Error(`未知工具: ${name}`), { code: -32602 });
  }
}

function send(msg) { process.stdout.write(`${JSON.stringify(msg)}\n`); }

async function handle(req) {
  const id = req.id;
  const reply = (result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };
  const fail = (code, message, data) => { if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code, message, data } }); };
  try {
    switch (req.method) {
      case 'initialize':
        return reply({
          protocolVersion: (req.params && req.params.protocolVersion) || PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'herdr-hybrid', version: api.version },
          instructions: 'hh_dispatch → hh_wait → hh_result/hh_read → 自己验收 → hh_send 返修。Leader 只拆解、派发、验收、review。',
        });
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return;
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const p = req.params || {};
        try {
          const out = await callTool(p.name, p.arguments);
          return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out });
        } catch (e) {
          if (e.code === -32602) return fail(-32602, e.message);
          return reply({ content: [{ type: 'text', text: JSON.stringify({ error: { code: e.code || 'error', message: e.message } }) }], isError: true });
        }
      }
      default:
        return fail(-32601, `Method not found: ${req.method}`);
    }
  } catch (e) {
    return fail(-32603, e.message);
  }
}

function serve() {
  let buf = '';
  let pending = 0;
  let ended = false;
  const maybeExit = () => { if (ended && pending === 0) process.exit(0); };
  const run = (req) => { pending++; handle(req).catch(() => {}).finally(() => { pending--; maybeExit(); }); };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let req;
      try { req = JSON.parse(line); } catch (e) { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
      if (Array.isArray(req)) req.forEach(run); else run(req);
    }
  });
  process.stdin.on('end', () => { ended = true; maybeExit(); });
}

module.exports = { serve, TOOLS, callTool };
