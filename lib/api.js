'use strict';
// 统一的操作层：CLI 和 MCP 都调这里，返回纯对象。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');
const { HHError, readText, which, shortHome, maskEnv, mask, expandHome, truncate, stripAnsi } = require('./util');
const config = require('./config');
const claude = require('./claude');
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
  const resolved = config.resolveProfile(c, profileName, opts.model || (r && r.model) || '');
  const autonomy = opts.autonomy || (r && r.autonomy) || 'full';
  const argv = claude.headlessArgv({ model: resolved.model, autonomy, resume: opts.resume || null, args: resolved.args });
  return {
    profile: profileName, gateway: resolved.gatewayName, model: resolved.model, autonomy, cwd: path.resolve(expandHome(opts.cwd || process.cwd())),
    bin: resolved.bin, bin_path: which(resolved.bin), argv, env: maskEnv(resolved.env), unset: resolved.unset, template: r ? shortHome(r.template || '') : null,
  };
}

async function wait(ids, opts) { return runs.waitRuns(ids.map(runs.resolveId), opts); }
function status(opts) { return { runs: runs.listRuns(opts) }; }
function read(ref, opts) { const id = runs.resolveId(ref); return { id, status: runs.summary(id).status, lines: runs.readOutput(id, opts) }; }
function result(ref) { return { run: runs.summary(runs.resolveId(ref), { full: true }) }; }
function task(ref) { const id = runs.resolveId(ref); return { id, task: readText(path.join(runs.runDir(id), 'task.md')) }; }
function send(ref, text, opts) {
  const id = runs.resolveId(ref);
  if (!text || !text.trim()) throw new HHError('need_text', '需要追加指令文本');
  return { run: runs.sendFollowup(cfg(), id, text, opts) };
}
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
    return `  ${name.padEnd(11)} → ${r.profile}${p.gateway ? ` @ ${p.gateway}` : ' (official)'}${(r.model || p.model) ? ` (${r.model || p.model})` : ''} · ${r.autonomy || 'full'} · ${r.desc || '（无描述）'}`;
  });
  const profileNames = Object.keys(c.profiles);
  const mcpOn = fs.existsSync(CLAUDE_JSON) && /"hh"\s*:/.test(readText(CLAUDE_JSON, ''));
  return [
    '# herdr-hybrid Leader 模式（由 hh claude 启动）',
    '',
    '你是 Leader。用户对你说的任何话都先经过下面协议的「三问」，再决定是直接回答、还是派给 worker、还是改配置。不要靠用户的措辞猜类型。',
    '',
    '## 当前环境（启动时快照；`hh roles` / `hh profiles` / `hh doctor` 随时可查最新）',
    `- 你的 profile: ${profileName}${resolved.gatewayName ? ` @ ${resolved.gatewayName}` : ' (official)'}${resolved.model ? ` (${resolved.model})` : ''}`,
    `- 工作目录: ${process.cwd()}`,
    `- 工具: ${mcpOn ? 'MCP 工具 hh_* 已注册（优先用）；' : 'MCP 未注册，'}命令行 hh 在你的 shell 里自动输出 JSON`,
    `- herdr 观察窗口: ${herdr.installed() ? (herdr.available() ? '可用，worker 会开在 tab 里' : '已安装未运行，worker 后台跑') : '未安装，worker 后台跑'}`,
    '- 当前角色（名字任意，看描述选人；没有贴切的就用 -p/-a 现场组一个）:',
    ...(roster.length ? roster : ['  （还没有角色：hh roles set <name> --profile <p> --desc "用途"）']),
    `- 可用 profile（${profileNames.length} 个）: ${profileNames.join(', ')}`,
    `- worker 汇报契约：每个 run 结束时 result.report 是它按此 schema 交的 JSON：${config.REPORT_SCHEMA}`,
    '',
    body,
  ].join('\n');
}

