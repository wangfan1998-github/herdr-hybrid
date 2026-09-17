# profile：端点 + 模型（密钥在端点上）

hh 不调用任何模型 API。它只做一件事：把 profile 翻译成一组环境变量 + agent CLI 的参数，然后要么交互式启动（`hh claude` / `hh codex`），要么无头启动一个 worker（`hh dispatch`），再把 agent 的事件流翻译回统一的 transcript 和 `result.json`。

profile 的 `agent` 字段决定用哪个 CLI：`claude`（缺省）或 `codex`。两者的 env / 参数算法不同，见下。

## env 是怎么算出来的

```text
commonEnv                          每个 profile 都带（CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC / NO_FLICKER / API_TIMEOUT_MS …）
  < gateways.<gw>.env              网关公共：ENABLE_TOOL_SEARCH=false、大上下文开关 …
  < profiles.<p>.env               profile 专属
  < 适配器注入                      按 agent 不同（下面两节）
```

**`agent: claude`** —— 全部走环境变量：

```text
  < ANTHROPIC_BASE_URL             = 网关 url
  < ANTHROPIC_AUTH_TOKEN | API_KEY = 网关 secret（按 auth 二选一，另一个从继承环境里清掉）
  < ANTHROPIC_MODEL + ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL + CLAUDE_CODE_SUBAGENT_MODEL = 模型
```

**`agent: codex`** —— codex 不认 `ANTHROPIC_*`，网关走命令行的 TOML 覆盖，只有密钥值留在 env：

```text
  < env  HH_CODEX_KEY = 网关 secret        （命令行上只出现变量名，不出现密钥）
  < argv -c model_provider=hh
         -c model_providers.hh.base_url=<网关 url>
         -c model_providers.hh.env_key=HH_CODEX_KEY
         -c model_providers.hh.wire_api=responses
         -m <模型>
```

> Codex 的直接网关连接使用 Responses API；native 模式由 hh 转换协议，可以连接 Chat Completions 或 Anthropic Messages 网关。

**跨 agent 清理**：external 清理 hh 注入的其他 Agent 网关变量，保留官方登录所需的用户凭证。native 进一步移除已知厂商凭证与配置中的密钥引用，只向 CLI 注入本地会话凭证；上游密钥由父进程持有。

`hh env <profile>` 打印最终结果（打码）；`hh env <profile> --reveal` 明文，可以 `env $(hh env fast --reveal | grep -v '^#') claude` 这样手工用。

### `gateway: null` = 用这个 CLI 自己的订阅 / 登录

`gateway: null` 的意思是**不注入网关**：不设地址和密钥，并且**清掉从父进程继承的**网关变量（`ANTHROPIC_*`、`HH_CODEX_KEY` …）。于是这个 profile 走的是它那个 agent 自己的登录，而不是 Leader 的网关。

这跟 agent 无关，两边都适用：

| profile | agent | gateway | 实际鉴权 |
| --- | --- | --- | --- |
| `official` | claude | `null` | Claude Code 自己的登录（`claude /login`） |
| 你起的任意名字 | codex | `null` | Codex 自己的登录（`codex login`，含 ChatGPT 订阅） |

```bash
hh profiles set codex --agent codex     # 用 ChatGPT 订阅 / codex 已有登录干活，不用配网关
```

内置的 **`official`** 就是「`agent: claude` + `gateway: null`」这一种，不可删。注意 `official` 只是**这个 profile 的名字**；起作用的是 `gateway: null`，换个名字一样生效。

`hh doctor` 按 `gateway === null` 判断要不要体检登录（不按 profile 名），只检查真的被 `leader` / 角色用到的，并且用 profile 实际会启动的那个可执行文件去问：

```text
✓ claude.auth   已登录 (oauth_token, firstParty)（profile: official）
✓ codex.auth    Logged in using ChatGPT（profile: codex）
```

### 密钥引用

`secret` 写 `env:VAR_NAME`，运行时从环境变量取。`hh doctor` 会检查该变量是否为空。

