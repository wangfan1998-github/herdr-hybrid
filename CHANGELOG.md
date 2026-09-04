# Changelog

## Unreleased

面向「手里有多个订阅 / API key、想混用」的人重写上手路径；shell alias 导入退为老用户的一键迁移。

### 删
- `hh profiles import-ccm`、`hh init` 对 `~/.config/ccm/*.conf` 的自动导入、`HH_CCM_DIR`。ccm 是这个仓库 0.x 时期自己的 bash 启动器，1.0 起没有人再需要从它迁移；配置早已在 `config.json` 里。

### 新
- `hh claude` 默认开进 herdr：装了 herdr 就在工作区里开一个聚焦的 `hh:leader` tab 跑 Leader，server 没起自动 `herdr server` 拉起，终端里顺手附着客户端；已经在 herdr pane 里就原地启动；没装回退当前终端并提示。`--no-herdr` 留在终端且给 Leader 设 `HH_VIEWER=none` 让 worker 也不开窗口；`--herdr` 让普通模式也进 herdr；`hh viewer auto|herdr|none` 改默认；`hh claude --dry-run` 多一行 `launch`。
- `hh install claude|herdr`：官方安装脚本装缺的依赖（TTY 先确认，`--yes` 跳过）；`install.sh` 缺依赖时会问（`HH_INSTALL_DEPS=yes|no` 跳过询问）；`hh doctor` 的提示指向它。
- `hh setup`：一问一答加一个端点 + profile（地址、鉴权、密钥不回显、模型），问它当 Leader 还是干活，顺手真发一次 pong。`hh init` 在 TTY 里没找到任何端点时自动进入（`--no-setup` 关闭）；非 TTY 打印等价命令。
- `hh claude` Leader 模式在只有 `official` 一个 profile、或所有角色都指向 Leader 自己时，stderr 提醒一句（照常启动）。
- `hh doctor` 无端点时的提示指向 `hh setup`。

### 改
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
- `tests/smoke.sh` 用 `tests/fake-agent` 假扮 claude 覆盖全链路（66 项，不需要真实 claude）；CI 跑 Node 18/20/22。

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
