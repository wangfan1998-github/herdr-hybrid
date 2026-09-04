# 排障

先跑 `hh doctor`：claude 是否找到、网关密钥是否齐、profile / 角色 / 模板是否完整、技能和 MCP 是否装好。`hh doctor --net` 再对角色用到的 profile 各发一次「pong」（`--all` 全部 profile，30 个 profile 会比较久）。

## 第一次配置

**`hh doctor` 说「没有端点，只有 official」/ `hh claude` 提醒「只有 official 一个 profile」**：还没加任何订阅 / API key / 网关，所有角色都是 `claude` 自己的登录，能跑但不是混动。`hh setup` 一问一答加一个，或 `hh gateways set` + `hh profiles set`。已经在 shell alias 里管着 key 的用 `hh profiles import-aliases`。

**`hh setup` 的 pong 测试失败**：地址、鉴权方式、密钥三者最常错。`hh read <id>` 看 stderr 尾部；`error` 里的 `API Error: …` 是网关返回的原话。地址不带末尾 `/v1`；`token` 和 `apikey` 换一种再试。

**stderr 里有 `[claude-code:unrecognized_model]`**：Claude Code 对所有非 Anthropic 官方模型名都会打这条警告，包括正常工作的网关模型。它不是错误；hh 生成 `error` 摘要时会过滤掉它，真因看 `API Error` 那一行。

## 网关 / 模型相关

**`failed`，`error` 含 `401` / `Invalid API key` / `authentication`**：密钥错或 `auth` 类型错（`token` → `ANTHROPIC_AUTH_TOKEN`，`apikey` → `ANTHROPIC_API_KEY`）。`hh env <profile>` 看注入了哪个；`hh gateways set <gw> --auth apikey` 换一种。

**`failed`，`error` 含 `503 No available servers` / `attempt 10/10`**：网关那个模型暂时没实例，不是派发问题。换 profile 重派：`hh dispatch -p <其它>`，或 `hh roles set coder --profile <其它>`。

**`failed`，`error` 含 `model not found`**：`hh profiles show <p>` 看 model id；网关的 `GET /v1/models` 能列出可用 id。

**`000` / `ENOTFOUND` / 连不上**：域名解析不到。公司内网网关常常只在办公 DNS 里有记录，本机 `dig` 不到就在 `/etc/hosts` 加一行；IP 直连的网关不受影响。

**CLIProxyAPI 一类网关 403 / 被封**：管理接口连续 5 次鉴权失败会按来源 IP 封 30 分钟。不要用错 key 反复 `hh doctor --net --all`；先 `hh profiles test` 单个确认。

## herdr 相关

**`hh claude` 没有开进 herdr**：`hh claude --dry-run` 的 `launch` 行说明原因。`terminal` 加「herdr 未安装」→ 终端里 `hh claude` 会问你要不要装，回车即装；非 TTY 不代跑安装脚本，手动 `hh install herdr`；`terminal` 加「viewer = none」→ `hh viewer auto`；`pane` 表示你已经在 herdr 的 pane 里，原地启动不再开 tab，派出的 worker 照样各开一个 tab。

**开了 tab 但终端没跳进 herdr**：只有 stdin 和 stdout 都是 TTY 才会附着客户端；在 Agent 的 shell 里只建 tab 并返回 JSON，自己打开 herdr 即可看到 `hh:leader` tab。

**「herdr server 没能在 15 秒内就绪」**：hh 用 `herdr server` 后台拉起失败，Leader 改在当前终端运行。手动 `herdr` 启动一次看报错；`hh doctor` 看 herdr 行。

**Claude Code / herdr 没装**：`hh install claude` / `hh install herdr` 跑官方安装脚本（TTY 里先确认，`--yes` 跳过；Windows 只打印命令）。`install.sh` 首次安装时也会问。

## 派发相关

**`failed`，`error` 是 `找不到可执行文件`**：`claude` 不在 hh 的 PATH 里。`config.claude.bin` 或 `hh profiles set <p> --bin /绝对路径`。

**`crashed`，`error` 是 `worker 从未启动`**：herdr tab 模式下 shell 没把命令跑起来（shell 启动极慢、或 tab 被立刻关掉）。用 `--view none` 走后台，或看 `hh log`。

**`done` 但什么都没改**：看 `hh result` 的 final 和 `hh read`。常见原因：任务没写清目录/文件；`autonomy` 是 `readonly`（reviewer / researcher 默认如此）却要它改代码。

**worker 停在提问上**：无头模式下没有人回答，所以模板里写了「不要提问」；如果它还是问了，`hh send <id> -t "选方案 X，直接全量实现并提交，不要再停下确认"`。

**worker 走错了网关**：`hh dispatch --dry-run -r <role>` 看最终 env。网关地址、密钥、模型这 8 个变量按 profile 重算：有网关就覆盖，是 `official` 就清掉，Leader 自己的不会漏过去（其它 `ANTHROPIC_*` 照常继承）。

**`hh wait` 超时（退出码 2）**：不是错误，再调一次即可。Leader 的单次 shell 调用有 600 秒上限，所以默认 540。

**同一仓库两个 worker 互相覆盖**：任务里写清文件边界；模板要求只 `git add <file>`。真要隔离用 `git worktree` 各给一个目录。

## 会话恢复（hh send）

**`hh send` 后 worker 不记得上一轮**：看 `hh result <原 id>` 的 `session_id` 是否为空。为空说明 `claude -p` 没输出 `init` / `result` 事件（通常是启动就失败了）。

**`hh send` 报 `仍在 running`**：只能给已结束的 run 追加；先 `hh wait` 或 `hh cancel`。

## 导入相关

**`hh profiles import-aliases` 漏了某条**：只识别同一行里 `alias NAME=…` 且含 `ANTHROPIC_BASE_URL=` 和 `claude` 的行；多行 alias、函数不支持，手写 `hh profiles set`。`--dry-run` 先看会导什么。

**导入后有大小写重复的 profile**：alias 名大小写不敏感去重；已存在的旧条目保留。`hh profiles rm` 多余的那个。

**`hh init` 说已存在**：`hh init --force` 会在现有配置上再导入一次（不删已有条目）；只想补导入用 `hh profiles import-aliases`。

## Leader 行为相关

**Leader 自己动手写代码了**：技能明确禁止；提醒它「按 herdr-leader 协议派给 coder」。

**Leader 用 `sleep` 轮询 / 把整段 transcript 贴出来**：提醒它用 `hh wait --timeout 540` 和 `hh result`。

**Leader 说没有 hh 命令**：`~/.local/bin` 不在它的 PATH；或者 `hh install-mcp` 注册成原生工具，就不依赖 PATH 了。

**Leader 把密钥打出来了**：`hh profiles` / `hh env` 默认打码；技能禁止用 `--reveal`。

## 安全相关

**worker 做了不该做的事**：`autonomy full` = 你账号的全部本地权限。评审 / 调研类任务用 `readonly`；不信任的目录不要派 `full`。

**config.json 权限不是 600**：`chmod 600 ~/.config/hh/config.json`。不想落明文就把 `secret` 写成 `env:VAR_NAME`。
