#!/usr/bin/env bash
# herdr-hybrid 一键安装：
#   hh → ~/.local/bin/hh（指向 ~/.local/share/herdr-hybrid；HH_DEV=1 则直接指向本仓库）
#   Leader 技能 → ~/.claude/skills/herdr-leader
#   配置 → hh init（自动导入 shell 里的 claude 启动 alias；已有 v2 配置则保留）
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
# 缺依赖时问一句要不要装（官方安装脚本）。HH_INSTALL_DEPS=yes|no 跳过询问；非 TTY 默认不装，只提示
ask(){
  case "${HH_INSTALL_DEPS:-ask}" in yes) return 0;; no) return 1;; esac
  if [ -t 0 ] && [ -t 1 ]; then
    printf '\033[1;36m??\033[0m %s [Y/n] ' "$1"; read -r a || return 1
    case "$a" in n|N|no|NO) return 1;; *) return 0;; esac
  fi
  return 1
}
if command -v claude >/dev/null; then
  echo "  claude: $(claude --version 2>/dev/null | head -1)"
else
  warn "缺少 Claude Code"
  if ask "现在用官方脚本安装 Claude Code？（curl -fsSL https://claude.ai/install.sh | bash）"; then
    curl -fsSL https://claude.ai/install.sh | bash || warn "安装失败；手动: npm install -g @anthropic-ai/claude-code，或稍后 hh install claude"
  else
    echo "  稍后: hh install claude"
  fi
fi
if command -v herdr >/dev/null; then
  echo "  herdr: $(herdr --version 2>/dev/null | head -1)（hh claude 会开在 herdr 里，每个 worker 一个窗口）"
else
  echo "  herdr: 未安装（可选：Leader 和每个 worker 各一个窗口；没有也能用，都在终端 / 后台）"
  if ask "顺手装上 herdr？（curl -fsSL https://herdr.dev/install.sh | sh）"; then
    curl -fsSL https://herdr.dev/install.sh | sh || warn "安装失败；手动: brew install herdr，或稍后 hh install herdr"
  else
    echo "  稍后: hh install herdr；不想用窗口: hh viewer none"
  fi
fi

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
    echo "  保留已有 ${CFG}（要再导入一次 alias：hh profiles import-aliases）"
    "$BIN_DIR/hh" doctor --plain || true
  fi
else
  "$BIN_DIR/hh" init --plain || warn "hh init 失败，稍后手动运行 hh init"
fi

cat <<NEXT

安装完成。下一步：
  1) hh doctor                     体检（claude / 端点 / profile / 角色 / 技能 / MCP）
     还没有端点？hh setup 一问一答加一个（订阅 / API key / 网关 + 模型），顺手测连通
  2) hh roles set coder --profile <便宜的>  ·  hh leader <最聪明的>   分工；hh doctor --net 对角色用到的 profile 各发一次 pong（--all 全部）
  3) hh claude                     启动 Leader，直接说需求（装了 herdr 就开在 herdr 里，worker 各一个窗口；--no-herdr 留在终端）
  4) hh install-mcp                （可选）把 hh 注册成 Claude Code 的原生 MCP 工具
  5) eval "\$(hh profiles aliases)"  （可选）生成 <profile>cc 快捷命令，写进 ~/.shell_aliases
NEXT
