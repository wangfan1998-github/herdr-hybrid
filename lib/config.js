'use strict';
// 配置：~/.config/hh/config.json
//   gateways  网关：url + 鉴权 + 密钥 + 该网关公共 env
//   profiles  模型 profile：网关 + model_id + 专属 env/args；`official` = 不注入，用 claude 自己的登录/当前环境
//   roles     角色：profile + 模板 + 自主级别
// 同一份配置既用于 `hh claude <profile>` 交互式启动（替代 xxxcc alias），也用于 `hh dispatch` 无头派发。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HHError, expandHome, readJson, writeJson, readText, which } = require('./util');

const ROOT = path.resolve(__dirname, '..');
const HH_BIN = path.join(ROOT, 'bin', 'hh');
const CONFIG_DIR = expandHome(process.env.HH_CONFIG_DIR || '~/.config/hh');
const STATE_DIR = expandHome(process.env.HH_STATE_DIR || '~/.local/state/hh');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PROMPTS_DIR = path.join(CONFIG_DIR, 'prompts');
const REPO_PROMPTS = path.join(ROOT, 'prompts');
const ALIAS_FILES = (process.env.HH_ALIAS_FILES ? process.env.HH_ALIAS_FILES.split(':') : ['~/.shell_aliases', '~/.zshrc', '~/.bashrc']).map(expandHome);

const OFFICIAL = 'official';
const AUTONOMY = ['full', 'workspace', 'readonly'];
const VIEWERS = ['auto', 'herdr', 'none']; // auto = 装了 herdr 就用；herdr = 必须；none = 从不开窗口
const AUTH = ['token', 'apikey'];
const MODEL_ENV_KEYS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];
const GATEWAY_ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY'].concat(MODEL_ENV_KEYS);
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
    claude: { bin: 'claude', interactiveArgs: ['--dangerously-skip-permissions'] },
    commonEnv: Object.assign({}, DEFAULT_COMMON_ENV),
    gateways: {},
    profiles: { [OFFICIAL]: { gateway: null, note: '不注入网关：用 claude 自己的登录 / 当前环境' } },
    roles: {},
  };
}

function exists() { return fs.existsSync(CONFIG_FILE); }

function normalize(cfg) {
  if (cfg.runners) { // 1.0-rc 的多 CLI 格式：丢弃 runners 和指向它们的角色
    delete cfg.runners;
    for (const [r, ro] of Object.entries(cfg.roles || {})) if (!ro.profile) delete cfg.roles[r];
    cfg.version = 2;
  }
  cfg.claude = Object.assign({ bin: 'claude', interactiveArgs: ['--dangerously-skip-permissions'] }, cfg.claude || {});
  if (process.env.HH_VIEWER) cfg.viewer = process.env.HH_VIEWER; // `hh claude --no-herdr` 给 Leader 进程设 none，它派的 worker 也不开窗口
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
  if (!NAME_RE.test(name || '')) throw new HHError('bad_name', `${kind} 名只能含字母数字和 . _ -，且以字母数字开头: ${name}`);
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
  validateEnv(`网关 ${name}`, g.env);
}

function validateProfile(cfg, name, p) {
  validateName('profile', name);
  if (p.gateway && !cfg.gateways[p.gateway]) throw new HHError('no_gateway', `profile ${name} 引用的网关不存在: ${p.gateway}（hh gateways 查看）`);
  if (p.model && /\s/.test(p.model)) throw new HHError('bad_model', `profile ${name} 的 model 不能含空白`);
  if (p.args && !Array.isArray(p.args)) throw new HHError('bad_args', `profile ${name} 的 args 必须是数组`);
  validateEnv(`profile ${name}`, p.env);
}

function getGateway(cfg, name) {
  const g = cfg.gateways[name];
  if (!g) throw new HHError('no_gateway', `网关不存在: ${name}（hh gateways 查看）`);
  return g;
}

function getProfile(cfg, name) {
  const p = cfg.profiles[name];
  if (!p) throw new HHError('no_profile', `profile 不存在: ${name}（hh profiles 查看）`);
  return p;
}

function secretValue(s) {
  if (typeof s === 'string' && s.startsWith('env:')) return process.env[s.slice(4)] || '';
  return s;
}

// profile → 最终注入的 env（commonEnv < 网关 env < profile env < 网关地址/密钥 < 模型），以及要从继承环境里清掉的键
function resolveProfile(cfg, name, overrideModel) {
  const p = getProfile(cfg, name);
  const env = Object.assign({}, cfg.commonEnv || {});
  let gateway = null;
  const unset = GATEWAY_ENV_KEYS.slice(); // 先清掉 Leader 进程继承下来的网关变量，避免 official 误连 Leader 的网关
  if (p.gateway) {
    gateway = getGateway(cfg, p.gateway);
    Object.assign(env, gateway.env || {});
  }
  Object.assign(env, p.env || {});
  if (gateway) {
    env.ANTHROPIC_BASE_URL = gateway.url;
    const secret = secretValue(gateway.secret);
    if (!secret) throw new HHError('no_secret', `网关 ${p.gateway} 的密钥为空（env: 引用的变量没设？）`);
    if (gateway.auth === 'apikey') env.ANTHROPIC_API_KEY = secret; else env.ANTHROPIC_AUTH_TOKEN = secret;
  }
  const model = overrideModel || p.model || '';
  if (model) for (const k of MODEL_ENV_KEYS) env[k] = model;
  return {
    name, profile: p, gatewayName: p.gateway || null, gateway, model, env, unset: unset.filter((k) => !(k in env)),
    bin: expandHome(p.bin || (cfg.claude && cfg.claude.bin) || 'claude'), args: p.args || [],
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
  const cfg = exists() ? load() : defaults();
  const claudeBin = which(cfg.claude.bin || 'claude');
  const result = { config: CONFIG_FILE, claude: claudeBin, herdr: which('herdr'), aliases: null, roles_defaulted: false };
  result.aliases = importAliases(cfg, null, {});
  if (!Object.keys(cfg.roles).length) {
    result.roles_defaulted = true;
    for (const [role, d] of Object.entries(ROLE_DEFAULTS)) cfg.roles[role] = { profile: OFFICIAL, template: `${role}.md`, autonomy: d.autonomy, desc: d.desc };
  }
  for (const [role, ro] of Object.entries(cfg.roles)) if (!ro.desc && ROLE_DEFAULTS[role]) ro.desc = ROLE_DEFAULTS[role].desc;
  if (!cfg.leader || !cfg.profiles[cfg.leader]) cfg.leader = OFFICIAL;
  save(cfg);
  result.prompts = installPrompts({ force: false });
  result.cfg = cfg;
  return result;
}

module.exports = {
  ROOT, HH_BIN, CONFIG_DIR, STATE_DIR, CONFIG_FILE, PROMPTS_DIR, REPO_PROMPTS, ALIAS_FILES,
  OFFICIAL, AUTONOMY, VIEWERS, AUTH, MODEL_ENV_KEYS, GATEWAY_ENV_KEYS, DEFAULT_COMMON_ENV, ROLE_DEFAULTS, DEFAULT_FOOTER, REPORT_SCHEMA,
  defaults, exists, load, save, validateName, validateGateway, validateProfile, getGateway, getProfile, resolveProfile, templatePath, resolveRole,
  installPrompts, importAliases, parseAliasLine, init,
};
