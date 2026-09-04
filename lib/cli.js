'use strict';
// CLI：给人看是表格，给 Agent 看是 JSON（stdout 不是 TTY 时自动 JSON；--json / --plain 强制）。
const fs = require('fs');
const { HHError, readText, expandHome, shortHome, fmtDuration, ago, truncate, maskEnv, which } = require('./util');
const config = require('./config');
const api = require('./api');

const USAGE = `hh — herdr-hybrid v${api.version}：把你手里的多个订阅 / API key / 网关配成一批 Claude Code profile；聪明的当 Leader，便宜的干活

开始
  hh init [--force] [--no-setup]         生成配置；已有的 claude 启动 alias 会自动导入；没有任何端点时进入 hh setup
  hh setup                               交互式加一个「端点 + 模型」= 一个 profile，顺手指定它当 Leader 还是干活，并测连通
  hh install claude|herdr [--yes]        用官方安装脚本装缺的依赖（TTY 里先确认；herdr 可选）
  hh doctor [--net] [--all]              体检；--net 对角色用到的 profile 真发一次 pong（--all 全部 profile）
用 profile 启动 Claude Code
  hh claude                              Leader 模式：用 config.leader 在当前终端启动并注入 Leader 协议（herdr 在跑时 worker 各开一个 tab）
  hh claude herdr [profile]              同上，但把 Leader 开进 herdr 的新 tab（没装会问你要不要装；已在 herdr 里就原地启动）
  hh claude <profile> [claude 参数...]   普通模式：注入该 profile 的端点/密钥/模型，在当前终端启动交互式 Claude Code
  hh claude --leader <profile>           指定 profile 的 Leader 模式；--no-herdr 连 worker 也不开窗口；--dry-run 只打印不启动
  hh profiles aliases                    输出 alias <profile>cc='hh claude <profile>'，eval "$(hh profiles aliases)" 得到 fastcc 这类快捷命令
  hh env <profile> [--reveal] [-m M]     看将注入的环境变量（默认打码；--reveal 明文，供 env $(hh env X --reveal) 用）
派发与跟踪（Leader 用）
  hh dispatch -r ROLE [-p PROFILE] [-m MODEL] [-a full|workspace|readonly] [-l LABEL] [-d CWD] (-f FILE | -t "TASK")
              [--view auto|herdr|none] [--no-template] [--dry-run]
                                         写任务文件 → 用该 profile 无头启动 claude -p → 立即返回 run id
  hh wait ID... [--timeout 540]          阻塞到全部 done/failed/cancelled/crashed；超时退出码 2（再调一次即可）
  hh status [--all] [-n N]  ·  hh read ID [-n 60] [--raw]  ·  hh result ID  ·  hh task ID
  hh send ID (-t "TEXT" | -f FILE) [-a A] [--view V]   追加指令 / 返修：恢复同一会话继续干，返回新 run id
  hh cancel ID  ·  hh close ID [--force]  ·  hh view ID  ·  hh log [-n 20]  ·  hh clean [--days 7]
配置（端点 gateway = 地址 + 鉴权 + 密钥，只存一次；profile = 端点 + 模型；role = 给 Leader 用的分工）
  hh gateways                            网关列表（密钥打码）
  hh gateways set NAME --url U [--auth token|apikey] --secret S [--env K=V]... [--unset-env K]
  hh gateways rm NAME
  hh profiles                            profile 列表
  hh profiles show NAME
  hh profiles set NAME --gateway G|official --model M [--env K=V]... [--unset-env K] [--args JSON数组] [--bin B] [--note ...]
  hh profiles rm NAME  ·  hh profiles test NAME
  hh profiles import-aliases [--dry-run] [FILE...]      迁移：从形如 alias fastcc="ANTHROPIC_BASE_URL=… claude" 的 shell alias 导入（默认扫 ~/.shell_aliases ~/.zshrc ~/.bashrc）
  hh roles                               角色 → profile / 模型 / 自主级别 / 模板
  hh roles set ROLE --profile P [--model M] [--autonomy A] [--template T|-] [--desc "用途"]  ·  hh roles rm ROLE
  hh leader [PROFILE]                    查看 / 设置默认 Leader profile
  hh viewer [auto|herdr|none]            worker 开不开 herdr 窗口：auto = herdr 在跑就开（默认）· herdr = 总是，且 hh claude 也自动开进 herdr · none = 从不
Leader 接入
  hh install-mcp                         把 hh 注册成 Claude Code 的 MCP server（hh_dispatch / hh_wait / … 成为原生工具）
  hh mcp                                 以 MCP stdio server 方式运行（供 Claude Code 调用，不手动跑）
其它
  hh version · hh help
  通用: --json 强制 JSON；--plain 强制文本。stdout 不是 TTY（在 Agent 的 shell 里）时默认 JSON。
  环境变量: HH_CONFIG_DIR(~/.config/hh)  HH_STATE_DIR(~/.local/state/hh)  HH_ALIAS_FILES(冒号分隔的 alias 文件列表)
`;

// ---------- 参数解析 ----------
function parseArgs(argv, spec) {
  spec = spec || {};
  const aliases = {};
  for (const [name, s] of Object.entries(spec)) if (s.alias) aliases[s.alias] = name;
  const opts = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    let name = null; let val;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      if (eq >= 0) val = a.slice(eq + 1);
      if (name.startsWith('no-') && spec[name.slice(3)] && spec[name.slice(3)].type === 'bool') { opts[name.slice(3)] = false; continue; }
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      name = aliases[a.slice(1)] || a.slice(1);
    } else { pos.push(a); continue; }
    if (name === 'json' || name === 'plain' || name === 'help') { opts[name] = true; continue; }
    const s = spec[name];
    if (!s) throw new HHError('bad_arg', `未知参数: ${a}（hh help）`);
    if (s.type === 'bool') { opts[name] = val === undefined ? true : !/^(0|false|no)$/i.test(val); continue; }
    if (val === undefined) { if (i + 1 >= argv.length) throw new HHError('bad_arg', `参数 ${a} 需要值`); val = argv[++i]; }
    if (s.type === 'list') (opts[name] = opts[name] || []).push(val);
    else if (s.type === 'number') { opts[name] = Number(val); if (Number.isNaN(opts[name])) throw new HHError('bad_arg', `参数 ${a} 需要数字`); }
    else opts[name] = val;
  }
  return { opts, pos };
}

