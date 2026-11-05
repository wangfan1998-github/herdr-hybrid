'use strict';
// 统一的操作层：CLI 和 MCP 都调这里，返回纯对象。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { HHError, readText, which, shortHome, maskEnv, mask, expandHome, truncate, stripAnsi } = require('./util');
const config = require('./config');
const agents = require('./agents');
const runs = require('./runs');
const herdr = require('./herdr');

const PKG = require('../package.json');

function cfg() { return config.load(); }

// ---------- runs ----------
function dispatch(opts) { return { run: runs.createRun(cfg(), opts) }; }

function dryRun(opts) {
  const c = cfg();
  let r = null;
  if (opts.role) r = config.resolveRole(c, opts.role);
  const profileName = opts.profile || (r && r.profileName);
  if (!profileName) throw new HHError('need_role', '需要 -r ROLE 或 -p PROFILE');
  const resolved = config.resolveProfile(c, profileName, opts.model || (opts.profile ? '' : (r && r.model) || ''));
  const autonomy = opts.autonomy || (r && r.autonomy) || 'full';
  const argv = resolved.agent.headlessArgv({ model: resolved.model, autonomy, resume: opts.resume || null, args: resolved.args });
  return {
    profile: profileName, agent: resolved.agentName, gateway: resolved.gatewayName, model: resolved.model, autonomy, cwd: path.resolve(expandHome(opts.cwd || process.cwd())),
    bin: resolved.bin, bin_path: which(resolved.bin), argv, env: maskEnv(resolved.env), unset: resolved.unset, template: r ? shortHome(r.template || '') : null,
  };
}

async function wait(ids, opts) { return runs.waitRuns(ids.map(runs.resolveId), opts); }
function status(opts) { return { runs: runs.listRuns(opts) }; }
function read(ref, opts) { const id = runs.resolveId(ref); return { id, status: runs.summary(id).status, lines: runs.readOutput(id, opts) }; }
function result(ref) { return { run: runs.summary(runs.resolveId(ref), { full: true }) }; }
function task(ref) { const id = runs.resolveId(ref); return { id, task: readText(path.join(runs.runDir(id), 'task.md')) }; }
function send(ref, text, opts) {
  opts = opts || {};
  const id = runs.resolveId(ref);
  if (!text || !text.trim()) throw new HHError('need_text', '需要追加指令文本');
  const c = cfg();
  const run = runs.sendFollowup(c, id, text, opts);
  const out = { run };
  if (opts.decision && String(opts.decision).trim()) out.decision = runs.recordDecision(c, { run: id, followup: run.id, text: String(opts.decision).trim() });
  return out;
}
// Leader 替用户做的决定 / 上报给用户的问题，留痕供用户事后抽查
function decide(text, opts) {
  opts = opts || {};
  if (!text || !String(text).trim()) throw new HHError('need_text', '需要决定内容：问题 → 结论：依据');
  return { decision: runs.recordDecision(config.load({ optional: true }), { run: opts.run ? runs.resolveId(opts.run) : null, text: String(text).trim(), escalated: !!opts.escalated }) };
}
function decisions(n) { return { decisions: runs.listDecisions(n) }; }
async function cancel(ref) { return { run: await runs.cancelRun(runs.resolveId(ref)) }; }
async function closeWith(id, opts) {
  opts = opts || {};
  const s = runs.status(id);
  if (!runs.SETTLED.has(s.status) && opts.force) await runs.cancelRun(id);
  return runs.closeRun(cfg(), id, opts);
}
function close(ref, opts) { return closeWith(runs.resolveId(ref), opts); }
function view(ref) {
  const id = runs.resolveId(ref);
  if (!herdr.available()) throw new HHError('herdr', 'herdr 未安装或未运行，无法开观察窗口；用 hh read 看输出');
  const meta = runs.readMeta(id);
  return { id, tab: herdr.openViewer(cfg(), meta, path.join(runs.runDir(id), 'output.log')) };
}
function log(n) { return { events: runs.recentEvents(n) }; }
function clean(opts) { return { removed: runs.cleanRuns(opts) }; }

