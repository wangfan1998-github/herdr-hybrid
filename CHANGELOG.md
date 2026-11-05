# Changelog

## Unreleased

### 2026-11-05 Leader 自主：小问题自己定，核心问题才找用户
- **问题分级写进 Leader 协议。** 原来是「派出去之后不再提问」，现在是：实现细节、可回退、范围内的取舍由 Leader 自己判断，`hh send` 回给 worker 接着干；只有整体架构 / 整体走向 / 不可逆且影响大的问题才上报用户，集中一次问、每条带推荐。
- **worker 报告加 `questions[{q,options,pick,blocking}]`。** 不阻塞的按推荐做完、请 Leader 复核；阻塞的停下并设 `status: blocked`。没改过的旧版默认页脚自动升级；角色模板同步。
- **`attention`：** `hh wait` / `hh status` / `hh result` 直接标出需要处理的 run（blocked / partial / 有问题 / 没交报告 / 验收失败 / failed / crashed），报告干净的不在里面。
- **决定留痕：** `hh send --decision`、`hh decide [--escalated]`、`hh decisions`（MCP `hh_decide` / `hh_decisions`），存到 `$HH_STATE_DIR/decisions.jsonl`，方便事后抽查。
- **worker 时限：** `config.limits.timeoutMin`（默认 120）/ `stallMin`（默认 45 分钟无输出算卡住，单调时钟计时、合盖睡眠不算），`hh dispatch --timeout MIN` 单次覆盖；到点连同 agent 的子进程一起结束，记为 `failed`；返修沿用原任务的时限，`error` 以 `timeout:` / `stalled:` 开头。
- **修：pid 复用导致 run 永远 running。** 判活时用 `ps` 核对命令行是 `hh _worker <id>`。
- **修：多轮返修标签撞号**（a-r1 再返修也叫 a-r1），现在沿返修链递增。
- Claude `readonly` 放行 grep / ls / cat / head / tail / wc / git blame / git ls-files（之前只能跑 4 条 git 命令）；有执行程序参数的 rg / git grep / find 故意不放行。
- 判活误判的兜底：`ps` 不可用（BusyBox）时退回只看 pid；被误判成 `crashed` 的 run，worker 真跑完后用真结果覆盖。
- 决定记录落盘前把网关密钥和形如 `sk-…` 的串打码，文件 0600。
- 性能：已结束的 run 查状态不再加锁；`hh read` / `hh log` 从文件尾部读；settled 超过 `keepDays`（默认 30）的 run 每天自动清理一次。

### 2026-09-17 双模式与完整联调
- 自主实现 external / native 编排、三协议路由、默认 worker、额外模型、委派提示、有限回退及上下文压缩，无外部 OpenCodex 运行依赖。
- 修复真实 CLI 参数、Claude 模型后缀、Codex grammar 工具转换、并行工具结果和 Responses 续接来源；密钥保留在父进程。
- 配置面板原子保存编排策略，MCP 与 CLI 共用校验；加固 worker 取消/重复启动和跨 Agent 续跑边界。
- 增加协议与并发回归、真实 CLI 契约、真实网关委派与回退验收。

面向「手里有多个订阅 / API key、想混用」的人重写上手路径；shell alias 导入退为老用户的一键迁移。

### 删
- `hh profiles import-ccm`、`hh init` 对 `~/.config/ccm/*.conf` 的自动导入、`HH_CCM_DIR`。ccm 是这个仓库 0.x 时期自己的 bash 启动器，1.0 起没有人再需要从它迁移；配置早已在 `config.json` 里。