function jsonArg(v, what) {
  if (v === undefined) return undefined;
  const t = v.trim();
  if (t.startsWith('[')) { try { return JSON.parse(t); } catch (e) { throw new HHError('bad_arg', `${what} 不是合法 JSON 数组: ${v}`); } }
  return t ? t.split(/\s+/) : [];
}

function envArg(list) {
  const env = {};
  for (const kv of list || []) {
    const i = kv.indexOf('=');
    if (i <= 0) throw new HHError('bad_arg', `--env 需要 K=V: ${kv}`);
    env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return env;
}

// ---------- 输出 ----------
let JSON_MODE = false;
function out(obj, humanFn) {
  if (JSON_MODE || !humanFn) process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  else humanFn(obj);
}
function say(s) { process.stdout.write(`${s}\n`); }
function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r) == null ? '' : c.get(r)).length)));
  say(cols.map((c, i) => c.label.padEnd(widths[i])).join('  ').trimEnd());
  for (const r of rows) say(cols.map((c, i) => String(c.get(r) == null ? '' : c.get(r)).padEnd(widths[i])).join('  ').trimEnd());
}
const STATUS_ICON = { running: '●', starting: '◐', done: '✓', failed: '✗', cancelled: '⊘', crashed: '☠' };
function statusText(s) { return `${STATUS_ICON[s] || '·'} ${s}`; }
function hhmmss() { return new Date().toTimeString().slice(0, 8); }
function profileLabel(r) { return `${r.profile}${r.gateway ? `@${r.gateway}` : ''}${r.model ? `(${r.model})` : ''}`; }

function showRun(r) {
  say(`run      ${r.id}`);
  say(`role     ${r.role || '-'} → ${profileLabel(r)} · ${r.autonomy}`);
  say(`cwd      ${shortHome(r.cwd)}`);
  say(`task     ${shortHome(r.task_file)}`);
  say(`launch   ${r.viewer ? `herdr tab ${r.viewer.tab_id}` : 'detached'}${r.parent ? `   parent ${r.parent}${r.session_id ? ' (resumed)' : ''}` : ''}`);
  say(`status   ${statusText(r.status)}`);
  say(`next     hh wait ${r.id}   ·   hh read ${r.id}   ·   hh result ${r.id}`);
}

function showRuns(list) {
  if (!list.length) { say('(没有 run；hh dispatch 派一个)'); return; }
  table(list, [
    { label: 'ID', get: (r) => r.id },
    { label: 'STATUS', get: (r) => statusText(r.status) },
    { label: 'ROLE', get: (r) => r.role || '-' },
    { label: 'PROFILE', get: (r) => truncate(profileLabel(r), 34) },
    { label: 'TIME', get: (r) => (r.ended ? fmtDuration(r.duration_ms) : `${ago(r.created)}…`) },
    { label: 'CWD', get: (r) => truncate(shortHome(r.cwd), 30) },
    { label: 'REPORT/ERROR', get: (r) => truncate(r.error || (r.report && `${r.report.status || ''} ${r.report.summary || ''}`.trim()) || r.final || '', 50) },
  ]);
}

function showDoctor(d) {
  for (const c of d.checks) {
    const mark = c.ok === true ? '✓' : c.ok === false ? '✗' : '·';
    say(`${mark} ${c.name.padEnd(22)} ${c.detail}${c.hint ? `   → ${c.hint}` : ''}`);
  }
  say(d.ok ? 'doctor: ok' : 'doctor: 有问题（看 ✗ 行）');
}

function showImport(r, what) {
  const added = (xs) => xs.filter((x) => x.status === 'added');
  say(`${what}${r.dry_run ? '（dry-run，未写入）' : ''}:`);
  if (r.files) say(`  扫描: ${r.files.map(shortHome).join(', ') || '（没有文件）'}`);
  if (r.dir) say(`  目录: ${shortHome(r.dir)}`);
  say(`  网关 +${added(r.gateways).length}${added(r.gateways).length ? `: ${added(r.gateways).map((g) => g.name).join(', ')}` : ''}`);
  say(`  profile +${added(r.profiles).length}${added(r.profiles).length ? `: ${added(r.profiles).map((p) => p.name).join(', ')}` : ''}`);
  if (r.roles) say(`  角色 +${added(r.roles).length}${added(r.roles).length ? `: ${added(r.roles).map((x) => `${x.role}→${x.profile}`).join(', ')}` : ''}`);
  const ex = r.profiles.filter((p) => p.status === 'exists').length;
  if (ex) say(`  已存在跳过 ${ex} 个 profile`);
  for (const s of r.skipped) say(`  ! ${s}`);
}

// ---------- 命令 ----------
const CMD = {};

// 还没有任何端点时给的指引（只有 official 一个 profile，混动无从谈起）
function sayNoGateways() {
  say('');
  say('还没有任何端点（只有 official = claude 自己的登录）。混动至少要再加一个订阅 / API key / 网关，两种方式：');
  say('  hh setup                                             交互式加一个，顺手分工并测连通（推荐）');
  say('  hh gateways set NAME --url URL --auth token|apikey --secret KEY');
  say('  hh profiles set NAME --gateway NAME --model MODEL   然后 hh profiles test NAME');
  say('已经在 shell alias 里管着一批 key（alias fastcc="ANTHROPIC_BASE_URL=… claude"）：hh profiles import-aliases');
}

