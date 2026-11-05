# 配置参考

一切都在 `~/.config/hh/`（`HH_CONFIG_DIR` 可改）：

```text
~/.config/hh/
├── config.json     gateways + profiles + roles + 默认值（600 权限，含密钥）
└── prompts/        角色模板（coder.md / executor.md / reviewer.md / researcher.md …）
```

运行状态在 `~/.local/state/hh/`（`HH_STATE_DIR` 可改）：`runs/<id>/` 和 `events.jsonl`。

三个概念：**端点**（gateway，也叫网关）= 地址 + 鉴权方式 + 密钥，只存一次；**profile** = 端点 + 模型；**角色**（role）= Leader 的分工，指向一个 profile。

改配置四种方式，效果相同、改完立即生效：

| 方式 | 命令 |
| --- | --- |
| 一问一答 | `hh setup`：加一个端点 + profile，顺手指定当 Leader / 干活，并真发一次 pong（终端里 `hh init` 没找到端点时自动进入） |
| 对 Leader 说 | 「加个网关」「加个模型 fast2 走 relay」「让 reviewer 用 smart」「把 xx 删了」 |
| 命令 | `hh gateways set/rm` · `hh profiles set/rm/test/import-aliases` · `hh roles set/rm` · `hh leader` |
| 改文件 | 直接编辑 `config.json` |

## 顶层字段

```json
{
  "version": 2,
  "leader": "smart",
  "viewer": "auto",
  "workspace": "w1",
  "footer": "## 完成要求\n\n- 全程不要停下来等确认…",
  "limits": { "timeoutMin": 120, "stallMin": 45 },
  "keepDays": 30,
  "claude": { "bin": "claude", "interactiveArgs": ["--dangerously-skip-permissions"], "pane": "right" },
  "codex": { "bin": "codex", "interactiveArgs": [] },
  "commonEnv": { "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "CLAUDE_CODE_NO_FLICKER": "1", "API_TIMEOUT_MS": "3000000" },
  "gateways": {},
  "profiles": {},
  "roles": {}
}
```

| 字段 | 说明 |
| --- | --- |
| `leader` | 你通常用哪个 profile 当 Leader（`hh leader <profile>` 改）；`hh doctor --net` 会顺带测它 |
| `viewer` | worker 开不开 herdr 窗口。`auto`（默认：herdr 在跑就给 worker 各开一个 tab，否则后台）· `herdr`（总是开，且 `hh claude` 也自动开进 herdr）· `none`（从不）。Leader 单次开进 herdr 用 `hh claude herdr`；`hh viewer <v>` 改默认；单次关闭 `hh claude --no-herdr` / `hh dispatch --view none`；环境变量 `HH_VIEWER` 覆盖 |
| `workspace` | herdr 工作区 id，默认 `w1` |
| `footer` | 拼在每个任务文件末尾的「完成要求」，默认要求 worker 在回复末尾附一个 JSON 报告（`status / summary / changed / commits / verified / assumptions / blockers / questions`），hh 解析进 `result.report`。改了它记得保留 json 块的要求，否则 `report` 为空。没改过的旧版默认页脚会自动升级 |
| `limits` | worker 时限（分钟，`0` = 不限）。`timeoutMin` 总时长，默认 120；`stallMin` 连续这么久 stdout / stderr 都没输出就判定卡住，默认 45（长构建 / 长测试本身就会几十分钟没输出，所以留得宽）。用单调时钟计时，合盖睡眠不算。超时会连 agent 拉起的子进程一起结束。到点 hh 结束 worker，run 记为 `failed`，`error` 以 `timeout:` / `stalled:` 开头。单个任务用 `hh dispatch --timeout MIN` 覆盖总时长 |
| `keepDays` | 已结束的 run 目录保留天数，默认 30；派发时每天最多检查一次，过期的自动删除。`0` = 不自动删（手动 `hh clean --days N`） |
| `claude.bin` | `claude` 可执行文件；profile 可单独覆盖 |
| `codex.bin` | `codex` 可执行文件；profile 可单独覆盖。只影响 `agent: "codex"` 的 profile |
| `claude.interactiveArgs` | `hh claude <profile>` 时追加的参数，默认跳过权限确认 |
| `claude.pane` | `/hh-config` 面板贴哪边：`right`（默认，右侧）· `bottom`（提示框上方）。`hh pane right\|bottom` 切换。pane 的位置由终端布局决定、插件设不了，所以这个开关实际切的是 `CLAUDE_CODE_NO_FLICKER`：`bottom` 会把它注入成 `0`（main screen 布局），代价是整屏可能有重绘闪烁。只作用于挂了面板的 Leader |
| `commonEnv` | 每个 profile 都带的环境变量；`official` 也带 |

## gateways

```json
"gateways": {
  "relay":  { "url": "https://relay.example.com",                "auth": "token",  "secret": "sk-…", "env": { "ENABLE_TOOL_SEARCH": "false" } },
  "vendor": { "url": "https://api.vendor.example.com/anthropic", "auth": "apikey", "secret": "env:VENDOR_KEY" }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `url` | 是 | `ANTHROPIC_BASE_URL`，`http(s)://…`，不带末尾 `/v1` |
| `auth` | 是 | `token` → 注入 `ANTHROPIC_AUTH_TOKEN`；`apikey` → 注入 `ANTHROPIC_API_KEY`。看网关文档要哪种，不确定先 `token` |
| `secret` | 是 | 密钥原文；或 `env:VAR_NAME` 从环境变量取，配置里不落明文 |
| `env` | 否 | 该网关下所有 profile 共用的环境变量 |

