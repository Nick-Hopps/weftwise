# Research 批准溯源 Phase 2C 执行计划

> **执行方式：** 隔离 worktree + TDD + 分任务 spec review / code quality review + 最终整体验收。

**目标：** 把 `finding/topic → Research → 候选批准 → Ingest → touched pages → verification lint` 升级为服务端持久化、可恢复、可验证的 provenance 闭环，并补齐所有 URL Ingest 共用的 SSRF-safe 出网边界。

**设计文档：** `docs/superpowers/specs/2026-07-13-research-approval-provenance-phase2c-design.md`

**分支：** `feat/research-approval-provenance-phase2c`
**worktree：** `.worktrees/research-approval-provenance-phase2c`
**基线：** `3050509`

## Task 1：收紧 URL 抓取的 SSRF 出网边界

**文件：**

- Create: `src/server/sources/url-safety.ts`
- Modify: `src/server/sources/url-fetcher.ts`
- Create: `src/server/sources/__tests__/url-safety.test.ts`
- Modify: `src/server/sources/__tests__/url-fetcher.test.ts`
- Modify: `src/server/sources/__tests__/url-ingest.test.ts`
- Modify: `src/app/api/ingest/__tests__/route.test.ts`

**步骤：**

1. 先写失败测试：URL userinfo、私网/loopback/link-local/CGNAT/reserved IPv4、IPv6、IPv4-mapped IPv6 被拒绝，公开地址通过。
2. 先写 DNS 测试：全部公开结果通过；混合公私结果拒绝；连接 lookup 固定到已验证地址，后续 resolver 变化不能重绑定。
3. 先写重定向测试：手动跟随、相对 Location、最大 5 跳、public → private 拒绝，每跳重新校验 Host/SNI 与 DNS。
4. 先写 timeout、非文本 content-type、声明/实际体积与流式 5MB 上限回归。
5. 实现可注入 resolver/request transport 的 SSRF-safe fetch；禁止原生 `redirect:'follow'`，不新增运行时依赖。
6. 候选 URL 规范化使用同一模块的无网络语法/IP literal 校验；通用 `/api/ingest { urls }` 自动继承完整抓取守卫。
7. 运行：

   ```bash
   npx vitest run src/server/sources/__tests__/url-safety.test.ts src/server/sources/__tests__/url-fetcher.test.ts src/server/sources/__tests__/url-ingest.test.ts src/app/api/ingest/__tests__/route.test.ts
   npx tsc --noEmit
   ```

8. 提交：`fix(security): 收紧 URL 抓取出网边界`

## Task 2：定义 provenance 契约、数据表与迁移

**文件：**

