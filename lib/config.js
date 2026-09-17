'use strict';
// 配置：~/.config/hh/config.json
//   gateways  网关：url + 鉴权 + 密钥 + 该网关公共 env
//   profiles  模型 profile：网关 + model_id + 专属 env/args；`official` = 不注入，用 claude 自己的登录/当前环境
//   roles     角色：profile + 模板 + 自主级别
// 同一份配置既用于 `hh claude <profile>` 交互式启动（用 profile 启动 Claude Code），也用于 `hh dispatch` 无头派发。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HHError, expandHome, readJson, writeJson, readText, which } = require('./util');
const agents = require('./agents');

const ROOT = path.resolve(__dirname, '..');
const HH_BIN = path.join(ROOT, 'bin', 'hh');
const MOD_DIR = path.join(ROOT, 'mod'); // 可视化配置界面（Claude Code function hooks）
const CONFIG_DIR = expandHome(process.env.HH_CONFIG_DIR || '~/.config/hh');
const STATE_DIR = expandHome(process.env.HH_STATE_DIR || '~/.local/state/hh');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PROMPTS_DIR = path.join(CONFIG_DIR, 'prompts');
const REPO_PROMPTS = path.join(ROOT, 'prompts');
const ALIAS_FILES = (process.env.HH_ALIAS_FILES ? process.env.HH_ALIAS_FILES.split(':') : ['~/.shell_aliases', '~/.zshrc', '~/.bashrc']).map(expandHome);

const OFFICIAL = 'official';
const AUTONOMY = ['full', 'workspace', 'readonly'];
const VIEWERS = ['auto', 'herdr', 'none']; // auto = 装了 herdr 就用；herdr = 必须；none = 从不开窗口
// /hh-config 面板贴哪边。位置由终端布局决定、插件改不了：fullscreen 布局把 pane 停在右侧
// （≥110 列），main screen 则放在提示框上方。开关就是 CLAUDE_CODE_NO_FLICKER：
//   right  = NO_FLICKER 保持 1（hh 的默认，无闪烁）→ 右侧
//   bottom = 启动 Leader 时改注入 0 → 底部，代价是整屏可能有重绘闪烁
const PANES = ['right', 'bottom'];
const AUTH = ['token', 'apikey'];
// 兼容导出：老代码 / 文档里引用的是 Claude 的键名，实际清理用 agents.allEnvKeys()
const MODEL_ENV_KEYS = agents.get('claude').modelEnvKeys;
const GATEWAY_ENV_KEYS = agents.get('claude').envKeys;
const DEFAULT_COMMON_ENV = { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_NO_FLICKER: '1', API_TIMEOUT_MS: '3000000' };

// 角色是数据：名字任意，desc 告诉 Leader 这个角色是干什么的（会注入 Leader 的 prompt）
const ROLE_DEFAULTS = {
  coder: { autonomy: 'full', desc: '实现明确边界内的改动，跑验收命令，按文件提交' },
  executor: { autonomy: 'full', desc: '跑脚本、批处理、环境操作，不改源码' },
  reviewer: { autonomy: 'readonly', desc: '只读审查 diff / 文件，输出严重度分级的问题表和结论' },
  researcher: { autonomy: 'readonly', desc: '只读调研代码与文档、方案对比，给出带证据（文件:行号）的推荐' },
};

// worker 的汇报契约：末尾附一个 JSON 报告，hh 解析进 result.report，Leader 拿数据核对而不是读散文
const REPORT_SCHEMA = '{"status":"done|partial|blocked","summary":"一句话结论","changed":["改过的文件路径"],"commits":["commit id"],"verified":[{"cmd":"跑过的验收命令","ok":true}],"assumptions":["你做的假设"],"blockers":["没做完的原因"]}';
const DEFAULT_FOOTER = [
  '## 完成要求',
  '',
  '- 全程不要向 Leader 提问、不要停下来等确认；无法继续就说明原因后结束。',
  '- 最后用中文总结：做了什么（文件路径 / commit id / 产物路径）、验收命令及结果、未完成项与假设。',
  '- 总结之后，在回复的最末尾附**一个** ```json 代码块作为机器可读报告（只此一个 json 块），字段：',
  `  ${REPORT_SCHEMA}`,
  '  没有的字段给空数组；只读任务 changed / commits 为空。',
].join('\n');
// 旧版本默认页脚：load 时若用户没改过就升级到新版
const LEGACY_FOOTERS = [
  ['## 完成要求', '', '- 全程不要向 Leader 提问、不要停下来等确认；无法继续就说明原因后结束。', '- 最后用中文总结：做了什么（文件路径 / commit id / 产物路径）、验收命令及结果、未完成项与假设。'].join('\n'),
];

