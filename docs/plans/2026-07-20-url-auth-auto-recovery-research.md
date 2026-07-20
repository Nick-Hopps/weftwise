# Plan：URL 登录态自动恢复与 Research 接入

对应 spec：`docs/specs/2026-07-20-url-auth-auto-recovery-research.md`
分支：`feat/url-auth-auto-recovery-research`（worktree）

## 任务拆分

### T1 Research grant 原子恢复（TDD）

- 文件：
  - `src/server/db/repos/research-provenance-repo.ts`
  - `src/server/services/research-approval-service.ts`
  - `src/app/api/jobs/[id]/url-auth/route.ts`
  - 对应 repo / route 测试
- 先写失败测试：
  1. Research child 授权把 grant ID 合并进原 params，并原子恢复 job/delivery/run；
  2. lineage/CAS 失败时状态不变；
  3. API 成功返回 202 并发 `authenticated + research` retry 事件；
  4. service 失败补偿删除新 grant，旧 grant 只在成功接管后清理。
- 验证：
  `npx vitest run src/server/db/repos/__tests__/research-provenance-repo.test.ts src/app/api/jobs/[id]/url-auth/__tests__/route.test.ts`

### T2 全局认证挑战恢复与队列（TDD）

- 文件：
  - `src/lib/ingest-auth.ts`
  - `src/components/shared/url-auth-recovery-state.ts`
  - `src/components/shared/global-job-tracker.tsx`
  - `src/components/shared/jobs-panel.tsx`
  - `src/components/shared/jobs-panel-state.ts`
  - 对应 helper / state 测试
- 先写失败测试：
  1. challenge 携带持久化 event ID；retry 后旧 challenge 失效；
  2. 队列按 challenge 去重，关闭只抑制本次自动提示，新 challenge 仍可入队；
  3. failed 列表只恢复 `url-auth-required` Ingest；
  4. tracked job 保留自身 subjectId。
- 实现：
  - 全局轮询增加 failed Ingest 查询和安全 code 过滤；
  - JobRow 在挑战成为失败原因时自动入队，提供 KeyRound 手动重开；
  - JobsPanel 一次渲染一个复用的 `IngestAuthDialog`；成功后重启同 job 跟踪。
- 验证：
  `npx vitest run src/lib/__tests__/ingest-auth.test.ts src/components/shared/__tests__/url-auth-recovery-state.test.ts src/components/shared/__tests__/jobs-panel-state.test.ts`

### T3 Subject 与 Research UI 生命周期接线（TDD）

- 文件：
  - `src/app/(app)/_components/ingest-auth-dialog.tsx`
  - `src/app/(app)/_components/ingest-workbench.tsx`
  - `src/components/health/health-view.tsx`
  - `src/lib/job-started-event.ts` 或现有事件消费者测试
- 行为：
  - 对话框可带精确 job subjectId 提交；工作台继续保留手动恢复且不新增第二套自动弹窗；
  - Research candidate dialog 观察同一 child 的 restart，回读 run 后恢复 importing 轮询；
  - 授权成功不改变普通 Ingest 的工作台 SSE 续订行为。
- 验证：
  `npx vitest run src/app/(app)/_components/__tests__/ingest-auth-dialog.test.ts src/components/health/__tests__/remediation-ui.test.ts`

### T4 文档、回归与完成验证

- 同步根 `CLAUDE.md`、`src/app/CLAUDE.md`、`src/components/CLAUDE.md`、
  `src/server/{db,sources,services}/CLAUDE.md` 中的 URL auth / Research 边界。
- 检查 diff 不含 grant、密钥、Cookie 或无关变更。
- 全量验证：
  - `npx tsc --noEmit`
  - `npm run lint`
  - `npx vitest run`
  - `npm run build`
- 按任务最小边界提交，完成后提醒是否用 `--no-ff` 回合 main 并清理 worktree。