### 新
- **支持 Codex CLI 当 worker（`profile.agent`）。** `hh profiles set <name> --agent codex` 就能让这个 profile 用 `codex exec --json` 干活，`hh dispatch` / `roles` / `wait` / `read` / `result` / `send` / `profiles test` 全线可用，worker 的 JSON 汇报契约与 Claude 完全一致。`hh codex <profile>` 用该 profile 起交互式 Codex。缺省 `agent` 是 `claude`，**老配置不用改**。
  - 差异都收在 `lib/agents/codex.js`：网关走 `-c model_providers.…`（不是 `ANTHROPIC_*`），续跑是 `exec resume <ID>` 子命令，自主级别映射到 `-s read-only|workspace-write` / `--dangerously-bypass-approvals-and-sandbox`，会话 id 取 `thread.started.thread_id`。
  - 密钥不上命令行：`-c …env_key=HH_CODEX_KEY` 只传变量名，值仍走 env，`argv` 里看不到密钥。
  - Claude 与 Codex 均支持 Leader；`/hh-config` 可视化面板仍是 Claude 插件，Codex 使用 CLI 或 MCP 配置。
  - 跨 agent 隔离：派 codex worker 前会清掉继承的 `ANTHROPIC_*`，反之亦然，避免一个 agent 连到另一个的网关。
  - Codex 直接连接使用 Responses；native 模式支持 hh 内置的 Chat / Messages 转换。
- `hh install codex`。`hh doctor` 在有 profile 用到 codex 时才检查它的可执行文件，没人用就不刷屏。
- **登录体检覆盖所有「用订阅」的 profile。** 之前只在**名叫 `official`** 的 profile 被用到时才查 `claude auth status`，于是把订阅 profile 改个名就漏检，codex 的登录也从来没查过。现在按 `gateway === null` 判断（名字无关），对每个用到的 agent 各查一次，并且用该 profile **实际会启动的那个可执行文件**去问（之前用 agent 级 bin，profile 自己指了 `bin` 时会去问错的程序）。检查方式由适配器提供：claude 读 `claude auth status` 的 JSON，codex 用 `codex login status` 的退出码。
- **`/hh-config` 面板适配双模式与多 Agent。** 编排字段（mode / workerModel / models / fallback / prompt / effort）与 profile 一次原子保存；网关列表标出 `wire`，未声明的显示 `wire?`。**native 引用到的网关必须先声明 wire**：面板保存前就拦住并指名是哪几个端点，不再「保存成功、启动才报错」（hh 只在 `native plan` / 启动时校验）。Leader 用的 Agent 不支持插件面板时（如 Codex），`hh doctor` 的 `leader.mod` 与注入 Leader 的环境快照都明确说明面板不可用、该走命令行，Leader 不会再推荐一个不会出现的 `/hh-config`。
- **`/hh-config`：Leader 里的可视化配置界面。** `hh claude` 起 Leader 时用 `--plugin-dir` 挂上仓库里的 `mod/`（Claude Code function hooks），会话里敲 `/hh-config` 开出一个面板：profiles / gateways / roles 三个标签页，每行可改可删，也能新建；再敲一次 / Esc / 点 `✕` 关掉。**枚举字段是下拉不是输入框**：`agent`（claude / codex）、`auth`、`autonomy` 是固定枚举，`gateway` / `profile` 的选项从 `hh …  --json` 实时读，选出来的一定存在（「引用的网关不存在」这类错误从源头消失）；`url` / `secret` / `model` / `desc` 仍是文本框。用 codex 的 profile 在列表里标 `[codex]`。界面只负责画，读写一律调 `hh … --json`，校验 / 引用保护 / 0600 写盘与命令行完全一致，不存在两套逻辑；密钥只显示打码值，编辑时留空 = 不改。只在 Leader 模式、且 agent 支持插件（`capabilities.mod`）时挂，`hh claude <profile>` 不受影响；不往 `~/.claude` 装任何东西。需要 Claude Code 开 `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS`，没开时 `hh doctor` 的 `leader.mod` 会说明（early access 接口，升级后可能要重跑 `/plugin-types`）。
- `hh pane right|bottom`：面板贴右边（默认）还是贴底。pane 的位置由终端布局决定、插件设不了，所以这个开关实际切的是 `CLAUDE_CODE_NO_FLICKER`——贴底要把它关掉，代价是整屏可能有重绘闪烁，因此默认保持贴右。只影响挂了面板的 Leader，普通 `hh claude <profile>` 的 env 不动。
- `hh claude herdr`：把 Leader 开进 herdr 工作区的一个聚焦 `hh:leader` tab，server 没起自动 `herdr server` 拉起，终端里顺手附着客户端；已经在 herdr pane 里就原地启动；没装 herdr 时终端里问一句「装上并开进去？」，默认 Y，用官方脚本装完接着开（Claude Code 没装同理；非 TTY 只提示）。平时 `hh claude` 仍在当前终端。`--no-herdr` 给 Leader 设 `HH_VIEWER=none` 让 worker 也不开窗口；`hh viewer auto|herdr|none` 改 worker 默认，`herdr` 时 `hh claude` 也自动开进去；`hh claude --dry-run` 多一行 `launch`。
- `hh install claude|herdr`：官方安装脚本装缺的依赖（TTY 先确认，`--yes` 跳过）；`install.sh` 缺依赖时会问（`HH_INSTALL_DEPS=yes|no` 跳过询问）；`hh doctor` 的提示指向它。
- `hh setup`：一问一答加一个端点 + profile（地址、鉴权、密钥不回显、模型），问它当 Leader 还是干活，顺手真发一次 pong；同一地址再跑默认复用端点只加模型。`hh init` 在 TTY 里没找到任何端点时自动进入（`--no-setup` 关闭）；非 TTY 打印等价命令。
- `hh claude` Leader 模式在只有 `official` 一个 profile、或所有角色都指向 Leader 自己时，stderr 提醒一句（照常启动）。
- `hh doctor` 无端点时的提示指向 `hh setup`。