function defaults() {
  return {
    version: 2,
    leader: OFFICIAL,
    viewer: 'auto',
    workspace: 'w1',
    footer: DEFAULT_FOOTER,
    claude: { bin: 'claude', interactiveArgs: ['--dangerously-skip-permissions'], pane: 'right' },
    codex: { bin: 'codex', interactiveArgs: [] },
    commonEnv: Object.assign({}, DEFAULT_COMMON_ENV),
    gateways: {},
    profiles: { [OFFICIAL]: { gateway: null, note: '不注入网关：用 claude 自己的登录 / 当前环境' } },
    roles: {},
  };
}

function exists() { return fs.existsSync(CONFIG_FILE); }

// ---------- 并发保护 ----------
// writeJson 用 tmp+rename，单次写是原子的；但「读 → 改 → 写」整体没锁：
// 两个 hh 同时改配置（Leader 和 worker 都能调 hh；可视化界面保存时后台也可能在写），
// 各自读到同一份旧配置，后 rename 的把前一个的改动整个盖掉 —— 实测必现丢失。
// 这里用 O_EXCL 建锁文件把整个读-改-写串起来。
const LOCK_FILE = path.join(CONFIG_DIR, 'config.lock');
const LOCK_STALE_MS = 10 * 1000;
const LOCK_WAIT_MS = 5000;

// 同步睡眠：save() 是同步 API，不能 await。Atomics.wait 是零依赖里唯一干净的办法。
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (e) { /* 拿不到就空转一下 */ }
}

function acquireLock() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx', 0o600);
      fs.writeSync(fd, `${process.pid}\n`);
      return fd;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 持锁进程崩了会留下死锁文件：超过 LOCK_STALE_MS 就抢过来
      let stale = false;
      try { stale = Date.now() - fs.statSync(LOCK_FILE).mtimeMs > LOCK_STALE_MS; } catch (e2) { stale = false; }
      if (stale) { try { fs.unlinkSync(LOCK_FILE); } catch (e2) { /* 别人先删了 */ } continue; }
      if (Date.now() > deadline) throw new HHError('locked', `配置被其它 hh 进程占用超过 ${LOCK_WAIT_MS / 1000} 秒：${LOCK_FILE}（确认没有卡住的 hh 后可手动删除）`);
      sleepSync(25);
    }
  }
}

function releaseLock(fd) {
  try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(LOCK_FILE); } catch (e) { /* ignore */ }
}

// 读-改-写一把锁：mutate(cfg) 里改传进来的 cfg，返回值原样带出。
// 注意 mutate 必须是同步的，锁才有意义。
function update(mutate) {
  const fd = acquireLock();
  try {
    const cfg = load();
    const out = mutate(cfg);
    save(cfg);
    return out;
  } finally {
    releaseLock(fd);
  }
}

function normalize(cfg) {
  if (cfg.runners) { // 1.0-rc 的多 CLI 格式：丢弃 runners 和指向它们的角色
    delete cfg.runners;
    for (const [r, ro] of Object.entries(cfg.roles || {})) if (!ro.profile) delete cfg.roles[r];
    cfg.version = 2;
  }
  cfg.claude = Object.assign({ bin: 'claude', interactiveArgs: ['--dangerously-skip-permissions'], pane: 'right' }, cfg.claude || {});
  cfg.codex = Object.assign({ bin: 'codex', interactiveArgs: [] }, cfg.codex || {});
  if (!PANES.includes(cfg.claude.pane)) cfg.claude.pane = 'right';
  if (!VIEWERS.includes(cfg.viewer)) cfg.viewer = 'auto';
  if (!cfg.footer || LEGACY_FOOTERS.includes(cfg.footer)) cfg.footer = DEFAULT_FOOTER;
  cfg.commonEnv = cfg.commonEnv || {};
  cfg.gateways = cfg.gateways || {};
  cfg.profiles = cfg.profiles || {};
  cfg.roles = cfg.roles || {};
  if (!cfg.profiles[OFFICIAL]) cfg.profiles[OFFICIAL] = defaults().profiles[OFFICIAL];
  for (const [role, ro] of Object.entries(cfg.roles)) if (ro && !ro.desc && ROLE_DEFAULTS[role]) ro.desc = ROLE_DEFAULTS[role].desc; // 旧配置回填默认用途
  return cfg;
}

