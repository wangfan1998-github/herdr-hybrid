#!/usr/bin/env bash
# 不依赖真实 claude 的冒烟测试：tests/fake-agent 假扮 claude（profile 的 bin 指向它）。
# 覆盖：init（导入 shell alias）/ herdr 唤起（fake-herdr）/ install / viewer / gateways / profiles / env 注入与继承清理 / roles / dispatch / wait / result / read / task /
#       send(resume) / cancel / failed / crashed / 超时退出码 / dry-run argv / aliases / doctor / log / status / MCP / 错误提示
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/nodeonly"; ln -s "$here/tests/fake-herdr" "$T/bin/herdr"; ln -s "$(command -v node)" "$T/nodeonly/node"   # 假 herdr：不碰真机上的 herdr；nodeonly 供「没装 herdr」的 PATH 用
export PATH="$T/bin:$here/bin:$PATH" FAKE_HERDR_LOG="$T/herdr.log"
export HH_CONFIG_DIR="$T/cfg" HH_STATE_DIR="$T/state" HH_ALIAS_FILES="$T/aliases"
unset HERDR_ENV HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID HH_VIEWER
pass(){ echo "PASS $*"; }; fail(){ echo "FAIL $*"; exit 1; }
has(){ [[ "$1" == *"$2"* ]]; }
jget(){ node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v==null?"":typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
FAKE="$here/tests/fake-agent"
FAKECODEX="$here/tests/fake-codex"

# ---- 准备 shell alias 让 init 导入；其余端点 / profile 用命令建 ----
cat > "$T/aliases" <<'EOF'
alias democc="CLAUDE_CODE_NO_FLICKER=1 ANTHROPIC_BASE_URL=https://demo.example.com ANTHROPIC_AUTH_TOKEN=sk-demo1234567890 ANTHROPIC_MODEL=demo-model ENABLE_TOOL_SEARCH=false claude"
alias demo2cc="ANTHROPIC_BASE_URL=https://demo.example.com ANTHROPIC_AUTH_TOKEN=sk-demo1234567890 ANTHROPIC_MODEL=demo-model-2 claude --foo"
alias cc="claude --dangerously-skip-permissions"
alias envcc='env -u ANTHROPIC_API_KEY -u CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_BASE_URL=https://envp.example.com ANTHROPIC_AUTH_TOKEN=sk-envp1234567890 claude'
EOF

out="$(hh init --json)"; has "$out" '"config"' && pass "hh init" || fail "init: $out"
[ -f "$HH_CONFIG_DIR/config.json" ] && pass "config.json 生成" || fail "config.json"
mode(){ node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"; }   # 跨 BSD/GNU 的权限读取
[ "$(mode "$HH_CONFIG_DIR/config.json")" = "600" ] && pass "config.json 600" || fail "perm: $(mode "$HH_CONFIG_DIR/config.json")"
[ -f "$HH_CONFIG_DIR/prompts/coder.md" ] && pass "prompts 复制" || fail "prompts"
git -C "$here" show 3940fc2:prompts/coder.md > "$HH_CONFIG_DIR/prompts/coder.md" 2>/dev/null && rm -f "$HH_CONFIG_DIR/prompts/.shipped.json" && echo "# 我自己的规范" > "$HH_CONFIG_DIR/prompts/reviewer.md"
hh init --force --json >/dev/null   # install.sh 在已有配置时就是这么调的
cmp -s "$HH_CONFIG_DIR/prompts/coder.md" "$here/prompts/coder.md" && pass "没改过的旧版模板随新版本升级" || fail "prompt upgrade"
[ "$(cat "$HH_CONFIG_DIR/prompts/reviewer.md")" = "# 我自己的规范" ] && pass "用户改过的模板不覆盖" || fail "prompt keep"
cp "$here/prompts/reviewer.md" "$HH_CONFIG_DIR/prompts/reviewer.md"
[ "$(jget roles.coder.profile <<<"$out")" = "official" ] && [ "$(jget roles_defaulted <<<"$out")" = "true" ] && pass "init 角色默认全 official" || fail "default roles: $out"
has "$out" '"env"' && pass "init 导入 env -u … 开头的 alias" || fail "env alias: $out"
has "$out" '"demo"' && has "$out" '"demo2"' && pass "init 导入 shell alias（去掉 cc 后缀）" || fail "aliases: $out"
gw="$(hh profiles show demo2 | jget profile.gateway)"; [ "$gw" = "$(hh profiles show demo | jget profile.gateway)" ] && pass "同 url+密钥的 alias 复用网关 ($gw)" || fail "alias gateway reuse"
hh gateways set gwa --url https://a.example.com --auth token --secret sk-aaaa1234567890 --env ENABLE_TOOL_SEARCH=false >/dev/null
hh gateways set gwh --url 'https://h.example.com/#x' --auth apikey --secret 'ab#cd1234567890' --env FOO=gw >/dev/null
hh profiles set pa --gateway gwa --model model-a >/dev/null
hh profiles set ph --gateway gwh --model 'model#1' --env FOO=profile >/dev/null
hh roles set coder --profile pa >/dev/null
[ "$(hh profiles show ph | jget profile.gateway)" = "gwh" ] && pass "命令建好测试用端点 gwa/gwh 与 profile pa/ph" || fail "test fixtures"

# ---- env 注入 ----
out="$(hh env ph --reveal)"; has "$out" 'ANTHROPIC_API_KEY=ab#cd1234567890' && ! has "$out" '{' && pass "apikey 注入（值含 # 原样）；--reveal 非 TTY 默认纯文本，供 env \$(hh env X --reveal) 用" || fail "env ph: $out"
has "$out" 'FOO=profile' && pass "profile env 覆盖 gateway env" || fail "override: $out"
has "$out" 'ANTHROPIC_MODEL=model#1' && has "$out" 'CLAUDE_CODE_SUBAGENT_MODEL=model#1' && pass "模型写入全部 model 变量" || fail "model env: $out"
out="$(hh env ph --reveal --json)"; has "$out" '"ANTHROPIC_API_KEY": "ab#cd1234567890"' && pass "--reveal --json 仍给 JSON" || fail "env json: $out"
out="$(hh env ph)"; has "$out" '"ANTHROPIC_API_KEY": "ab#c***90"' && pass "默认打码" || fail "mask: $out"
out="$(hh env official)"; has "$out" '"ANTHROPIC_BASE_URL"' && ! has "$out" '"ANTHROPIC_BASE_URL":' && pass "official 会清掉继承的网关变量" || fail "official unset: $out"
out="$(hh env pa -m other)"; has "$out" '"ANTHROPIC_MODEL": "other"' && pass "env -m 覆盖模型" || fail "env -m: $out"

# ---- gateways / profiles 增删改与引用保护 ----
out="$(hh gateways set gw2 --url https://g2.example.com --auth apikey --secret sk-two --env ENABLE_TOOL_SEARCH=false --json)"; has "$out" '"gw2"' && pass "gateways set" || fail "gw set: $out"
out="$(hh gateways set gwbad --url notaurl --secret x 2>&1 || true)"; has "$out" 'http(s)' && pass "gateways set 校验 url" || fail "gw url: $out"
out="$(hh profiles set p2 --gateway gw2 --model model-two --env K=V --json)"; has "$out" '"model": "model-two"' && pass "profiles set" || fail "p set: $out"
out="$(hh profiles set px --gateway nope --model m 2>&1 || true)"; has "$out" '网关不存在' && pass "profiles set 未知网关拒绝" || fail "p nope: $out"
out="$(hh gateways rm gw2 2>&1 || true)"; has "$out" '仍被 profile 引用' && pass "gateways rm 被引用拒绝" || fail "gw rm: $out"
out="$(hh profiles rm p2 --json)"; has "$out" '"removed": "p2"' && pass "profiles rm" || fail "p rm: $out"
out="$(hh gateways rm gw2 --json)"; has "$out" '"removed": "gw2"' && pass "gateways rm" || fail "gw rm2: $out"
out="$(hh profiles rm official 2>&1 || true)"; has "$out" '内置' && pass "official 不可删" || fail "rm official: $out"
out="$(hh profiles aliases)"; [ "${out:0:6}" = "alias " ] && has "$out" "alias pacc='" && has "$out" "claude pa'" && pass "profiles aliases 非 TTY 也是纯文本（eval 可直接用）" || fail "aliases: $out"
out="$(bash -c 'shopt -s expand_aliases; eval "$(hh profiles aliases)"; alias pacc' 2>&1)"; has "$out" "claude pa" && pass 'eval "$(hh profiles aliases)" 真能定义 alias' || fail "eval aliases: $out"
out="$(hh roles --plain)"; has "$out" 'coder' && has "$out" 'pa' && pass "hh roles 表格" || fail "roles table: $out"
out="$(hh leader ph --json)"; has "$out" '"leader": "ph"' && pass "hh leader 设置" || fail "leader: $out"

# ---- 假 claude：profile 的 bin 指向 fake-agent ----
hh profiles set fake --gateway gwh --model fake-model --bin "$FAKE" --env FOO=fake >/dev/null
hh roles set coder --profile fake >/dev/null
hh profiles set official --bin "$FAKE" >/dev/null
out="$(hh dispatch -r coder -l t1 -d "$T" -t "say pong please" --view none)"; id="$(jget run.id <<<"$out")"; [ -n "$id" ] && pass "dispatch → $id" || fail "dispatch: $out"
grep -q '角色规范' "$HH_STATE_DIR/runs/$id/task.md" && grep -q '完成要求' "$HH_STATE_DIR/runs/$id/task.md" && pass "task.md 含角色模板与完成要求" || fail "task.md"
out="$(hh wait "$id" --timeout 30)"; [ "$(jget settled <<<"$out")" = "true" ] && pass "wait settled" || fail "wait: $out"
out="$(hh result "$id")"; [ "$(jget run.status <<<"$out")" = "done" ] && [ "$(jget run.final <<<"$out")" = "pong" ] && pass "result done, final=pong" || fail "result: $out"
sid="$(jget run.session_id <<<"$out")"; [ -n "$sid" ] && pass "session_id=$sid" || fail "session_id"
[ "$(jget run.gateway <<<"$out")" = "gwh" ] && [ "$(jget run.model <<<"$out")" = "fake-model" ] && pass "run 记录 gateway/model" || fail "run meta: $out"
out="$(hh read "$id" --plain)"; has "$out" '⏺ pong' && has "$out" '⚙ Read' && has "$out" 'mode=bypassPermissions' && pass "read transcript（含 autonomy 参数）" || fail "read: $out"
out="$(hh task "$id" --plain)"; has "$out" 'say pong please' && pass "task 回溯" || fail "task: $out"

# ---- env 真正到达子进程 + official 清理继承 ----
out="$(hh dispatch -r coder -l envck -d "$T" -t "envcheck" --view none)"; id_e="$(jget run.id <<<"$out")"; hh wait "$id_e" --timeout 30 >/dev/null
fin="$(hh result "$id_e" | jget run.final)"; [ "$fin" = "env=https://h.example.com/#x/fake-model/-/fake" ] && pass "子进程收到 BASE_URL/MODEL/profile env（apikey 网关不设 AUTH_TOKEN）" || fail "envcheck: $fin"
out="$(ANTHROPIC_BASE_URL=https://leader.example.com ANTHROPIC_AUTH_TOKEN=leader-token ANTHROPIC_MODEL=leader-model hh dispatch -p official -l offck -d "$T" -t "envcheck" --view none)"; id_o="$(jget run.id <<<"$out")"; hh wait "$id_o" --timeout 30 >/dev/null
fin="$(hh result "$id_o" | jget run.final)"; [ "$fin" = "env=-/-/-/-" ] && pass "official worker 不继承 Leader 的网关变量" || fail "official inherit: $fin"
out="$(hh dispatch -r coder -p pa -l override -d "$T" -t "envcheck" --view none 2>&1 || true)"; has "$out" '找不到可执行文件' || has "$out" '"id"' && pass "-r 与 -p 同时给：-p 优先（pa 无 fake bin）" || fail "override: $out"

# ---- codex 适配器：假 codex（tests/fake-codex）----
hh profiles set cx --agent codex --gateway gwh --model codex-model --bin "$FAKECODEX" --env FOO=cx >/dev/null
out="$(hh profiles show cx --json)"; [ "$(jget profile.agent <<<"$out")" = "codex" ] && pass "profile 带 agent=codex" || fail "cx agent: $out"
out="$(hh profiles set cxbad --agent nope --gateway gwh 2>&1 || true)"; has "$out" '未知 agent' && pass "未知 agent 拒绝" || fail "cx bad agent: $out"
# 原型链上的键（toString / constructor）不能被当成 agent：真值判断放过去 → 之后才在 resolveGateway 上炸 TypeError
out="$(hh profiles set cxproto --agent toString --gateway gwh 2>&1 || true)"; has "$out" '未知 agent' && pass "原型链键不被当成 agent" || fail "cx proto: $out"
# official + codex：语义是「用 codex 自己的登录」，不能把用户 export 的 OPENAI_API_KEY 清掉
hh profiles set cxoff --agent codex --bin "$FAKECODEX" >/dev/null
out="$(hh env cxoff --json)"; ! has "$out" '"OPENAI_API_KEY"' && has "$out" '"HH_CODEX_KEY"' && pass "codex official 保留用户的 OPENAI_API_KEY，只清 hh 注入的 HH_CODEX_KEY" || fail "cx official unset: $out"
# ---- 登录体检：按 gateway===null 判定，不按 profile 名叫不叫 official ----
# fake-agent 收到 `auth status` 输出 loggedIn JSON；fake-codex 收到 `login status` 用退出码表示（FAKE_LOGGED_OUT=1 模拟未登录）
out="$(hh doctor --plain 2>&1 || true)"
has "$out" '✓ claude.auth' && pass "doctor 体检用到的 claude 订阅 profile 的登录" || fail "doctor claude.auth: $out"
out="$(FAKE_AUTH_VIA_ENV=1 ANTHROPIC_AUTH_TOKEN=agk-leader hh doctor --plain 2>&1 || true)"; has "$out" '✗ claude.auth' && pass "doctor 按 worker 的 env 体检（会话里的网关密钥不算 official 已登录）" || fail "doctor env-aware auth: $out"
out="$(FAKE_LOGGED_OUT=1 hh doctor --plain 2>&1 || true)"; has "$out" '✗ claude.auth' && has "$out" 'claude /login' && pass "claude 未登录 → ✗ 并提示 /login" || fail "doctor logged out: $out"
FAKE_LOGGED_OUT=1 hh doctor >/dev/null 2>&1 && fail "未登录应退出非 0" || pass "未登录 doctor 退出码非 0"
# 改个名的订阅 profile（不叫 official）也要被检到——旧实现按名字匹配会漏
hh profiles set mysub --bin "$FAKE" >/dev/null
hh roles set subrole --profile mysub >/dev/null
out="$(hh doctor --plain 2>&1 || true)"; has "$out" 'mysub' && pass "改名的订阅 profile 也纳入登录体检（不按名字匹配）" || fail "doctor renamed sub: $out"
hh roles rm subrole >/dev/null; hh profiles rm mysub >/dev/null
# 配了网关的 profile 不该触发登录体检（它用网关密钥，不是订阅）
hh roles set subrole --profile ph >/dev/null
out="$(hh doctor --plain 2>&1 || true)"; ! has "$out" 'profile: official, ph' && pass "配了网关的 profile 不做登录体检" || fail "doctor gw profile auth: $out"
hh roles rm subrole >/dev/null
# codex 订阅 profile 的登录体检走 codex login status
hh profiles set cxsub --agent codex --bin "$FAKECODEX" >/dev/null
hh roles set cxrole --profile cxsub >/dev/null
out="$(hh doctor --plain 2>&1 || true)"; has "$out" '✓ codex.auth' && has "$out" 'Logged in using ChatGPT' && pass "codex 订阅 profile 走 codex login status 体检" || fail "doctor codex.auth: $out"
out="$(FAKE_LOGGED_OUT=1 hh doctor --plain 2>&1 || true)"; has "$out" '✗ codex.auth' && has "$out" 'codex login' && pass "codex 未登录 → ✗ 并提示 codex login" || fail "doctor codex logged out: $out"
hh roles rm cxrole >/dev/null; hh profiles rm cxsub >/dev/null

# ---- 手改 config.json 写出不存在的 agent ----
node -e '
const f=process.env.HH_CONFIG_DIR+"/config.json";const c=require(f);
c.profiles.handedited={agent:"gemini-cli"};
require("fs").writeFileSync(f,JSON.stringify(c));'
out="$(hh doctor --plain 2>&1 || true)"; has "$out" 'agent 不存在: gemini-cli' && pass "doctor 抓出手改出来的未知 agent" || fail "doctor unknown agent: $out"
hh doctor >/dev/null 2>&1 && fail "doctor 未知 agent 应退出非 0" || pass "doctor 未知 agent 退出码非 0"
node -e '
const f=process.env.HH_CONFIG_DIR+"/config.json";const c=require(f);
delete c.profiles.handedited;
require("fs").writeFileSync(f,JSON.stringify(c));'
hh profiles rm cxoff >/dev/null
# 网关走 -c model_providers.…（不是 ANTHROPIC_*），密钥只以「变量名」上命令行、值留在 env
out="$(hh dispatch -p cx -l cxdry -d "$T" -t x --dry-run --json)"
has "$out" 'model_providers.hh.base_url=https://h.example.com/#x' && pass "codex 网关走 -c model_providers（非 ANTHROPIC_*）" || fail "cx gw: $out"
has "$out" 'model_providers.hh.env_key=HH_CODEX_KEY' && ! has "$out" 'ab#cd1234567890' && pass "codex 密钥只上变量名，值不进 argv" || fail "cx secret: $out"
has "$out" '"--skip-git-repo-check"' && pass "codex 带 --skip-git-repo-check（probe 目录不是 git 仓库）" || fail "cx gitcheck: $out"
has "$out" '"--dangerously-bypass-approvals-and-sandbox"' && pass "autonomy full → codex bypass 参数" || fail "cx autonomy: $out"
out="$(hh dispatch -p cx -a readonly -l cxro -d "$T" -t x --dry-run --json)"; has "$out" '"read-only"' && pass "autonomy readonly → -s read-only" || fail "cx ro: $out"
# 真跑一轮：事件流解析、transcript、report、session_id 全链路
out="$(hh dispatch -p cx -l cx1 -d "$T" -t "say pong please" --view none)"; idc="$(jget run.id <<<"$out")"; hh wait "$idc" --timeout 30 >/dev/null
out="$(hh result "$idc")"; [ "$(jget run.status <<<"$out")" = "done" ] && [ "$(jget run.final <<<"$out")" = "pong" ] && pass "codex run done, final=pong" || fail "cx result: $out"
[ "$(jget run.agent <<<"$out")" = "codex" ] && pass "run 记录 agent=codex" || fail "cx run agent: $out"
has "$(jget run.session_id <<<"$out")" '0199fake' && pass "codex session_id 取自 thread.started.thread_id" || fail "cx sid: $out"
out="$(hh read "$idc" --plain)"; has "$out" '⏺ pong' && has "$out" "⚙ bash 'ls'" && pass "codex transcript（agent_message / command_execution）" || fail "cx read: $out"
has "$out" '⚠ skipping async hook' && pass "codex 的非致命 item.error 降级成提示（不是 ✗ 失败）" || fail "cx noise shown: $out"
# 网关/模型/密钥真的到达子进程
out="$(hh dispatch -p cx -l cxenv -d "$T" -t "envcheck" --view none)"; idce="$(jget run.id <<<"$out")"; hh wait "$idce" --timeout 30 >/dev/null
fin="$(hh result "$idce" | jget run.final)"; [ "$fin" = "env=https://h.example.com/#x/codex-model/ab#cd1234567890/cx" ] && pass "codex 子进程收到网关/模型/密钥/profile env" || fail "cx envcheck: $fin"
# 续跑：codex 是 `exec resume <ID>` 子命令，不是 --resume flag
out="$(hh send "$idc" -t "继续" --view none)"; idc2="$(jget run.id <<<"$out")"; hh wait "$idc2" --timeout 30 >/dev/null
has "$(hh result "$idc2" | jget run.final)" 'resumed 0199fake' && pass "codex 续跑用 exec resume <ID> 位置参数" || fail "cx resume: $(hh result "$idc2" | jget run.final)"
# resume 的参数集比 exec 窄：不认 -s（真 codex 会 Usage 报错退出 2），末尾也不能带 `-`（会被当成 PROMPT 位置参数）
cmd="$(node -e "console.log(require('$HH_STATE_DIR/runs/$idc2/meta.json').command.join(' '))")"
! has "$cmd" ' -s ' && [ "${cmd: -2}" != " -" ] && pass "codex 续跑不带 -s、末尾不带 -（真 codex 会拒绝）" || fail "cx resume argv: $cmd"
has "$cmd" 'bypass-approvals' && pass "codex 续跑 autonomy=full → bypass 参数（resume 也认）" || fail "cx resume full: $cmd"
# readonly / workspace 续跑不能用 -s，改用 -c sandbox_mode=
out="$(hh send "$idc" -t "再继续" -a readonly --view none)"; idc3="$(jget run.id <<<"$out")"; hh wait "$idc3" --timeout 30 >/dev/null
cmd3="$(node -e "console.log(require('$HH_STATE_DIR/runs/$idc3/meta.json').command.join(' '))")"
has "$cmd3" 'sandbox_mode=read-only' && ! has "$cmd3" ' -s ' && pass "codex 续跑 readonly → -c sandbox_mode=read-only（resume 不认 -s）" || fail "cx resume ro: $cmd3"
# turn.failed → 失败
out="$(FAKE_FAIL=1 hh dispatch -p cx -l cxfail -d "$T" -t x --view none)"; idcf="$(jget run.id <<<"$out")"; hh wait "$idcf" --timeout 30 >/dev/null
out="$(hh result "$idcf")"; [ "$(jget run.status <<<"$out")" = "failed" ] && has "$(jget run.error <<<"$out")" 'stream disconnected' && pass "turn.failed → failed，错误取 turn.failed.error" || fail "cx fail: $out"
# Codex Leader uses per-session developer_instructions
out="$(hh leader cx)"; has "$out" '"cx"' && pass "Codex 可当 Leader" || fail "cx leader: $out"
hh leader ph >/dev/null
out="$(hh run cx --dry-run)"; has "$out" 'developer_instructions=' && pass "Codex Leader 协议注入" || fail "cx leader launch: $out"
out="$(hh codex cx --dry-run --plain)"; has "$out" 'codex' && ! has "$out" 'append-system-prompt' && pass "hh codex <profile> 交互式启动（不注入 Leader 协议）" || fail "hh codex: $out"
out="$(hh codex ph 2>&1 || true)"; has "$out" '不是 codex' && pass "hh codex 拒绝非 codex profile" || fail "hh codex wrong: $out"
# claude profile 不受影响：仍走 ANTHROPIC_*
out="$(hh env fake --reveal)"; has "$out" 'ANTHROPIC_BASE_URL=' && pass "claude profile 不受 codex 改动影响" || fail "claude regress: $out"
# 跨 agent 清理：codex worker 不该继承 Leader 进程里的 ANTHROPIC_*
out="$(hh env cx --json)"; has "$out" '"ANTHROPIC_BASE_URL"' && pass "codex profile 会清掉继承的 ANTHROPIC_*（跨 agent 隔离）" || fail "cx unset: $out"
hh profiles rm cx >/dev/null


grep -q '"status":"done|partial|blocked"' "$HH_STATE_DIR/runs/$id/task.md" && pass "task.md 页脚含 report schema" || fail "footer schema"
out="$(hh dispatch -r coder -l rep -d "$T" -t "please report" --view none)"; id_r="$(jget run.id <<<"$out")"; hh wait "$id_r" --timeout 30 >/dev/null
out="$(hh result "$id_r")"; [ "$(jget run.report.status <<<"$out")" = "done" ] && has "$(jget run.report.changed <<<"$out")" 'a.txt' && pass "result.report 解析" || fail "report: $out"
[ "$(hh result "$id" | jget run.report)" = "" ] && pass "没有 json 块时 report 为空" || fail "report null"
out="$(hh roles --plain)"; has "$out" 'DESC' && has "$out" '实现明确边界' && pass "角色带用途描述（导入时补默认）" || fail "desc: $out"
out="$(hh roles set tester --profile fake --desc '跑测试并报告' --json)"; has "$out" '"desc": "跑测试并报告"' && pass "roles set --desc" || fail "roles desc: $out"
out="$(hh claude --dry-run)"; has "$out" 'tester' && has "$out" '跑测试并报告' && has "$out" 'fake-model' && has "$out" 'result.report' && pass "Leader prompt 注入实时角色表 / profile / 汇报契约" || fail "roster: $out"
hh roles rm tester >/dev/null

# ---- send = 恢复同一会话 ----
out="$(hh send "$id" -t "one more thing" --view none)"; id2="$(jget run.id <<<"$out")"; [ "$(jget run.parent <<<"$out")" = "$id" ] && pass "send → $id2 (parent ok)" || fail "send: $out"
hh wait "$id2" --timeout 30 >/dev/null
out="$(hh result "$id2")"; has "$(jget run.final <<<"$out")" "resumed $sid" && pass "send 恢复了同一 session" || fail "send resume: $out"

# ---- cancel / failed / crashed / 超时 ----
out="$(FAKE_SLEEP=60 hh dispatch -r coder -l slow -d "$T" -t "sleep" --view none)"; id3="$(jget run.id <<<"$out")"
sleep 1; out="$(hh status)"; has "$out" "\"$id3\"" && has "$out" '"running"' && pass "status 显示 running" || fail "status running: $out"
out="$(hh cancel "$id3")"; [ "$(jget run.status <<<"$out")" = "cancelled" ] && pass "cancel" || fail "cancel: $out"
out="$(FAKE_FAIL=1 hh dispatch -r coder -l boom -d "$T" -t "fail" --view none)"; id4="$(jget run.id <<<"$out")"; hh wait "$id4" --timeout 30 >/dev/null
out="$(hh result "$id4")"; [ "$(jget run.status <<<"$out")" = "failed" ] && has "$(jget run.error <<<"$out")" 'error_during_execution' && pass "failed + error 记录" || fail "fail: $out"
mkdir -p "$HH_STATE_DIR/runs/20200101-000000-ghost-0000"
printf '{"id":"20200101-000000-ghost-0000","label":"ghost","profile":"fake","cwd":"%s","created":"2020-01-01T00:00:00.000Z","status":"running","worker_pid":999999}\n' "$T" > "$HH_STATE_DIR/runs/20200101-000000-ghost-0000/meta.json"
out="$(hh wait ghost --timeout 5)"; [ "$(jget settled <<<"$out")" = "true" ] && has "$out" '"crashed"' && pass "死 worker → crashed（不空转）" || fail "crashed: $out"
out="$(FAKE_SLEEP=20 hh dispatch -r coder -l slow2 -d "$T" -t "sleep" --view none)"; id5="$(jget run.id <<<"$out")"
set +e; hh wait "$id5" --timeout 2 >/dev/null; rc=$?; set -e; [ $rc -eq 2 ] && pass "wait 超时退出码 2" || fail "wait rc=$rc"
hh cancel "$id5" >/dev/null

# ---- attention：wait 直接告诉 Leader 哪些 run 要处理 ----
out="$(hh dispatch -r coder -l ask -d "$T" -t "askq" --view none)"; id_q="$(jget run.id <<<"$out")"
out="$(hh dispatch -r coder -l vf -d "$T" -t "verifyfail" --view none)"; id_v="$(jget run.id <<<"$out")"
out="$(hh wait "$id_q" "$id_v" "$id_r" "$id" --timeout 30)"
att="$(jget attention <<<"$out")"
has "$att" "\"$id_q\"" && has "$att" 'blocked' && has "$att" 'blocking_question' && pass "attention：blocked + 阻塞问题" || fail "attention q: $att"
has "$att" "\"$id_v\"" && has "$att" 'verify_failed' && has "$att" '"question"' && pass "attention：验收失败 + 非阻塞问题" || fail "attention v: $att"
has "$att" "\"$id\"" && has "$att" 'no_report' && pass "attention：没交报告" || fail "attention no_report: $att"
! has "$att" "\"$id_r\"" && pass "attention：报告干净的 run 不在列表里" || fail "attention clean: $att"
out="$(hh wait "$id_q" --timeout 5 --plain)"; has "$out" "ATTENTION $id_q" && pass "wait 人类输出带 ATTENTION 行" || fail "wait plain: $out"
has "$(hh status)" '"attention"' && pass "status 每个 run 带 attention" || fail "status attention"

# ---- 决定留痕 + 返修链编号 ----
out="$(hh send "$id_q" -t "用 sqlite" --decision "sqlite or postgres → sqlite：单机工具，README 写了零依赖" --view none)"; id_q1="$(jget run.id <<<"$out")"
has "$(jget run.label <<<"$out")" 'ask-r1' && has "$(jget decision.text <<<"$out")" '→ sqlite' && pass "send --decision 记录决定" || fail "send decision: $out"
hh wait "$id_q1" --timeout 30 >/dev/null
out="$(hh send "$id_q1" -t "再改一下" --view none)"; id_q2="$(jget run.id <<<"$out")"; [ "$(jget run.label <<<"$out")" = "ask-r2" ] && pass "多轮返修编号沿链递增（ask-r2，不撞 r1）" || fail "round label: $out"
hh wait "$id_q2" --timeout 30 >/dev/null
hh decide "要不要换存储层 → 上报" --run "$id_q" --escalated >/dev/null
out="$(hh decisions)"; has "$out" '→ sqlite' && has "$out" '"escalated": true' && pass "hh decisions 列出决定与上报" || fail "decisions: $out"
out="$(hh decide "" 2>&1 || true)"; has "$out" '需要决定内容' && pass "decide 空内容拒绝" || fail "decide empty: $out"

# ---- worker 时限：总时长 / 卡住 ----
out="$(FAKE_SLEEP=30 hh dispatch -r coder -l to -d "$T" -t "sleep" --timeout 0.03 --view none)"; id_t="$(jget run.id <<<"$out")"
out="$(hh wait "$id_t" --timeout 20)"; [ "$(jget settled <<<"$out")" = "true" ] && out="$(hh result "$id_t")" && [ "$(jget run.status <<<"$out")" = "failed" ] && has "$(jget run.error <<<"$out")" 'timeout:' && pass "超过 --timeout → failed（timeout:）" || fail "timeout: $out"
node -e 'const f=process.argv[1];const c=JSON.parse(require("fs").readFileSync(f));c.limits={timeoutMin:0,stallMin:0.03};require("fs").writeFileSync(f,JSON.stringify(c))' "$HH_CONFIG_DIR/config.json"
out="$(FAKE_SLEEP=30 hh dispatch -r coder -l st -d "$T" -t "sleep" --view none)"; id_s="$(jget run.id <<<"$out")"
out="$(hh wait "$id_s" --timeout 20)"; out="$(hh result "$id_s")"; has "$(jget run.error <<<"$out")" 'stalled:' && pass "长时间无输出 → failed（stalled:）" || fail "stall: $out"
node -e 'const f=process.argv[1];const c=JSON.parse(require("fs").readFileSync(f));delete c.limits;require("fs").writeFileSync(f,JSON.stringify(c))' "$HH_CONFIG_DIR/config.json"
out="$(hh dispatch -r coder -l bt -d "$T" -t x --timeout -1 2>&1 || true)"; has "$out" '≥0' && pass "--timeout 校验" || fail "bad timeout: $out"
has "$(hh status --all)" '"timeout"' && pass "attention 带 timeout 原因" || fail "attention timeout reason"
out="$(FAKE_GRANDCHILD=40 FAKE_SLEEP=30 hh dispatch -r coder -l gc -d "$T" -t "sleep" --timeout 0.03 --view none)"; id_g="$(jget run.id <<<"$out")"
t0=$SECONDS; hh wait "$id_g" --timeout 25 >/dev/null || true
[ $((SECONDS - t0)) -lt 20 ] && [ "$(hh result "$id_g" | jget run.status)" = "failed" ] && pass "超时连孙进程一起结束（不被攥着的管道卡住）" || fail "grandchild: $((SECONDS - t0))s $(hh result "$id_g")"
out="$(hh send "$id_t" -t "继续" --view none)"; [ "$(jget run.id <<<"$out" | xargs -I{} cat "$HH_STATE_DIR/runs/{}/meta.json" | jget limits.timeoutMin)" = "0.03" ] && pass "返修沿用原任务的时限" || fail "followup timeout: $out"
hh cancel "$(jget run.id <<<"$out")" >/dev/null 2>&1 || true
out="$(hh decide "密钥是 sk-aaaa1234567890 别外传，另一个 sk-zzzzzzzzzzzzzzzzzz")"; ! has "$out" 'sk-aaaa1234567890' && ! has "$out" 'zzzzzzzzzzzzzzzzzz' && ! grep -q 'sk-aaaa1234567890' "$HH_STATE_DIR/decisions.jsonl" && pass "决定记录给密钥打码" || fail "decision mask: $out"
[ "$(mode "$HH_STATE_DIR/decisions.jsonl")" = "600" ] && pass "decisions.jsonl 600" || fail "decisions perm"

# ---- pid 被复用：活着但不是我们的 worker → crashed ----
sleep 60 & alien=$!
mkdir -p "$HH_STATE_DIR/runs/20200101-000001-reuse-0000"
printf '{"id":"20200101-000001-reuse-0000","label":"reuse","profile":"fake","cwd":"%s","created":"2020-01-01T00:00:00.000Z","status":"running","worker_pid":%s}\n' "$T" "$alien" > "$HH_STATE_DIR/runs/20200101-000001-reuse-0000/meta.json"
out="$(hh wait reuse --timeout 5)"; kill "$alien" 2>/dev/null || true
[ "$(jget settled <<<"$out")" = "true" ] && has "$out" '"crashed"' && pass "pid 被别的进程复用 → crashed（不永远 running）" || fail "pid reuse: $out"

# ---- dry-run argv ----
out="$(hh dispatch --dry-run -p pa -d "$T" -t x)"; has "$out" '"-p"' && has "$out" 'bypassPermissions' && has "$out" '"model-a"' && has "$out" '"ANTHROPIC_AUTH_TOKEN": "sk-a***90"' && pass "dry-run argv + env 打码" || fail "dry: $out"
out="$(hh dispatch --dry-run -r coder -p pa -d "$T" -t x)"; [ "$(jget model <<<"$out")" = "model-a" ] && pass "-r 与 -p 同时给：模型跟 -p 的 profile 走（不带角色原 profile 的 fake-model）" || fail "dry -r -p model: $out"
out="$(hh dispatch --dry-run -r coder -p pa -m m9 -d "$T" -t x)"; [ "$(jget model <<<"$out")" = "m9" ] && pass "-r -p -m：-m 最高优先" || fail "dry -m: $out"
out="$(hh dispatch --dry-run -p pa -a readonly -d "$T" -t x)"; has "$out" '"default"' && has "$out" 'git diff' && ! has "$out" 'Bash(rg' && pass "readonly 映射（不放行能执行程序的 rg）" || fail "dry ro: $out"
out="$(hh dispatch --dry-run -p pa -a workspace -d "$T" -t x)"; has "$out" 'acceptEdits' && pass "workspace 映射" || fail "dry ws: $out"

# ---- 引用保护 / 删除 ----
out="$(hh profiles rm fake 2>&1 || true)"; has "$out" '仍被角色引用' && pass "profiles rm 被引用拒绝" || fail "rm referenced: $out"
out="$(hh roles rm reviewer --json)"; has "$out" '"removed": "reviewer"' && pass "roles rm" || fail "roles rm: $out"
out="$(hh profiles import-aliases --dry-run "$T/aliases")"; has "$out" '"dry_run": true' && pass "import-aliases --dry-run" || fail "import dry: $out"

# ---- doctor / log / status --all ----
out="$(hh doctor --json || true)"; has "$out" '"checks"' && has "$out" '"gateway.gwh"' && pass "doctor --json" || fail "doctor: $out"
out="$(hh log -n 200)"; has "$out" '"dispatch"' && has "$out" '"cancel"' && pass "log 事件流" || fail "log: $out"
out="$(hh status --all)"; has "$out" "\"$id\"" && has "$out" "\"$id4\"" && pass "status --all" || fail "status all: $out"

# ---- MCP ----
req='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"hh_profiles","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"hh_result","arguments":{"id":"'"$id"'"}}}
{"jsonrpc":"2.0","id":5,"method":"nope"}'
out="$(printf '%s\n' "$req" | hh mcp)"
has "$out" '"serverInfo"' && pass "mcp initialize" || fail "mcp init: $out"
has "$out" '"hh_dispatch"' && has "$out" '"hh_send"' && pass "mcp tools/list" || fail "mcp list: $out"
has "$out" 'gwh' && ! has "$out" 'ab#cd1234567890' && pass "mcp hh_profiles（密钥不外泄）" || fail "mcp profiles: $out"
has "$out" 'pong' && pass "mcp hh_result" || fail "mcp result: $out"
has "$out" '"code":-32601' && pass "mcp 未知方法报错" || fail "mcp err: $out"

# ---- setup：交互式加端点（管道喂答案；提示走 stderr，stdout 是 JSON）----
out="$(printf 'https://s.example.com\n\napikey\nsk-setup1234567890\nmodel-s\n\n1\nn\nn\n' | hh setup 2>/dev/null)"
has "$out" '"gateway": "s-example-com"' && has "$out" '"use": "leader"' && pass "setup 加端点 + profile（名字默认取 host）并设为 Leader" || fail "setup: $out"
[ "$(hh leader | jget leader)" = "s-example-com" ] && [ "$(hh profiles show s-example-com | jget profile.model)" = "model-s" ] && pass "setup 写入生效（leader / model）" || fail "setup effect"
[ "$(hh gateways | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const g=JSON.parse(d).gateways.find(x=>x.name==="s-example-com");console.log(g.auth+"/"+g.secret)})')" = "apikey/sk-s***90" ] && pass "setup 网关 auth=apikey、密钥打码" || fail "setup gw"
out="$(printf 'https://w.example.com\n\n\nsk-w1234567890\n\nwork\n2\nn\nn\n' | hh setup 2>/dev/null)"; has "$out" '"use": "worker"' && has "$out" '"roles": [' && pass "setup 选 2 → coder/executor" || fail "setup worker: $out"
[ "$(hh roles | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{console.log(JSON.parse(d).roles.find(r=>r.role==="coder").profile)})')" = "work" ] && pass "setup coder → work（auth 默认 token）" || fail "setup coder"
gw_before="$(hh gateways | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).gateways.length))')"
out="$(printf 'https://s.example.com\n\nmodel-s2\n\n3\nn\nn\n' | hh setup 2>/dev/null)"; has "$out" '"gateway": "s-example-com"' && has "$out" '"profile": "model-s2"' && pass "setup 同地址 → 默认复用端点，只加模型，profile 名默认取模型尾" || fail "setup reuse: $out"
[ "$(hh gateways | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).gateways.length))')" = "$gw_before" ] && pass "复用后端点数不变" || fail "reuse gw count"
hh profiles rm model-s2 >/dev/null
out="$(printf 'notaurl\n' | hh setup 2>&1 || true)"; has "$out" 'http(s)://' && has "$out" '"eof"' && pass "setup 坏地址立即报错并重问，EOF 中止" || fail "setup bad url: $out"
out="$(printf 'https://x.example.com\n\nbasic\napikey\nsk-x1234567890\n\nxp\n3\nn\nn\n' | hh setup 2>&1)"; has "$out" '只能是 token 或 apikey' && has "$out" '"gateway": "x-example-com"' && pass "setup 鉴权方式写错只重问这一项" || fail "setup auth: $out"
hh profiles rm xp >/dev/null; hh gateways rm x-example-com >/dev/null
node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.claude.bin=process.argv[2];fs.writeFileSync(f,JSON.stringify(c,null,2))' "$HH_CONFIG_DIR/config.json" "$FAKE"
out="$(printf 'https://t.example.com\n\n\nsk-t1234567890\n\n\n3\ny\nn\n' | hh setup 2>/dev/null)"; [ "$(jget added.0.test.ok <<<"$out")" = "true" ] && pass "setup 顺手 pong 测连通（走 claude.bin）" || fail "setup test: $out"
node -e 'const f=process.argv[1],fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.claude.bin="claude";fs.writeFileSync(f,JSON.stringify(c,null,2))' "$HH_CONFIG_DIR/config.json"
hh leader ph >/dev/null; hh roles set coder --profile fake >/dev/null; hh roles set executor --profile fake >/dev/null
for p in work t-example-com; do hh profiles rm $p >/dev/null; done; for g in w-example-com t-example-com; do hh gateways rm $g >/dev/null; done

# ---- 零端点用户：init 指引 / Leader 模式提醒 ----
out="$(HH_CONFIG_DIR=$T/cfg0 HH_ALIAS_FILES=$T/noalias hh init --plain)"; has "$out" 'hh setup' && has "$out" '还没有任何端点' && pass "init 无端点 → 指引 hh setup（非 TTY 不自动进入）" || fail "init hint: $out"
out="$(HH_CONFIG_DIR=$T/cfg0 hh claude --version 2>&1 || true)"; has "$out" '只有 official' && pass "Leader 模式只有 official 时提醒" || fail "leader warn: $out"

# ---- 错误摘要：过滤 stderr 常驻噪音，API Error 放最前 ----
out="$(FAKE_NOISE=1 hh dispatch -r coder -l noise -d "$T" -t "noise" --view none)"; idn="$(jget run.id <<<"$out")"; hh wait "$idn" --timeout 30 >/dev/null
err="$(hh result "$idn" | jget run.error)"; has "$err" 'API Error: 401' && ! has "$err" 'unrecognized_model' && pass "error 摘要 = API Error，不含 unrecognized_model 噪音" || fail "noise: $err"

# ---- 错误提示 ----
out="$(hh dispatch --bogus 2>&1 || true)"; has "$out" '未知参数' && pass "未知参数报错" || fail "bogus: $out"
out="$(HH_CONFIG_DIR=$T/none hh roles 2>&1 || true)"; has "$out" 'hh init' && pass "无配置提示 hh init" || fail "no config: $out"
out="$(hh claude --help 2>&1)"; has "$out" '用法' && pass "hh claude --help 给用法" || fail "claude usage: $out"
hh profiles set ph --bin "$FAKE" >/dev/null   # CI 没有真 claude：启动前会检查可执行文件
out="$(hh claude --version </dev/null 2>&1 || true)"; has "$out" 'Leader 模式' && has "$out" 'profile ph' && ! has "$out" '"launch": "herdr"' && ! grep -q 'tab create' "$FAKE_HERDR_LOG" && pass "hh claude 不带 profile = leader 模式，默认留在当前终端" || fail "claude leader: $out"
out="$(hh claude herdr --version 2>&1 || true)"; has "$out" '"launch": "herdr"' && pass "hh claude herdr → 开进 herdr" || fail "claude herdr: $out"
hh profiles set nobin --gateway gwa --model m --bin /nonexistent/claude >/dev/null
out="$(hh claude nobin --no-herdr 2>&1 || true)"; has "$out" '找不到 /nonexistent/claude' && has "$out" 'hh install claude' && pass "claude 可执行文件不存在 → 启动前报错并指向 hh install claude" || fail "no claude bin: $out"
hh profiles rm nobin >/dev/null
grep -q 'tab create --workspace w1' "$FAKE_HERDR_LOG" && grep -q 'claude --in-herdr-tab --leader ph --version' "$FAKE_HERDR_LOG" && ! grep -q -- '--no-herdr' "$FAKE_HERDR_LOG" && ! grep -q -- '--no-focus.*hh:leader\|hh:leader.*--no-focus' "$FAKE_HERDR_LOG" && pass "herdr：建聚焦 tab，pane 里跑 hh claude --in-herdr-tab --leader ph（不是 --no-herdr，worker 仍开窗口）" || fail "herdr log: $(cat "$FAKE_HERDR_LOG")"
out="$(hh claude --dry-run --in-herdr-tab)"; has "$out" '"launch": "pane"' && ! has "$out" 'HH_VIEWER' && pass "--in-herdr-tab → 原地启动且不设 HH_VIEWER" || fail "in-tab: $out"
out="$(hh claude herdr --version 2>/dev/null)"; node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' <<<"$out" && pass "非 TTY 下 hh claude herdr 的 stdout 是纯 JSON（提示行走 stderr）" || fail "json stdout: $out"
HH_VIEWER=none hh leader ph >/dev/null; [ "$(hh viewer | jget viewer)" = "auto" ] && pass "HH_VIEWER 只在本进程生效，不写回 config.json" || fail "viewer persisted: $(hh viewer)"
out="$(FAKE_HERDR_DOWN=1 HH_HERDR_START_TIMEOUT_MS=800 hh claude herdr --version </dev/null 2>&1)"; has "$out" '"launch": "terminal"' && has "$out" '就绪' && pass "herdr server 起不来 → 回退终端，不崩" || fail "server down: $out"
: > "$FAKE_HERDR_LOG"
out="$(hh claude --dry-run)"; has "$out" '"launch": "terminal"' && pass "dry-run: 默认 launch=terminal" || fail "dry default: $out"
out="$(hh claude herdr --dry-run)"; has "$out" '"launch": "herdr"' && has "$out" '"--leader"' && pass "dry-run: hh claude herdr → launch=herdr（Leader 模式）" || fail "dry herdr: $out"
out="$(hh claude herdr --dry-run pa)"; has "$out" '"launch": "herdr"' && has "$out" '"leader": false' && pass "hh claude herdr <profile> → 普通模式也进 herdr" || fail "dry herdr pa: $out"
out="$(hh claude --dry-run --no-herdr)"; has "$out" '"launch": "terminal"' && has "$out" '"HH_VIEWER": "none"' && pass "--no-herdr → 当前终端，且 worker 不开窗口（HH_VIEWER=none）" || fail "dry no-herdr: $out"
out="$(HERDR_ENV=1 HERDR_PANE_ID=w1:p1 hh claude herdr --dry-run)"; has "$out" '"launch": "pane"' && pass "已在 herdr pane 里 → 原地启动" || fail "dry pane: $out"
out="$(HH_VIEWER=none hh claude --dry-run)"; has "$out" '"launch": "terminal"' && pass "HH_VIEWER=none → 终端" || fail "dry viewer env: $out"
out="$(hh claude --dry-run pa)"; has "$out" '"launch": "terminal"' && pass "普通模式默认当前终端" || fail "dry plain: $out"
out="$(hh claude --dry-run --herdr pa)"; has "$out" '"launch": "herdr"' && has "$out" '"herdr_argv": [' && pass "--herdr 普通模式也进 herdr" || fail "dry herdr plain: $out"
out="$(PATH="$here/bin:$T/nodeonly:/usr/bin:/bin" hh claude herdr --dry-run)"; has "$out" '"launch": "terminal"' && has "$out" 'herdr 未安装' && has "$out" 'hh install herdr' && pass "hh claude herdr 但没装 → 终端 + 安装提示（TTY 里会问要不要装）" || fail "dry no herdr: $out"
out="$(PATH="$here/bin:$T/nodeonly:/usr/bin:/bin" hh claude --dry-run)"; has "$out" '"launch": "terminal"' && ! has "$out" 'herdr 未安装' && pass "没装 herdr 时默认 hh claude 不唠叨" || fail "dry quiet: $out"
out="$(hh viewer herdr --json)"; has "$out" '"viewer": "herdr"' && [ "$(hh claude --dry-run | jget launch)" = "herdr" ] && pass "hh viewer herdr → hh claude 也自动开进 herdr" || fail "viewer herdr: $out"
out="$(hh viewer none --json)"; has "$out" '"viewer": "none"' && [ "$(hh claude --dry-run | jget launch)" = "terminal" ] && pass "hh viewer none → 留在终端" || fail "viewer none: $out"
out="$(hh viewer bogus 2>&1 || true)"; has "$out" 'auto|herdr|none' && pass "hh viewer 校验" || fail "viewer bad: $out"
hh viewer auto >/dev/null
out="$(hh install nope 2>&1 || true)"; has "$out" 'claude|codex|herdr' && pass "hh install 只认 claude|codex|herdr" || fail "install nope: $out"
out="$(hh install herdr --yes)"; has "$out" '"already": true' && pass "hh install herdr：已装就不重装" || fail "install herdr: $out"
out="$(PATH="$here/bin:$T/nodeonly:/usr/bin:/bin" hh install herdr)"; has "$out" '"ran": false' && has "$out" 'install.sh' && pass "非 TTY 不带 --yes 只打印安装命令" || fail "install print: $out"
out="$(hh claude --dry-run)"; has "$out" '"leader": true' && has "$out" '--append-system-prompt' && has "$out" 'herdr-hybrid Leader 模式' && has "$out" '先三问' && pass "Leader 模式注入协议（原则，不是对照表）" || fail "leader dry: $out"
out="$(hh claude --dry-run pa --foo)"; has "$out" '"leader": false' && ! has "$out" 'append-system-prompt' && has "$out" '"--foo"' && has "$out" 'sk-a***90' && pass "普通模式不注入协议、参数透传、env 打码" || fail "plain dry: $out"
out="$(hh claude --leader pa --dry-run)"; has "$out" '"leader": true' && has "$out" '"profile": "pa"' && pass "--leader 指定 profile" || fail "leader pa: $out"
out="$(hh claude --dry-run --plain)"; has "$out" 'Leader 模式 · profile ph' && ! has "$out" '--plain' && pass "dry-run 的 --plain 不透传给 claude" || fail "plain passthrough: $out"

# ---- 并发写配置不丢改动（读-改-写整体加锁）----
# 修之前必现：两个 hh 同时写，各自读到同一份旧配置，后 rename 的把前一个盖掉。
for n in 1 2 3 4 5 6; do ( hh profiles set "race$n" --gateway gwa --model "m$n" >/dev/null 2>&1 ) & done
wait
got=0; for n in 1 2 3 4 5 6; do hh profiles show "race$n" >/dev/null 2>&1 && got=$((got+1)); done
[ "$got" = "6" ] && pass "6 个 hh 并发写配置，6 个都在（无 lost update）" || fail "concurrent config write: 只剩 $got/6"
for n in 1 2 3 4 5 6; do hh profiles rm "race$n" >/dev/null 2>&1; done
[ ! -e "$HH_CONFIG_DIR/config.lock" ] && pass "锁文件用完即删" || fail "锁文件残留: $HH_CONFIG_DIR/config.lock"

# ---- 可视化配置界面（mod）：Leader 模式自动挂载 ----
out="$(hh claude --dry-run)"; has "$out" '"--plugin-dir"' && has "$out" '/mod' && pass "Leader 模式自动挂上 mod（/hh-config 可用）" || fail "mod not attached: $out"
out="$(hh claude --dry-run pa)"; ! has "$out" '--plugin-dir' && pass "普通模式不挂 mod" || fail "mod leaked into plain mode: $out"
out="$(hh claude --dry-run --in-herdr-tab)"; has "$out" '"--plugin-dir"' && pass "herdr tab 内重放也挂 mod" || fail "mod missing in tab: $out"
[ -f "$here/mod/hooks/hooks.json" ] && [ -f "$here/mod/.claude-plugin/plugin.json" ] && pass "mod 结构完整（hooks.json + plugin.json）" || fail "mod 文件缺失"
# mod 的下拉选项是写死的字面量（插件环境里读不到 lib/）：这里守住它和真实枚举一致，
# 以后加第三个 agent / 改 autonomy 时不会静默漏掉面板。
out="$(node -e '
const a = require("'"$here"'/lib/agents").NAMES;
const c = require("'"$here"'/lib/config");
const src = require("fs").readFileSync("'"$here"'/mod/hooks/register.tsx", "utf8");
const listOf = (re) => { const m = src.match(re); return m ? m[1].split(",").map(s => s.trim().replace(/^.|.$/g, "")) : []; };
const same = (x, y) => x.length === y.length && x.every((v, i) => v === y[i]);
const agentOpts = listOf(/key: .agent.[^\n]*options: \[([^\]]+)\]/);
const autoOpts  = listOf(/key: .autonomy.[^\n]*options: \[([^\]]+)\]/);
const authOpts  = listOf(/key: .auth.[^\n]*options: \[([^\]]+)\]/);
const bad = [];
if (!same(agentOpts, a)) bad.push("agent: mod=" + agentOpts + " lib=" + a);
if (!same(autoOpts, c.AUTONOMY)) bad.push("autonomy: mod=" + autoOpts + " lib=" + c.AUTONOMY);
if (!same(authOpts, c.AUTH)) bad.push("auth: mod=" + authOpts + " lib=" + c.AUTH);
console.log(bad.length ? "DRIFT " + bad.join(" | ") : "OK");
')"
[ "$out" = "OK" ] && pass "mod 的下拉选项与 lib 的枚举一致（agent / autonomy / auth）" || fail "mod 下拉选项漂移: $out"
# 面板保存 native 前要自己拦住「网关没声明 wire」：hh 只在 plan/启动时报，面板必须早一步说清楚。
# 这里守住 mod 里 missingWires 的存在与关键行为（面板是 tsx，无法 require，检查源码 + 用 hh 验证同一条约束真的存在）
out="$(node -e '
const src = require("fs").readFileSync("'"$here"'/mod/hooks/register.tsx", "utf8");
const need = ["function missingWires", "state.wires", "workerModel", "fallback"];
const miss = need.filter((s) => !src.includes(s));
const wired = /missingWires\(state\.editing\.fields\)/.test(src);
console.log(miss.length ? "MISSING " + miss.join(",") : wired ? "OK" : "NOT_WIRED");
')"
[ "$out" = "OK" ] && pass "mod 保存前校验 native 引用的网关都声明了 wire" || fail "mod missingWires: $out"
hh gateways set nowire --url https://nw.example.com/v1 --auth apikey --secret sk-nowire12345 >/dev/null
out="$(hh profiles set pnw --gateway nowire --model m --orchestration '{"mode":"native","workerModel":"nowire/w","models":[],"fallback":[],"prompt":"","effort":""}' --json 2>&1 || true)"
out2="$(hh native plan pnw 2>&1 || true)"; has "$out2" 'wire' && pass "hh 侧确认：网关缺 wire 时 native 会失败（所以面板要提前拦）" || fail "native wire check: $out2"
hh profiles rm pnw >/dev/null; hh gateways rm nowire >/dev/null
out="$(hh doctor --json || true)"; has "$out" '"leader.mod"' && pass "doctor 体检里有 mod 一项" || fail "doctor mod check: $out"
# 面板依赖 Claude Code 的 function hooks：Leader 用不支持插件的 agent（codex）时不能报「/hh-config 打开」，
# Leader prompt 里也不能推荐这个不会出现的斜杠命令。
hh profiles set cxlead --agent codex --bin "$FAKECODEX" >/dev/null
hh leader cxlead >/dev/null
out="$(hh doctor --plain 2>&1 || true)"; has "$out" '不支持插件面板' && ! has "$out" 'Leader 里 /hh-config 打开' && pass "codex 当 Leader：doctor 说明面板不可用" || fail "doctor codex mod: $out"
out="$(hh run cxlead --dry-run --plain 2>&1 || true)"; has "$out" '别推荐 /hh-config' && pass "codex Leader prompt 明确说面板不可用" || fail "codex leader prompt panel: $out"
hh leader ph >/dev/null
out="$(hh run ph --dry-run --plain 2>&1 || true)"; has "$out" '配置面板' && pass "claude Leader prompt 带配置面板可用性" || fail "claude leader prompt panel: $out"
hh profiles rm cxlead >/dev/null