// Leader 开在哪：herdr（新开聚焦 tab，装了就用）/ pane（已经在 herdr 里，原地跑）/ terminal（当前终端）
// opts.herdr: true = --herdr 强制；false = --no-herdr；undefined = 按模式和 config.viewer
function decideLaunch(c, opts) {
  const forced = opts.herdr === true;
  const want = opts.herdr === false ? 'none' : forced ? 'herdr' : (opts.leader ? c.viewer : 'none');
  if (want === 'none') return { launch: 'terminal', reason: opts.herdr === false ? '--no-herdr' : opts.leader ? 'viewer = none' : '普通模式默认在当前终端（--herdr 可改）' };
  if (herdr.insidePane()) return { launch: 'pane', reason: `已经在 herdr 的 pane 里（${process.env.HERDR_PANE_ID || 'HERDR_ENV'}）` };
  if (!herdr.installed()) {
    const hint = `装 herdr 可以让 Leader 和每个 worker 各一个窗口：hh install herdr（或 ${herdr.INSTALL_CMD}）；不想再看到这条：hh viewer none 或 hh claude --no-herdr`;
    if (want === 'herdr') throw new HHError('no_herdr', `herdr 未安装。${hint}`);
    return { launch: 'terminal', reason: 'herdr 未安装', missing: 'herdr', hint };
  }
  return { launch: 'herdr', reason: herdr.available() ? 'herdr 运行中' : 'herdr 已安装，未运行，会先启动 server' };
}

function launchPlan(profileName, extra, opts) {
  opts = opts || {};
  const c = cfg();
  const resolved = config.resolveProfile(c, profileName, '');
  if (opts.herdr === false) resolved.env.HH_VIEWER = 'none'; // 明确不要 herdr：Leader 派出去的 worker 也不开窗口
  const env = Object.assign({}, process.env);
  for (const k of resolved.unset) delete env[k];
  Object.assign(env, resolved.env);
  const prompt = opts.leader ? leaderPrompt(profileName) : null;
  const argv = claude.interactiveArgv(c, resolved.args, prompt ? ['--append-system-prompt', prompt] : []).concat(extra || []);
  const decision = decideLaunch(c, opts);
  // 交给 herdr tab 里的 `hh claude --no-herdr …` 重放的参数（它自己再算 env / prompt）
  const herdrArgv = (opts.leader ? ['--leader', profileName] : [profileName]).concat(extra || []);
  return Object.assign({ resolved, env, argv, leader: !!opts.leader, prompt, herdrArgv, workspace: c.workspace }, decision);
}

function launch(profileName, extra, opts) {
  const plan = launchPlan(profileName, extra || [], opts);
  if (plan.launch === 'herdr') {
    if (!herdr.ensureServer()) {
      process.stderr.write('hh: herdr server 没能在 15 秒内就绪，Leader 改在当前终端运行（hh doctor 看 herdr 状态）\n');
    } else {
      const c = cfg();
      const tab = herdr.openLeader(c, { cwd: process.cwd(), argv: plan.herdrArgv });
      const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
      const code = tty ? herdr.attach() : 0; // 有终端就把 herdr 客户端附着进来，用户直接看到 Leader；没有就只报 tab
      return Promise.resolve({ code, launch: 'herdr', tab, attached: tty, workspace: c.workspace });
    }
  }
  return new Promise((resolve) => {
    const child = spawn(plan.resolved.bin, plan.argv, { stdio: 'inherit', env: plan.env });
    child.on('error', (e) => { process.stderr.write(`hh: 无法启动 ${plan.resolved.bin}: ${e.message}\n`); resolve({ code: 127, launch: plan.launch }); });
    child.on('exit', (code, signal) => resolve({ code: code == null ? (signal ? 128 : 1) : code, launch: plan.launch, hint: plan.hint }));
  });
}

function viewerSet(v) {
  if (!config.VIEWERS.includes(v)) throw new HHError('bad_viewer', `viewer 只能是 ${config.VIEWERS.join('|')}`);
  const c = cfg();
  c.viewer = v;
  config.save(c);
  return { viewer: v };
}

