# 双模式与内置模型路由

herdr-hybrid 自己实现模型路由与协议转换，无需安装或运行 OpenCodex。借鉴的是其原生子代理跨模型的实现思路，不依赖其进程、SDK、配置或服务。

保留 `agent adapter → worker → runs` 边界。Agent 决定工具与执行会话，gateway 决定模型服务，orchestration 决定子任务由谁管理。

| 模式 | 调度者 | 子任务 | 状态 |
| --- | --- | --- | --- |
| external（默认） | hh + Leader | 独立 Claude Code / Codex CLI，各用自己的 profile | hh runs、result、send/resume、herdr tab |
| native | 当前 CLI | 同一种 CLI 的原生子代理，选择不同 gateway/model | 当前 CLI 的原生会话 |
| plain | 无 hh Leader 协议 | 普通交互式 CLI | 当前 CLI 自身 |

## 配置

沿用现有 gateways、密钥引用和 profiles。为 native 使用的网关声明协议：`responses`、`anthropic` 或 `chat`。URL 填服务根地址或以 `/v1` 结尾的 API 基址；模型填写服务端支持的实际 ID。

```bash
# 密钥预先设置在环境变量中；以下域名、模型名都是占位示例
hh gateways set primary --url https://primary.example/v1 --wire responses --secret env:PRIMARY_API_KEY
hh gateways set secondary --url https://secondary.example/v1 --wire anthropic --auth apikey --secret env:SECONDARY_API_KEY
hh profiles set native-cx --agent codex --gateway primary --model MAIN_MODEL
hh mode native-cx --mode native --worker secondary/WORKER_MODEL --models primary/REVIEW_MODEL --fallback primary/BACKUP_MODEL --effort high --prompt '完成后报告测试证据'
hh native plan native-cx
hh run native-cx --dry-run
hh run native-cx
```

Claude 使用相同配置流程，将 profile 的 `--agent` 改成 `claude`。`hh mode PROFILE --fallback ''` 清空回退，`--models ''` 清空额外模型。默认 worker 加额外 roster 最多 5 个，备用模型最多 4 个。

```bash
hh run PROFILE --mode external  # 临时使用独立 CLI worker
hh mode PROFILE --mode external # 保存默认模式
hh run PROFILE
```

`hh run` 默认启动 Leader；旧的显式 `hh claude PROFILE` / `hh codex PROFILE` 仍是普通启动，`--leader` 可启用 Leader。`hh dispatch` 始终是显式的外部任务原语，不自动嵌套 native 编排。

旧试验配置若含 `transport: opencodex`，须用 `hh profiles set PROFILE --transport direct --gateway GATEWAY --model MODEL` 改回本项目的网关；不继续使用旧 bridge 配置。

## 内部实现

- `lib/orchestration.js`：模式、默认 worker、可选模型、回退链与委派提示。
- `lib/native.js`：会话内 HTTP 服务、路由、凭证、模型目录、续接缓存和生命周期。
- `lib/protocols/`：Responses、Anthropic Messages、Chat Completions 的统一消息表示、SSE、工具调用和输出转换。
- `lib/agents/`：Codex / Claude 启动参数。runs / worker 内核无需理解厂商协议。

native 启动时在 127.0.0.1 随机端口创建服务，并生成随机会话凭证。CLI 退出后停止服务，清理模型目录和缓存。dry-run 不启动服务、不访问模型。网关密钥留在父进程路由器中；CLI 只获取本地会话凭证。来自继承环境的已知厂商密钥与配置中的密钥引用被移除，工具所需的其他环境变量保留。

Codex 使用会话模型目录、默认子代理模型和 v1 multi-agent 配置；Claude 用 `--agents` 定义 hh-worker 等子代理，系统提示中的 `hh-route` / `hh-effort` 由我们自己的路由器解析。配置不覆盖 CLI 全局文件。

同协议请求保留原生请求结构；跨协议转换文本、图片、工具调用及结果、工具选择、结构化输出和流式事件，也支持上游返回非流式 JSON。Responses namespace/custom 工具映射为函数工具，再还原名称、namespace 与 freeform 输入。并行工具调用合并为正确的 Chat assistant 回合。

仅默认 worker 使用配置的回退链：收到 HTTP 408、429、500、502、503、504 且尚未输出时，按顺序切换。鉴权失败、含糊的网络失败和流中断不会自动重放。回退不重跑整个代码任务。额外 roster 模型不自动继承回退链。

Claude 去掉模型名末尾 `[1m]` 时，hh 仅在已声明模型中恢复唯一匹配；不会允许调用 roster 外的模型。

同协议 Responses 返回的 ID 记录上游来源；回退后续接和 compact 固定到实际生成该 ID 的目标。未知、过期、路由不匹配或跨目标碰撞的 ID 明确拒绝，避免把历史发往错误模型。