CMD.init = async (argv) => {
  const { opts } = parseArgs(argv, { force: { type: 'bool' }, setup: { type: 'bool' } });
  const r = api.init({ force: !!opts.force });
  const noGateways = !r.gateways.length;
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY) && !JSON_MODE;
  const autoSetup = noGateways && opts.setup !== false && interactive;
  out(r, () => {
    say(`配置已写入 ${shortHome(r.config)}`);
    say(`claude: ${r.claude || '✗ 未找到（安装 Claude Code）'}`);
    say(`herdr: ${r.herdr ? r.herdr : '未安装（可选，只影响观察窗口）'}`);
    if (r.aliases) showImport(r.aliases, '导入 shell alias');
    say(`端点 ${r.gateways.length} 个，profile ${r.profiles.length} 个（含 official），Leader 默认: ${r.leader}`);
    say('角色分工:');
    for (const [role, ro] of Object.entries(r.roles)) say(`  ${role.padEnd(11)} → ${ro.profile.padEnd(12)} ${(ro.autonomy || 'full').padEnd(9)} ${ro.template}`);
    if (r.roles_defaulted && !noGateways) say('  （没有导入到角色，全部默认 official；用 hh roles set <role> --profile <便宜的> 分工）');
    if (r.prompts.length) say(`模板已复制到 ${shortHome(config.PROMPTS_DIR)}/`);
    if (noGateways && !autoSetup) sayNoGateways();
    else if (!noGateways) say('下一步: hh doctor  →  hh profiles test <name>  →  hh roles set coder --profile <便宜的>  →  hh leader <聪明的>  →  hh claude');
  });
  if (autoSetup) { say(''); say('先把第一个端点配好再说：'); await CMD.setup([]); }
};

// ---------- hh setup：交互式加一个「端点 + 模型」= profile，顺手分工、测连通 ----------
function makeAsker() {
  const readline = require('readline');
  const output = JSON_MODE ? process.stderr : process.stdout; // JSON 模式下提示走 stderr，stdout 只留结果
  const tty = !!process.stdin.isTTY;
  const rl = readline.createInterface({ input: process.stdin, output: tty ? output : undefined, terminal: tty });
  let muted = false; // 密钥输入不回显（只在 TTY 有意义）
  if (tty && rl._writeToOutput) { const orig = rl._writeToOutput.bind(rl); rl._writeToOutput = (s) => { if (!muted) orig(s); }; }
  // 管道喂答案时所有行会一次到齐，用队列接住；不能用 rl.question（没在等的行会被丢掉）
  const queue = [];
  let waiter = null;
  let closed = false;
  const eof = () => new HHError('eof', '输入结束，setup 中止');
  rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w.resolve(l); } else queue.push(l); });
  rl.on('close', () => { closed = true; if (waiter) { const w = waiter; waiter = null; w.reject(eof()); } });
  const ask = (q, o) => new Promise((resolve, reject) => {
    o = o || {};
    const label = `${q}${o.def ? ` [${o.def}]` : ''}: `;
    const done = (ans) => { if (muted) { muted = false; output.write('\n'); } resolve((ans || '').trim() || o.def || ''); };
    if (tty) { rl.setPrompt(label); rl.prompt(); muted = !!o.secret; } else output.write(label);
    if (queue.length) return done(queue.shift());
    if (closed) return reject(eof());
    waiter = { resolve: done, reject };
    return undefined;
  });
  return { ask, close: () => { waiter = null; rl.close(); } };
}
const hostSlug = (url) => { try { return new URL(url).host.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase(); } catch (e) { return ''; } };