// ---------- 装依赖：官方安装脚本 ----------
const INSTALLERS = {
  claude: { cmd: 'curl -fsSL https://claude.ai/install.sh | bash', alt: 'npm install -g @anthropic-ai/claude-code', check: () => which('claude'), what: 'Claude Code' },
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
  const r = spawnSync('bash', ['-lc', d.cmd], { stdio: 'inherit' });
  const after = d.check();
  return { name, already: false, ran: true, ok: r.status === 0 && !!after, exit: r.status, path: after || null, command: d.cmd, alt: d.alt, what: d.what };
}

function envOf(profileName, opts) {
  opts = opts || {};
  const c = cfg();
  const resolved = config.resolveProfile(c, profileName, opts.model || '');
  return { profile: profileName, gateway: resolved.gatewayName, model: resolved.model, bin: resolved.bin, env: opts.reveal ? resolved.env : maskEnv(resolved.env), unset: resolved.unset, args: resolved.args };
}

// ---------- gateways ----------
function gatewayInfo(name, g) {
  return { name, url: g.url, auth: g.auth, secret: mask(g.secret), secret_ref: typeof g.secret === 'string' && g.secret.startsWith('env:') ? g.secret : null, env: g.env || {} };
}
function gateways() { const c = cfg(); return { gateways: Object.entries(c.gateways).map(([n, g]) => gatewayInfo(n, g)) }; }
function gatewaysSet(name, opts) {
  const c = cfg();
  const g = Object.assign({}, c.gateways[name] || {});
  if (opts.url !== undefined) g.url = opts.url;
  if (opts.auth !== undefined) g.auth = opts.auth;
  if (opts.secret !== undefined) g.secret = opts.secret;
  if (!g.auth) g.auth = 'token';
  if (opts.env && Object.keys(opts.env).length) g.env = Object.assign({}, g.env || {}, opts.env);
  if (opts.unsetEnv) for (const k of opts.unsetEnv) if (g.env) delete g.env[k];
  if (g.env && !Object.keys(g.env).length) delete g.env;
  config.validateGateway(name, g);
  c.gateways[name] = g;
  config.save(c);
  runs.logEvent('gateways_set', { gateway: name, url: g.url, auth: g.auth });
  return { gateway: gatewayInfo(name, g) };
}
function gatewaysRm(name) {
  const c = cfg();
  config.getGateway(c, name);
  const refs = Object.entries(c.profiles).filter(([, p]) => p.gateway === name).map(([n]) => n);
  if (refs.length) throw new HHError('referenced', `网关 ${name} 仍被 profile 引用: ${refs.join(', ')}（先 hh profiles rm 它们）`);
  delete c.gateways[name];
  config.save(c);
  runs.logEvent('gateways_rm', { gateway: name });
  return { removed: name };
}