// ---------- 交互式启动：hh claude [--leader] [profile] [args] ----------
const SKILL_SRC = path.join(config.ROOT, 'skill', 'herdr-leader', 'SKILL.md');
// Leader 模式：把「实时环境 + 协议」整段塞进 system prompt。协议只讲原则和原语；角色、profile 是从配置里现读的数据，
// Leader 按角色描述自己判断派给谁——不靠关键词，也不靠对照表。
function leaderPrompt(profileName) {
  const c = cfg();
  const body = readText(SKILL_SRC, '').replace(/^---[\s\S]*?---\s*/, '').trim();
  const resolved = config.resolveProfile(c, profileName, '');
  const roster = Object.entries(c.roles).map(([name, r]) => {
    const p = c.profiles[r.profile] || {};
    const ag = p.agent && p.agent !== agents.DEFAULT ? ` [${p.agent}]` : '';
    return `  ${name.padEnd(11)} → ${r.profile}${ag}${p.gateway ? ` @ ${p.gateway}` : ' (official)'}${(r.model || p.model) ? ` (${r.model || p.model})` : ''} · ${r.autonomy || 'full'} · ${r.desc || '（无描述）'}`;
  });
  const profileNames = Object.keys(c.profiles);
  const mcpOn = resolved.agentName === agents.DEFAULT && fs.existsSync(CLAUDE_JSON) && /"hh"\s*:/.test(readText(CLAUDE_JSON, ''));
  // /hh-config 只在支持插件的 agent（Claude Code）+ mod 到位 + function hooks 开着时才存在。
  // 明确告诉 Leader，别让它向用户推荐一个不会出现的斜杠命令。
  const panelOn = resolved.agent.capabilities.mod
    && fs.existsSync(path.join(config.MOD_DIR, '.claude-plugin', 'plugin.json'))
    && /"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"\s*:\s*"?1"?/.test(readText(path.join(os.homedir(), '.claude', 'settings.json'), ''));
  return [
    '# herdr-hybrid Leader 模式（由 hh 启动）',
    '',
    '你是 Leader。用户对你说的任何话都先经过下面协议的「三问」，再决定是直接回答、还是派给 worker、还是改配置。不要靠用户的措辞猜类型。',
    '',
    '## 当前环境（启动时快照；`hh roles` / `hh profiles` / `hh doctor` 随时可查最新）',
    `- 你的 profile: ${profileName}${resolved.gatewayName ? ` @ ${resolved.gatewayName}` : ' (official)'}${resolved.model ? ` (${resolved.model})` : ''}`,
    `- 工作目录: ${process.cwd()}`,
    `- 工具: ${mcpOn ? 'MCP 工具 hh_* 已注册（优先用）；' : 'MCP 未注册，'}命令行 hh 在你的 shell 里自动输出 JSON`,
    `- 配置面板: ${panelOn ? '可用——用户想自己看着改就让他敲 /hh-config' : `不可用（${resolved.agent.capabilities.mod ? 'mod 未装或 function hooks 未开' : `${resolved.agent.label} 不支持插件面板`}）——别推荐 /hh-config，直接用 hh gateways / profiles / roles / mode 替他改`}`,
    `- herdr 观察窗口: ${config.effectiveViewer(c) === 'none' ? '已关闭（viewer=none），worker 后台跑' : herdr.installed() ? (herdr.available() ? '可用，worker 会开在 tab 里' : '已安装未运行，worker 后台跑') : '未安装，worker 后台跑'}`,
    '- 当前角色（名字任意，看描述选人；没有贴切的就用 -p/-a 现场组一个）:',
    ...(roster.length ? roster : ['  （还没有角色：hh roles set <name> --profile <p> --desc "用途"）']),
    `- 可用 profile（${profileNames.length} 个）: ${profileNames.join(', ')}`,
    `- worker 汇报契约：每个 run 结束时 result.report 是它按此 schema 交的 JSON：${config.REPORT_SCHEMA}`,
    '',
    body,
  ].join('\n');
}

// Leader 开在哪：terminal（默认，当前终端）/ herdr（`hh claude herdr`：新开聚焦 tab）/ pane（已经在 herdr 里，原地跑）
// opts.herdr: true = 要 herdr；false = --no-herdr（连 worker 也不开窗口）；undefined = 当前终端，除非 viewer 配成 herdr
function decideLaunch(c, opts) {
  if (opts.inTab) return { launch: 'pane', reason: 'herdr tab 内重放（--in-herdr-tab）' };
  const viewer = config.effectiveViewer(c);
  const want = opts.herdr === false ? 'none' : opts.herdr === true ? 'herdr' : (opts.leader && viewer === 'herdr' ? 'herdr' : 'none');
  if (want === 'none') return { launch: 'terminal', reason: opts.herdr === false ? '--no-herdr' : '默认在当前终端（hh claude herdr 开进 herdr）' };
  if (herdr.insidePane()) return { launch: 'pane', reason: `已经在 herdr 的 pane 里（${process.env.HERDR_PANE_ID || 'HERDR_ENV'}）` };
  if (!herdr.installed()) {
    return { launch: 'terminal', reason: 'herdr 未安装', missing: 'herdr', hint: `herdr 未安装，Leader 在当前终端运行。装上就能开进去：hh install herdr（或 ${herdr.INSTALL_CMD}）` };
  }
  return { launch: 'herdr', reason: opts.herdr === true ? (herdr.available() ? 'herdr 运行中' : 'herdr 已安装，未运行，会先启动 server') : 'viewer = herdr' };
}