- Modify: `src/lib/contracts.ts`
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/client.ts`
- Modify: `src/server/sources/source-store.ts`
- Create: `src/server/sources/source-ingest-transaction.ts`
- Modify: `src/server/sources/__tests__/source-store.test.ts`
- Create: `src/server/sources/__tests__/source-ingest-transaction.test.ts`
- Modify: `src/server/db/repos/sources-repo.ts`
- Modify: `src/server/db/repos/__tests__/sources-repo.test.ts`
- Create: `drizzle/0004_*.sql`（以 `npm run db:generate` 实际输出为准）
- Modify: `drizzle/meta/_journal.json`
- Create: `drizzle/meta/0004_snapshot.json`
- Create: `src/server/db/__tests__/research-provenance-migration.test.ts`
- Modify: `src/server/db/repos/subjects-repo.ts`
- Modify: `src/server/db/repos/__tests__/subjects-repo.test.ts`
- Modify: `src/app/api/reset/route.ts`
- Modify: `src/app/api/reset/__tests__/route.test.ts`
- Modify: `src/app/api/ingest/route.ts`
- Modify: `src/app/api/ingest/__tests__/route.test.ts`

**步骤：**

1. 先在 contracts 中定义 run/candidate/approval/delivery status、row/view 和 API 错误契约的失败编译测试或使用点。
2. 先写迁移失败测试：五张表、CHECK、复合 FK、`research_job_id/run_id/(run_id,normalized_url)/ingest_job_id` 唯一约束与热路径索引。
3. 增加 `research_runs`、`research_run_findings`、`research_candidates`、`research_approvals`、`research_candidate_ingests`；delivery 含 claim token/lease/attempt；candidate approval 与 delivery 两组关系都使用同 run 复合 FK。
4. 为 `sources(subjectId, contentHash, filename)` 增加唯一约束；迁移先稳定合并重复 source、引用与 loser sidecar；source store 并发 loser 清理自己的 sidecar 并复用 winner ID。
5. 用 `npm run db:generate` 生成 0004 迁移；同步 `client.ts::ensureTables` 幂等建表/索引，不能手写与 Drizzle 不同的约束。
6. 写旧库升级与新库初始化测试；未知 status/decision 被 CHECK 拒绝；finding 行包含原始 snapshot 与 verification status/snapshot。
7. 为 Subject 增加内部 `maintenance_state/mutation_epoch`；写 lease 领取、reset 原子 bump epoch、失败 finally 恢复 active 与 delete 后旧 lease 失效测试。
8. 新增 `persistSourceAndEnqueueIngest`：同一 `IMMEDIATE` transaction 校验 state/epoch，再完成 source 文件/sidecar/行与 ingest job INSERT；file/text/URL route 不再 save 后另行 enqueue。
9. 写跨请求竞态测试：URL 抓取等待期间 reset/delete 后，旧请求不得重建 raw/sidecar/source/job；source+job 先落地时 active guard 阻止 reset。
10. 写 Subject 删除/reset 测试：同一事务检查 active job 并 purge；subject active 或 `subject_id IS NULL` 全局 lint 时 409；无 active job 时清除全部 provenance；删除 Subject 的语义明确为删除历史。
11. 运行 DB、source、Ingest Route、Subject、reset 定向回归和 `npx tsc --noEmit`。
12. 提交：`feat(research): 定义批准溯源数据模型`

## Task 3：实现稳定身份、run 落地与原子批准仓储

**文件：**

- Create: `src/server/services/research-provenance.ts`
- Create: `src/server/db/repos/research-provenance-repo.ts`
- Create: `src/server/services/__tests__/research-provenance.test.ts`
- Create: `src/server/db/repos/__tests__/research-provenance-repo.test.ts`
- Modify: `src/server/services/research-scope.ts`
- Modify: `src/server/services/__tests__/research-service.test.ts`
- Modify: `src/server/services/research-service.ts`

**步骤：**

1. 先写纯函数失败测试：规范化 URL、candidate ID、candidate set hash、approval payload hash、canonical selection 与 snapshot 校验。
2. 先写 run repo 测试：researchJobId 幂等、finding snapshot、topics/queries/candidate 原子写入、相同 hash 重放、不同 hash 拒绝覆盖、Subject 隔离。
3. 让 `research-scope` 返回已验证 finding 的 ID + 可解释快照；手动 topic 保持无 finding。
4. `runResearchJob` 入口先按 researchJobId 恢复完整 run；命中时直接返回持久化 topics/queries/candidates，不重复 LLM/search；未命中才研究并先持久化后返回；无候选写 `empty`。
5. 先写 approval 并发测试：先拒绝重复 ID、canonical sort/hash，再查 `(runId,idempotencyKey)`；同 key/hash 幂等，不同 hash 409；不存在才检查 expectedVersion/候选归属。
6. 在同一个 `IMMEDIATE` transaction 内完成 approval、candidate decision、delivery、`research-import` job INSERT 和 coordinatorJobId 回写；禁止调用普通 `queue.enqueue` 假装原子。
7. 实现 dismiss CAS；已批准不可撤销，pending candidates 原子 rejected。
8. 运行 Research service、scope、repo 与哈希测试。
9. 提交：`feat(research): 持久化研究批次并原子批准`

## Task 4：提供 Research run 读取、批准与驳回 API

**文件：**

- Create: `src/server/services/research-approval-service.ts`
- Create: `src/server/services/__tests__/research-approval-service.test.ts`
- Create: `src/app/api/research-runs/[id]/route.ts`
- Create: `src/app/api/research-runs/[id]/approve/route.ts`
- Create: `src/app/api/research-runs/[id]/dismiss/route.ts`
- Create: `src/app/api/research-runs/[id]/__tests__/route.test.ts`
- Create: `src/app/api/research-runs/[id]/approve/__tests__/route.test.ts`
- Create: `src/app/api/research-runs/[id]/dismiss/__tests__/route.test.ts`

**步骤：**

1. 先写 view mapper 测试：candidate snapshot + decision + delivery、approval、finding 原始/验证 snapshot、verification job、稳定排序和 JSON 损坏降级。
2. GET 使用 `requireAuth + resolveSubjectFromRequest`；approve/dismiss 额外执行 `requireCsrf` 与 required Subject。
3. 批准 body 只允许 candidateIds/expectedVersion/idempotencyKey/subjectId；出现 URL、未知字段、重复/空 candidate 或跨 run ID 都拒绝。
4. 固定 202/200/400/404/409 状态和 `RESEARCH_*` 错误码；跨 Subject 与不存在统一 404。
5. GET 严格只读：不调用 reconciler、不推进状态、不入队；读取支持内部按 researchJobId 批量恢复，公开 API 仍以 run ID 为主；错误不泄露 URL 正文、绝对路径或 credential。
6. 运行三组 Route、service、auth/CSRF/subject 回归。
7. 提交：`feat(api): 提供 Research 批准与恢复接口`

## Task 5：实现候选级租约协调、Ingest lineage 与验证对账

**文件：**

- Create: `src/server/services/research-import-service.ts`
- Create: `src/server/services/research-provenance-reconciler.ts`
- Create: `src/server/services/__tests__/research-import-service.test.ts`
- Create: `src/server/services/__tests__/research-provenance-reconciler.test.ts`
- Modify: `src/server/db/repos/research-provenance-repo.ts`
- Modify: `src/server/db/repos/__tests__/research-provenance-repo.test.ts`
- Modify: `src/server/db/repos/operations-repo.ts`（仅在现有查询不足时）
- Modify: `src/server/jobs/worker.ts`
- Modify: `src/server/jobs/__tests__/worker.test.ts`
- Modify: `src/server/worker-entry.ts`
- Modify: `src/app/api/jobs/[id]/retry/route.ts`
- Modify: `src/app/api/jobs/[id]/retry/__tests__/route.test.ts`
- Modify: `src/app/api/jobs/[id]/cancel/route.ts`
- Modify: `src/app/api/jobs/[id]/cancel/__tests__/route.test.ts`
- Modify: `src/lib/tool-activity.ts`
- Modify: `src/components/shared/job-detail-dialog.tsx`
- Modify: `src/components/shared/progress-toast.tsx`

**步骤：**

1. 先写 delivery CAS 测试：pending/过期 fetching 可 claim；未过期不可；claim token/lease/attempt；旧 token 的续租、失败、source/job 回写全部拒绝。
2. 先写唯一入队测试：抓取后在同一 `IMMEDIATE` transaction 内重验 token，并完成 source get-or-create、sourceId、child ingest INSERT 与 delivery queued；source/ingestJobId 均唯一；handler 双重运行只产生一个 source/sidecar/child。
3. `research-import` job params 只接受 runId/approvalId/subjectId；URL 必须从服务端 snapshot 读取；每候选先 claim，再走 SSRF-safe fetch/source save/child enqueue，单条失败不阻断其他项。
4. child Ingest params 由服务端加入 `researchProvenance`；通用 Ingest route 仍不能接受客户端 provenance。
5. 先写 touched pages 物化测试：优先 Ingest result；损坏/缺失时回退 applied operations；slug 去重排序并标识系统页；保存 operation IDs/commit SHA。
6. 实现幂等 reconciler：同步 queued/running/terminal delivery，聚合 topic run；finding run 全部终态且至少一条成功时，用专用 `IMMEDIATE` CAS 一次性 INSERT verification lint + 回写 ID。
7. verification lint 完成后用 exact ID 或稳定 locus 保守匹配 residual，在 finding 行物化 `fixed/residual/unverifiable`、时间与 snapshot，再计算 run completed/partial/failed。
8. worker 只在 job 真正完成或最终失败后触发终态对账；coordinator 最终失败把未调度 delivery 终结为 failed；携带 research provenance 的 failed child 手动 retry 返回 409。
9. pending/running coordinator cancel 成功后 route 立即调用同一终态原语；维护 reconciler 扫描 terminal coordinator 补偿 cancel route/进程崩溃，覆盖两种取消测试。
10. worker 启动/维护 tick 补偿崩溃窗口，且对账必须先于 `pruneOldOperations`；hook/reconciler 错误只能记录，不能改写原 job 终态。
11. 注册 `research-import` handler 与事件展示，运行 coordinator/reconciler/worker/operations/retry/cancel 回归。
12. 提交：`feat(research): 串联候选导入与验证溯源`

## Task 6：接入 Health 候选审批、刷新恢复与 remediation 状态

**文件：**

- Modify: `src/components/health/research-candidates-dialog.tsx`
- Create: `src/components/health/__tests__/research-candidates-dialog.test.tsx`
- Modify: `src/components/health/remediation-ui.ts`
- Modify: `src/components/health/__tests__/remediation-ui.test.ts`
- Modify: `src/components/health/health-view.tsx`
- Modify: `src/server/services/remediation-status.ts`
- Modify: `src/server/services/__tests__/remediation-status.test.ts`
- Modify: `src/app/api/lint/latest/route.ts`
- Modify: `src/app/api/lint/latest/__tests__/route.test.ts`

**步骤：**

1. 先写 UI 失败测试：candidate ID 选择、score=3 默认勾选、approve body 无 URL、普通关闭不 dismiss、显式 dismiss、pending/importing/verifying/terminal 展示。
2. Research job 完成后从 `result.runId` GET run view；job result 只作为定位，不再作为批准事实；刷新/恢复按 researchJobId 批量找到同一 run。
3. `confirmIngest` 替换为专用 approve 调用，生成客户端 idempotency key 并在网络结果不确定时 GET run，不盲目重发不同 selection。
4. 批准后显示 coordinator/child delivery；终态与重连后 GET run 对账，并失效 pages、lint latest、active jobs 查询。
5. `buildHealthSnapshot` 保持纯函数：route 先批量读取相关 research run 摘要并作为 options 传入，避免函数内部 DB 查询和 N+1。
6. 映射 awaiting-approval/importing/verifying/completed/partial/failed/dismissed/empty；finding run 使用已物化逐 finding verification outcome；历史无 run 的 Research job 保留 resultJson fallback。
7. Subject/scope 切换取消旧请求、清理候选 view/idempotency key，禁止跨 Subject 状态串线。
8. 运行 dialog、remediation-ui/status、lint latest、Health 相关回归。
9. 提交：`feat(health): 接入 Research 批准与验证闭环`

## Task 7：文档、配置审计与全量验收

**文件：**

- Modify: `src/server/services/CLAUDE.md`
- Modify: `src/server/db/CLAUDE.md`
- Modify: `src/server/jobs/CLAUDE.md`
- Modify: `src/server/sources/CLAUDE.md`
- Modify: `src/app/CLAUDE.md`
- Modify: `src/components/CLAUDE.md`
- Modify: `src/lib/CLAUDE.md`
- Modify: `CLAUDE.md`
- Verify unchanged: `llm-config.example.json`

**步骤：**

1. 更新 Research、URL 抓取安全、五表模型、job 类型、API、Health 恢复与测试计数。
2. 扫描旧断链与安全漂移：

   ```bash
   rg -n "POST /api/ingest|confirmIngest|selectedUrls|redirect: 'follow'|research-import|researchProvenance" src docs
   rg -n "research_runs|research_candidates|research_approvals|research_candidate_ingests" src drizzle docs
   git diff --exit-code 3050509 -- llm-config.example.json
   ```

3. 运行：

   ```bash
   npx vitest run
   npx tsc --noEmit
   npm run lint
   npm run build
   ```

4. 执行整分支 spec review 与 code quality review，修复所有 blocker/important finding。
5. 确认通用 file/text/URL Ingest、Research queries/triage、Subject 删除/reset 与 worker retry 回归通过。
6. 提交：`docs: 同步 Research 批准溯源工作流`
7. 确认 worktree clean。

## Task 8：回合主分支并清理

1. 返回主工作区，确认 main 无未提交改动。
2. 执行：

   ```bash
   git merge --no-ff feat/research-approval-provenance-phase2c -m "merge: 合并 feat/research-approval-provenance-phase2c"
   ```

3. 在 main 上验证 merge tree 与已验收 feature tree 一致，并运行关键回归。
4. 删除 `.worktrees/research-approval-provenance-phase2c`，再删除特性分支。
5. 最终报告提交、测试、SSRF/配置审计结果与后续 Phase 2D 状态。