// ---------- profiles ----------
function profileInfo(c, name, p) {
  const g = p.gateway ? c.gateways[p.gateway] : null;
  return {
    name, gateway: p.gateway || null, gateway_ok: !p.gateway || !!g, url: g ? g.url : null, model: p.model || null, env: maskEnv(p.env || {}), args: p.args || [],
    bin: p.bin || null, note: p.note || null, official: !p.gateway,
    roles: Object.entries(c.roles).filter(([, r]) => r.profile === name).map(([r]) => r),
  };
}
function profiles() { const c = cfg(); return { leader: c.leader, profiles: Object.entries(c.profiles).map(([n, p]) => profileInfo(c, n, p)) }; }
function profilesShow(name) { const c = cfg(); return { profile: profileInfo(c, name, config.getProfile(c, name)) }; }
function profilesSet(name, opts) {
  const c = cfg();
  const p = Object.assign({}, c.profiles[name] || {});
  if (opts.gateway !== undefined) p.gateway = opts.gateway === '-' || opts.gateway === 'official' || opts.gateway === '' ? null : opts.gateway;
  if (p.gateway === undefined) p.gateway = null;
  if (opts.model !== undefined) p.model = opts.model;
  if (opts.args !== undefined) p.args = opts.args;
  if (opts.bin !== undefined) p.bin = opts.bin || undefined;
  if (opts.note !== undefined) p.note = opts.note || undefined;
  if (opts.env && Object.keys(opts.env).length) p.env = Object.assign({}, p.env || {}, opts.env);
  if (opts.unsetEnv) for (const k of opts.unsetEnv) if (p.env) delete p.env[k];
  if (p.env && !Object.keys(p.env).length) delete p.env;
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  config.validateProfile(c, name, p);
  c.profiles[name] = p;
  config.save(c);
  runs.logEvent('profiles_set', { profile: name, gateway: p.gateway, model: p.model || null });
  return { profile: profileInfo(c, name, p) };
}
function profilesRm(name) {
  const c = cfg();
  config.getProfile(c, name);
  if (name === config.OFFICIAL) throw new HHError('protected', `${config.OFFICIAL} 是内置 profile，不能删`);
  const refs = Object.entries(c.roles).filter(([, r]) => r.profile === name).map(([n]) => n);
  if (refs.length) throw new HHError('referenced', `profile ${name} 仍被角色引用: ${refs.join(', ')}（先 hh roles set <role> --profile <其它>）`);
  delete c.profiles[name];
  config.save(c);
  runs.logEvent('profiles_rm', { profile: name });
  return { removed: name };
}
async function profilesTest(name, opts) {
  opts = opts || {};
  const c = cfg();
  config.getProfile(c, name);
  const dir = path.join(config.STATE_DIR, 'probe');
  fs.mkdirSync(dir, { recursive: true });
  const run = runs.createRun(c, { profile: name, label: `probe-${name}`, cwd: dir, autonomy: 'readonly', view: 'none', noTemplate: true, noFooter: true, task: 'Reply with exactly the single word: pong' });
  const w = await runs.waitRuns([run.id], { timeout: opts.timeout || 120, interval: 2 });
  const s = runs.summary(run.id, { full: true });
  const ok = s.status === 'done' && /pong/i.test(s.final || '');
  return { profile: name, gateway: s.gateway, model: s.model, ok, status: s.status, final: truncate(s.final || '', 200), error: s.error, session_id: s.session_id, duration_ms: s.duration_ms, id: run.id, settled: w.settled };
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
  const c = cfg();
  const r = config.importAliases(c, files, { dryRun: !!opts.dryRun });
  if (!opts.dryRun) config.save(c);
  r.dry_run = !!opts.dryRun;
  return r;
}

// ---------- roles ----------
function roles() {
  const c = cfg();
  const list = Object.entries(c.roles).map(([name, r]) => {
    const p = c.profiles[r.profile];
    const tpl = config.templatePath(r.template);
    return {
      role: name, profile: r.profile, gateway: p ? p.gateway || null : null, model: r.model || (p && p.model) || null, autonomy: r.autonomy || 'full',
      desc: r.desc || null, template: r.template || null, template_ok: tpl ? fs.existsSync(tpl) : true, profile_ok: !!p,
    };
  });
  return { leader: c.leader, roles: list };
}
function rolesSet(name, opts) {
  const c = cfg();
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
  const model = opts.model !== undefined ? opts.model : old.model;
  const autonomy = opts.autonomy !== undefined ? opts.autonomy : old.autonomy || (config.ROLE_DEFAULTS[name] || {}).autonomy;
  const desc = opts.desc !== undefined ? opts.desc : old.desc || (config.ROLE_DEFAULTS[name] || {}).desc;
  if (model) role.model = model;
  if (autonomy) role.autonomy = autonomy;
  if (desc) role.desc = desc;
  c.roles[name] = role;
  config.save(c);
  runs.logEvent('roles_set', { role: name, profile, model: role.model || null, autonomy: role.autonomy || null, template });
  return { role: name, config: c.roles[name] };
}
function rolesRm(name) {
  const c = cfg();
  if (!c.roles[name]) throw new HHError('no_role', `角色不存在: ${name}`);
  delete c.roles[name];
  config.save(c);
  runs.logEvent('roles_rm', { role: name });
  return { removed: name };
}
function leaderSet(profileName) {
  const c = cfg();
  config.getProfile(c, profileName);
  c.leader = profileName;
  config.save(c);
  return { leader: profileName };
}