function launchPlan(profileName, extra, opts) {
  opts = opts || {};
  const c = cfg();
  const profile = config.getProfile(c, profileName);
  const modeOverride = opts.mode;
  const mode = opts.mode || (opts.leader ? (profile.orchestration || {}).mode || 'external' : 'plain');
  if (!require('./orchestration').MODES.includes(mode)) throw new HHError('bad_mode', 'mode 必须是 external|native|plain');
  opts = { ...opts, leader: mode !== 'plain', mode };
  const native = mode === 'native' ? opts.nativeRuntime || require('./native').plan(c, profileName) : null;
  const runtime = native ? opts.nativeRuntime || { main: native.main, url: 'http://127.0.0.1:0', token: 'hh-session-preview' } : null;
  const resolved = config.resolveProfile(c, profileName, '', runtime);
  const agent = resolved.agent;
  if (native) config.validateOrchestration(c, { ...profile.orchestration, mode: 'native' }, agent);
  if (native && agent.validateNativeArgs) agent.validateNativeArgs([...(c[agent.name]?.interactiveArgs || []), ...(profile.args || []), ...(extra || [])]);
  if (native && !agent.capabilities.native) throw new HHError('no_native', '此 Agent 不支持原生委派');
  if (opts.leader && !agent.capabilities.leader) {
    throw new HHError('no_leader', `profile ${profileName} 用的是 ${agent.label}，暂不能当 Leader（协议注入依赖 Claude Code 的 --append-system-prompt）。它可以当 worker：hh roles set coder --profile ${profileName}`);
  }
  if (opts.herdr === false) resolved.env.HH_VIEWER = 'none'; // 明确不要 herdr：Leader 派出去的 worker 也不开窗口
  const prompt = native ? native.guidance : opts.leader ? leaderPrompt(profileName) : null;
  // Leader 模式挂上 hh 自带的配置界面（Leader 里 /hh-config 打开）。
  // mod 目录不存在（老版本装的）或该 agent 不支持插件就跳过，不报错。
  const mod = opts.leader && agent.capabilities.mod && fs.existsSync(path.join(config.MOD_DIR, '.claude-plugin', 'plugin.json')) ? config.MOD_DIR : null;
  // 面板贴底：pane 的位置由终端布局决定（fullscreen 靠右，main screen 在提示框上方），
  // 插件改不了，唯一的开关是 CLAUDE_CODE_NO_FLICKER。只在挂了面板的 Leader 上动它。
  // 必须在下面算 env 之前改：env 是 resolved.env 的快照，改晚了 spawn 拿到的还是旧值（dry-run 打的是 resolved.env，看不出来）。
  if (mod && (c.claude.pane || 'right') === 'bottom') resolved.env.CLAUDE_CODE_NO_FLICKER = '0';
  const env = Object.assign({}, process.env);
  for (const k of resolved.unset) delete env[k];
  Object.assign(env, resolved.env);
  const argv = agent.interactiveArgv(c[agent.name], resolved.args, agent.leaderArgs(prompt).concat(native ? agent.nativeArgs(native) : [], extra || []), { mod });
  const decision = decideLaunch(c, opts);
  // 交给 herdr tab 里的 `hh claude --in-herdr-tab …` 重放的参数（它自己再算 env / prompt）
  const herdrArgv = (opts.leader ? ['--leader', profileName] : [profileName]).concat(modeOverride || mode === 'native' ? ['--mode', mode] : [], extra || []);
  return Object.assign({ resolved, agent: agent.name, mode, native, env, argv, leader: !!opts.leader, prompt, herdrArgv, workspace: c.workspace }, decision);
}

async function launch(profileName, extra, opts) {
  let plan = launchPlan(profileName, extra || [], opts);
  if (plan.launch === 'herdr') {
    let fallback = null;
    if (!herdr.ensureServer()) fallback = 'herdr server 没能在限定时间内就绪';
    else {
      try {
        const c = cfg();
        const tab = herdr.openLeader(c, { cwd: process.cwd(), argv: plan.herdrArgv });
        const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
        const code = tty ? herdr.attach() : 0; // 有终端就把 herdr 客户端附着进来，用户直接看到 Leader；没有就只报 tab
        return Promise.resolve({ code, launch: 'herdr', tab, attached: tty, workspace: c.workspace });
      } catch (e) { fallback = `herdr 开 tab 失败: ${e.message}`; }
    }
    // 回退：Leader 在当前终端跑；worker 仍按 viewer 判定（server 在跑就开 tab）
    plan.launch = 'terminal';
    plan.reason = fallback;
    process.stderr.write(`hh: ${fallback}，Leader 改在当前终端运行（hh doctor 看 herdr 状态）\n`);
  }
  let runtime;
  try {
    if (plan.native) {
      runtime = await require('./native').start(cfg(), profileName);
      const decision = { launch: plan.launch, reason: plan.reason };
      plan = Object.assign(launchPlan(profileName, extra || [], { ...opts, nativeRuntime: runtime }), decision);
    }
    return await new Promise((resolve) => {
      const child = spawn(plan.resolved.bin, plan.argv, { stdio: 'inherit', env: plan.env });
      const forward = signal => child.kill(signal);
      const interrupt = () => forward('SIGINT'); const terminate = () => forward('SIGTERM');
      process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
      const finish = (code, signal) => {
        process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
        resolve({ code: code == null ? (signal ? 128 : 1) : code, launch: plan.launch, reason: plan.reason });
      };
      child.once('error', () => { process.stderr.write(`hh: 无法启动 ${plan.resolved.bin}\n`); finish(127); });
      child.once('exit', finish);
    });
  } finally { if (runtime) await runtime.close(); }

}

function paneSet(v) {
  if (!config.PANES.includes(v)) throw new HHError('bad_pane', `pane 只能是 ${config.PANES.join('|')}`);
  config.update((c) => { c.claude.pane = v; });
  return { pane: v };
}

function viewerSet(v) {
  if (!config.VIEWERS.includes(v)) throw new HHError('bad_viewer', `viewer 只能是 ${config.VIEWERS.join('|')}`);
  config.update((c) => { c.viewer = v; });
  return { viewer: v };
}

