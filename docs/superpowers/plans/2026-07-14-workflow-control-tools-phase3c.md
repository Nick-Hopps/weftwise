# Wiki 工作流控制工具 Phase 3C 执行计划

**目标：** 让 Ask AI 安全查看 active Subject 任务，并通过 PendingAction 提出 re-enrich、research 与 cancel 工作流操作。

**分支：** `feat/workflow-control-tools-phase3c`
**Worktree：** `.worktrees/workflow-control-tools-phase3c`

## Task 1：锁定领域契约、registry 与 profile

1. 增加 workflow status/start/cancel 输入输出契约与三个 PendingAction operation；
2. 先补 registry/profile/query resolve 红测；
3. 注册 `workflow.reenrich.start`、`workflow.research.start`、`workflow.status`、`workflow.cancel`；
4. status 只读，start/cancel 只允许 propose，其他 runner 不获得 workflow 工具；
5. 把 `wiki.reenrich` 改为新审批回调的弃用别名。

## Task 2：实现 subject-scoped 工作流服务

1. 实现安全 job status view，不返回 params/result；
2. 抽取 re-enrich/research start 的 plan 与 enqueue；
3. 实现 cancel plan/apply，复用 `requestCancel`、cancel event 与 Research provenance 对账；
4. 未知、跨 Subject、全局、终态 job 统一在服务端拒绝或隐藏。

## Task 3：接入 PendingAction 与原子最终化

1. 新增三个 workflow preview 创建路径；
2. 批准时重新规划并处理 stale preview；
3. start job insert 与 action applied 同一 SQLite 事务；
4. cancel 与 action applied 同一事务，事件/对账在提交后 best-effort；
5. 维护流程只对遗留的 executing workflow action 做超时失败收口，禁止猜测性重复入队；
6. 扩展 CHECK 启动迁移与 Drizzle migration。

## Task 4：Query、Prompt 与 UI 接线

1. `ToolContext` 注入 status、三个 preview callback；
2. Query intent 识别开始 Research、重新丰富和取消任务；
3. Query prompt 写明工具选择、审批纪律与 Research 二次候选审批；
4. PendingAction 卡片区分 workflow 状态；
5. tool activity 增加四工具与弃用 alias 的安全摘要。

## Task 5：文档与配置审计

1. 更新根、agents、jobs、services、app、components、lib 模块文档；
2. 更新治理总 spec，标记 Phase 3C 已实现；
3. 确认未新增 LLM task/provider 路由；
4. 检查 `git diff -- llm-config.example.json`，预期为空。

## Task 6：验证、提交、合回与清理

1. 运行定向 Vitest；
2. 运行全量 Vitest、`npx tsc --noEmit`、`npm run lint`、`npm run build`；
3. 检查 `git diff --check` 与工作树状态；
4. 使用中文一句话提交逻辑批次；
5. 回到 main 执行 `git merge --no-ff feat/workflow-control-tools-phase3c`，merge message 包含分支名；
6. 删除 worktree 与特性分支，确认 main 干净。

## 完成判据

- Query 可安全查询 active Subject job，不泄露跨 Subject/全局任务；
- start/cancel 只能生成 PendingAction，批准前零队列/取消副作用；
- 批准后入队/取消与 action 状态原子一致；
- `wiki.reenrich` 兼容 alias 不再直写队列；
- `llm-config.example.json` 无差异；
- 全部验证通过并以 `--no-ff` 合回 main。

## 执行结果

- builtin 工具总数从 23 增至 27，新增 `workflow.status`、`workflow.reenrich.start`、`workflow.research.start`、`workflow.cancel`；
- Query 的读取/提议边界完成：状态读取只返回当前 subject 的安全字段，启动与取消只创建 PendingAction；
- Re-enrich / Research 启动和任务取消均通过 SQLite 原子事务提交业务副作用与 action `applied` 状态；
- `wiki.reenrich` 保留为一个版本的弃用别名，并改为提议语义；
- 新增 Drizzle 迁移 `0006_magical_alex_wilder.sql`，扩展 PendingAction operation CHECK；
- 全量测试通过：233 个测试文件、2058 个用例；
- `npx tsc --noEmit`、`npm run lint`、`npm run build` 均通过；lint 仅保留 12 条既有 warning；
- `llm-config.example.json` 无差异，本阶段未新增 LLM task，无需更新。
