# profile：网关 + key + 模型

hh 不调用任何模型 API。它只做一件事：把 profile 翻译成一组环境变量 + `claude` 的参数，然后要么交互式启动（`hh claude`），要么无头启动一个 worker（`hh dispatch`），再把 `claude -p` 的事件流翻译回统一的 transcript 和 `result.json`。

## env 是怎么算出来的

```text
commonEnv                          每个 profile 都带（CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC / NO_FLICKER / API_TIMEOUT_MS …）
  < gateways.<gw>.env              网关公共：ENABLE_TOOL_SEARCH=false、大上下文开关 …
  < profiles.<p>.env               profile 专属
  < ANTHROPIC_BASE_URL             = 网关 url
  < ANTHROPIC_AUTH_TOKEN | API_KEY = 网关 secret（按 auth 二选一，另一个从继承环境里清掉）
  < ANTHROPIC_MODEL + ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL + CLAUDE_CODE_SUBAGENT_MODEL = 模型
```

`hh env <profile>` 打印最终结果（打码）；`hh env <profile> --reveal` 明文，可以 `env $(hh env fast --reveal | grep -v '^#') claude` 这样手工用。

### `official`

内置、不可删。`gateway: null`：不注入网关变量，并且**清掉从父进程继承的** `ANTHROPIC_BASE_URL / AUTH_TOKEN / API_KEY / *_MODEL`。这意味着 Leader 用 `fast` 启动、派 `official` worker 时，worker 走的是 `claude` 自己的登录，而不是 Leader 的网关。

### 密钥引用

`secret` 写 `env:VAR_NAME`，运行时从环境变量取。`hh doctor` 会检查该变量是否为空。

## 交互式：`hh claude <profile> [args…]`

等价于以前的 `ccm <profile>` / `xxxcc` alias：

```bash
hh claude fast                     # 注入 env 后 exec claude --dangerously-skip-permissions
hh claude fast -p "hi"             # 参数原样透传
hh claude official                 # 清掉网关变量，用官方登录
eval "$(hh profiles aliases)"      # alias fastcc='…/hh claude fast' …（--suffix 改后缀）
```

`claude.interactiveArgs`（默认 `["--dangerously-skip-permissions"]`）+ `profiles.<p>.args` + 你给的参数，按这个顺序拼。

## 无头：`hh dispatch`

```text
claude -p --output-format stream-json --verbose <autonomy 参数> [--model M] [--resume SID] [profile.args…]
```

| autonomy | 参数 |
| --- | --- |
| `full` | `--permission-mode bypassPermissions` |
| `workspace` | `--permission-mode acceptEdits` |
| `readonly` | `--permission-mode default --allowedTools "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(git status:*)"` |

无头模式下没有人点「允许」，`readonly` 的本质是需要审批的调用直接被拒，reviewer / researcher 用它正合适。

worker 拿到：stdin = 完整 `task.md`（角色规范 + 任务 + 完成要求）；env = 上面算出来的；cwd = `-d`；另外有 `HH_RUN_ID` / `HH_RUN_DIR`。

`events.jsonl` 原样保存每一行 stdout；`output.log` 是解析后的 transcript：

```text
  · init model=… mode=bypassPermissions    ← 信息行（session_id 从这里来）
⏺ 我先读一下现有实现                        ← 模型的文字
  ⚙ Read src/export.go                     ← 工具调用
  ↳ ✗ file not found                       ← 失败的工具结果（成功的不打印）
  ■ success                                ← 结束事件
# done · exit 0 · 4m21s                    ← hh 的收尾行
```

`result.json`：

```json
{ "status": "done", "exit_code": 0, "signal": null, "final": "…最终回复全文…",
  "report": { "status": "done", "summary": "已实现 /export 接口", "changed": ["be/export.go"], "commits": ["3f2a9c1"],
              "verified": [{ "cmd": "go test ./...", "ok": true }], "assumptions": [], "blockers": [] },
  "session_id": "…", "usage": { "cost_usd": 0.02, "turns": 5, "duration_ms": 261000 },
  "error": null, "started": "…", "ended": "…", "duration_ms": 261340 }
```

`report` 来自 worker 回复末尾的最后一个 ```json 块（任务页脚 `config.footer` 要求它这么交）。解析失败或没有就是 `null`——Leader 把这当成「没做完」的信号去看 `hh read`。`status` 是进程层面的，`report.status` 是 worker 自述的完成度，两者都要看，最终以 Leader 自己的验收为准。

`status` 判定：退出码 0 且 `result` 事件没有 `is_error` → `done`；否则 `failed`；被 `hh cancel` → `cancelled`；进程消失且没写结果 → `crashed`。

### 返修：`hh send`

`hh send <id> -t "…"` 用上一轮的 `session_id` 起一个 `--resume` 的新 run，同 profile、同目录、同自主级别；只发送你的追加指令 + 完成要求。`session_id` 为空（极少见）时退化为把上一轮结论拼进新任务。

## 导入

### shell alias（`hh profiles import-aliases [--dry-run] [FILE…]`）

默认扫 `~/.shell_aliases` `~/.zshrc` `~/.bashrc`。识别同一行里 `alias NAME=…` 且包含 `ANTHROPIC_BASE_URL=` 和 `claude` 的行；`claude` 之前的所有 `K=V` 都算环境变量。

- 网关：同 url + 同密钥归为一个，名字取 host（`relay-example-com`）；已有同 url + 同密钥的网关直接复用。
- profile：名字去掉尾部 `cc`（`fastcc` → `fast`），大小写不敏感去重；`ANTHROPIC_MODEL` → `model`；其它 `K=V` 里与 `commonEnv` 相同的丢掉，剩下的进 profile `env`。
- 多行 alias、函数不识别，手写 `hh profiles set` 即可。

### ccm（`hh profiles import-ccm [--dry-run] [DIR]`）

默认读 `~/.config/ccm/{gateways,profiles,roles}.conf`（空白分隔，`#` 注释，值内 `#` 保留）。`roles.conf` 里的 `claude` / `-` 映射为 `official`。已存在的条目跳过，不覆盖。

`hh init` 会自动做这两件事。
