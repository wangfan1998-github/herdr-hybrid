'use strict';
// Codex CLI 适配（实测 codex-cli 0.144.3）。与 Claude 的差异集中在这里：
//   无头      codex exec --json（不是 -p --output-format stream-json）
//   任务正文  stdin，但必须以位置参数 `-` 明示，否则 codex 等不到输入
//   会话 id   thread.started.thread_id（不是 session_id）
//   续跑      codex exec resume <ID>：子命令 + 位置参数，不是 --resume 这样的 flag
//   自主级别  -s read-only|workspace-write / --dangerously-bypass-approvals-and-sandbox
//   网关      -c model_providers.<n>.…（TOML 覆盖），不是 ANTHROPIC_* 环境变量
const { truncate, HHError } = require('../util');

// codex 的密钥不直接上命令行：命令行只出现「变量名」，值仍走 env。
// 正好符合「密钥永不进 stdout / transcript」——argv 会被打印，env 会被 maskEnv。
const SECRET_ENV = 'HH_CODEX_KEY';
const GATEWAY_NAME = 'hh'; // 注入的 provider 名，固定即可（每次 exec 都现算）
// 只有 hh 自己注入的密钥变量算「网关变量」，需要跨 agent 清理。
// OPENAI_API_KEY / CODEX_API_KEY 不在此列：official profile 的语义就是「用 codex 自己的登录 / 当前环境」，
// 把用户 export 的 key 清掉会让 official worker 直接没鉴权。
const ENV_KEYS = [SECRET_ENV];

// codex 不认 ANTHROPIC_*，网关信息通过 -c 传：base_url + env_key(变量名) + wire_api。
// wire_api 在 0.144.3 只剩 "responses"（"chat" 已被移除，见 openai/codex#7782），
// 所以只支持 chat-completions 的第三方网关接不进来——这是 codex 的限制，不是 hh 的。
function resolveGateway(gateway, secret, model) {
  const env = {};
  const args = [];
  if (gateway) {
    env[SECRET_ENV] = secret;
    args.push(
      '-c', `model_provider=${GATEWAY_NAME}`,
      '-c', `model_providers.${GATEWAY_NAME}.name=${GATEWAY_NAME}`,
      '-c', `model_providers.${GATEWAY_NAME}.base_url=${gateway.url}`,
      '-c', `model_providers.${GATEWAY_NAME}.env_key=${SECRET_ENV}`,
      '-c', `model_providers.${GATEWAY_NAME}.wire_api=responses`,
    );
  }
  if (model) args.push('-m', model);
  return { env, args };
}

// autonomy → 参数。resume 子命令的参数集跟 exec 不一样：它**不认 `-s`**（实测 0.144.3 直接
// Usage 报错退出 2），只认 --dangerously-bypass-approvals-and-sandbox 和 -c 覆盖。
// 所以续跑时把 read-only / workspace-write 用 -c sandbox_mode=… 表达（实测可用）。
function autonomyArgs(autonomy, resume) {
  if (autonomy === 'full') return ['--dangerously-bypass-approvals-and-sandbox'];
  const mode = autonomy === 'workspace' ? 'workspace-write' : 'read-only';
  return resume ? ['-c', `sandbox_mode=${mode}`] : ['-s', mode];
}

// ctx: { model, autonomy, resume, args }
// 注意顺序：`exec [resume <ID>]` 必须紧跟在 exec 之后。
// --skip-git-repo-check 是必需的：hh 的 probe 目录（profiles test）不是 git 仓库，
// 不加这个参数 codex 会直接拒绝启动。
// 末尾的 `-` 只在**非** resume 时加：resume 的第二个位置参数是 PROMPT，`-` 会被当成 prompt，
// 反而把后面的 flag 挤成位置参数导致解析失败；不加 `-` 时 resume 照样从 stdin 读（实测）。
function headlessArgv(ctx) {
  const a = ['exec'];
  if (ctx.resume) a.push('resume', ctx.resume);
  a.push('--json', '--skip-git-repo-check');
  a.push(...autonomyArgs(ctx.autonomy || 'full', !!ctx.resume));
  // resolveGateway 已经把 -c/-m 放进 ctx.args
  a.push(...(ctx.args || []));
  if (!ctx.resume) a.push('-');
  return a;
}