// 实际生效的 viewer：`hh claude --no-herdr` 给 Leader 进程设 HH_VIEWER=none，让它派的 worker 也不开窗口。
// 只在本进程生效，不写进 cfg（否则 Leader 里一次 hh roles set 就把 none 持久化进 config.json）
function effectiveViewer(cfg) {
  const v = process.env.HH_VIEWER;
  return VIEWERS.includes(v) ? v : cfg.viewer;
}

function load(opts) {
  opts = opts || {};
  if (!exists()) {
    if (opts.optional) return null;
    throw new HHError('no_config', `缺少配置 ${CONFIG_FILE}，先运行: hh init`);
  }
  return normalize(Object.assign(defaults(), readJson(CONFIG_FILE)));
}

function save(cfg) {
  writeJson(CONFIG_FILE, cfg, 0o600);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (e) { /* ignore */ }
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
function validateName(kind, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new HHError('bad_name', `${kind} 名只能含字母数字和 . _ -，且以字母数字开头: ${name}`);
}

function validateEnv(where, env) {
  if (env == null) return;
  if (typeof env !== 'object' || Array.isArray(env)) throw new HHError('bad_env', `${where} 的 env 必须是对象`);
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new HHError('bad_env', `${where} 的 env 键不合法: ${k}`);
    if (typeof v !== 'string') throw new HHError('bad_env', `${where} 的 env 值必须是字符串: ${k}`);
  }
}

function validateGateway(name, g) {
  validateName('网关', name);
  if (!/^https?:\/\/[^\s]+$/.test(g.url || '')) throw new HHError('bad_url', `网关 ${name} 的 url 应为 http(s)://… 且不含空白`);
  if (!AUTH.includes(g.auth)) throw new HHError('bad_auth', `网关 ${name} 的 auth 只能是 ${AUTH.join('|')}`);
  if (!g.secret || /\s/.test(g.secret)) throw new HHError('bad_secret', `网关 ${name} 的 secret 不能为空或含空白`);
  if (g.wire && !['responses', 'anthropic', 'chat'].includes(g.wire)) throw new HHError('bad_wire', 'wire 必须是 responses|anthropic|chat');
  for (const key of ['contextWindow', 'maxOutputTokens']) if (g[key] !== undefined && (!Number.isInteger(g[key]) || g[key] < 1024 || g[key] > 2000000)) throw new HHError('bad_metadata', `${key} 必须是 1024..2000000 的整数`);
  if (g.capabilities !== undefined) {
    const caps = g.capabilities;
    const bools = ['imageInput', 'parallelToolCalls', 'reasoningSummaries'];
    if (!caps || typeof caps !== 'object' || Array.isArray(caps) || Object.keys(caps).some(k => ![...bools, 'reasoningEfforts'].includes(k))) throw new HHError('bad_metadata', '无效 gateway capabilities');
    for (const key of bools) if (caps[key] !== undefined && typeof caps[key] !== 'boolean') throw new HHError('bad_metadata', `${key} 必须是布尔值`);
    if (caps.reasoningEfforts !== undefined && (!Array.isArray(caps.reasoningEfforts) || new Set(caps.reasoningEfforts).size !== caps.reasoningEfforts.length || caps.reasoningEfforts.some(e => !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(e)))) throw new HHError('bad_metadata', 'reasoningEfforts 必须是无重复的推理强度数组');
  }
  validateEnv(`网关 ${name}`, g.env);
}