// ---------- 装依赖：官方安装脚本 ----------
const INSTALLERS = {
  claude: { cmd: 'curl -fsSL https://claude.ai/install.sh | bash', alt: 'npm install -g @anthropic-ai/claude-code', check: () => which('claude'), what: 'Claude Code' },
  codex: { cmd: 'npm install -g @openai/codex', alt: 'brew install codex', check: () => which('codex'), what: 'Codex CLI（可作为 worker）' },
  herdr: { cmd: herdr.INSTALL_CMD, alt: herdr.INSTALL_ALT, check: () => which('herdr'), what: 'herdr（可选：Leader 和每个 worker 各一个窗口）' },
};
function installCommand(name) { return (INSTALLERS[name] || {}).cmd || ''; }
function installDep(name, opts) {
  opts = opts || {};
  const d = INSTALLERS[name];
  if (!d) throw new HHError('bad_arg', `hh install 只能是 ${Object.keys(INSTALLERS).join('|')}`);
  const before = d.check();
  if (before) return { name, already: true, path: before, command: d.cmd };
  if (!opts.run) return { name, already: false, ran: false, command: d.cmd, alt: d.alt, what: d.what };
  if (process.platform === 'win32') return { name, already: false, ran: false, command: d.cmd, alt: d.alt, what: d.what, manual: true };
  const r = spawnSync('bash', ['-lc', `set -o pipefail; ${d.cmd}`], { stdio: 'inherit' }); // pipefail：curl 失败不能被 sh/bash 的 0 盖掉
  let after = d.check();
  let pathHint = null;
  if (!after && r.status === 0) { // 官方脚本都装到 ~/.local/bin；全新机器它多半还不在 PATH 里
    const guess = require('path').join(require('os').homedir(), '.local', 'bin', name);
    if (fs.existsSync(guess)) { after = guess; pathHint = require('path').dirname(guess); }
  }
  return { name, already: false, ran: true, ok: r.status === 0 && !!after, exit: r.status, path: after || null, path_hint: pathHint, command: d.cmd, alt: d.alt, what: d.what };
}

function envOf(profileName, opts) {
  opts = opts || {};
  const c = cfg();
  const resolved = config.resolveProfile(c, profileName, opts.model || '');
  return { profile: profileName, agent: resolved.agentName, gateway: resolved.gatewayName, model: resolved.model, bin: resolved.bin, env: opts.reveal ? resolved.env : maskEnv(resolved.env), unset: resolved.unset, args: resolved.args };
}

// ---------- gateways ----------
function gatewayInfo(name, g) {
  return { name, url: g.url, wire: g.wire || null, capabilities: g.capabilities || null, contextWindow: g.contextWindow || null, maxOutputTokens: g.maxOutputTokens || null, auth: g.auth, secret: mask(g.secret), secret_ref: typeof g.secret === 'string' && g.secret.startsWith('env:') ? g.secret : null, env: maskEnv(g.env || {}) };
}
function gateways() { const c = cfg(); return { gateways: Object.entries(c.gateways).map(([n, g]) => gatewayInfo(n, g)) }; }
function gatewaysSet(name, opts) {
  const r = config.update((c) => {
    const g = Object.assign({}, c.gateways[name] || {});
    if (opts.url !== undefined) g.url = opts.url;
    if (opts.auth !== undefined) g.auth = opts.auth;
    if (opts.secret !== undefined) g.secret = opts.secret;
    for (const key of ['wire', 'contextWindow', 'maxOutputTokens', 'capabilities']) if (opts[key] !== undefined) g[key] = opts[key];
    if (!g.auth) g.auth = 'token';
    if (opts.env && Object.keys(opts.env).length) g.env = Object.assign({}, g.env || {}, opts.env);
    if (opts.unsetEnv) for (const k of opts.unsetEnv) if (g.env) delete g.env[k];
    if (g.env && !Object.keys(g.env).length) delete g.env;
    config.validateGateway(name, g);
    c.gateways[name] = g;
    return g;
  });
  runs.logEvent('gateways_set', { gateway: name, url: r.url, auth: r.auth });
  return { gateway: gatewayInfo(name, r) };
}
function gatewaysRm(name) {
  config.update((c) => {
    config.getGateway(c, name);
    const refs = Object.entries(c.profiles).filter(([, p]) => p.gateway === name || [p.orchestration?.workerModel, ...(p.orchestration?.models || []), ...(p.orchestration?.fallback || [])].some(m => typeof m === 'string' && m.startsWith(name + '/'))).map(([n]) => n);
    if (refs.length) throw new HHError('referenced', `网关 ${name} 仍被 profile 引用: ${refs.join(', ')}（先 hh profiles rm 它们）`);
    delete c.gateways[name];
  });
  runs.logEvent('gateways_rm', { gateway: name });
  return { removed: name };
}