CMD.setup = async (argv) => {
  parseArgs(argv, {});
  config.load(); // 没配置先提示 hh init
  const io = makeAsker();
  const say2 = (s) => (JSON_MODE ? process.stderr : process.stdout).write(`${s}\n`);
  const added = [];
  try {
    say2('hh setup — 加一个端点（订阅 / API key / 网关）+ 模型 = 一个 profile。直接回车用 [默认值]；Ctrl-C 退出。');
    say2('密钥可以写 env:VAR_NAME 从环境变量取，配置文件里就不落明文。');
    for (;;) {
      let gwName; let profileName;
      try {
        const url = await io.ask('API 地址（ANTHROPIC_BASE_URL，例 https://api.example.com）');
        if (!/^https?:\/\/\S+$/.test(url)) { say2('  地址要以 http(s):// 开头且不含空白，重来。'); continue; }
        // 同一个地址已经有端点：默认复用（密钥只存一次），这一轮只加模型
        const existing = Object.entries(config.load().gateways).find(([, g]) => g.url.replace(/\/+$/, '') === url.replace(/\/+$/, ''));
        let reuse = false;
        if (existing) reuse = (await io.ask(`已有端点 ${existing[0]} 用同一个地址，复用它、只加一个模型？ Y/n`, { def: 'Y' })).toLowerCase().startsWith('y');
        let auth; let secret;
        if (reuse) gwName = existing[0];
        else {
          gwName = await io.ask('端点名', { def: hostSlug(url) || 'gw' });
          auth = (await io.ask('鉴权方式 token|apikey（token → ANTHROPIC_AUTH_TOKEN，apikey → ANTHROPIC_API_KEY；不确定选 token）', { def: 'token' })).toLowerCase();
          while (!config.AUTH.includes(auth)) auth = (await io.ask(`  只能是 ${config.AUTH.join(' 或 ')}`, { def: 'token' })).toLowerCase();
          secret = await io.ask('密钥（不回显）', { secret: true });
        }
        const model = await io.ask('模型 id（留空用端点默认；例 claude-sonnet-4-5 / gemini-2.5-pro）');
        const modelSlug = model ? model.split('/').pop().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '') : '';
        profileName = await io.ask('profile 名', { def: reuse ? (modelSlug || `${gwName}-2`) : gwName });
        if (!reuse) api.gatewaysSet(gwName, { url, auth, secret });
        api.profilesSet(profileName, { gateway: gwName, model: model || undefined });
      } catch (e) {
        if (e.code === 'eof') throw e;
        say2(`  ✗ ${e.message}，重新来一遍这个端点。`);
        continue;
      }
      say2(`  ✓ 端点 ${gwName} · profile ${profileName}`);
      const c = config.load();
      const leaderIsOfficial = !c.leader || c.leader === config.OFFICIAL;
      const coderIsOfficial = !c.roles.coder || c.roles.coder.profile === config.OFFICIAL;
      const def = leaderIsOfficial ? '1' : coderIsOfficial ? '2' : '3';
      const use = await io.ask(`这个 profile 用来做什么？ 1=当 Leader（最聪明的那个） 2=干活（coder / executor，便宜快的） 3=先不分配`, { def });
      const roles = [];
      if (use === '1') { api.leaderSet(profileName); say2(`  ✓ leader → ${profileName}`); }
      else if (use === '2') {
        for (const role of ['coder', 'executor']) { api.rolesSet(role, { profile: profileName }); roles.push(role); }
        say2(`  ✓ coder / executor → ${profileName}`);
      }
      let test = null;
      const doTest = (await io.ask('现在真发一次 pong 测连通？ Y/n', { def: 'Y' })).toLowerCase();
      if (doTest.startsWith('y')) {
        say2('  … 启动一个无头 claude 发 pong（10~30 秒）');
        try {
          test = await api.profilesTest(profileName, {});
          say2(`  ${test.ok ? '✓' : '✗'} ${test.status} ${fmtDuration(test.duration_ms)} → ${test.ok ? test.final : (test.error || test.final || '无回复')}${test.ok ? '' : `   （hh read ${test.id} 看详情；密钥 / 鉴权方式 / 地址三者最常错）`}`);
        } catch (e) { // 例如 env:VAR 当前 shell 没 export：端点和 profile 已经存好，只是这次测不了
          test = { ok: false, status: 'error', error: e.message };
          say2(`  ✗ 没测成: ${e.message}（配置已保存，稍后 hh profiles test ${profileName}）`);
        }
      }
      added.push({ gateway: gwName, profile: profileName, use: use === '1' ? 'leader' : use === '2' ? 'worker' : 'none', roles, test: test ? { ok: test.ok, status: test.status, error: test.error || null } : null });
      const more = (await io.ask('再加一个端点？ y/N', { def: 'N' })).toLowerCase();
      if (!more.startsWith('y')) break;
    }
  } finally { io.close(); }
  const c = config.load();
  const r = { added, leader: c.leader, roles: Object.fromEntries(Object.entries(c.roles).map(([k, v]) => [k, v.profile])) };
  out(r, () => {
    say('');
    say(`完成：leader = ${r.leader}；${Object.entries(r.roles).map(([k, v]) => `${k} → ${v}`).join('，')}`);
    if (r.leader === config.OFFICIAL || Object.values(r.roles).every((p) => p === r.leader)) say('提示：Leader 和干活的还是同一个模型。再 hh setup 加一个更便宜 / 更聪明的，或 hh roles set coder --profile <便宜的>。');
    say('下一步：hh doctor 体检  →  hh claude 启动 Leader，直接说需求  ·  hh claude <profile> 单独用某个 profile');
  });
};

CMD.doctor = async (argv) => {
  const { opts } = parseArgs(argv, { net: { type: 'bool' }, all: { type: 'bool' } });
  const d = api.doctor();
  if (opts.net) { const n = await api.doctorNet({ all: !!opts.all }); d.net = n; d.ok = d.ok && n.ok; }
  out(d, () => {
    showDoctor(d);
    if (d.net) for (const r of d.net.results) say(`${r.ok ? '✓' : '✗'} net.${String(r.profile).padEnd(18)} ${r.status || ''} ${fmtDuration(r.duration_ms)} ${r.ok ? `→ ${r.final}` : `→ ${r.error || r.final || ''}`}`);
  });
  if (!d.ok) process.exitCode = 3;
};