// Validate retained policy too: switching to external must not hide dangling routes.
function validateOrchestration(cfg, policy, agent) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new HHError('bad_policy', 'orchestration 必须是对象');
  const allowed = ['mode', 'workerModel', 'models', 'fallback', 'prompt', 'effort'];
  if (Object.keys(policy).some(k => !allowed.includes(k))) throw new HHError('bad_policy', '未知 orchestration 字段');
  require('./orchestration').validate(policy);
  if (policy.effort !== undefined && policy.effort !== '' && !['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(policy.effort)) throw new HHError('bad_effort', '未知 reasoning effort');
  if (policy.prompt !== undefined && (typeof policy.prompt !== 'string' || policy.prompt.length > 16000)) throw new HHError('bad_prompt', 'prompt 必须是至多 16000 字符的文本');
  const selectors = [];
  if (policy.workerModel !== undefined && policy.workerModel !== '') selectors.push(policy.workerModel);
  for (const key of ['models', 'fallback']) {
    if (policy[key] !== undefined && (!Array.isArray(policy[key]) || policy[key].length > 4)) throw new HHError('bad_policy', `${key} 必须是至多 4 个模型的数组`);
    selectors.push(...(policy[key] || []));
  }
  for (const selector of selectors) {
    if (typeof selector !== 'string' || !/^[A-Za-z0-9_.-]+\/[^\s<>"'`]+$/.test(selector)) throw new HHError('bad_model', '模型必须是 gateway/model');
    const gateway = getGateway(cfg, selector.slice(0, selector.indexOf('/')));
    if (policy.mode === 'native' && policy.effort && gateway.capabilities?.reasoningEfforts && !gateway.capabilities.reasoningEfforts.includes(policy.effort)) throw new HHError('bad_effort', '委派模型的 gateway capabilities 不支持所选 effort');
  }
  if (policy.mode === 'native' && agent) {
    if (!agent.capabilities.native) throw new HHError('no_native', '此 Agent 不支持原生委派');
    if (agent.validateNativePolicy) agent.validateNativePolicy(policy);
  }
}

function validateProfile(cfg, name, p) {
  validateName('profile', name);
  if (p.agent !== undefined && p.agent !== null) agents.get(p.agent); // 未知 agent 直接抛
  if (p.gateway && !Object.prototype.hasOwnProperty.call(cfg.gateways, p.gateway)) throw new HHError('no_gateway', `profile ${name} 引用的网关不存在: ${p.gateway}（hh gateways 查看）`);
  if (p.model != null && (typeof p.model !== 'string' || /\s/.test(p.model))) throw new HHError('bad_model', `profile ${name} 的 model 不能含空白`);
  if (p.args !== undefined && (!Array.isArray(p.args) || p.args.some(a => typeof a !== 'string'))) throw new HHError('bad_args', `profile ${name} 的 args 必须是数组`);
  if (p.transport && p.transport !== 'direct') throw new HHError('bad_transport', '外部 transport 已移除；hh profiles set NAME --transport direct，然后 hh mode NAME --mode native 使用内置路由');
  if (p.orchestration !== undefined) validateOrchestration(cfg, p.orchestration, agents.get(p.agent));
  validateEnv(`profile ${name}`, p.env);
}

function getGateway(cfg, name) {
  const g = Object.prototype.hasOwnProperty.call(cfg.gateways, name) ? cfg.gateways[name] : null;
  if (!g) throw new HHError('no_gateway', `网关不存在: ${name}（hh gateways 查看）`);
  return g;
}

function getProfile(cfg, name) {
  const p = Object.prototype.hasOwnProperty.call(cfg.profiles, name) ? cfg.profiles[name] : null;
  if (!p) throw new HHError('no_profile', `profile 不存在: ${name}（hh profiles 查看）`);
  return p;
}

function secretValue(s) {
  if (typeof s === 'string' && s.startsWith('env:')) return process.env[s.slice(4)] || '';
  return s;
}

// profile → 最终注入的 env（commonEnv < 网关 env < profile env < 网关地址/密钥 < 模型）、额外 args，以及要从继承环境里清掉的键。
// 网关/模型怎么落地由 agent 适配器决定：Claude 走 ANTHROPIC_* 环境变量，codex 走 -c model_providers.… 的 TOML 覆盖。
function resolveProfile(cfg, name, overrideModel, runtime) {
  const p = getProfile(cfg, name);
  validateProfile(cfg, name, p);
  const agent = agents.get(p.agent);
  const agentCfg = cfg[agent.name] || {};
  const env = Object.assign({}, cfg.commonEnv || {});
  let gateway = null;
  // 先清掉本进程继承来的所有 agent 的网关变量：Leader（claude）派 codex worker 时，
  // 子进程不该看见 ANTHROPIC_*；反之亦然。official 也靠这个避免误连 Leader 的网关。
  const unset = agents.allEnvKeys();
  if (p.gateway) {
    gateway = getGateway(cfg, p.gateway);
    Object.assign(env, gateway.env || {});
  }
  Object.assign(env, p.env || {});
  let secret = '';
  if (gateway) {
    secret = secretValue(gateway.secret);
    if (!secret) throw new HHError('no_secret', `网关 ${p.gateway} 的密钥为空（env: 引用的变量没设？）`);
  }
  let model = overrideModel || p.model || '';
  if (runtime) {
    model = runtime.main;
    gateway = { url: `${runtime.url}${agent.nativePath}`, auth: 'token' }; secret = runtime.token;
    // Real provider credentials remain in hh's router process, never in a routed CLI.
    const providerKeys = new Set([...agents.allEnvKeys(), 'OPENAI_API_KEY', 'CODEX_API_KEY', ...(agent.nativeEnvKeys || [])]);
    for (const g of Object.values(cfg.gateways)) if (typeof g.secret === 'string' && g.secret.startsWith('env:')) providerKeys.add(g.secret.slice(4));
    for (const key of providerKeys) { delete env[key]; unset.push(key); }

  }
  const inject = agent.resolveGateway(gateway, secret, model);
  Object.assign(env, inject.env);
  return {
    name, profile: p, agent, agentName: agent.name, gatewayName: runtime ? 'hh-native' : p.gateway || null, gateway, model, env,
    unset: unset.filter((k) => !(k in env)),
    bin: expandHome(p.bin || agentCfg.bin || agent.defaultBin), args: (inject.args || []).concat(p.args || []),
  };
}

function templatePath(t) {
  if (!t || t === '-') return null;
  if (t.startsWith('/') || t.startsWith('~')) return expandHome(t);
  return path.join(PROMPTS_DIR, t);
}

function resolveRole(cfg, role) {
  const ro = cfg.roles[role];
  if (!ro) throw new HHError('no_role', `角色不存在: ${role}（hh roles 查看，hh roles set 新增）`);
  const profile = getProfile(cfg, ro.profile);
  return { role, profileName: ro.profile, profile, model: ro.model || profile.model || '', autonomy: ro.autonomy || 'full', template: templatePath(ro.template), desc: ro.desc || '' };
}

function installPrompts(opts) {
  opts = opts || {};
  fs.mkdirSync(PROMPTS_DIR, { recursive: true });
  const done = [];
  if (!fs.existsSync(REPO_PROMPTS)) return done;
  for (const f of fs.readdirSync(REPO_PROMPTS)) {
    if (!f.endsWith('.md')) continue;
    const dst = path.join(PROMPTS_DIR, f);
    if (fs.existsSync(dst) && !opts.force) continue;
    fs.copyFileSync(path.join(REPO_PROMPTS, f), dst);
    done.push(dst);
  }
  return done;
}

function hostSlug(url) {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'gw';
}

// ---------- 导入：shell alias ----------
// 识别形如 alias NAME="K=V K=V ANTHROPIC_BASE_URL=… ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY=… [ANTHROPIC_MODEL=…] claude …" 的行
const ALIAS_RE = /^\s*alias\s+([A-Za-z0-9_.-]+)=(["']?)(.*)\2\s*$/;
function parseAliasLine(line) {
  const m = line.match(ALIAS_RE);
  if (!m) return null;
  const body = m[3];
  if (!/ANTHROPIC_BASE_URL=/.test(body) || !/\bclaude\b/.test(body)) return null;
  const env = {};
  const rest = [];
  for (const tok of body.trim().split(/\s+/)) {
    const kv = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (kv && !rest.length) env[kv[1]] = kv[2].replace(/^["']|["']$/g, '');
    else rest.push(tok);
  }
  return { alias: m[1], env, command: rest };
}

function importAliases(cfg, files, opts) {
  opts = opts || {};
  files = files && files.length ? files.map(expandHome) : ALIAS_FILES;
  const out = { files: [], gateways: [], profiles: [], skipped: [] };
  const common = cfg.commonEnv || {};
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    out.files.push(f);
    for (const line of readText(f).split('\n')) {
      const a = parseAliasLine(line);
      if (!a) continue;
      const url = a.env.ANTHROPIC_BASE_URL;
      const token = a.env.ANTHROPIC_AUTH_TOKEN;
      const key = a.env.ANTHROPIC_API_KEY;
      const secret = token || key;
      if (!url || !secret) { out.skipped.push(`${a.alias}: 缺 ANTHROPIC_BASE_URL 或密钥`); continue; }
      const name = a.alias.replace(/cc$/, '') || a.alias;
      const dup = Object.keys(cfg.profiles).find((n) => n.toLowerCase() === name.toLowerCase());
      if (dup) { out.profiles.push({ name: dup, status: 'exists', alias: a.alias }); continue; }
      // 网关：同 url + 同密钥复用；否则新建（名字取 host）
      let gwName = Object.keys(cfg.gateways).find((n) => cfg.gateways[n].url === url && cfg.gateways[n].secret === secret);
      if (!gwName) {
        gwName = hostSlug(url);
        let i = 2;
        while (cfg.gateways[gwName]) gwName = `${hostSlug(url)}-${i++}`;
        const g = { url, auth: token ? 'token' : 'apikey', secret };
        if (!opts.dryRun) cfg.gateways[gwName] = g;
        out.gateways.push({ name: gwName, status: 'added', url });
      }
      const p = { gateway: gwName, model: a.env.ANTHROPIC_MODEL || '' };
      const extra = {};
      for (const [k, v] of Object.entries(a.env)) {
        if (GATEWAY_ENV_KEYS.includes(k)) continue;
        if (common[k] === v) continue;
        extra[k] = v;
      }
      if (Object.keys(extra).length) p.env = extra;
      if (!opts.dryRun) cfg.profiles[name] = p;
      out.profiles.push({ name, status: 'added', alias: a.alias, gateway: gwName, model: p.model });
    }
  }
  return out;
}

function init(opts) {
  opts = opts || {};
  if (exists() && !opts.force) throw new HHError('exists', `${CONFIG_FILE} 已存在；hh init --force 会在现有配置上再导入一次（不删已有条目）`);
  const fd = acquireLock();
  let cfg;
  let result;
  try {
    cfg = exists() ? load() : defaults();
    const claudeBin = which(cfg.claude.bin || 'claude');
    result = { config: CONFIG_FILE, claude: claudeBin, herdr: which('herdr'), aliases: null, roles_defaulted: false };
    result.aliases = importAliases(cfg, null, {});
    if (!Object.keys(cfg.roles).length) {
      result.roles_defaulted = true;
      for (const [role, d] of Object.entries(ROLE_DEFAULTS)) cfg.roles[role] = { profile: OFFICIAL, template: `${role}.md`, autonomy: d.autonomy, desc: d.desc };
    }
    for (const [role, ro] of Object.entries(cfg.roles)) if (!ro.desc && ROLE_DEFAULTS[role]) ro.desc = ROLE_DEFAULTS[role].desc;
    if (!cfg.leader || !cfg.profiles[cfg.leader]) cfg.leader = OFFICIAL;
    save(cfg);
  } finally {
    releaseLock(fd);
  }
  result.prompts = installPrompts({ force: false });
  result.cfg = cfg;
  return result;
}

module.exports = {
  ROOT, HH_BIN, MOD_DIR, CONFIG_DIR, STATE_DIR, CONFIG_FILE, PROMPTS_DIR, REPO_PROMPTS, ALIAS_FILES,
  OFFICIAL, AUTONOMY, VIEWERS, PANES, AUTH, MODEL_ENV_KEYS, GATEWAY_ENV_KEYS, DEFAULT_COMMON_ENV, ROLE_DEFAULTS, DEFAULT_FOOTER, REPORT_SCHEMA, AGENT_NAMES: agents.NAMES,
  defaults, exists, load, save, update, effectiveViewer, validateName, validateGateway, validateProfile, validateOrchestration, getGateway, getProfile, resolveProfile, templatePath, resolveRole,
  installPrompts, importAliases, parseAliasLine, init,
};