// ---------- profiles ----------
function profileInfo(c, name, p) {
  const g = p.gateway ? c.gateways[p.gateway] : null;
  const agent = Object.prototype.hasOwnProperty.call(agents.AGENTS, p.agent || agents.DEFAULT) ? agents.AGENTS[p.agent || agents.DEFAULT] : null;
  return {
    name, agent: (agent && agent.name) || p.agent, agent_ok: !!agent, transport: p.transport || 'direct', orchestration: p.orchestration || { mode: 'external' },
    gateway: p.gateway || null, gateway_ok: !p.gateway || !!g, url: g ? g.url : null, model: p.model || null, env: maskEnv(p.env || {}), args: p.args || [],
    bin: p.bin || null, note: p.note || null, official: !p.gateway,
    roles: Object.entries(c.roles).filter(([, r]) => r.profile === name).map(([r]) => r),
  };
}
function profiles() { const c = cfg(); return { leader: c.leader, profiles: Object.entries(c.profiles).map(([n, p]) => profileInfo(c, n, p)) }; }
function profilesShow(name) { const c = cfg(); return { profile: profileInfo(c, name, config.getProfile(c, name)) }; }
function profilesSet(name, opts) {
  const p = config.update((c) => {
    const p = Object.assign({}, c.profiles[name] || {});
    if (opts.agent !== undefined) p.agent = opts.agent && opts.agent !== agents.DEFAULT ? opts.agent : undefined;
    if (opts.gateway !== undefined) p.gateway = opts.gateway === '-' || opts.gateway === 'official' || opts.gateway === '' ? null : opts.gateway;
    if (p.gateway === undefined) p.gateway = null;
    if (opts.model !== undefined) p.model = opts.model;
    if (opts.transport !== undefined) p.transport = opts.transport;
    if (opts.orchestration !== undefined) p.orchestration = opts.orchestration;
    if (opts.args !== undefined) p.args = opts.args;
    if (opts.bin !== undefined) p.bin = opts.bin || undefined;
    if (opts.note !== undefined) p.note = opts.note || undefined;
    if (opts.env && Object.keys(opts.env).length) p.env = Object.assign({}, p.env || {}, opts.env);
    if (opts.unsetEnv) for (const k of opts.unsetEnv) if (p.env) delete p.env[k];
    if (p.env && !Object.keys(p.env).length) delete p.env;
    for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
    config.validateProfile(c, name, p);
    c.profiles[name] = p;
    return p;
  });
  runs.logEvent('profiles_set', { profile: name, agent: p.agent || agents.DEFAULT, gateway: p.gateway, model: p.model || null });
  return { profile: profileInfo(cfg(), name, p) };
}
function profilesRm(name) {
  config.update((c) => {
    config.getProfile(c, name);
    if (name === config.OFFICIAL) throw new HHError('protected', `${config.OFFICIAL} 是内置 profile，不能删`);
    if (c.leader === name) throw new HHError('referenced', '不能删除当前 Leader profile；先 hh leader <其它>');
    const refs = Object.entries(c.roles).filter(([, r]) => r.profile === name).map(([n]) => n);
    if (refs.length) throw new HHError('referenced', `profile ${name} 仍被角色引用: ${refs.join(', ')}（先 hh roles set <role> --profile <其它>）`);
    delete c.profiles[name];
  });
  runs.logEvent('profiles_rm', { profile: name });
  return { removed: name };
}
async function profilesTest(name, opts) {
  opts = opts || {};
  const c = cfg();
  config.getProfile(c, name);
  const dir = path.join(config.STATE_DIR, 'probe');
  fs.mkdirSync(dir, { recursive: true });
  const run = runs.createRun(c, { profile: name, label: `probe-${name}`, cwd: dir, autonomy: 'readonly', view: 'none', noTemplate: true, noFooter: true, probe: true, task: 'Reply with exactly the single word: pong' });
  const w = await runs.waitRuns([run.id], { timeout: opts.timeout || 120, interval: 2 });
  const s = runs.summary(run.id, { full: true });
  const ok = s.status === 'done' && /pong/i.test(s.final || '');
  return { profile: name, agent: s.agent || null, gateway: s.gateway, model: s.model, ok, status: s.status, final: truncate(s.final || '', 200), error: s.error, session_id: s.session_id, duration_ms: s.duration_ms, id: run.id, settled: w.settled };
}
function profilesAliases(opts) {
  opts = opts || {};
  const c = cfg();
  const suffix = opts.suffix == null ? 'cc' : opts.suffix;
  const hh = which('hh') || config.HH_BIN;
  return { lines: Object.keys(c.profiles).map((n) => `alias ${n}${suffix}='${hh} claude ${n}'`) };
}
function importAliases(files, opts) {
  opts = opts || {};
  // dry-run 不写盘，就不必抢锁
  if (opts.dryRun) {
    const r = config.importAliases(cfg(), files, { dryRun: true });
    r.dry_run = true;
    return r;
  }
  const r = config.update((c) => config.importAliases(c, files, { dryRun: false }));
  r.dry_run = false;
  return r;
}

