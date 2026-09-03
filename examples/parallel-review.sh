#!/usr/bin/env bash
# 双模型对照审查：同一份审查任务派给 reviewer 角色 + 另一个 profile，等两边结束后并排打印结论。
# 用法: examples/parallel-review.sh <目录> <审查对象> [另一个 profile 名]
set -euo pipefail
dir="${1:?目录}"; target="${2:?审查对象}"; alt="${3:-}"
task="只读审查 ${target}。输出：结论（通过/需修改）、按严重度排序的问题列表（文件:行号、原因、修复建议，最多 8 条）、一句话总评。全部中文。"
ids=()
a="$(hh dispatch -r reviewer -l review-a -d "$dir" -t "$task" --json)"; ids+=("$(node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).run.id' <<<"$a")")
if [ -n "$alt" ]; then
  b="$(hh dispatch -r reviewer -p "$alt" -l "review-$alt" -d "$dir" -t "$task" --json)"; ids+=("$(node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).run.id' <<<"$b")")
fi
until hh wait "${ids[@]}" --timeout 540 --plain; do :; done
for id in "${ids[@]}"; do echo; echo "===== $id ====="; hh result "$id" --plain; done
