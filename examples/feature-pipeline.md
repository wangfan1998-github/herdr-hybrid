# 示例：一个需求的混动流水线

> Leader（`hh claude` 启动的 Claude Code）收到需求后按下面顺序自己跑完；用户只在最后看汇报。
> 下面用命令行写法；注册了 MCP 的 Leader 用 `hh_dispatch` / `hh_wait` / `hh_result` / `hh_send` 同义。

```text
需求：给后台 admin-web 的「订单」列表加导出 CSV 按钮，后端补 /export 接口
```

1. **拆解**（Leader 自己做，不派）
   - T1 后端 `/export` 接口（目录 be/，验收 `go test ./...`）
   - T2 前端按钮 + 下载逻辑（目录 fe/，验收 `npm run build`）
   - 两者只通过接口契约耦合，可并行；契约先由 Leader 写进两个任务文件
2. **派发 coding**
   ```bash
   hh dispatch -r coder -l export-be -d ~/repo/be -f /tmp/t1.md     # → {"run":{"id":"…export-be-a1f2"}}
   hh dispatch -r coder -l export-fe -d ~/repo/fe -f /tmp/t2.md     # → {"run":{"id":"…export-fe-7c03"}}
   ```
3. **等待**
   ```bash
   hh wait export-be export-fe --timeout 540      # 退出码 2 就再调一次；settled 后看 runs[].status
   hh result export-be ; hh result export-fe      # failed → hh read <id> 看末尾和 error
   ```
4. **验收**（Leader 自己跑，不信自述）
   ```bash
   (cd ~/repo/be && go test ./...) ; (cd ~/repo/fe && npm run build) ; git -C ~/repo log --oneline -5
   ```
5. **review 交给判断力强的角色**
   ```bash
   git -C ~/repo diff HEAD~2 > /tmp/export.diff
   hh dispatch -r reviewer -l export-review -d ~/repo -t "审查 /tmp/export.diff 对应的两个提交，重点：接口契约一致性、错误处理、CSV 注入。"
   hh wait export-review ; hh result export-review
   ```
6. **返修**：reviewer 提的高/中问题回给原 coder（同一会话，有上下文）
   ```bash
   hh send export-be -t "reviewer 指出：… 请修复并重新跑 go test ./...，提交后总结。"   # → 新 run …export-be-r1-…
   hh wait export-be-r1
   ```
   再验收、再让 reviewer 看一眼。
7. **收尾**：进程都已退出；开了 herdr 窗口的 `hh close <id>`。
8. **汇报**：`hh status` + 各任务结论 + 验收输出，中文表格给用户。