### 改
- **并发改配置不再丢改动。** 之前 `config.load()` → 改 → `config.save()` 这个读-改-写序列没有锁：两个 hh 同时写，各自读到同一份旧配置，后 rename 的把前一个整个盖掉（两进程并发实测 5/5 必现丢失）。平时手敲命令碰不到，但 worker 继承了 hh 的 MCP、并发 `hh roles set` 完全可能，加上可视化界面后更容易撞上。现在所有写路径走 `config.update()`，用 `O_EXCL` 锁文件把读-改-写串起来（超 10 秒的死锁自动接管，超 5 秒等不到就报错）。smoke 里加了 6 路并发的回归用例。
- `hh dispatch -r ROLE -p PROFILE` 同时给时，模型跟 `-p` 的 profile 走（之前会把角色原 profile 的模型 id 发到另一个网关）。
- `hh profiles aliases` 与 `hh env --reveal` 在非 TTY 下默认纯文本，`eval "$(hh profiles aliases)"` 和 `env $(hh env X --reveal)` 能直接用；显式 `--json` 仍给 JSON。
- 删除无引用的 `prompts/planner.md`（Leader 提示词来自 skill/herdr-leader/SKILL.md）。
- smoke 现在 100 项左右（fake-agent + fake-herdr）。
- worker 的 `error` 摘要过滤 stderr 常驻噪音（`[claude-code:unrecognized_model]`、connectors disabled），并把回复里的 `API Error: …` 放到最前——之前地址写错会被误报成「模型不存在」。
- README / 帮助文本 / 文档：先解释端点、profile、角色三个词；「三分钟上手」拆成「第一次配置」「已有 alias 一键迁移」「分工、验证、启动」；写明前提（两个以上端点）、与 Claude Code 自带子代理的区别、默认权限、任务粒度。`fastcc` 这类 alias 只在迁移段落出现并解释。

## 1.0.0 — 2026-09-02

换底座：从「bash alias/ccm + hl 抓屏编排」改成「一份 profile 配置 + `claude -p` 无头 worker + 文件状态」。只支持 Claude Code。

