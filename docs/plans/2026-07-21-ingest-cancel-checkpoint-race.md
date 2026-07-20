# Plan：采集任务取消后的检查点竞态修复

对应 spec：`docs/specs/2026-07-21-ingest-cancel-checkpoint-race.md`
分支：`feat/ingest-cancel-checkpoint-race`（worktree）

## 任务拆分

### T1 锁定取消竞态（TDD）

- 文件：
  - `src/server/db/repos/__tests__/jobs-repo-cancel.test.ts`
  - `src/server/db/repos/__tests__/checkpoints-repo.test.ts`
- 先写失败测试：
  1. running job 取消后再调用 `putCheckpoint()`，不得重新产生 checkpoint；
  2. 模拟历史遗留 cancelled checkpoint 时，`getProgress()` 返回 `null`；
  3. 普通 failed job 的 checkpoint 进度保持可读。
- 运行定向测试，确认以竞态未被拦截为原因失败。

### T2 实现 checkpoint 写入门禁与读取防御

- 文件：`src/server/db/repos/checkpoints-repo.ts`
- 将 upsert 改为单条条件写入，以 `jobs.cancel_requested` 作为持久化取消真相。
- `getProgress()` 聚合时排除已取消 job，避免历史遗留行触发恢复。
- 运行 T1 定向测试转绿。

### T3 全量验证与真实数据核对

- 运行：
  - `npx vitest run src/server/db/repos/__tests__/checkpoints-repo.test.ts src/server/db/repos/__tests__/jobs-repo-cancel.test.ts`
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npx vitest run`
- 用只读 SQL 按修复后的恢复条件核对当前 3 个 job 不再具备 checkpointProgress。
- 检查 diff 与提交边界；完成后等待确认再 `--no-ff` 回合 main 并清理 worktree。
