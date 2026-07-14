# Saga / Worker 终态一致性执行计划

**目标：** 锁定 Saga 失败时业务事件、job 状态与终态事件的唯一顺序，并消除 retry/cancel 的虚假状态事件。

**分支：** `feat/saga-worker-terminal-consistency`  
**Worktree：** `.worktrees/saga-worker-terminal-consistency`  
**状态：** 已完成

## Task 1：事件顺序红测

1. 构造同一毫秒、逆 UUID 顺序的两条 `job_events`；
2. 断言全量读取保持 INSERT 顺序；
3. 断言 `afterId` 能读取同毫秒后插入的事件。

## Task 2：Worker 状态事件红测

1. 最终失败必须先 `queue.fail`，再发布 `job:failed`，最后对账；
2. fail fencing 未命中时不发布终态事件；
3. 自动 retry 必须先成功 requeue，再发布 `job:retrying`；
4. requeue fencing 未命中时不发布 retrying；
5. `requestCancel` 只有返回 cancelled 才发布 `job:cancelled`。

## Task 3：真实 SQLite Saga 失败集成

1. 注册会先 emit Saga 业务事件、随后抛错的 handler；
2. 用数据库 trigger 断言 `job:failed` 插入前 jobs.status 已为 failed；
3. 断言事件按业务事件 → `job:failed` 排列，且不存在 completed/retrying/cancelled；
4. 断言 resultJson、completedAt、租约与心跳符合 failed 终态。

## Task 4：最小实现

1. `getJobEvents` 和 afterId cursor 改用 rowid；
2. retry 改为 requeue 成功后 emit；
3. cancel 按 `requestCancel` 返回值闸门 emit/reconcile；
4. completed/failed/no-handler 既有先迁移后 emit 语义保持。

## Task 5：文档与验证

1. 更新根、Jobs、DB、Services 文档并删除最后的“仍待补充”；
2. 运行定向和全量 Vitest；
3. 运行 `npx tsc --noEmit`、`npm run lint`、`npm run build`；
4. 确认 `git diff --check` 与 `llm-config.example.json` 无差异；
5. 中文单句提交，以 `--no-ff` 合并回 main 并清理 worktree/分支。

## 执行结果

- 定向回归：4 个测试文件、71 个用例通过；
- 全量 Vitest：240 个测试文件、2123 个用例通过；
- `npx tsc --noEmit`、`npm run lint`、`npm run build` 与 `git diff --check` 均通过；
- `llm-config.example.json` 无差异；
- 提交、合并与 worktree 清理在本计划落库后按仓库规范执行。