// ---------- roles ----------
function roles() {
  const c = cfg();
  const list = Object.entries(c.roles).map(([name, r]) => {
    const p = c.profiles[r.profile];
    const tpl = config.templatePath(r.template);
    return {
      role: name, profile: r.profile, agent: p ? (p.agent || agents.DEFAULT) : null, gateway: p ? p.gateway || null : null, model: r.model || (p && p.model) || null, autonomy: r.autonomy || 'full',
      desc: r.desc || null, template: r.template || null, template_ok: tpl ? fs.existsSync(tpl) : true, profile_ok: !!p,
    };
  });
  return { leader: c.leader, roles: list };
}
function rolesSet(name, opts) {
  const role = config.update((c) => {
    config.validateName('角色', name);
    const profile = opts.profile || (c.roles[name] && c.roles[name].profile);
    if (!profile) throw new HHError('need_profile', '需要 --profile PROFILE');
    config.getProfile(c, profile);
    if (opts.autonomy && !config.AUTONOMY.includes(opts.autonomy)) throw new HHError('bad_autonomy', `autonomy 必须是 ${config.AUTONOMY.join('|')}`);
    const old = c.roles[name] || {};
    let template = opts.template !== undefined ? opts.template : old.template;
    if (template === undefined) template = fs.existsSync(path.join(config.PROMPTS_DIR, `${name}.md`)) ? `${name}.md` : '-';
    if (template && template !== '-' && !fs.existsSync(config.templatePath(template))) throw new HHError('no_template', `模板不存在: ${config.templatePath(template)}`);
    const role = { profile, template };
    const model = opts.model !== undefined ? opts.model : profile !== old.profile ? undefined : old.model;
    const autonomy = opts.autonomy !== undefined ? opts.autonomy : old.autonomy || (config.ROLE_DEFAULTS[name] || {}).autonomy;
    const desc = opts.desc !== undefined ? opts.desc : old.desc || (config.ROLE_DEFAULTS[name] || {}).desc;
    if (model) role.model = model;
    if (autonomy) role.autonomy = autonomy;
    if (desc) role.desc = desc;
    c.roles[name] = role;
    return role;
  });
  runs.logEvent('roles_set', { role: name, profile: role.profile, model: role.model || null, autonomy: role.autonomy || null, template: role.template });
  return { role: name, config: role };
}
function rolesRm(name) {
  config.update((c) => {
    if (!c.roles[name]) throw new HHError('no_role', `角色不存在: ${name}`);
    delete c.roles[name];
  });
  runs.logEvent('roles_rm', { role: name });
  return { removed: name };
}
function leaderSet(profileName) {
  config.update((c) => {
    const p = config.getProfile(c, profileName);
    const a = agents.get(p.agent);
    if (!a.capabilities.leader) throw new HHError('no_leader', `${profileName} 用的是 ${a.label}，暂不能当 Leader（协议注入依赖 Claude Code 的 --append-system-prompt）。它可以当 worker：hh roles set coder --profile ${profileName}`);
    c.leader = profileName;
  });
  return { leader: profileName };
}

// ---------- doctor ----------
function claudeVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').trim().split('\n')[0].slice(0, 60);
}
const agentVersion = claudeVersion;

const SKILL_FILE = path.join(os.homedir(), '.claude', 'skills', 'herdr-leader', 'SKILL.md');
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');