const ARG_SPEC = {
  aliases: { '-c': '--config', '-m': '--model', '-p': '--profile', '-s': '--sandbox', '-C': '--cd', '-a': '--ask-for-approval', '-i': '--image', '-o': '--output-last-message' },
  values: ['--config', '--model', '--profile', '--sandbox', '--cd', '--ask-for-approval', '--image', '--output-last-message', '--enable', '--disable', '--remote', '--remote-auth-token-env', '--local-provider', '--add-dir', '--thread-source', '--output-schema', '--color'],
};
function interactiveArgv(agentCfg, profileArgs, extra, opts) {
  const args = ((agentCfg && agentCfg.interactiveArgs) || []).concat(profileArgs || [], extra || []);
  // Root and exec own separate config overrides. Put the exec command first so
  // injected provider/catalog flags reach the command that performs requests.
  const positional = require('./argv').scan(args, ARG_SPEC).find(a => a.positional !== undefined);
  if (positional && ['exec', 'e'].includes(positional.positional)) {
    const index = positional.start;
    const root = []; const command = [];
    // TUI-only flags still belong to the root parser. Configuration and shared
    // flags belong to exec; moving a root-only flag would make exec reject it.
    const rootOnly = ['--no-alt-screen', '--search', '--ask-for-approval', '--remote', '--remote-auth-token-env'];
    for (const arg of require('./argv').scan(args.slice(0, index), ARG_SPEC)) {
      (rootOnly.includes(arg.key) ? root : command).push(...args.slice(arg.start, arg.end));
    }
    return [...root, args[index], ...command, ...args.slice(index + 1)];
  }
  return args;
}

function newState() {
  return { texts: [], rawLines: [], session_id: null, final: null, usage: null, is_error: false, error: null, sawJson: false };
}

function tryJson(line) {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try { return JSON.parse(t); } catch (e) { return null; }
}

function cmdText(item) {
  return truncate(String(item.command || '').replace(/^\/bin\/(ba)?sh\s+-lc\s+/, ''), 100);
}

function parseLine(line, st) {
  const ev = tryJson(line);
  if (!ev) { st.rawLines.push(line); return [{ kind: 'raw', text: line }]; }
  st.sawJson = true;
  const out = [];
  if (ev.type === 'thread.started') {
    st.session_id = ev.thread_id || st.session_id;
    out.push({ kind: 'info', text: `thread ${truncate(ev.thread_id || '?', 40)}` });
  } else if (ev.type === 'item.started' || ev.type === 'item.completed') {
    const it = ev.item || {};
    const done = ev.type === 'item.completed';
    if (it.type === 'agent_message') {
      if (done && it.text) { st.texts.push(it.text); out.push({ kind: 'text', text: it.text }); }
    } else if (it.type === 'command_execution') {
      if (!done) out.push({ kind: 'tool', text: `bash ${cmdText(it)}` });
      else if (it.exit_code) out.push({ kind: 'tool_result', text: `exit ${it.exit_code} ${truncate(it.aggregated_output || '', 200)}`, error: true });
    } else if (it.type === 'file_change') {
      if (done) out.push({ kind: 'tool', text: `edit ${(it.changes || []).map((c) => `${c.kind} ${c.path}`).join(', ').slice(0, 100)}` });
    } else if (it.type === 'error') {
      // codex 把「跳过 hook」「skill 描述被截断」这类提示也发成 item.error，它们不致命，
      // 后面照样 turn.completed。真正的失败信号是 turn.failed，所以这里降级成 note（· 而不是 ✗）、也不置 is_error。
      if (done) out.push({ kind: 'note', text: truncate(it.message || '', 200) });
    } else if (it.type === 'reasoning') {
      if (done && it.text) out.push({ kind: 'info', text: truncate(it.text, 120) });
    }
  } else if (ev.type === 'turn.completed') {
    const u = ev.usage || {};
    st.usage = { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cached_input_tokens: u.cached_input_tokens };
    out.push({ kind: 'result', text: 'completed' });
  } else if (ev.type === 'turn.failed') {
    st.is_error = true;
    st.error = truncate((ev.error && ev.error.message) || 'turn failed', 300);
    out.push({ kind: 'result', text: 'failed' });
  } else if (ev.type === 'error') {
    // 顶层 error（非 item 包裹）才是致命的，例如流断开
    st.is_error = true;
    st.error = truncate(ev.message || 'error', 300);
    out.push({ kind: 'error', text: st.error });
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
    case 'note': return `  ⚠ ${item.text}`; // 非致命提示：不用 ✗，免得看着像失败
    case 'result': return `  ■ ${item.text}`;
    case 'error': return `  ✗ ${item.text}`;
    default: return item.text;
  }
}