CMD.claude = async (argv) => {
  if (argv[0] === '-h' || argv[0] === '--help') {
    say('用法: hh claude [herdr] [--leader] [--no-herdr] [--dry-run] [profile] [claude 参数...]');
    say('  不给 profile = 用 config.leader 并进入 Leader 模式（协议注入 system prompt）；给了 profile = 普通启动；--leader 让指定 profile 也进 Leader 模式');
    return;
  }
  let leader = false;
  let dry = argv.includes('--dry-run');
  let herdrOpt; // undefined = 按模式和 viewer；true = --herdr；false = --no-herdr
  if (argv.includes('--no-herdr')) herdrOpt = false; else if (argv.includes('--herdr')) herdrOpt = true;
  const inTab = argv.includes('--in-herdr-tab'); // 隐藏参数：herdr tab 里重放时带上，原地启动、不再开 tab，也不动 viewer
  argv = argv.filter((a) => a !== '--herdr' && a !== '--no-herdr' && a !== '--in-herdr-tab');
  const note = (s) => (JSON_MODE ? process.stderr : process.stdout).write(`${s}\n`); // 提示行：JSON 模式下不污染 stdout
  if (dry) { // dry-run 是 hh 自己的输出，此时 --json / --plain 也归 hh
    if (argv.includes('--json')) JSON_MODE = true;
    if (argv.includes('--plain')) JSON_MODE = false;
    argv = argv.filter((a) => a !== '--json' && a !== '--plain' && a !== '--dry-run');
  }
  let i = 0;
  while (i < argv.length && (argv[i] === '--leader' || argv[i] === 'herdr')) { // `hh claude herdr [profile]`：把 Leader 开进 herdr
    if (argv[i] === 'herdr') { if (herdrOpt !== false) herdrOpt = true; } else leader = true;
    i++;
  }
  let profile = argv[i];
  let pass = argv.slice(i + 1);
  if (!profile || profile.startsWith('-')) { profile = config.load().leader; pass = argv.slice(i); leader = true; }
  const lopts = { leader, herdr: herdrOpt, inTab };
  if (dry) {
    const p = api.launchPlan(profile, pass, lopts);
    return out({ profile, leader, launch: p.launch, reason: p.reason, hint: p.hint || null, bin: p.resolved.bin, argv: p.argv.map((a) => (a.length > 120 ? `${a.slice(0, 100)}…(${a.length} chars)` : a)), env: maskEnv(p.resolved.env), unset: p.resolved.unset, herdr_argv: p.launch === 'herdr' ? p.herdrArgv : null, prompt: p.prompt }, (d) => {
      say(`# ${d.leader ? 'Leader 模式' : '普通模式'} · profile ${d.profile}`);
      say(`launch   ${d.launch}（${d.reason}）${d.launch === 'herdr' ? `  → herdr tab 里跑: hh claude --no-herdr ${d.herdr_argv.join(' ')}` : ''}`);
      if (d.hint) say(`hint     ${d.hint}`);
      say(`${d.bin} ${d.argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
      for (const [k, v] of Object.entries(d.env)) say(`${k}=${v}`);
      if (d.prompt) { say(''); say('--- 注入的 system prompt（环境快照部分）---'); for (const l of d.prompt.split('\n').slice(0, 20)) say(l); say(`… 共 ${d.prompt.length} 字符，后面是协议正文`); }
    });
  }
  note(`# hh: ${leader ? 'Leader 模式（协议已注入）' : '普通模式'} · profile ${profile}`);
  if (leader) {
    const c = config.load();
    const names = Object.keys(c.profiles);
    const workers = new Set(Object.values(c.roles).map((r) => r.profile));
    if (names.length <= 1) process.stderr.write('hh: 只有 official 一个 profile，Leader 和 worker 会是同一个模型。先 hh setup 加一个端点再混动（现在照样能用，只是不省钱）。\n');
    else if (workers.size === 1 && workers.has(profile)) process.stderr.write(`hh: 所有角色都指向 Leader 自己的 profile ${profile}。hh roles set coder --profile <便宜的> 才是混动。\n`);
  }
  let plan = api.launchPlan(profile, pass, lopts);
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY) && !JSON_MODE;
  // 缺依赖：终端里问一句，回车就用官方脚本装上，装好接着开；非 TTY 只提示不代跑安装脚本
  const offer = async (what, question, after) => {
    const io = makeAsker();
    let go = false;
    try { go = (await io.ask(question, { def: 'Y' })).toLowerCase().startsWith('y'); } finally { io.close(); }
    if (!go) return false;
    const r = api.installDep(what, { run: true });
    if (r.ok) {
      say(`✓ ${what} 已安装: ${r.path}`);
      if (r.path_hint) { // 官方脚本装到 ~/.local/bin，新机器常不在 PATH：这次先加进本进程，子进程也能找到
        process.env.PATH = `${r.path_hint}${require('path').delimiter}${process.env.PATH || ''}`;
        say(`  ${r.path_hint} 不在 PATH 里，本次已临时加上；把 export PATH="${r.path_hint}:$PATH" 写进 shell 配置后长期生效`);
      }
      return after();
    }
    say(`✗ ${what} 安装脚本退出码 ${r.exit}。手动: ${r.command}  或  ${r.alt}`);
    return false;
  };
  if (!which(plan.resolved.bin)) {
    if (plan.resolved.bin === 'claude' && tty) {
      const ok = await offer('claude', '没装 Claude Code。现在用官方脚本装上再启动？（curl -fsSL https://claude.ai/install.sh | bash）Y/n', () => true);
      if (!ok) throw new HHError('no_claude', '没有 claude：hh install claude，或 config.claude.bin 指到已有的可执行文件');
    } else throw new HHError('no_claude', `找不到 ${plan.resolved.bin}：hh install claude，或 config.claude.bin 指到已有的可执行文件`);
  }
  if (plan.missing === 'herdr' && tty) {
    const ok = await offer('herdr', `没装 herdr。装上并把 Leader 开进 herdr？每个 worker 也会各有一个窗口（${api.installCommand('herdr')}）Y/n`, () => true);
    if (ok) plan = api.launchPlan(profile, pass, lopts);
    else { say('好，这次留在当前终端。'); plan.hint = null; }
  }
  if (plan.hint) process.stderr.write(`hh: ${plan.hint}\n`);
  if (plan.launch === 'pane') note(`# hh: ${inTab ? 'herdr tab 内启动' : '已经在 herdr 里，原地启动'}；派出的 worker 各开一个 tab`);
  if (plan.launch === 'herdr') note(`# hh: 开到 herdr 工作区 ${plan.workspace} 的新 tab（${plan.reason}）…`);
  const r = await api.launch(profile, pass, lopts);
  if (r.launch === 'herdr' && r.tab) {
    out({ launch: 'herdr', profile, leader, tab: r.tab, workspace: r.workspace, attached: r.attached }, () => {
      if (r.attached) say(`# hh: 已退出 herdr 客户端；Leader 仍在工作区 ${r.workspace} 的 tab ${r.tab.tab_id} 里运行，输入 herdr 可回去`);
      else say(`# hh: Leader 已在工作区 ${r.workspace} 的 tab ${r.tab.tab_id} 启动；本终端不是 TTY，没有附着客户端，打开 herdr 即可看到`);
    });
  } else if (JSON_MODE) out({ launch: r.launch, reason: r.reason || null, profile, leader, code: r.code });
  process.exitCode = r.code;
  return undefined;
};

// ---------- hh install claude|herdr：官方安装脚本 ----------
CMD.install = async (argv) => {
  const { opts, pos } = parseArgs(argv, { yes: { alias: 'y', type: 'bool' } });
  const name = pos[0];
  if (!name) throw new HHError('bad_arg', 'hh install <claude|herdr> [--yes]');
  let r = api.installDep(name, { run: false });
  if (r.already) return out(r, () => say(`✓ ${name} 已安装: ${r.path}`));
  let go = !!opts.yes;
  if (!go && process.stdin.isTTY && process.stdout.isTTY && !JSON_MODE) {
    const io = makeAsker();
    try { go = (await io.ask(`安装 ${r.what}？将执行: ${r.command}  Y/n`, { def: 'Y' })).toLowerCase().startsWith('y'); } finally { io.close(); }
  }
  if (!go) return out(r, () => { say(`未安装 ${name}。手动执行: ${r.command}`); say(`或: ${r.alt}`); say(`不问直接装: hh install ${name} --yes`); });
  r = api.installDep(name, { run: true });
  return out(r, () => {
    if (r.manual) { say(`Windows 请手动执行: ${r.command}`); return; }
    if (r.ok) {
      say(`✓ ${name} 已安装: ${r.path}`);
      if (r.path_hint) say(`注意: ${r.path_hint} 不在 PATH 里，把 export PATH="${r.path_hint}:$PATH" 写进 shell 配置后重开终端`);
    } else { say(`✗ 安装脚本退出码 ${r.exit}。手动试试: ${r.command}  或  ${r.alt}`); process.exitCode = 3; }
  });
};

CMD.viewer = async (argv) => {
  if (argv[0]) { const r = api.viewerSet(argv[0]); return out(r, () => say(`viewer → ${r.viewer}`)); }
  const c = config.load();
  return out({ viewer: c.viewer }, () => say(c.viewer));
};

CMD.env = async (argv) => {
  const { opts, pos } = parseArgs(argv, { reveal: { type: 'bool' }, model: { alias: 'm' } });
  if (!pos[0]) throw new HHError('need_profile', 'hh env <profile> [--reveal]');
  const r = api.envOf(pos[0], { reveal: !!opts.reveal, model: opts.model });
  out(r, () => {
    say(`# ${r.profile}${r.gateway ? ` @ ${r.gateway}` : ' (official)'}${r.model ? ` · ${r.model}` : ''} · bin ${r.bin}${r.args.length ? ` · args ${JSON.stringify(r.args)}` : ''}`);
    if (r.unset.length) say(`# 会从继承环境清掉: ${r.unset.join(' ')}`);
    for (const [k, v] of Object.entries(r.env)) say(`${k}=${v}`);
  });
};

const DISPATCH_SPEC = {
  role: { alias: 'r' }, profile: { alias: 'p' }, model: { alias: 'm' }, autonomy: { alias: 'a' }, label: { alias: 'l' }, cwd: { alias: 'd' },
  file: { alias: 'f' }, task: { alias: 't' }, view: {}, template: { type: 'bool' }, 'dry-run': { type: 'bool' },
};
CMD.dispatch = async (argv) => {
  const { opts, pos } = parseArgs(argv, DISPATCH_SPEC);
  if (pos.length && !opts.task && !opts.file) opts.task = pos.join(' ');
  const o = { role: opts.role, profile: opts.profile, model: opts.model, autonomy: opts.autonomy, label: opts.label, cwd: opts.cwd, task: opts.task, taskFile: opts.file, view: opts.view, noTemplate: opts.template === false };
  if (opts['dry-run']) {
    const d = api.dryRun(o);
    return out(d, () => {
      say(`profile  ${d.profile}${d.gateway ? ` @ ${d.gateway}` : ' (official)'}${d.model ? ` · ${d.model}` : ''} · ${d.autonomy}${d.bin_path ? '' : `   ✗ 找不到 ${d.bin}`}`);
      say(`cwd      ${shortHome(d.cwd)}`);
      say(`template ${d.template || '-'}`);
      say(`command  ${[d.bin].concat(d.argv).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}   (task.md 走 stdin)`);
      say(`env      ${Object.entries(d.env).map(([k, v]) => `${k}=${v}`).join(' ') || '（无）'}`);
      if (d.unset.length) say(`unset    ${d.unset.join(' ')}`);
    });
  }
  const r = api.dispatch(o);
  out(r, () => showRun(r.run));
};

CMD.wait = async (argv) => {
  const { opts, pos } = parseArgs(argv, { timeout: { alias: 't', type: 'number' }, interval: { type: 'number' } });
  if (!pos.length) throw new HHError('need_id', 'hh wait ID... [--timeout 540]');
  const r = await api.wait(pos, { timeout: opts.timeout, interval: opts.interval, onChange: JSON_MODE ? null : (st) => say(`[${hhmmss()}] ${st.map((s) => `${s.id}=${s.status}`).join('  ')}`) });
  out(r, () => { say(r.settled ? `ALL_SETTLED (${r.elapsed_s}s)` : `TIMEOUT after ${r.elapsed_s}s（再调一次 hh wait）`); showRuns(r.runs); });
  if (!r.settled) process.exitCode = 2;
};

CMD.status = async (argv) => {
  const { opts } = parseArgs(argv, { all: { type: 'bool' }, limit: { alias: 'n', type: 'number' } });
  const r = api.status({ all: !!opts.all, limit: opts.limit });
  out(r, () => showRuns(r.runs));
};

CMD.read = async (argv) => {
  const { opts, pos } = parseArgs(argv, { lines: { alias: 'n', type: 'number' }, raw: { type: 'bool' } });
  const r = api.read(pos[0], { lines: opts.lines, raw: !!opts.raw });
  out(r, () => { say(`# ${r.id} · ${statusText(r.status)}`); for (const l of r.lines) say(l); });
};

CMD.result = async (argv) => {
  const { pos } = parseArgs(argv, {});
  const r = api.result(pos[0]);
  out(r, () => {
    const x = r.run;
    say(`# ${x.id} · ${statusText(x.status)} · ${x.role || '-'} → ${profileLabel(x)} · ${fmtDuration(x.duration_ms)}${x.exit_code != null ? ` · exit ${x.exit_code}` : ''}`);
    if (x.session_id) say(`session  ${x.session_id}`);
    if (x.usage) say(`usage    ${Object.entries(x.usage).filter(([, v]) => v != null).map(([k, v]) => `${k}=${typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(4) : v}`).join(' ')}`);
    if (x.error) say(`error    ${x.error}`);
    if (x.report) say(`report   ${JSON.stringify(x.report)}`);
    say('');
    say(x.final || '(无最终回复)');
  });
};

CMD.task = async (argv) => { const { pos } = parseArgs(argv, {}); const r = api.task(pos[0]); out(r, () => say(r.task)); };

CMD.send = async (argv) => {
  const { opts, pos } = parseArgs(argv, { task: { alias: 't' }, file: { alias: 'f' }, view: {}, autonomy: { alias: 'a' } });
  let text = opts.task;
  if (opts.file) text = readText(expandHome(opts.file));
  if (!text && pos.length > 1) text = pos.slice(1).join(' ');
  const r = api.send(pos[0], text, { view: opts.view, autonomy: opts.autonomy });
  out(r, () => showRun(r.run));
};

CMD.cancel = async (argv) => { const { pos } = parseArgs(argv, {}); const r = await api.cancel(pos[0]); out(r, () => say(`${r.run.id} → ${statusText(r.run.status)}`)); };
CMD.close = async (argv) => {
  const { opts, pos } = parseArgs(argv, { force: { type: 'bool' } });
  const r = await api.close(pos[0], { force: !!opts.force });
  out(r, () => say(`${r.id} ${statusText(r.status)} · tab ${r.tab_closed ? '已关' : r.tab_error ? `关闭失败: ${r.tab_error}` : '无'}`));
};
CMD.view = async (argv) => { const { pos } = parseArgs(argv, {}); const r = api.view(pos[0]); out(r, () => say(`观察 tab ${r.tab.tab_id} (${r.tab.pane_id}) ← ${r.id}`)); };
CMD.log = async (argv) => {
  const { opts } = parseArgs(argv, { lines: { alias: 'n', type: 'number' } });
  const r = api.log(opts.lines || 20);
  out(r, () => {
    if (!r.events.length) return say('(暂无事件)');
    for (const e of r.events) say(`${(e.ts || '').replace('T', ' ').slice(0, 19)}  ${(e.kind || '?').padEnd(13)} ${e.id || e.role || e.profile || e.gateway || ''}  ${e.status || e.label || ''}${e.error ? `  ${e.error}` : ''}`);
  });
};
CMD.clean = async (argv) => { const { opts } = parseArgs(argv, { days: { type: 'number' } }); const r = api.clean({ days: opts.days }); out(r, () => say(`删除 ${r.removed.length} 个 run 目录`)); };

CMD.roles = async (argv) => {
  const sub = argv[0];
  if (sub === 'set') {
    const { opts, pos } = parseArgs(argv.slice(1), { profile: { alias: 'p' }, model: { alias: 'm' }, autonomy: { alias: 'a' }, template: {}, desc: {} });
    const r = api.rolesSet(pos[0], { profile: opts.profile, model: opts.model, autonomy: opts.autonomy, template: opts.template, desc: opts.desc });
    return out(r, () => say(`= ${r.role} → ${r.config.profile}${r.config.model ? ` (${r.config.model})` : ''} · ${r.config.autonomy || 'full'} · ${r.config.template}${r.config.desc ? ` · ${r.config.desc}` : ''}`));
  }
  if (sub === 'rm') { const r = api.rolesRm(argv[1]); return out(r, () => say(`- role ${r.removed}`)); }
  if (sub && sub !== 'list') throw new HHError('bad_arg', 'hh roles [set ROLE --profile P | rm ROLE]');
  const r = api.roles();
  out(r, () => {
    say(`leader: ${r.leader || '-'}`);
    table(r.roles, [
      { label: 'ROLE', get: (x) => x.role },
      { label: 'PROFILE', get: (x) => `${x.profile}${x.profile_ok ? '' : ' ✗'}` },
      { label: 'GATEWAY', get: (x) => x.gateway || 'official' },
      { label: 'MODEL', get: (x) => x.model || '-' },
      { label: 'AUTONOMY', get: (x) => x.autonomy },
      { label: 'TEMPLATE', get: (x) => `${x.template || '-'}${x.template_ok ? '' : ' ✗'}` },
      { label: 'DESC', get: (x) => truncate(x.desc || '', 40) },
    ]);
  });
};

CMD.leader = async (argv) => {
  if (argv[0]) { const r = api.leaderSet(argv[0]); return out(r, () => say(`leader → ${r.leader}`)); }
  const r = api.roles();
  out({ leader: r.leader }, () => say(r.leader));
};

function showGateways(list) {
  if (!list.length) return say('(没有网关；hh gateways set 或 hh profiles import-aliases)');
  table(list, [
    { label: 'NAME', get: (g) => g.name },
    { label: 'URL', get: (g) => g.url },
    { label: 'AUTH', get: (g) => g.auth },
    { label: 'SECRET', get: (g) => g.secret_ref || g.secret },
    { label: 'ENV', get: (g) => Object.entries(g.env).map(([k, v]) => `${k}=${v}`).join(',') },
  ]);
}
CMD.gateways = async (argv) => {
  const sub = argv[0];
  if (sub === 'set') {
    const { opts, pos } = parseArgs(argv.slice(1), { url: {}, auth: {}, secret: {}, env: { type: 'list' }, 'unset-env': { type: 'list' } });
    const r = api.gatewaysSet(pos[0], { url: opts.url, auth: opts.auth, secret: opts.secret, env: envArg(opts.env), unsetEnv: opts['unset-env'] });
    return out(r, () => showGateways([r.gateway]));
  }
  if (sub === 'rm') { const r = api.gatewaysRm(argv[1]); return out(r, () => say(`- gateway ${r.removed}`)); }
  if (sub && sub !== 'list') throw new HHError('bad_arg', 'hh gateways [set NAME --url U --secret S | rm NAME]');
  const r = api.gateways();
  out(r, () => showGateways(r.gateways));
};

function showProfiles(list) {
  if (!list.length) return say('(没有 profile)');
  table(list, [
    { label: 'PROFILE', get: (p) => p.name },
    { label: 'GATEWAY', get: (p) => `${p.gateway || 'official'}${p.gateway_ok ? '' : ' ✗'}` },
    { label: 'MODEL', get: (p) => p.model || '-' },
    { label: 'ROLES', get: (p) => p.roles.join(',') },
    { label: 'ENV/ARGS', get: (p) => truncate([...Object.entries(p.env).map(([k, v]) => `${k}=${v}`), ...(p.args.length ? [`args ${JSON.stringify(p.args)}`] : [])].join(' '), 40) },
    { label: 'NOTE', get: (p) => truncate(p.note || '', 30) },
  ]);
}
CMD.profiles = async (argv) => {
  const sub = argv[0];
  if (sub === 'set') {
    const { opts, pos } = parseArgs(argv.slice(1), { gateway: { alias: 'g' }, model: { alias: 'm' }, env: { type: 'list' }, 'unset-env': { type: 'list' }, args: {}, bin: {}, note: {} });
    const r = api.profilesSet(pos[0], { gateway: opts.gateway, model: opts.model, env: envArg(opts.env), unsetEnv: opts['unset-env'], args: jsonArg(opts.args, '--args'), bin: opts.bin, note: opts.note });
    return out(r, () => showProfiles([r.profile]));
  }
  if (sub === 'rm') { const r = api.profilesRm(argv[1]); return out(r, () => say(`- profile ${r.removed}`)); }
  if (sub === 'show') { const r = api.profilesShow(argv[1]); return out(r, () => showProfiles([r.profile])); }
  if (sub === 'test') {
    const r = await api.profilesTest(argv[1], {});
    out(r, () => say(`${r.ok ? '✓' : '✗'} ${r.profile}${r.gateway ? ` @ ${r.gateway}` : ''}${r.model ? ` (${r.model})` : ''}: ${r.status} ${fmtDuration(r.duration_ms)} → ${r.ok ? r.final : (r.error || r.final || '无回复')}   (hh read ${r.id})`));
    if (!r.ok) process.exitCode = 3;
    return undefined;
  }
  if (sub === 'aliases') {
    const { opts } = parseArgs(argv.slice(1), { suffix: {} });
    const r = api.profilesAliases({ suffix: opts.suffix });
    return out(r, () => { for (const l of r.lines) say(l); });
  }
  if (sub === 'import-aliases') {
    const { opts, pos } = parseArgs(argv.slice(1), { 'dry-run': { type: 'bool' } });
    const r = api.importAliases(pos, { dryRun: !!opts['dry-run'] });
    return out(r, () => showImport(r, '导入 shell alias'));
  }
  if (sub && sub !== 'list') throw new HHError('bad_arg', 'hh profiles [show|set|rm|test NAME | aliases | import-aliases]');
  const r = api.profiles();
  out(r, () => { say(`leader: ${r.leader}`); showProfiles(r.profiles); });
};

CMD['install-mcp'] = async () => {
  const r = api.installMcp();
  out(r, () => say(`${r.ok ? '✓' : '✗'} ${r.command}   ${r.detail}`));
  if (!r.ok) process.exitCode = 3;
};

CMD.mcp = async () => { require('./mcp').serve(); await new Promise(() => {}); };
CMD._worker = async (argv) => { await require('./worker').main(argv[0]); await new Promise(() => {}); };
CMD.version = async () => out({ version: api.version }, () => say(`hh ${api.version}`));
CMD.help = async () => say(USAGE);

async function main(argv) {
  process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
  const cmd = argv[0];
  try {
    if (cmd === 'claude') { JSON_MODE = !process.stdout.isTTY; return await CMD.claude(argv.slice(1)); } // 参数原样透传给 claude（只有 --dry-run 会输出）
    const rest = argv.filter((a) => a !== '--json' && a !== '--plain');
    JSON_MODE = argv.includes('--json') || (!argv.includes('--plain') && !process.stdout.isTTY);
    // 给 shell 吃的输出（eval "$(hh profiles aliases)"、env $(hh env X --reveal)）默认纯文本，显式 --json 才给 JSON
    if (!argv.includes('--json') && ((cmd === 'profiles' && rest[1] === 'aliases') || (cmd === 'env' && rest.includes('--reveal')))) JSON_MODE = false;
    const args = rest.slice(1);
    if (!cmd || cmd === '-h' || cmd === '--help') return CMD.help();
    if (cmd === '--version' || cmd === '-v') return CMD.version();
    const fn = CMD[cmd];
    if (!fn) throw new HHError('bad_cmd', `未知子命令: ${cmd}（hh help）`);
    if (args.includes('-h') || args.includes('--help')) return CMD.help();
    await fn(args);
  } catch (e) {
    const code = e instanceof HHError ? e.code : 'error';
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ error: { code, message: e.message } })}\n`);
    else process.stderr.write(`hh: ${e.message}\n`);
    if (!(e instanceof HHError) && process.env.HH_DEBUG) process.stderr.write(`${e.stack}\n`);
    process.exitCode = 1;
  }
  return undefined;
}

module.exports = { main, parseArgs };