function doctor() {
  const checks = [];
  const add = (name, ok, detail, hint) => checks.push({ name, ok, detail: detail || '', hint: hint || '' });
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node', nodeMajor >= 18, `v${process.versions.node}`, nodeMajor >= 18 ? '' : '需要 Node ≥ 18');
  const c = config.load({ optional: true });
  add('config', !!c, shortHome(config.CONFIG_FILE), c ? '' : '运行 hh init');
  if (!c) return { ok: false, checks, version: PKG.version };
  let mode = '600';
  try { mode = (fs.statSync(config.CONFIG_FILE).mode & 0o777).toString(8); } catch (e) { /* ignore */ }
  add('config.perm', mode === '600', mode, mode === '600' ? '' : 'config.json 含密钥，chmod 600');
  const bin = which(c.claude.bin || 'claude');
  add('claude', !!bin, bin ? `${bin} · ${claudeVersion(bin) || '?'}` : `找不到 ${c.claude.bin}`, bin ? '' : 'hh install claude（官方安装脚本），或改 config.claude.bin');
  // 其它 agent：只有真的有 profile 在用时才检查，没人用就不刷屏
  for (const a of agents.NAMES) {
    if (a === 'claude') continue;
    const users = Object.entries(c.profiles).filter(([, p]) => (p.agent || agents.DEFAULT) === a).map(([n]) => n);
    if (!users.length) continue;
    const ad = agents.get(a);
    const ab = which((c[a] && c[a].bin) || ad.defaultBin);
    add(a, !!ab, ab ? `${ab} · ${agentVersion(ab) || '?'} · profile: ${users.join(', ')}` : `找不到 ${(c[a] && c[a].bin) || ad.defaultBin}（profile: ${users.join(', ')}）`, ab ? '' : `hh install ${a}`);
  }
  // 登录只对「不配网关」的 profile 有意义（gateway: null = 用该 CLI 自己的订阅/登录）。
  // 按 gateway 判断，不按 profile 名叫不叫 official——否则改个名就漏检，
  // 也漏掉 codex 这类同样用订阅的 agent。只检查真的被 leader / 角色用到的。
  const usedProfiles = new Set([c.leader].concat(Object.values(c.roles).map((r) => r.profile)));
  const subscriptionAgents = new Map(); // agent 名 → { users: [profile 名], bin }
  for (const [pname, p] of Object.entries(c.profiles)) {
    if (p.gateway || !usedProfiles.has(pname)) continue;
    const an = p.agent || agents.DEFAULT;
    if (!Object.prototype.hasOwnProperty.call(agents.AGENTS, an)) continue;
    const ad = agents.AGENTS[an];
    // 登录状态取决于实际会被启动的那个可执行文件：profile 的 bin 优先，其次 agent 级 bin。
    // 用 agent 级 bin 一把梭会去问错的程序（profile 指到别处时结论无意义）。
    const pbin = which(expandHome(p.bin || (c[an] && c[an].bin) || ad.defaultBin));
    if (!pbin) continue; // 可执行文件缺失已经在别处报过
    const key = `${an}\0${pbin}`;
    if (!subscriptionAgents.has(key)) subscriptionAgents.set(key, { agent: an, bin: pbin, users: [] });
    subscriptionAgents.get(key).users.push(pname);
  }
  const authSeen = new Set();
  for (const { agent: an, bin: abin, users } of subscriptionAgents.values()) {
    const ad = agents.get(an);
    if (!ad.checkAuth) continue;
    // 用 worker 真正拿到的 env 体检：official 会清掉继承的 ANTHROPIC_* 网关变量，
    // 直接用当前进程的 env 会把「Leader 会话里带着中转站密钥」误报成「已登录」。
    const r0 = config.resolveProfile(c, users[0], '');
    const env = Object.assign({}, process.env);
    for (const k of r0.unset) delete env[k];
    Object.assign(env, r0.env);
    const a = ad.checkAuth(abin, (b, args, o) => spawnSync(b, args, Object.assign({}, o, { env })), stripAnsi);
    // 同一个 agent 可能有多个不同 bin（测试 / 多版本共存）：名字加序号避免覆盖
    let label = `${an}.auth`;
    for (let i = 2; authSeen.has(label); i++) label = `${an}.auth.${i}`;
    authSeen.add(label);
    add(label, a.ok, `${a.detail}（profile: ${users.join(', ')}）`, a.ok === false ? (a.hint || '') : '');
  }
  const gwNames = Object.keys(c.gateways);
  add('gateways', gwNames.length > 0 ? true : null, gwNames.length ? gwNames.join(', ') : '（没有端点，只有 official）', gwNames.length ? '' : 'hh setup（交互式）/ hh gateways set / 已有 alias: hh profiles import-aliases');
  for (const [name, g] of Object.entries(c.gateways)) {
    let err = null;
    try { config.validateGateway(name, g); } catch (e) { err = e.message; }
    const secretOk = !!config.resolveProfile ? !!(typeof g.secret === 'string' && (g.secret.startsWith('env:') ? process.env[g.secret.slice(4)] : g.secret)) : true;
    add(`gateway.${name}`, !err && secretOk, `${g.url} · ${g.auth} · ${mask(g.secret)}${g.env ? ` · env ${Object.keys(g.env).join(',')}` : ''}`, err || (secretOk ? '' : `密钥引用的环境变量为空: ${g.secret}`));
  }
  const pNames = Object.keys(c.profiles);
  add('profiles', pNames.length > 1, `${pNames.length} 个：${pNames.slice(0, 12).join(', ')}${pNames.length > 12 ? ' …' : ''}`, pNames.length > 1 ? '' : 'hh setup / hh profiles set / 已有 alias: import-aliases');
  for (const [name, p] of Object.entries(c.profiles)) {
    // 手改 config.json 可能写出不存在的 agent：这时 dispatch / env 全会失败，doctor 不能说 ok
    if (p.agent && !Object.prototype.hasOwnProperty.call(agents.AGENTS, p.agent)) {
      add(`profile.${name}`, false, `agent 不存在: ${p.agent}`, `hh profiles set ${name} --agent ${agents.NAMES.join('|')}`);
    }
    if (p.gateway && !c.gateways[p.gateway]) add(`profile.${name}`, false, `网关不存在: ${p.gateway}`, `hh profiles set ${name} --gateway <existing>`);
    try {
      config.validateProfile(c, name, p);
      if (p.orchestration && p.orchestration.mode === 'native') require('./native').plan(c, name);
    } catch (e) { add(`profile.${name}.policy`, false, e.message, 'hh profiles set / hh mode'); }
    if (p.bin && !which(expandHome(p.bin))) add(`profile.${name}`, false, `bin 不存在: ${p.bin}`, '');
  }
  const leaderProfile = c.profiles[c.leader];
  const leaderAgent = leaderProfile && Object.prototype.hasOwnProperty.call(agents.AGENTS, leaderProfile.agent || agents.DEFAULT) ? agents.AGENTS[leaderProfile.agent || agents.DEFAULT] : null;
  const leaderCan = !leaderProfile || !leaderAgent || leaderAgent.capabilities.leader;
  add('leader', !!leaderProfile && leaderCan, `${c.leader}${leaderAgent && leaderAgent.name !== agents.DEFAULT ? ` · ${leaderAgent.label}` : ''}`,
    !leaderProfile ? 'hh leader <profile>' : !leaderCan ? `${leaderAgent.label} 暂不能当 Leader（协议注入依赖 Claude Code）；换一个 claude profile 当 Leader，它可以当 worker` : '');
  for (const [name, ro] of Object.entries(c.roles)) {
    const pOk = !!c.profiles[ro.profile];
    const tpl = config.templatePath(ro.template);
    const tplOk = !tpl || fs.existsSync(tpl);
    const p = c.profiles[ro.profile];
    add(`role.${name}`, pOk && tplOk, `→ ${ro.profile}${p && p.gateway ? ` @ ${p.gateway}` : ''}${(ro.model || (p && p.model)) ? ` (${ro.model || p.model})` : ''} · ${ro.autonomy || 'full'} · ${ro.template || '-'}`, !pOk ? `profile ${ro.profile} 不存在` : !tplOk ? `模板缺失 ${shortHome(tpl)}` : '');
  }
  add('leader.skill', fs.existsSync(SKILL_FILE), shortHome(SKILL_FILE), fs.existsSync(SKILL_FILE) ? '' : '运行 install.sh');
  // 配置界面（mod）：文件在不在，以及 Claude Code 的 function hooks 开没开。
  // 两者缺一 /hh-config 就不出现，但都不影响 hh 的其它功能，所以是提示（null）不是失败。
  const modOk = fs.existsSync(path.join(config.MOD_DIR, '.claude-plugin', 'plugin.json'));
  const settingsFile = path.join(os.homedir(), '.claude', 'settings.json');
  const hooksOn = /"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS"\s*:\s*"?1"?/.test(readText(settingsFile, ''));
  // /hh-config 是 Claude Code 的 function hooks 插件：Leader 用的 agent 不支持插件（如 codex）时
  // 面板根本不会挂上，不能报「/hh-config 打开」误导用户。
  const leaderModOk = !leaderAgent || leaderAgent.capabilities.mod;
  add('leader.mod', leaderModOk && modOk && hooksOn ? true : null,
    !leaderModOk ? `Leader 用的是 ${leaderAgent.label}，不支持插件面板 → 用命令行 hh gateways / profiles / roles / mode 改配置`
      : !modOk ? '未安装（运行 install.sh）'
        : hooksOn ? `${shortHome(config.MOD_DIR)} · Leader 里 /hh-config 打开`
          : `${shortHome(config.MOD_DIR)} · function hooks 未开启，/hh-config 不会出现`,
    leaderModOk && modOk && !hooksOn ? `在 ${shortHome(settingsFile)} 的 env 加 "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` : '');
  const mcpOk = fs.existsSync(CLAUDE_JSON) && /"hh"\s*:/.test(readText(CLAUDE_JSON, ''));
  add('leader.mcp', mcpOk ? true : null, mcpOk ? 'hh MCP 已注册' : '未注册（可选，hh 命令行本身够用）', mcpOk ? '' : 'hh install-mcp');
  const hInst = herdr.installed();
  const hRun = hInst && herdr.available();
  const viewer = config.effectiveViewer(c);
  const vNote = viewer === 'none' ? '（viewer=none：Leader 与 worker 都不开窗口）' : hRun ? '（worker 各一个 tab；hh claude herdr 把 Leader 也开进去）' : '（worker 后台跑；hh claude herdr 会拉起 server）';
  add('herdr', hInst ? true : null, hInst ? `${hRun ? '运行中' : '已安装未运行'} · viewer=${viewer}${vNote}` : `未安装（可选）· viewer=${viewer}，Leader 与 worker 都在终端 / 后台`, hInst ? '' : 'hh install herdr');
  try { fs.mkdirSync(runs.RUNS_DIR, { recursive: true }); add('state', true, shortHome(config.STATE_DIR), ''); } catch (e) { add('state', false, e.message, ''); }
  return { ok: checks.every((x) => x.ok !== false), checks, version: PKG.version };
}

