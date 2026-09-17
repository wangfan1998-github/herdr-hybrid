'use strict';
// Claude Code 适配：无头命令（claude -p --output-format stream-json）、事件流解析、交互式启动参数。
const { truncate, HHError } = require('../util');

const MODEL_ENV_KEYS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];
const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].concat(MODEL_ENV_KEYS);

// Claude 的网关全靠环境变量：地址、密钥、模型都是 env，命令行上不出现。
function resolveGateway(gateway, secret, model) {
  const env = {};
  if (gateway) {
    env.ANTHROPIC_BASE_URL = gateway.url;
    if (gateway.auth === 'apikey') env.ANTHROPIC_API_KEY = secret; else env.ANTHROPIC_AUTH_TOKEN = secret;
  }
  if (model) for (const k of MODEL_ENV_KEYS) env[k] = model;
  return { env, args: [] };
}

// stderr 常驻噪音：非 Anthropic 模型名一律触发的 unrecognized_model、设了网关后 connectors 被关的提示。
const STDERR_NOISE = /\[claude-code:unrecognized_model\]|connectors are disabled because ANTHROPIC_API_KEY/;

const INPUT_KEYS = ['command', 'file_path', 'path', 'pattern', 'query', 'url', 'description', 'prompt', 'notebook_path'];
function summarizeInput(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of INPUT_KEYS) if (input[k]) return truncate(String(input[k]), 100);
  return truncate(JSON.stringify(input), 100);
}

function autonomyArgs(autonomy) {
  if (autonomy === 'full') return ['--permission-mode', 'bypassPermissions'];
  if (autonomy === 'workspace') return ['--permission-mode', 'acceptEdits'];
  return ['--permission-mode', 'default', '--allowedTools', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git status:*)'];
}

// ctx: { model, autonomy, resume, args }
function headlessArgv(ctx) {
  const a = ['-p', '--output-format', 'stream-json', '--verbose'].concat(autonomyArgs(ctx.autonomy || 'full'));
  if (ctx.model) a.push('--model', ctx.model);
  if (ctx.resume) a.push('--resume', ctx.resume);
  a.push(...(ctx.args || []));
  return a;
}

// 交互式：hh claude <profile> [args…]
// mod：hh 自带的可视化配置界面（mod/），用 --plugin-dir 挂进去，Leader 里 /hh-config 就能开。
// 只在 Leader 模式挂：普通 `hh claude <profile>` 是「就想用这个模型」，不该被塞私货。
function interactiveArgv(agentCfg, profileArgs, extra, opts) {
  opts = opts || {};
  const pre = [];
  if (opts.mod) pre.push('--plugin-dir', opts.mod);
  return ((agentCfg && agentCfg.interactiveArgs) || []).concat(pre, profileArgs || [], extra || []);
}

// Leader 协议注入：Claude 有原生的 --append-system-prompt
function leaderArgs(prompt) {
  return prompt ? ['--append-system-prompt', prompt] : [];
}

function newState() {
  return { texts: [], rawLines: [], session_id: null, final: null, usage: null, is_error: false, error: null, sawJson: false };
}

function tryJson(line) {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch (e) { return null; }
}

function parseLine(line, st) {
  const ev = tryJson(line);
  if (!ev) { st.rawLines.push(line); return [{ kind: 'raw', text: line }]; }
  st.sawJson = true;
  const out = [];
  if (ev.type === 'system' && ev.subtype === 'init') {
    st.session_id = ev.session_id || st.session_id;
    out.push({ kind: 'info', text: `init model=${ev.model || '?'} mode=${ev.permissionMode || '?'}` });
  } else if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c.type === 'text' && c.text) { st.texts.push(c.text); out.push({ kind: 'text', text: c.text }); }
      else if (c.type === 'tool_use') out.push({ kind: 'tool', text: `${c.name} ${summarizeInput(c.input)}` });
    }
  } else if (ev.type === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const c of ev.message.content) {
      if (c.type !== 'tool_result' || !c.is_error) continue;
      const t = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x) => x.text || '').join(' ') : '';
      out.push({ kind: 'tool_result', text: truncate(t, 200), error: true });
    }
  } else if (ev.type === 'result') {
    st.session_id = ev.session_id || st.session_id;
    st.is_error = !!ev.is_error;
    if (typeof ev.result === 'string' && ev.result) st.final = ev.result;
    st.usage = {
      cost_usd: ev.total_cost_usd, turns: ev.num_turns, duration_ms: ev.duration_ms,
      input_tokens: ev.usage && ev.usage.input_tokens, output_tokens: ev.usage && ev.usage.output_tokens,
    };
    if (ev.subtype && ev.subtype !== 'success') st.error = ev.subtype + (ev.result ? `: ${truncate(ev.result, 300)}` : '');
    out.push({ kind: 'result', text: ev.subtype || 'result' });
  }
  return out;
}

function finalize(st) {
  const final = st.final || st.texts[st.texts.length - 1] || (!st.sawJson ? st.rawLines.join('\n').trim() : '');
  return { final, session_id: st.session_id, usage: st.usage, is_error: st.is_error, error: st.error };
}

