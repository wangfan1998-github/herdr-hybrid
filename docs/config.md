# 配置参考

一切都在 `~/.config/hh/`（`HH_CONFIG_DIR` 可改）：

```text
~/.config/hh/
├── config.json     gateways + profiles + roles + 默认值（600 权限，含密钥）
└── prompts/        角色模板（coder.md / executor.md / reviewer.md / researcher.md / planner.md …）
```

运行状态在 `~/.local/state/hh/`（`HH_STATE_DIR` 可改）：`runs/<id>/` 和 `events.jsonl`。

改配置三种方式，效果相同、改完立即生效：

| 方式 | 命令 |
| --- | --- |
| 对 Leader 说 | 「加个网关」「加个模型 fast2 走 relay」「让 reviewer 用 smart」「把 xx 删了」 |
| 命令 | `hh gateways set/rm` · `hh profiles set/rm/test/import-aliases/import-ccm` · `hh roles set/rm` · `hh leader` |
| 改文件 | 直接编辑 `config.json` |

## 顶层字段

```json
{
  "version": 2,
  "leader": "smart",
  "viewer": "auto",
  "workspace": "w1",
  "footer": "## 完成要求\n\n- 全程不要向 Leader 提问…",
  "claude": { "bin": "claude", "interactiveArgs": ["--dangerously-skip-permissions"] },
  "commonEnv": { "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1", "CLAUDE_CODE_NO_FLICKER": "1", "API_TIMEOUT_MS": "3000000" },
  "gateways": {},
  "profiles": {},
  "roles": {}
}
```

| 字段 | 说明 |
| --- | --- |
| `leader` | 你通常用哪个 profile 当 Leader（`hh leader <profile>` 改）；`hh doctor --net` 会顺带测它 |
| `viewer` | `auto`（herdr 在运行就开 tab，否则后台）· `herdr`（必须开 tab，失败回退后台）· `none`（总是后台） |
| `workspace` | herdr 工作区 id，默认 `w1` |
| `footer` | 拼在每个任务文件末尾的「完成要求」，默认要求 worker 在回复末尾附一个 JSON 报告（`status / summary / changed / commits / verified / assumptions / blockers`），hh 解析进 `result.report`。改了它记得保留 json 块的要求，否则 `report` 为空 |
| `claude.bin` | `claude` 可执行文件；profile 可单独覆盖 |
| `claude.interactiveArgs` | `hh claude <profile>` 时追加的参数，默认跳过权限确认 |
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
| `gateway` | 是 | `gateways` 里的名字；`null` = official（不注入网关变量，并清掉继承来的） |
| `model` | 否 | 传给 `ANTHROPIC_MODEL` 及 `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`、`CLAUDE_CODE_SUBAGENT_MODEL`；空 = 网关默认 |
| `env` | 否 | 只对这个 profile 生效的环境变量；同名覆盖网关的 |
| `args` | 否 | 追加给 `claude` 的参数（交互式和无头都加） |
| `bin` | 否 | 覆盖 `claude` 可执行文件路径 |
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

模型的最终取值顺序：`hh dispatch -m` > `roles.<role>.model` > `profiles.<profile>.model` > 网关默认。

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
