# AGENTS.md — 给在这个仓库里干活的 Agent

herdr-hybrid 是一个 **Node ≥ 18、零依赖** 的 CLI（`hh`）：一份配置管一批「网关 + key + 模型」的 Claude Code profile，既用于交互式启动，也用于把子任务派给便宜 profile 的无头 worker。只支持 Claude Code。改代码前先读这页。

## 结构

```text
bin/hh            入口，只 require lib/cli
lib/util.js       文件/JSON/进程小工具，HHError，maskEnv
lib/config.js     config.json 读写；gateways / profiles / roles；resolveProfile(env 计算)；importAliases；init
lib/claude.js     claude 适配：headlessArgv / interactiveArgv / autonomyArgs；stream-json 解析；transcript 渲染
lib/runs.js       run 目录 = 状态：createRun / status / waitRuns / sendFollowup / cancelRun / closeRun
lib/worker.js     hh _worker <id>：用 profile env spawn `claude -p`，写 events.jsonl / output.log / result.json
lib/herdr.js      可选观察窗口（herdr tab）；状态判定不依赖它
lib/api.js        CLI 与 MCP 共用的操作层，返回纯对象（含 launch = hh claude）
lib/mcp.js        MCP stdio server（JSON-RPC 按行）
lib/cli.js        参数解析 + 人类/JSON 双模输出
prompts/          角色模板；skill/  Leader 协议；tests/  冒烟测试与假 claude
```

## 硬约束

- 不引入 npm 依赖。Node 内置模块够用。
- `lib/api.js` 里的函数返回可 JSON 序列化的对象；CLI 的人类格式化只在 `lib/cli.js`。
- 状态只来自文件（`result.json`、`meta.json` 的 pid），不要再引入抓屏、终端标题、问「做完了吗」之类的判定。
- 密钥永远不进 stdout / transcript / 事件日志 / MCP 输出；一律 `maskEnv` / `mask`。只有 `hh env --reveal` 例外。
- 只支持 Claude Code。要接别的东西，用 profile 的 `bin` / `args` / `env`，不要加新的 CLI 适配器。
- 改 env 计算顺序（`config.resolveProfile`）必须同步 docs/profiles.md 和 smoke 里的 envcheck 断言。

## 验证

```bash
npm run check          # node --check 全部文件
bash tests/smoke.sh    # 不需要真实 claude；tests/fake-agent 假扮 claude（profile 的 bin 指向它）
hh dispatch --dry-run -p <profile> -d . -t x     # 看某个 profile 会拼出什么命令和 env（打码）
hh profiles test <profile>                       # 真发一次 pong
```

CI（`.github/workflows/ci.yml`）跑 Node 18/20/22 的 check + smoke + shellcheck。

## 提交

- 改 `bin/` `lib/` 后跑 `bash tests/smoke.sh`；改 `install.sh` / `tests/*.sh` 后跑 `shellcheck`。
- 用户机器上的安装是 `~/.local/share/herdr-hybrid` 的拷贝：改完仓库要再跑 `./install.sh` 才生效（`HH_DEV=1 ./install.sh` 则直接软链到仓库）。

## 图片资产

`docs/assets/src/*.html` + `theme.css` 是源文件（HTML/CSS 排版，`?theme=light|dark` 切主题）；README 用 `<picture>` 引用渲染好的 `docs/assets/<name>-{light,dark}.png`，GitHub 按读者主题自动切换；`showcase.gif` 只有深色版；`hero` / `architecture` / `config-model` 三张的源是 `src/*.svg`，只渲染一张浅色 PNG，README 用 `<img>` 引用。不要直接引用 SVG/HTML（GitHub 不加载外部字体，中文会变方块）。改完源文件：

```bash
docs/assets/src/render.sh      # 需要 Chrome（CHROME= 可指定路径）和 ffmpeg（GIF）；输出 2x PNG + GIF
```

设计约束（来自 impeccable）：一种强调色（--accent）+ 暖灰中性色；字体栈不用 Inter；深底上的次要文字用 --term-muted 而不是纯灰；不要卡片套卡片；每个观点只说一次。