function renderLine(item) {
  switch (item.kind) {
    case 'text': return item.text.split('\n').map((l, i) => (i === 0 ? `⏺ ${l}` : `  ${l}`)).join('\n');
    case 'tool': return `  ⚙ ${item.text}`;
    case 'tool_result': return `  ↳ ${item.error ? '✗ ' : ''}${item.text}`;
    case 'info': return `  · ${item.text}`;
    case 'result': return `  ■ ${item.text}`;
    case 'error': return `  ✗ ${item.text}`;
    default: return item.text;
  }
}

// 登录体检：claude auth status 输出 JSON
// 返回 { ok: true|false|null, detail }；null = 查不了（没装 / 超时 / 输出变了），doctor 里显示成提示而不是失败
function checkAuth(bin, spawnSync, stripAnsi) {
  try {
    const r = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 15000 });
    const j = JSON.parse(stripAnsi(r.stdout || '{}'));
    return { ok: !!j.loggedIn, detail: j.loggedIn ? `已登录 (${j.authMethod || '?'}${j.apiProvider ? `, ${j.apiProvider}` : ''})` : '未登录', hint: 'claude /login' };
  } catch (e) { return { ok: null, detail: `无法检查: ${e.message}` }; }
}

function validateNativePolicy(policy) {
  if (policy.effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(policy.effort)) throw new HHError('bad_effort', 'Claude 原生委派 effort 仅支持 low|medium|high|xhigh|max');
}
const ARG_SPEC = {
  aliases: { '-p': '--print', '-n': '--name', '-r': '--resume', '-d': '--debug', '-w': '--worktree' },
  values: ['--settings', '--setting-sources', '--model', '--agents', '--agent', '--fallback-model', '--betas', '--tools', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--mcp-config', '--plugin-dir', '--plugin-url', '--system-prompt', '--append-system-prompt', '--system-prompt-file', '--append-system-prompt-file', '--output-format', '--input-format', '--json-schema', '--permission-mode', '--permission-prompts', '--max-turns', '--max-budget-usd', '--effort', '--add-dir', '--file', '--session-id', '--name', '--debug-file', '--autocompact', '--system-prompt-snapshot', '--environment', '--remote-control-session-name-prefix'],
  optional: ['--resume', '--debug', '--worktree', '--cloud', '--from-pr', '--prompt-suggestions', '--remote-control', '--teleport', '--tmux'],
  variadic: ['--tools', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--mcp-config', '--add-dir', '--file', '--betas'],
};
function validateNativeArgs(args) {
  const reject = () => { throw new HHError('native_override', 'native 模式不能覆盖网关、模型、认证或 Agent；settings 仅接受安全的隔离 JSON'); };
  for (const arg of require('./argv').scan(args, ARG_SPEC)) {
    if (['--model', '--agents', '--agent', '--fallback-model', '--betas'].includes(arg.key)) reject();
    if (arg.key === '--setting-sources' && arg.value !== '') reject();
    if (arg.key === '--settings') {
      let settings;
      try { settings = JSON.parse(arg.value); } catch (_) { reject(); }
      // Inline isolation options only: settings files could change between
      // validation and spawn; unknown fields may introduce new routing knobs.
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) reject();
      for (const [key, value] of Object.entries(settings)) {
        if (key === 'disableAllHooks' && typeof value === 'boolean') continue;
        reject();
      }
    }
  }
}

module.exports = {
  name: 'claude',
  label: 'Claude Code',
  defaultBin: 'claude',
  defaultInteractiveArgs: ['--dangerously-skip-permissions'],
  envKeys: ENV_KEYS,
  modelEnvKeys: MODEL_ENV_KEYS,
  capabilities: { leader: true, mod: true, mcp: true, native: true },
  stderrNoise: STDERR_NOISE,
  resolveGateway, leaderArgs, checkAuth,
  nativePath: '',
  validateNativeArgs, validateNativePolicy,
  nativeEnvKeys: ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'CLAUDE_CODE_SKIP_BEDROCK_AUTH', 'CLAUDE_CODE_SKIP_VERTEX_AUTH', 'CLAUDE_CODE_SKIP_FOUNDRY_AUTH'],
  nativeArgs: (plan) => {
    if (plan.effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(plan.effort)) throw new HHError('bad_effort', 'Claude 原生委派 effort 仅支持 low|medium|high|xhigh|max');
    return ['--agents', JSON.stringify(Object.fromEntries(plan.roster.map(r => [r.name, {
    description: `执行独立任务，模型 ${r.model}。使用此 subagent_type，model 参数省略或 haiku 占位。`,
    prompt: `完成主 Agent 指定的独立任务，遵守文件边界并报告验证结果。\n<!-- hh-route: ${r.model} -->${plan.effort ? `\n<!-- hh-effort: ${plan.effort} -->` : ''}`,
    model: 'haiku',
    }])))];
  },
  headlessArgv, interactiveArgv, autonomyArgs, newState, parseLine, finalize, renderLine,
};