// codex 启动时常驻的 models cache / hook 噪音，对排障没用
const STDERR_NOISE = /codex_models_manager|failed to load models cache|failed to renew cache TTL|async hooks are not supported/;

// 登录体检：codex login status 输出一行人话（不是 JSON），靠退出码判定
//   exit 0 = "Logged in using ChatGPT" / API key；exit 1 = "Not logged in"（均实测 0.154.0）
function checkAuth(bin, spawnSync, stripAnsi) {
  try {
    const r = spawnSync(bin, ['login', 'status'], { encoding: 'utf8', timeout: 15000 });
    if (r.error) return { ok: null, detail: `无法检查: ${r.error.message}` };
    const line = stripAnsi(`${r.stdout || ''}${r.stderr || ''}`).trim().split('\n')[0] || '';
    if (r.status === 0) return { ok: true, detail: line || '已登录' };
    return { ok: false, detail: line || '未登录', hint: 'codex login' };
  } catch (e) { return { ok: null, detail: `无法检查: ${e.message}` }; }
}

// Native routing owns provider/model/config selection. Refuse overrides from every
// caller-supplied argv source before starting the session router.
const ROUTER_FEATURES = { multi_agent: true, multi_agent_v2: false, enable_request_compression: false, remote_compaction_v2: false };
function validateNativeArgs(args) {
  const reject = () => { throw new HHError('native_override', 'native 模式不能覆盖路由保留的 provider、model、catalog、agents 或 feature'); };
  for (const arg of require('./argv').scan(args, ARG_SPEC)) {
    if (['--profile', '--model', '--oss', '--local-provider', '--remote', '--remote-auth-token-env'].includes(arg.key)) reject();
    if (['--enable', '--disable'].includes(arg.key)) {
      if (Object.prototype.hasOwnProperty.call(ROUTER_FEATURES, arg.value) && ROUTER_FEATURES[arg.value] !== (arg.key === '--enable')) reject();
    }
    if (arg.key !== '--config') continue;
    // TOML dotted keys may be quoted. Normalize each segment before comparing,
    // including escaped double-quoted keys; malformed keys fail closed.
    const match = typeof arg.value === 'string' && arg.value.match(/^\s*((?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=([\s\S]*)$/);
    if (!match) reject();
    let keys;
    try { keys = match[1].match(/"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+/g).map(k => k[0] === '"' ? JSON.parse(k) : k[0] === "'" ? k.slice(1, -1) : k); } catch (_) { reject(); }
    if (['model', 'model_provider', 'model_providers', 'model_catalog_json', 'agents', 'profiles', 'profile', 'forced_login_method', 'forced_chatgpt_workspace_id', 'chatgpt_base_url'].includes(keys[0])) reject();
    if (keys[0] === 'features') {
      if (keys.length === 1) reject();
      if (Object.prototype.hasOwnProperty.call(ROUTER_FEATURES, keys[1]) && (keys.length !== 2 || match[2].trim() !== String(ROUTER_FEATURES[keys[1]]))) reject();
    }
  }
}

module.exports = {
  name: 'codex',
  label: 'Codex CLI',
  defaultBin: 'codex',
  defaultInteractiveArgs: [],
  envKeys: ENV_KEYS,
  modelEnvKeys: [],
  // Per-launch developer_instructions enables Leader without writing global config.
  capabilities: { leader: true, mod: false, mcp: true, native: true },
  stderrNoise: STDERR_NOISE,
  nativePath: '/v1',
  validateNativeArgs,
  nativeEnvKeys: ['OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID'],
  resolveGateway, leaderArgs: (prompt) => prompt ? ['-c', `developer_instructions=${JSON.stringify(prompt)}`] : [], checkAuth,
  nativeArgs: (plan) => ['-c', `model_catalog_json=${JSON.stringify(plan.catalogPath)}`, '-c', 'features.multi_agent=true', '-c', 'features.multi_agent_v2=false', '-c', 'features.enable_request_compression=false', '-c', 'features.remote_compaction_v2=false', '-c', 'web_search="disabled"', '-c', `agents.default_subagent_model=${JSON.stringify(plan.worker)}`, ...(plan.effort ? ['-c', `agents.default_subagent_reasoning_effort=${JSON.stringify(plan.effort)}`] : [])],
  headlessArgv, interactiveArgv, autonomyArgs, newState, parseLine, finalize, renderLine,
};
