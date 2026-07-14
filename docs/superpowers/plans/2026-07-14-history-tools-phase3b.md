# Wiki History 工具与回滚审批 Phase 3B 执行计划

**目标：** 让 Ask AI 能读取 active Subject 历史、查看 operation diff 并生成安全的回滚审批，同时复用现有 History/API/git/Saga 能力。

**分支：** `feat/history-tools-phase3b`  
**Worktree：** `.worktrees/history-tools-phase3b`

## Task 1：锁定契约、registry 与 profile

1. 增加 History 工具输入输出与 `history-revert` PendingAction 契约；
2. 先补 registry/profile/query intent 红测；
3. 注册 `history.list`、`history.diff`、`history.revert`；
4. list/diff 只读，revert 只允许 propose，其他 runner 不获得 History 工具。

## Task 2：抽取 History 共享读取与回滚计划

1. 复用 operations repo、`buildHistoryEntries`、git log/diff；
2. 实现 subject-scoped list/filter/limit 与 diff；
3. 抽取回滚 plan：旧快照、当前快照、inverse entries、validation、统一 diff；
4. 抽取回滚 apply：`expectedPreHead` + Saga；
5. 让三个既有 History API 路由复用共享服务。

## Task 3：接入 PendingAction 审批闭环

1. 新增 `createPendingHistoryRevertPreview`；
2. 批准时重算回滚计划并处理 stale preview；
3. 执行时保存新 Saga operationId；
4. 原子最终化原 operation 状态、embedding job 与 action 状态；
5. 维护流程按 action operation 类型恢复最终化。

## Task 4：DB 兼容迁移与 Query 接入

1. 扩展 schema 与启动迁移 CHECK；
2. 补旧表重建、历史数据保留和未知 operation 拒绝测试；
3. `ToolContext` 注入 History 读与回滚预览回调；
4. 更新 Query prompt 与明确回滚意图识别；
5. 保证跨 Subject operation 始终不可见。

## Task 5：文档与配置审计

1. 更新根、agents、services、wiki、db、lib 模块文档与工具数量；
2. 更新治理总 spec，标记 Phase 3B 已实现；
3. 确认未新增 LLM task/provider 路由；
4. 检查 `git diff -- llm-config.example.json`，预期为空。

## Task 6：验证、提交、合回与清理

1. 运行定向 Vitest；
2. 运行全量 Vitest、`npx tsc --noEmit`、`npm run lint`、`npm run build`；
3. 检查 `git diff --check` 与工作树状态；
4. 使用中文一句话提交逻辑批次；
5. 回到 main 执行 `git merge --no-ff feat/history-tools-phase3b`，merge message 包含分支名；
6. 删除 worktree 与特性分支，确认 main 干净。

## 完成判据

- History 三工具契约可用且只在 Query profile 可达；
- 模型只能提出回滚，不能绕过 PendingAction；
- stale/重复/跨 Subject 回滚被服务端拒绝；
- 既有 History UI/API 不回归；
- `llm-config.example.json` 无差异；
- 全部验证通过并以 `--no-ff` 合回 main。

## 执行结果

- builtin registry 从 20 个扩展为 23 个，History 三工具只进入 Query profile；
- `history.list/diff` 复用 operations 与 git，`history.revert` 只生成 PendingAction；
- 回滚批准覆盖 payload hash、重新规划、stale HEAD、inverse Saga、原 operation 标记与崩溃后最终化恢复；
- 既有 History 三个 API 改用共享服务，页面人工确认路径保持兼容；
- 新增 Drizzle `0005_calm_dorian_gray.sql` 与启动期 CHECK 原子兼容迁移；
- Vitest：231 个测试文件、2017 个用例全部通过；
- `npx tsc --noEmit` 通过；
- `npm run lint` 通过，仅保留 12 条既有 warning；
- `npm run build` 通过；
- `git diff -- llm-config.example.json` 为空，无需更新示例配置。
