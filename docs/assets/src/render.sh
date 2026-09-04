#!/usr/bin/env bash
# 渲染 README 图片：src/*.svg → ../*.png（2x，浅色）；src/*.html → ../*-{light,dark}.png（2x）；src/showcase.html → ../showcase.gif
# 依赖：Chrome/Chromium（CHROME 环境变量可覆盖路径）、ffmpeg（只有 GIF 需要）
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$(cd "$here/.." && pwd)"
C="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[ -x "$C" ] || C="$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)"
[ -n "$C" ] || { echo "找不到 Chrome，设置 CHROME=/path/to/chrome" >&2; exit 1; }

render(){ "$C" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 --window-size="$3" --screenshot="$2" "$1" >/dev/null 2>&1; }

# SVG 图（hero / architecture / config-model）：源文件就是 svg，直接截图成 2x PNG，只有浅色版
for spec in hero:1400,720 architecture:1400,820 config-model:1400,760; do
  n="${spec%%:*}"; size="${spec##*:}"
  render "file://$here/$n.svg" "$out/$n.png" "$size"; echo "  $n.png"
done

for spec in banner:1500,420 herdr:1500,480; do
  n="${spec%%:*}"; size="${spec##*:}"
  for t in light dark; do render "file://$here/$n.html?theme=$t" "$out/$n-$t.png" "$size"; echo "  $n-$t.png"; done
done

if command -v ffmpeg >/dev/null; then
  tmp="$(mktemp -d)"
  for n in 1 2 3 4 5 6 7 8 9; do render "file://$here/showcase.html?n=$n" "$tmp/f$n.png" 1200,560; done
  {
    for n in 1 2 3 4 5 6 7 8; do d=1.6; [ "$n" = 1 ] && d=2.2; [ "$n" = 3 ] && d=2.4; [ "$n" = 6 ] && d=2.4; [ "$n" = 8 ] && d=2.6; printf "file '%s/f%s.png'\nduration %s\n" "$tmp" "$n" "$d"; done
    printf "file '%s/f9.png'\nduration 4\nfile '%s/f9.png'\n" "$tmp" "$tmp"
  } > "$tmp/list.txt"
  ffmpeg -y -loglevel error -f concat -safe 0 -i "$tmp/list.txt" -vf "scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3" -loop 0 "$out/showcase.gif"
  rm -rf "$tmp"; echo "  showcase.gif"
else
  echo "  (没有 ffmpeg，跳过 showcase.gif)"
fi