转换后的 Responses 续接保存在会话内存中：最多 32 条、总计 32 MiB、单条 8 MiB、20 分钟有效；失效时明确报错，不丢弃历史继续执行。单次请求 16 MiB、输出 32 MiB、并发 16、超时 180 秒；客户端断开会取消上游请求。

跨协议 `/responses/compact` 使用模型生成有界摘要，返回可回放的普通 checkpoint 消息，不伪造加密 reasoning。输入预算 512 KiB、摘要输出预算 64 KiB；摘要未完成则报错并保留原始上下文。Codex 会话显式关闭 `remote_compaction_v2`，使用已验证的 v1 compact 路径，同时关闭请求压缩，兼容 Node 18。

## 兼容边界

- native 需要能调用的模型 API 网关与凭证。external 可继续使用官方 CLI 自己的订阅登录；不会自动把订阅登录变成跨厂商 API 凭证。
- 已验证的是协议与真实 CLI 委派链路。厂商模型仍须支持工具调用和对应参数；不能保证所有模型具有相同编码能力。
- Chat 标准工具结果只支持文本；图片工具结果向 Chat 转换时明确拒绝。Messages 与 Responses 间保留工具结果中的文本、图片及顺序。
- SSE 与 JSON 响应均可转换；Messages 的并行工具块暂存后按顺序输出，避免交错内容块。加密 reasoning 无法跨协议转译，会明确拒绝；公开 reasoning summary 可以转换。
- 服务端专属 hosted tools 不会伪装成本地工具。Codex native 默认关闭托管 web search；CLI 的本地工具和 MCP 工具仍可使用。调用者强行传入不可转换的托管工具会得到明确错误。
- Codex 的 grammar custom 工具（包括 apply_patch）转换成 input 字符串函数工具，保留描述与语法提示，结果还原为原始 custom 输入。语法最终由 CLI 工具解析器验证；不宣称目标 API 提供同等的 grammar 强约束。
- Claude count_tokens 对 Messages 网关真实转发；其他协议明确返回估算值。Responses 网关 compact 原生透传，其他网关使用本项目摘要压缩。
- 默认上下文是 hh 的 128000 token 会话预算，不是厂商能力保证；用 `--context-window` 设置实际预算。回退 alias 取各目标最小预算。Anthropic 输出预算默认 8192，可用 `--max-output-tokens` 修正。
- 可通过网关 `--capabilities` JSON 声明 imageInput、parallelToolCalls、reasoningSummaries、reasoningEfforts。模型目录只展示已声明的共同能力；未知 metadata 不会阻断 CLI 自动携带的 effort，显式声明不支持才会拒绝。不同模型能力不同，应使用适合它们的网关配置。
- 原生子代理不进入 hh status / 独立 herdr tab。CLI 升级后需重新运行契约测试。

## 验证

```bash
npm run check
npm test
# 可选：安装了真实 CLI 后运行；仅请求本地模拟模型，无付费请求
node tests/live-native-contract.js
node tests/live-codex-contract.js
node tests/live-compaction-contract.js
HH_LIVE_CONTRACT=1 node --test tests/integration-edge.test.js
claude plugin test mod/
```

live-native-contract 用真实 Claude Code / Codex 调用本项目路由器，主模型走 Chat Completions，子代理走 Anthropic Messages，再返回主模型。普通 CI 使用假 CLI 与本地模拟服务，覆盖三种协议组合、工具、回退、断流、续接、鉴权、密钥隔离和清理；无 Bun 或第三方 npm 依赖。真实厂商验收使用 opt-in 的 `node tests/live-provider-contract.js --live`，支持 profile/model 选择、native/fallback/external 分例、预算上限与脱敏证据；默认测试不会发付费请求。

## 配置入口与兼容保护

Claude Leader 中用 `/hh-config` 编辑 profile 的 mode、workerModel、models、fallback、prompt、effort，并声明 gateway wire。profile 与策略通过一次原子保存更新，校验失败保留编辑内容。CLI 同样支持 `hh profiles set NAME --orchestration JSON`。MCP 提供策略读取、更新与离线路由计划。

native 的 provider、主模型、模型目录、子代理路由及必要 feature 由 hh 管理，冲突的 CLI 覆盖会在启动前拒绝；关闭 hooks、隔离 settings、sandbox 等安全参数可以保留。Codex exec 参数按子命令重新编排，避免根参数被 exec 忽略。

删除网关会检查主模型和全部保留的委派策略引用；角色切换 profile 时，没有显式提供新的 model 就清除旧模型覆盖。external run 通过状态锁、启动领取记录和取消标记处理并发；已取消的延迟 worker 不再执行，重复启动只执行一次。profile 的 Agent 改变后禁止使用旧 Agent 会话续跑，应新建任务。