async function doctorNet(opts) {
  opts = opts || {};
  const c = cfg();
  let names = Object.keys(c.profiles);
  if (!opts.all) {
    const used = new Set([c.leader].concat(Object.values(c.roles).map((r) => r.profile)));
    names = names.filter((n) => used.has(n));
  }
  const results = [];
  for (const name of names) {
    try { results.push(await profilesTest(name, { timeout: opts.timeout || 120 })); } catch (e) { results.push({ profile: name, ok: false, error: e.message }); }
  }
  return { ok: results.every((r) => r.ok), results };
}

// ---------- init / install-mcp ----------
function init(opts) {
  const r = config.init(opts);
  return {
    config: r.config, claude: r.claude, herdr: r.herdr, aliases: r.aliases, roles_defaulted: r.roles_defaulted, prompts: r.prompts,
    leader: r.cfg.leader, gateways: Object.keys(r.cfg.gateways), profiles: Object.keys(r.cfg.profiles), roles: r.cfg.roles,
  };
}

function installMcp() {
  const hhPath = which('hh') || config.HH_BIN;
  const bin = which('claude');
  if (!bin) throw new HHError('no_claude', 'claude 未安装');
  const args = ['mcp', 'add', '--scope', 'user', 'hh', '--', hhPath, 'mcp'];
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 30000 });
  const outText = ((r.stdout || '') + (r.stderr || '')).trim();
  return { ok: !r.error && r.status === 0, command: [bin].concat(args).join(' '), detail: truncate(outText, 200) };
}

// Shared orchestration operations (CLI and MCP return the same JSON contracts).
function modeSet(profileName, changes) {
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new HHError('bad_policy', 'changes 必须是对象');
  return config.update(c => {
    const p = config.getProfile(c, profileName);
    const next = { ...(p.orchestration || { mode: 'external' }), ...changes };
    config.validateOrchestration(c, next, agents.get(p.agent));
    p.orchestration = next;
    return { profile: profileInfo(c, profileName, p) };
  });
}
function nativePlan(profileName) {
  const p = require('./native').plan(cfg(), profileName);
  return { profile: profileName, main: p.main, worker: p.worker, models: p.models, fallback: p.targets, catalog: p.catalogPath, runtime: 'builtin' };
}

module.exports = {
  dispatch, dryRun, wait, status, read, result, task, send, decide, decisions, cancel, close, closeWith, view, log, clean,
  modeSet, nativePlan,
  launch, launchPlan, envOf, viewerSet, paneSet, installDep, installCommand,
  gateways, gatewaysSet, gatewaysRm,
  profiles, profilesShow, profilesSet, profilesRm, profilesTest, profilesAliases, importAliases,
  roles, rolesSet, rolesRm, leaderSet,
  doctor, doctorNet, init, installMcp, version: PKG.version,
};
