'use strict';
// Agent 适配器注册表。hh 的调度内核（runs.js）与 agent 无关：它只认「进程退出 + result.json」。
// 每个适配器负责把一种 CLI 的差异收敛成同一组方法，见 AGENTS.md「适配器边界」。
//
// 适配器接口：
//   name                        标识，= profile.agent 的取值
//   label                       人类可读名
//   defaultBin                  默认可执行文件
//   envKeys                     该 agent 认的网关/模型环境变量（用于跨 agent 清理，见 config.resolveProfile）
//   capabilities                { leader, mod, mcp, native }：能不能当 Leader / 挂配置面板 / 注册 MCP
//   resolveGateway(g, secret, model) → { env, args }   网关 + 密钥 + 模型怎么注入
//   checkAuth(bin, spawnSync, stripAnsi) → { ok, detail, hint }（可选）
//                               gateway:null 的 profile 用「这个 CLI 自己的登录」，doctor 拿它体检；
//                               ok=null 表示查不了（显示成提示而非失败）。依赖注入 spawnSync 是为了不在适配器里 require。
//   headlessArgv(ctx)           无头派发的 argv（任务正文一律走 stdin）
//   interactiveArgv(agentCfg, profileArgs, extra, opts)  交互式启动的 argv
//   nativePath / nativeArgs(plan)   Built-in router URL suffix / native session flags (optional)
//   newState() / parseLine(line, st) / finalize(st)      事件流解析
//   renderLine(item)            transcript 渲染
//   stderrNoise                 stderr 常驻噪音（排障时过滤掉）
const { HHError } = require('../util');

const AGENTS = {
  claude: require('./claude'),
  codex: require('./codex'),
};

const DEFAULT = 'claude';
const NAMES = Object.keys(AGENTS);

function get(name) {
  const key = name || DEFAULT;
  // 必须用 hasOwnProperty：`--agent toString` 会从 Object.prototype 上摸到一个函数，
  // 真值判断放它过去 → validateProfile 不报错、写进配置，之后才在 resolveGateway 上炸成 TypeError。
  const a = Object.prototype.hasOwnProperty.call(AGENTS, key) ? AGENTS[key] : null;
  if (!a) throw new HHError('bad_agent', `未知 agent: ${name}（可选 ${NAMES.join(' | ')}）`);
  return a;
}

// 所有 agent 的 env 键并集：派 codex worker 前要把 Leader 进程里继承的 ANTHROPIC_* 清掉，
// 否则 codex 进程里残留着 Claude 的网关变量（反之亦然）。
function allEnvKeys() {
  const out = [];
  for (const a of Object.values(AGENTS)) for (const k of a.envKeys || []) if (!out.includes(k)) out.push(k);
  return out;
}

module.exports = { get, AGENTS, NAMES, DEFAULT, allEnvKeys };
