# AGENTS.md — 给在这个仓库里干活的 Agent

herdr-hybrid 是一个 **Node ≥ 18、零依赖** 的 CLI（`hh`）：一份配置管一批「网关 + key + 模型」的 profile，既用于交互式启动，也用于把子任务派给便宜 profile 的无头 worker。支持 Claude Code 与 Codex CLI。改代码前先读这页。

## 结构

```text
bin/hh            入口，只 require lib/cli
lib/util.js       文件/JSON/进程小工具，HHError，maskEnv
lib/config.js     config.json 读写；gateways / profiles / roles；resolveProfile(env 计算)；importAliases；init
lib/agents/       agent 适配器：index.js 注册表 · claude.js · codex.js
lib/runs.js       run 目录 = 状态：createRun / status / waitRuns / sendFollowup / cancelRun / closeRun
lib/worker.js     hh _worker <id>：用 profile env spawn agent 无头命令，写 events.jsonl / output.log / result.json
lib/herdr.js      可选观察窗口（herdr tab）；状态判定不依赖它
lib/api.js        CLI 与 MCP 共用的操作层，返回纯对象（含 launch = hh claude）
lib/mcp.js        MCP stdio server（JSON-RPC 按行）
lib/cli.js        参数解析 + 人类/JSON 双模输出
prompts/          角色模板；skill/  Leader 协议；tests/  冒烟测试与假 claude / 假 codex
```

## 硬约束

- 不引入 npm 依赖。Node 内置模块够用。
- `lib/api.js` 里的函数返回可 JSON 序列化的对象；CLI 的人类格式化只在 `lib/cli.js`。
- 状态只来自文件（`result.json`、`meta.json` 的 pid，pid 用 `ps` 核对是不是 `hh _worker <id>`），不要再引入抓屏、终端标题、问「做完了吗」之类的判定。worker 时限由 worker 自己的 watchdog 执行（`config.limits`），不要放到 Leader 侧轮询。
- 密钥永远不进 stdout / transcript / 事件日志 / MCP 输出；一律 `maskEnv` / `mask`。只有 `hh env --reveal` 例外。
- 改 env 计算顺序（`config.resolveProfile`）必须同步 docs/profiles.md 和 smoke 里的 envcheck 断言。

## 适配器边界（新增 agent 看这里）

调度内核与 agent 无关：`lib/runs.js` 里 **0 处** agent 名字，它只认「进程退出 + `result.json`」。
一种 CLI 的全部差异收敛在 `lib/agents/<name>.js` 一个文件里，接口见 `lib/agents/index.js` 顶部注释。

- 新增 agent = 新加一个适配器文件 + 在 `index.js` 注册，**不改** `runs.js`，尽量不改 `worker.js`。
- 差异一律走适配器方法，不要在 `worker.js` / `api.js` 里写 `if (agent === 'codex')`。
  能力差异用 `capabilities`（`leader` / `mod` / `mcp`）表达，调用方查能力、不查名字。
- `profile.agent` 缺省是 `claude`，老配置不写这个字段也要照常工作。
- 新 agent 必须配一个 `tests/fake-<name>`（照实测样本仿事件流）并在 smoke 里跑通全链路，不依赖真 CLI、不发网络。
- 网关/密钥/模型怎么注入由适配器的 `resolveGateway` 决定；`envKeys` 要列全，否则跨 agent 派发时会残留上一个 agent 的环境变量。
  但**只列 hh 自己注入的键**：把用户 export 的凭证（`OPENAI_API_KEY` 之类）列进去，会让 `gateway: null` 的 profile 失去「用自己的登录」这个语义。
- 想让 `hh doctor` 体检登录就实现 `checkAuth`；`gateway: null` 的 profile 才会被查（按 gateway 判断，不按名字叫不叫 `official`）。

> 历史：1.0-rc 有过一版 `runners` 多 CLI 配置，因为它把差异摊在配置里、每加一个 CLI 都要改内核，1.0 时删掉了（`config.js` 仍保留丢弃 `runners` 的迁移分支）。
> 现在这版把差异收进适配器、内核保持 agent 无关，才重新支持多 CLI。加新 agent 前先确认你的改动没有把差异漏回内核。

## 验证

```bash
npm run check          # node --check 全部文件
bash tests/smoke.sh    # 不需要真实 claude / codex；tests/fake-agent、tests/fake-codex 假扮它们（profile 的 bin 指向假的）
hh dispatch --dry-run -p <profile> -d . -t x     # 看某个 profile 会拼出什么命令和 env（打码）
hh profiles test <profile>                       # 真发一次 pong
```

CI（`.github/workflows/ci.yml`）跑 Node 18/20/22 的 check + smoke + shellcheck。

## 提交

- 改 `bin/` `lib/` 后跑 `bash tests/smoke.sh`；改 `install.sh` / `tests/*.sh` 后跑 `shellcheck`。
- 用户机器上的安装是 `~/.local/share/herdr-hybrid` 的拷贝：改完仓库要再跑 `./install.sh` 才生效（`HH_DEV=1 ./install.sh` 则直接软链到仓库）。

## 图片资产

`docs/assets/src/*.html` + `theme.css` 是源文件（HTML/CSS 排版，`?theme=light|dark` 切主题）；README 用 `<picture>` 引用渲染好的 `docs/assets/<name>-{light,dark}.png`，GitHub 按读者主题自动切换；`showcase.gif` 只有深色版。不要直接引用 SVG/HTML（GitHub 不加载外部字体，中文会变方块）。改完源文件：

```bash
docs/assets/src/render.sh      # 需要 Chrome（CHROME= 可指定路径）和 ffmpeg（GIF）；输出 2x PNG + GIF
```

设计约束（来自 impeccable）：一种强调色（--accent）+ 暖灰中性色；字体栈不用 Inter；深底上的次要文字用 --term-muted 而不是纯灰；不要卡片套卡片；每个观点只说一次。

## 双模式扩展边界

- `lib/orchestration.js` 负责策略与委派计划；`lib/native.js` 负责会话内路由、回退和生命周期；`lib/protocols/` 负责协议转换。不要向 runs 内核塞厂商协议。
- `external` 与 `native` 在会话级选择；原生子代理不是 hh run。适配器用 `nativeArgs`、`nativePath`、`capabilities.native` 表达差异。
- 上游密钥不能进入 native Agent 子进程；不能输出上游错误正文。保持 Node ≥18、零 npm 依赖。
- `lib/compaction.js` 提供跨协议有界 checkpoint；`lib/agents/argv.js` 提供 CLI 参数扫描，具体保护规则仍属于适配器。
- npm test 自动运行 tests/*.test.js，覆盖双模式、协议、生命周期与并发测试。真实 CLI 契约测试可选，见 docs/orchestration.md。