// ---------- doctor ----------
function claudeVersion(bin) {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || '').trim().split('\n')[0].slice(0, 60);
}
function claudeAuth(bin) {
  try {
    const r = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 15000 });
    const j = JSON.parse(stripAnsi(r.stdout || '{}'));
    return { ok: !!j.loggedIn, detail: j.loggedIn ? `已登录 (${j.authMethod || '?'}${j.apiProvider ? `, ${j.apiProvider}` : ''})` : '未登录（只影响 official profile）' };
  } catch (e) { return { ok: null, detail: `无法检查: ${e.message}` }; }
}

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
  const usesOfficial = c.leader === config.OFFICIAL || Object.values(c.roles).some((r) => r.profile === config.OFFICIAL);
  if (bin) { const a = claudeAuth(bin); add('claude.auth', usesOfficial ? a.ok : null, a.detail, usesOfficial && a.ok === false ? 'claude /login，或把用到 official 的角色改到别的 profile' : ''); }
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
    if (p.gateway && !c.gateways[p.gateway]) add(`profile.${name}`, false, `网关不存在: ${p.gateway}`, `hh profiles set ${name} --gateway <existing>`);
    if (p.bin && !which(expandHome(p.bin))) add(`profile.${name}`, false, `bin 不存在: ${p.bin}`, '');
  }
  add('leader', !!c.profiles[c.leader], c.leader, c.profiles[c.leader] ? '' : 'hh leader <profile>');
  for (const [name, ro] of Object.entries(c.roles)) {
    const pOk = !!c.profiles[ro.profile];
    const tpl = config.templatePath(ro.template);
    const tplOk = !tpl || fs.existsSync(tpl);
    const p = c.profiles[ro.profile];
    add(`role.${name}`, pOk && tplOk, `→ ${ro.profile}${p && p.gateway ? ` @ ${p.gateway}` : ''}${(ro.model || (p && p.model)) ? ` (${ro.model || p.model})` : ''} · ${ro.autonomy || 'full'} · ${ro.template || '-'}`, !pOk ? `profile ${ro.profile} 不存在` : !tplOk ? `模板缺失 ${shortHome(tpl)}` : '');
  }
  add('leader.skill', fs.existsSync(SKILL_FILE), shortHome(SKILL_FILE), fs.existsSync(SKILL_FILE) ? '' : '运行 install.sh');
  const mcpOk = fs.existsSync(CLAUDE_JSON) && /"hh"\s*:/.test(readText(CLAUDE_JSON, ''));
  add('leader.mcp', mcpOk ? true : null, mcpOk ? 'hh MCP 已注册' : '未注册（可选，hh 命令行本身够用）', mcpOk ? '' : 'hh install-mcp');
  const hInst = herdr.installed();
  const hRun = hInst && herdr.available();
  add('herdr', hInst ? true : null, hInst ? (hRun ? `运行中 · viewer=${c.viewer}（hh claude 开在 herdr 里，worker 各一个 tab）` : `已安装未运行 · viewer=${c.viewer}（hh claude 会自动启动 server）`) : `未安装（可选）· viewer=${c.viewer}，Leader 与 worker 都在终端 / 后台`, hInst ? '' : 'hh install herdr');
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

module.exports = {
  dispatch, dryRun, wait, status, read, result, task, send, cancel, close, closeWith, view, log, clean,
  launch, launchPlan, envOf, viewerSet, installDep, installCommand,
  gateways, gatewaysSet, gatewaysRm,
  profiles, profilesShow, profilesSet, profilesRm, profilesTest, profilesAliases, importAliases,
  roles, rolesSet, rolesRm, leaderSet,
  doctor, doctorNet, init, installMcp, version: PKG.version,
};