## 交互式：`hh claude <profile> [args…]` / `hh codex <profile> [args…]`

等价于手写的 `fastcc` 这类 alias：

```bash
hh claude fast                     # 注入 env 后 exec claude --dangerously-skip-permissions
hh claude fast -p "hi"             # 参数原样透传
hh claude official                 # 清掉网关变量，用官方登录
hh codex cx                        # agent: codex 的 profile 用这个起（hh run cx 可作为 Leader）
eval "$(hh profiles aliases)"      # alias fastcc='…/hh claude fast' …（--suffix 改后缀）
```

`<agent>.interactiveArgs`（claude 默认 `["--dangerously-skip-permissions"]`，codex 默认空）+ `profiles.<p>.args` + 你给的参数，按这个顺序拼。

## 无头：`hh dispatch`

**`agent: claude`**

```text
claude -p --output-format stream-json --verbose <autonomy 参数> [--model M] [--resume SID] [profile.args…]
```

| autonomy | 参数 |
| --- | --- |
| `full` | `--permission-mode bypassPermissions` |
| `workspace` | `--permission-mode acceptEdits` |
| `readonly` | `--permission-mode default --allowedTools "Bash(git diff:*)" "Bash(git log:*)" "Bash(git show:*)" "Bash(git status:*)"` |

**`agent: codex`**（任务正文同样走 stdin，末尾 `-` 是明示从 stdin 读）

```text
codex exec [resume SID] --json --skip-git-repo-check <autonomy 参数> [-c 网关覆盖…] [-m M] [profile.args…] -
```

| autonomy | 参数 |
| --- | --- |
| `full` | `--dangerously-bypass-approvals-and-sandbox` |
| `workspace` | `-s workspace-write` |
| `readonly` | `-s read-only` |

> `--skip-git-repo-check` 是必需的：codex 默认拒绝在非 git 目录里跑，而 `hh profiles test` 的 probe 目录不是 git 仓库。
> 续跑是 `exec resume <ID>` 子命令 + 位置参数（不是 `--resume` flag）；会话 id 取自 `thread.started.thread_id`。

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

## 迁移：从 shell alias 导入

给之前就用 alias 管一批 key 的人：`hh init` 自动做，下面的命令可以随时补导入。从零开始的用户用 `hh setup` 或 `hh gateways set` + `hh profiles set`，不需要这一节。

### shell alias（`hh profiles import-aliases [--dry-run] [FILE…]`）

指的是这种手写的启动 alias：

```bash
alias fastcc="ANTHROPIC_BASE_URL=https://relay.example.com ANTHROPIC_AUTH_TOKEN=sk-… ANTHROPIC_MODEL=vendor/coding-fast claude"
```

默认扫 `~/.shell_aliases` `~/.zshrc` `~/.bashrc`。识别同一行里 `alias NAME=…` 且包含 `ANTHROPIC_BASE_URL=` 和 `claude` 的行；`claude` 之前的所有 `K=V` 都算环境变量。

- 网关：同 url + 同密钥归为一个，名字取 host（`relay-example-com`）；已有同 url + 同密钥的网关直接复用。
- profile：名字去掉尾部 `cc`（`fastcc` → `fast`），大小写不敏感去重；`ANTHROPIC_MODEL` → `model`；其它 `K=V` 里与 `commonEnv` 相同的丢掉，剩下的进 profile `env`。
- 多行 alias、函数不识别，手写 `hh profiles set` 即可。

`hh init` 会自动做这件事；已存在的条目跳过，不覆盖。

## Transport 与交互式编排策略

`profile.orchestration` 保存 mode、workerModel、models、fallback、prompt、effort；详情见 [双模式](orchestration.md)。native 的主模型来自 profile.gateway / model，子模型通过 gateway/model 选择。

环境计算顺序保持 `commonEnv < gateway.env < profile.env < 适配器注入的网关/模型`。native 启动时最后移除已知厂商凭证与配置的密钥引用，注入临时本地端点与会话凭证。原生委派参数只在 Leader 启动阶段添加，不影响显式 hh dispatch 的执行语义。
