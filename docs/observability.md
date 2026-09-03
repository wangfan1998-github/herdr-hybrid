# 观测：谁在干嘛、卡在哪、结果是什么

## 三层视角

| 层 | 命令 | 看什么 |
| --- | --- | --- |
| 快照 | `hh status`（`--all` 全部） | 每个 run：状态、角色/profile、耗时、最终回复或错误的前 50 字 |
| 细节 | `hh read <id> [-n 60]` · `hh result <id>` · `hh task <id>` | transcript 尾部 / 最终结论与用量 / 当时派发的原文 |
| 回溯 | `hh log [-n 20]` · `~/.local/state/hh/runs/<id>/` | dispatch / finished / cancel / profiles_set 事件流；每个 run 的完整目录 |

Agent 用同样的命令，拿到的是 JSON。

## 状态怎么解读

| 状态 | 含义 | 处置 |
| --- | --- | --- |
| `starting` | run 目录已建，worker 进程还没登记 pid（herdr tab 模式下 shell 刚起） | 等；90 秒没起来会自动变 `crashed` |
| `running` | worker 进程活着 | `hh read` 看进度；不要打断 |
| `done` | 进程退出码 0，`claude -p` 没报错 | **不等于任务合格**：`hh result` 看 final，自己跑验收 |
| `failed` | 退出码非 0，或 `result` 事件 `is_error`（网关 401/503、模型不存在、超时…） | `hh result` 的 `error` + `hh read` 末尾（含 stderr 尾部）找根因；网关问题换 profile 重派 |
| `cancelled` | 被 `hh cancel` 终止 | — |
| `crashed` | 进程消失且没写 `result.json`（被 kill、机器重启、tab 没跑起来） | `hh read`；通常重派 |

状态由文件决定，不依赖 herdr，也不依赖任何终端标题：`result.json` 存在就用它；否则 `worker_pid` 活着就是 `running`；否则 `crashed`。**`hh wait` 不会因为进程死了而空转到超时。**

## run 目录

```text
~/.local/state/hh/runs/20260902-141003-export-be-a1f2/
├── meta.json      id、label、role、profile、gateway、model、autonomy、cwd、pid、command、viewer、parent、session_id
├── task.md        worker 收到的全文
├── events.jsonl   claude -p 原始事件流（--raw 看）
├── output.log     人可读 transcript
├── stderr.log     claude 的 stderr
└── result.json    结论
```

id 的形状是 `<时间>-<label>-<4位随机>`。`hh` 的所有子命令都接受完整 id、id 前缀、或 label（唯一时）。

## herdr：可选的观察窗口

装了 [herdr](https://herdr.dev) 且在运行时，`hh dispatch` 默认（`viewer: auto`）把 worker 跑在一个 `--no-focus` 的 tab 里，你能看到 transcript 实时滚动：

```text
# hh run 2026…-export-be-a1f2 · coder → fast @ relay (vendor/coding-fast) · full · ~/repo/be
$ claude -p --output-format stream-json --verbose --permission-mode bypassPermissions --model vendor/coding-fast
  · init model=vendor/coding-fast mode=bypassPermissions
⏺ 先读一下现有实现
  ⚙ Read src/export.go
⏺ 已实现 /export 接口，go test ./... 通过
  ■ success
# done · exit 0 · 4m21s
```

- 状态判定完全不经过 herdr；tab 只是窗口。关掉 tab 不会杀 worker（它忽略 SIGHUP，继续写文件）。
- `hh close <id>` 收回 tab；`hh view <id>` 给后台 run 补开一个 `tail -f` 窗口。
- 不想开窗口：`--view none` 或 `config.viewer = "none"`。

推荐布局：tab 1 是 Leader（`hh claude <最聪明的 profile>`），其余 tab 由 hh 创建和回收；想看细节点进去即可，不要在里面输入。

## 事件流

`~/.local/state/hh/events.jsonl`，一行一个 JSON：

```json
{"ts":"2026-09-02T06:10:05.120Z","id":"20260902-141003-export-be-a1f2","label":"export-be","role":"coder","profile":"fast","gateway":"relay","model":"vendor/coding-fast","cwd":"/Users/me/repo/be","parent":null,"resume":false,"kind":"dispatch"}
{"ts":"2026-09-02T06:14:40.003Z","id":"20260902-141003-export-be-a1f2","status":"done","exit_code":0,"error":null,"kind":"finished"}
```

`kind` 取值：`dispatch` `finished` `crashed` `cancel` `close` `roles_set` `roles_rm` `profiles_set` `profiles_rm` `gateways_set` `gateways_rm`。要做统计直接 `jq`。

## Leader 的等待节奏

Claude Code 单次 Bash 调用最长 600 秒，所以 Leader 用 `hh wait … --timeout 540` 循环：每 3 秒查一次文件状态、只在变化时打印一行，超时退出码 2 再调一次。MCP 工具 `hh_wait` 默认 240 秒、上限 300 秒，同样循环。