### 新
- `hh`：单一 CLI（Node ≥ 18，零依赖），stdout 非 TTY 时自动输出 JSON。
- profile 模型：`gateways`（url + 鉴权 + 密钥 + 公共 env）→ `profiles`（网关 + model + 专属 env/args）→ `roles`（profile + 模板 + 自主级别）。`official` 内置 profile 不注入网关并清掉继承变量。
- `hh claude <profile>`：交互式启动（替代 `ccm <profile>` / `xxxcc` alias）；`hh profiles aliases` 反向生成 alias。
- `hh init` 自动导入 `~/.config/ccm/*.conf` 与 shell 里的 `xxxcc` alias；`hh profiles import-aliases / import-ccm` 手动导入，`--dry-run` 预览。
- run 目录即状态：`task.md / events.jsonl / output.log / result.json`；`done / failed / cancelled / crashed` 由进程与文件决定。
- `hh send`：`--resume` 恢复同一会话返修。
- 自主级别 `full / workspace / readonly` → `--permission-mode` 参数；角色可覆盖；模型取值 `-m` > 角色 > profile。
- `hh mcp` + `hh install-mcp`：hh 成为 Claude Code 的原生 MCP 工具。
- `hh doctor`：claude / 网关密钥 / profile / 角色 / 技能 / MCP / herdr；`--net` 对角色用到的 profile 真发 pong。
- 密钥支持 `env:VAR` 引用；所有输出打码。
- Leader 模式（`hh claude` 不带 profile）：协议 + 实时角色表 / profile 清单注入 system prompt；协议只讲不变量和「三问」，不按措辞分类；角色带 `desc` 用途描述，Leader 按描述选人。
- worker 汇报契约：回复末尾的 JSON 报告解析进 `result.report`（status / summary / changed / commits / verified / assumptions / blockers）。
- `tests/smoke.sh` 用 `tests/fake-agent` 假扮 claude 覆盖全链路（1.0.0 时 66 项，不需要真实 claude）；CI 跑 Node 18/20/22。

### 移除
- `ccm`（bash）和 `hl`（herdr 抓屏编排）；`gateways.conf / profiles.conf / roles.conf` 改为 `config.json`（自动导入）。
- 「先问『已完成』再关 tab」：进程退出即完成；验收由 Leader 做。

### 修复（相对 0.2 的设计缺陷）
- 关闭门禁被上一轮回复 / 「尚未已完成」误判 → 不再有门禁。
- worker 进程消失后 `wait` 空转到超时 → 立刻 `crashed`。
- `agent start` 失败被吞 → 启动失败进 `result.json` 的 `error` 和 stderr 尾部。
- README 声称 `CCM_CLAUDE_ARGS=""` 可关掉跳过权限，实际对派发无效 → 自主级别是显式配置。
- 所有 profile 都硬塞 `CLAUDE_CODE_EFFORT_LEVEL=max` → 不再默认设置，按 profile `env` 自定。
- Leader 的网关变量会漏给 official worker → worker 显式清理继承的 `ANTHROPIC_*`。
- herdr 从硬依赖降为可选观察窗口。

## 0.2.0 — 2026-09-02

初版：ccm + hl + herdr-leader 技能。

## Unreleased

### 2026-09-17 双模式与完整联调
- 自主实现 external / native 编排、三协议路由、默认 worker、额外模型、委派提示、有限回退及上下文压缩，无外部 OpenCodex 运行依赖。
- 修复真实 CLI 参数、Claude 模型后缀、Codex grammar 工具转换、并行工具结果和 Responses 续接来源；密钥保留在父进程。
- 配置面板原子保存编排策略，MCP 与 CLI 共用校验；加固 worker 取消/重复启动和跨 Agent 续跑边界。
- 增加协议与并发回归、真实 CLI 契约、真实网关委派与回退验收。 — 双模式与内置路由

- 保留跨 CLI worker 内核；增加 native 子代理策略和统一 hh run，支持 Codex Leader。
- 自实现会话路由与 Responses / Messages / Chat 协议转换，支持工具、SSE、默认 worker、委派提示和请求回退。
- 网关凭证复用且不传入 native CLI；路由器随会话启动与清理，无外部代理依赖。
- 修复删除当前 Leader profile 后引用悬空的问题。
- CI 增加双模式与协议测试；真实 Codex / Claude 跨协议委派契约检查。
