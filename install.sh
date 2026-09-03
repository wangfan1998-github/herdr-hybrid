#!/usr/bin/env bash
# herdr-hybrid 一键安装：
#   hh → ~/.local/bin/hh（指向 ~/.local/share/herdr-hybrid；HH_DEV=1 则直接指向本仓库）
#   Leader 技能 → ~/.claude/skills/herdr-leader
#   配置 → hh init（自动导入 ~/.config/ccm/*.conf 与 shell alias；已有 v2 配置则保留）
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN_DIR="${HH_BIN_DIR:-$HOME/.local/bin}"
SHARE_DIR="${HH_SHARE_DIR:-$HOME/.local/share/herdr-hybrid}"
CFG="${HH_CONFIG_DIR:-$HOME/.config/hh}/config.json"
say(){ printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m!!\033[0m %s\n' "$*"; }

say "检查依赖"
command -v node >/dev/null || { warn "缺少 node（≥ 18）。Claude Code 本身就需要 Node。"; exit 1; }
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 18 ] || { warn "node 版本过低: $(node --version)，需要 ≥ 18"; exit 1; }
echo "  node: $(node --version)"
command -v claude >/dev/null && echo "  claude: $(claude --version 2>/dev/null | head -1)" || warn "缺少 claude（Claude Code CLI）；装好后再 hh init"
command -v herdr >/dev/null && echo "  herdr: $(herdr --version 2>/dev/null | head -1)（可选，观察窗口）" || echo "  herdr: 未安装（可选，只影响观察窗口）"

if [ "${HH_DEV:-0}" = 1 ]; then
  say "开发模式：~/.local/bin/hh → $here/bin/hh"
  target="$here/bin/hh"
else
  say "安装到 $SHARE_DIR"
  mkdir -p "$SHARE_DIR"
  rm -rf "${SHARE_DIR:?}/bin" "${SHARE_DIR:?}/lib" "${SHARE_DIR:?}/prompts" "${SHARE_DIR:?}/skill"
  cp -R "$here/bin" "$here/lib" "$here/prompts" "$here/skill" "$SHARE_DIR/"
  cp "$here/package.json" "$SHARE_DIR/package.json"
  target="$SHARE_DIR/bin/hh"
fi
mkdir -p "$BIN_DIR"
chmod 755 "$target"
ln -sfn "$target" "$BIN_DIR/hh"
echo "  $BIN_DIR/hh → $target"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR 不在 PATH，请加到 shell 配置：export PATH=\"$BIN_DIR:\$PATH\"";; esac

say "安装 Leader 技能"
d="$HOME/.claude/skills/herdr-leader"; mkdir -p "$d"; install -m 644 "$here/skill/herdr-leader/SKILL.md" "$d/SKILL.md"; echo "  $d/SKILL.md"

say "初始化配置"
if [ -f "$CFG" ]; then
  ver="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||0)}catch(e){console.log(0)}' "$CFG")"
  if [ "$ver" != "2" ]; then
    bak="${CFG}.bak-$(date +%Y%m%d%H%M%S)"; cp "$CFG" "$bak"
    echo "  旧格式配置已备份到 ${bak}，重新生成"
    "$BIN_DIR/hh" init --force --plain || warn "hh init 失败，稍后手动运行 hh init --force"
  else
    echo "  保留已有 ${CFG}（要再导入一次 alias / ccm：hh profiles import-aliases / import-ccm）"
    "$BIN_DIR/hh" doctor --plain || true
  fi
else
  "$BIN_DIR/hh" init --plain || warn "hh init 失败，稍后手动运行 hh init"
fi

cat <<NEXT

安装完成。下一步：
  1) hh doctor                     体检（claude / 网关 / profile / 角色 / 技能 / MCP）
  2) hh profiles test <name>       某个 profile 真发一次「pong」（hh doctor --net 测角色用到的全部）
  3) eval "\$(hh profiles aliases)"  生成 <profile>cc alias，写进 ~/.shell_aliases 沿用旧习惯
  4) hh install-mcp                （可选）把 hh 注册成 Claude Code 的原生 MCP 工具
  5) 在 herdr 里开一个 tab：hh claude <你最聪明的 profile>，直接说：
     「把这个需求拆一下，coding 派给 coder 并行做，做完让 reviewer 审，通过后汇报」
NEXT
