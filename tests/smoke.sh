#!/usr/bin/env bash
# 不依赖真实 claude 的冒烟测试：tests/fake-agent 假扮 claude（profile 的 bin 指向它）。
# 覆盖：init（导入 shell alias）/ herdr 唤起（fake-herdr）/ install / viewer / gateways / profiles / env 注入与继承清理 / roles / dispatch / wait / result / read / task /
#       send(resume) / cancel / failed / crashed / 超时退出码 / dry-run argv / aliases / doctor / log / status / MCP / 错误提示
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"; ln -s "$here/tests/fake-herdr" "$T/bin/herdr"   # 假 herdr：不碰真机上的 herdr
export PATH="$T/bin:$here/bin:$PATH" FAKE_HERDR_LOG="$T/herdr.log"
export HH_CONFIG_DIR="$T/cfg" HH_STATE_DIR="$T/state" HH_ALIAS_FILES="$T/aliases"
unset HERDR_ENV HERDR_PANE_ID HERDR_TAB_ID HERDR_WORKSPACE_ID HH_VIEWER
pass(){ echo "PASS $*"; }; fail(){ echo "FAIL $*"; exit 1; }
has(){ [[ "$1" == *"$2"* ]]; }
jget(){ node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);const v=process.argv[1].split(".").reduce((a,k)=>a==null?a:a[k],o);console.log(v==null?"":typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
FAKE="$here/tests/fake-agent"

# ---- 准备 shell alias 让 init 导入；其余端点 / profile 用命令建 ----
cat > "$T/aliases" <<'EOF'
alias democc="CLAUDE_CODE_NO_FLICKER=1 ANTHROPIC_BASE_URL=https://demo.example.com ANTHROPIC_AUTH_TOKEN=sk-demo1234567890 ANTHROPIC_MODEL=demo-model ENABLE_TOOL_SEARCH=false claude"
alias demo2cc="ANTHROPIC_BASE_URL=https://demo.example.com ANTHROPIC_AUTH_TOKEN=sk-demo1234567890 ANTHROPIC_MODEL=demo-model-2 claude --foo"
alias cc="claude --dangerously-skip-permissions"
EOF

out="$(hh init --json)"; has "$out" '"config"' && pass "hh init" || fail "init: $out"
[ -f "$HH_CONFIG_DIR/config.json" ] && pass "config.json 生成" || fail "config.json"
mode(){ node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$1"; }   # 跨 BSD/GNU 的权限读取
[ "$(mode "$HH_CONFIG_DIR/config.json")" = "600" ] && pass "config.json 600" || fail "perm: $(mode "$HH_CONFIG_DIR/config.json")"
[ -f "$HH_CONFIG_DIR/prompts/coder.md" ] && pass "prompts 复制" || fail "prompts"
[ "$(jget roles.coder.profile <<<"$out")" = "official" ] && [ "$(jget roles_defaulted <<<"$out")" = "true" ] && pass "init 角色默认全 official" || fail "default roles: $out"
has "$out" '"demo"' && has "$out" '"demo2"' && pass "init 导入 shell alias（去掉 cc 后缀）" || fail "aliases: $out"
gw="$(hh profiles show demo2 | jget profile.gateway)"; [ "$gw" = "$(hh profiles show demo | jget profile.gateway)" ] && pass "同 url+密钥的 alias 复用网关 ($gw)" || fail "alias gateway reuse"
hh gateways set gwa --url https://a.example.com --auth token --secret sk-aaaa1234567890 --env ENABLE_TOOL_SEARCH=false >/dev/null
hh gateways set gwh --url 'https://h.example.com/#x' --auth apikey --secret 'ab#cd1234567890' --env FOO=gw >/dev/null
hh profiles set pa --gateway gwa --model model-a >/dev/null
hh profiles set ph --gateway gwh --model 'model#1' --env FOO=profile >/dev/null
hh roles set coder --profile pa >/dev/null
[ "$(hh profiles show ph | jget profile.gateway)" = "gwh" ] && pass "命令建好测试用端点 gwa/gwh 与 profile pa/ph" || fail "test fixtures"

# ---- env 注入 ----
out="$(hh env ph --reveal)"; has "$out" '"ANTHROPIC_API_KEY": "ab#cd1234567890"' && pass "apikey 注入（值含 # 原样）" || fail "env ph: $out"
has "$out" '"FOO": "profile"' && pass "profile env 覆盖 gateway env" || fail "override: $out"
has "$out" '"ANTHROPIC_MODEL": "model#1"' && has "$out" '"CLAUDE_CODE_SUBAGENT_MODEL": "model#1"' && pass "模型写入全部 model 变量" || fail "model env: $out"
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
out="$(hh profiles aliases)"; has "$out" "alias pacc='" && has "$out" "claude pa'" && pass "profiles aliases" || fail "aliases: $out"
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

# ---- worker 汇报契约：末尾 json 块 → result.report ----
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

# ---- dry-run argv ----
out="$(hh dispatch --dry-run -p pa -d "$T" -t x)"; has "$out" '"-p"' && has "$out" 'bypassPermissions' && has "$out" '"model-a"' && has "$out" '"ANTHROPIC_AUTH_TOKEN": "sk-a***90"' && pass "dry-run argv + env 打码" || fail "dry: $out"
out="$(hh dispatch --dry-run -p pa -a readonly -d "$T" -t x)"; has "$out" '"default"' && has "$out" 'git diff' && pass "readonly 映射" || fail "dry ro: $out"
out="$(hh dispatch --dry-run -p pa -a workspace -d "$T" -t x)"; has "$out" 'acceptEdits' && pass "workspace 映射" || fail "dry ws: $out"

# ---- 引用保护 / 删除 ----
out="$(hh profiles rm fake 2>&1 || true)"; has "$out" '仍被角色引用' && pass "profiles rm 被引用拒绝" || fail "rm referenced: $out"
out="$(hh roles rm reviewer --json)"; has "$out" '"removed": "reviewer"' && pass "roles rm" || fail "roles rm: $out"
out="$(hh profiles import-aliases --dry-run "$T/aliases")"; has "$out" '"dry_run": true' && pass "import-aliases --dry-run" || fail "import dry: $out"

# ---- doctor / log / status --all ----
out="$(hh doctor --json || true)"; has "$out" '"checks"' && has "$out" '"gateway.gwh"' && pass "doctor --json" || fail "doctor: $out"
out="$(hh log)"; has "$out" '"dispatch"' && has "$out" '"cancel"' && pass "log 事件流" || fail "log: $out"
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
out="$(hh claude --version 2>&1 || true)"; has "$out" 'Leader 模式' && has "$out" 'profile ph' && has "$out" '"launch": "herdr"' && pass "hh claude 不带 profile = leader 模式，默认开进 herdr" || fail "claude leader: $out"
hh profiles set nobin --gateway gwa --model m --bin /nonexistent/claude >/dev/null
out="$(hh claude nobin --no-herdr 2>&1 || true)"; has "$out" '找不到 /nonexistent/claude' && has "$out" 'hh install claude' && pass "claude 可执行文件不存在 → 启动前报错并指向 hh install claude" || fail "no claude bin: $out"
hh profiles rm nobin >/dev/null
grep -q 'tab create --workspace w1' "$FAKE_HERDR_LOG" && grep -q 'claude --no-herdr --leader ph --version' "$FAKE_HERDR_LOG" && ! grep -q -- '--no-focus.*hh:leader\|hh:leader.*--no-focus' "$FAKE_HERDR_LOG" && pass "herdr：建聚焦 tab，pane 里跑 hh claude --no-herdr --leader ph（参数透传）" || fail "herdr log: $(cat "$FAKE_HERDR_LOG")"
: > "$FAKE_HERDR_LOG"
out="$(hh claude --dry-run)"; has "$out" '"launch": "herdr"' && pass "dry-run: Leader 模式 launch=herdr" || fail "dry herdr: $out"
out="$(hh claude --dry-run --no-herdr)"; has "$out" '"launch": "terminal"' && has "$out" '"HH_VIEWER": "none"' && pass "--no-herdr → 当前终端，且 worker 不开窗口（HH_VIEWER=none）" || fail "dry no-herdr: $out"
out="$(HERDR_ENV=1 HERDR_PANE_ID=w1:p1 hh claude --dry-run)"; has "$out" '"launch": "pane"' && pass "已在 herdr pane 里 → 原地启动" || fail "dry pane: $out"
out="$(HH_VIEWER=none hh claude --dry-run)"; has "$out" '"launch": "terminal"' && pass "HH_VIEWER=none → 终端" || fail "dry viewer env: $out"
out="$(hh claude --dry-run pa)"; has "$out" '"launch": "terminal"' && pass "普通模式默认当前终端" || fail "dry plain: $out"
out="$(hh claude --dry-run --herdr pa)"; has "$out" '"launch": "herdr"' && has "$out" '"herdr_argv": [' && pass "--herdr 普通模式也进 herdr" || fail "dry herdr plain: $out"
out="$(PATH="$here/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" hh claude --dry-run)"; has "$out" '"launch": "terminal"' && has "$out" 'herdr 未安装' && has "$out" 'hh install herdr' && pass "没装 herdr → 终端 + 安装提示" || fail "dry no herdr: $out"
out="$(PATH="$here/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" hh claude --dry-run --herdr 2>&1 || true)"; has "$out" 'herdr 未安装' && pass "--herdr 但没装 → 报错" || fail "force herdr: $out"
out="$(hh viewer none --json)"; has "$out" '"viewer": "none"' && [ "$(hh claude --dry-run | jget launch)" = "terminal" ] && pass "hh viewer none → Leader 也留在终端" || fail "viewer none: $out"
out="$(hh viewer bogus 2>&1 || true)"; has "$out" 'auto|herdr|none' && pass "hh viewer 校验" || fail "viewer bad: $out"
hh viewer auto >/dev/null
out="$(hh install nope 2>&1 || true)"; has "$out" 'claude|herdr' && pass "hh install 只认 claude|herdr" || fail "install nope: $out"
out="$(hh install herdr --yes)"; has "$out" '"already": true' && pass "hh install herdr：已装就不重装" || fail "install herdr: $out"
out="$(PATH="$here/bin:$(dirname "$(command -v node)"):/usr/bin:/bin" hh install herdr)"; has "$out" '"ran": false' && has "$out" 'install.sh' && pass "非 TTY 不带 --yes 只打印安装命令" || fail "install print: $out"
out="$(hh claude --dry-run)"; has "$out" '"leader": true' && has "$out" '--append-system-prompt' && has "$out" 'herdr-hybrid Leader 模式' && has "$out" '先三问' && pass "Leader 模式注入协议（原则，不是对照表）" || fail "leader dry: $out"
out="$(hh claude --dry-run pa --foo)"; has "$out" '"leader": false' && ! has "$out" 'append-system-prompt' && has "$out" '"--foo"' && has "$out" 'sk-a***90' && pass "普通模式不注入协议、参数透传、env 打码" || fail "plain dry: $out"
out="$(hh claude --leader pa --dry-run)"; has "$out" '"leader": true' && has "$out" '"profile": "pa"' && pass "--leader 指定 profile" || fail "leader pa: $out"
out="$(hh claude --dry-run --plain)"; has "$out" 'Leader 模式 · profile ph' && ! has "$out" '--plain' && pass "dry-run 的 --plain 不透传给 claude" || fail "plain passthrough: $out"
echo "ALL PASS"