# ---- hh pane：面板贴右 / 贴底（靠 CLAUDE_CODE_NO_FLICKER 切 fullscreen / main screen）----
[ "$(hh pane | jget pane)" = "right" ] && pass "pane 默认 right" || fail "pane default: $(hh pane)"
out="$(hh claude --dry-run)"; has "$out" '"CLAUDE_CODE_NO_FLICKER": "1"' && pass "right：NO_FLICKER 保持 1（fullscreen，面板靠右）" || fail "pane right env: $out"
hh pane bottom >/dev/null
out="$(hh claude --dry-run)"; has "$out" '"CLAUDE_CODE_NO_FLICKER": "0"' && pass "bottom：注入 NO_FLICKER=0（main screen，面板贴底）" || fail "pane bottom env: $out"
out="$(hh claude --dry-run pa)"; has "$out" '"CLAUDE_CODE_NO_FLICKER": "1"' && pass "pane=bottom 不影响普通模式（没挂面板就不动 NO_FLICKER）" || fail "pane plain: $out"
hh pane right >/dev/null
out="$(hh pane bogus 2>&1 || true)"; has "$out" 'right|bottom' && pass "hh pane 校验" || fail "pane bad: $out"
# ---- 自动清理：settled 超过 keepDays 的 run 每天清一次 ----
[ -d "$HH_STATE_DIR/runs/20200101-000000-ghost-0000" ] || fail "ghost fixture missing"
rm -f "$HH_STATE_DIR/last-clean"
hh dispatch -r coder -l ac -d "$T" -t x --view none >/dev/null
[ ! -d "$HH_STATE_DIR/runs/20200101-000000-ghost-0000" ] && [ -f "$HH_STATE_DIR/last-clean" ] && pass "自动清理过期 run" || fail "auto clean"
echo "ALL PASS"