```bash
hh gateways set relay --url https://relay.example.com --auth token --secret sk-xxx --env ENABLE_TOOL_SEARCH=false
hh gateways set vendor --url https://api.vendor.example.com/anthropic --auth apikey --secret env:VENDOR_KEY
hh gateways rm vendor          # 仍被 profile 引用会拒绝
```

## profiles

```json
"profiles": {
  "official": { "gateway": null, "note": "不注入网关：用 claude 自己的登录 / 当前环境" },
  "fast":     { "gateway": "relay",     "model": "vendor/coding-fast" },
  "gemini":   { "gateway": "gemini-gw", "model": "gemini-2.5-pro", "env": { "CLAUDE_CODE_EFFORT_LEVEL": "high" } },
  "lite":     { "gateway": "relay",     "model": "vendor/coding-lite", "args": ["--effort", "low"] }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `gateway` | 是（可为 `null`） | `gateways` 里的名字；`null` / `official` = 不注入网关变量，并清掉继承来的；`hh profiles set` 不给 `--gateway` 即为 null |
| `agent` | 否 | 用哪个 CLI 干活：`claude`（缺省，不写就是它）· `codex`。决定无头命令、事件流解析、网关怎么注入。`hh profiles set <n> --agent codex` |
| `model` | 否 | claude：传给 `ANTHROPIC_MODEL` 及 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`；codex：传给 `-m`。空 = 网关默认 |
| `env` | 否 | 只对这个 profile 生效的环境变量；同名覆盖网关的 |
| `args` | 否 | 追加给 agent 的参数（交互式和无头都加） |
| `bin` | 否 | 覆盖可执行文件路径（默认取 `claude.bin` / `codex.bin`） |
| `note` | 否 | 备注，`hh profiles` 里显示 |

```bash
hh profiles set fast --gateway relay --model vendor/coding-fast
hh profiles set gemini --env CLAUDE_CODE_EFFORT_LEVEL=high
hh profiles set lite --gateway relay --model vendor/coding-lite --args '["--effort","low"]'
hh profiles show fast        # 密钥打码
hh profiles test fast        # 真发一次 pong
hh profiles rm fast          # 仍被角色引用会拒绝；official 不能删
hh env fast                  # 最终注入的 env（打码）；--reveal 明文
hh dispatch --dry-run -p fast -d . -t x    # 看它会拼出什么命令，不真跑
```

## roles

```json
"roles": {
  "coder":      { "profile": "fast",     "template": "coder.md",      "autonomy": "full" },
  "executor":   { "profile": "fast",     "template": "executor.md",   "autonomy": "full" },
  "reviewer":   { "profile": "official", "template": "reviewer.md",   "autonomy": "readonly" },
  "researcher": { "profile": "gemini",   "template": "researcher.md", "autonomy": "readonly", "model": "gemini-2.5-pro" },
  "tester":     { "profile": "fast",     "template": "-" }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `profile` | 是 | `profiles` 里的名字 |
| `template` | 否 | `prompts/` 下的文件名或绝对路径；`-` 表示不套模板。`hh roles set` 不写时默认取 `prompts/<role>.md`，没有则 `-` |
| `model` | 否 | 覆盖 profile 的 `model`（同一网关换个模型不用新建 profile） |
| `autonomy` | 否 | `full` `workspace` `readonly`，默认 `full` |
| `desc` | 否 | 一句话用途。**Leader 靠它选人**：启动时角色表连同 desc 注入 prompt。角色名字任意，`coder / executor / reviewer / researcher` 只是有默认 desc 和模板的四个 |

```bash
hh roles set reviewer --profile smart
hh roles set coder --model vendor/coding-fast-v2
hh roles set tester --profile fast --desc "跑测试并报告失败用例"   # 模板自动找 prompts/tester.md
hh roles rm tester
hh leader smart
```

模型的最终取值顺序：`hh dispatch -m` > `roles.<role>.model` > `profiles.<profile>.model` > 网关默认。`-r` 与 `-p` 同时给时，角色上的 `model` 不再生效，用 `-p` 那个 profile 自己的模型（要换模型再加 `-m`）。

## prompts/

每个模板就是一段 Markdown，`hh dispatch -r <role>` 时拼进任务文件的「角色规范」段。`hh init` 只在缺失时复制仓库里的默认模板，你改过的不会被覆盖。任务文件的最终结构：

```markdown
# 任务：export-be
- 角色: coder    profile: fast (relay, vendor/coding-fast)    autonomy: full    工作目录: ~/repo/be    run: 2026…    创建: …

## 角色规范
（prompts/coder.md）

## 任务
（你 -f / -t 给的内容）

## 完成要求
（config.footer）
```

`hh send` 的返修 run 只发送你的追加指令 + 完成要求（会话里已经有角色规范）。

## 内置原生子代理（可选）

网关可声明 `wire: "responses" | "anthropic" | "chat"`，以及 `contextWindow`、`maxOutputTokens`、可选 `capabilities`（imageInput、parallelToolCalls、reasoningSummaries、reasoningEfforts）。profile 的 `orchestration` 保存 `{mode: "native", workerModel: "gateway/model", models: [], fallback: [], prompt: "", effort: "high"}`。凭证复用 gateway.secret（支持 env:变量名）；无需外部代理服务。完整说明见 [orchestration.md](orchestration.md)。
