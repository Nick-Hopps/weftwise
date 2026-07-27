# 实现计划：批量 Research 拆分为单主题 job + 处置动作互不阻塞

设计稿：`docs/specs/2026-07-27-research-batch-per-topic-jobs.md`

每个任务独立可测、可评审，完成即提交一次。顺序遵循「并存加新 → 原子切换 → 删旧」，每步结束系统都能跑。

---

## T1 服务端按主题拆 job + 响应契约切换

**目标**：一次 research 请求创建 N 个单主题 job；同一提交内把前端读值改到新契约，保持可运行（research 暂时仍只跟踪首个 job，行为与今天等价）。

**涉及文件**
- `src/server/services/remediation-service.ts`：新增 `MAX_RESEARCH_BATCH_JOBS = 10`；research 分支改为逐 finding 创建；`assertWebSearchConfigured()` 提到循环之前调用一次；返回 `{ jobIds, deduplicated }`
- `src/app/api/health/remediations/route.ts`：透传新返回值（202 不变）
- `src/components/health/health-view.tsx`：`runRemediation` 读 `jobIds`，取 `jobIds[0]` 喂给现有单 job 状态机
- `src/server/services/__tests__/remediation-service.test.ts`：新增用例
- `src/app/api/health/remediations/__tests__/route.test.ts`：断言新响应形状

**失败测试先写**
1. 3 个 coverage-gap findingIds + action=research → 返回 3 个 jobId，每个 job 的 `params.findingIds` 与 `remediationContext.findingIds` 长度均为 1，三者并集等于请求集合
2. 11 个 findingIds + action=research → 400 `invalid-research-batch`，且**零** job 被创建
3. web search 未配置 + 3 个 findingIds → 抛配置错误，且**零** job 被创建（回归：不能创建了 1 个才发现没配）
4. 同一批重复请求两次 → 第二次全部复用既有 job，`deduplicated === true`
5. fix / curate / re-ingest → `jobIds` 长度恒为 1，语义不变

**验证**
```
npx vitest run src/server/services/__tests__/remediation-service.test.ts src/app/api/health/remediations/__tests__/route.test.ts
```

**提交**：`feat: 批量研究按主题拆分为独立 job`

---

## T2 前端多 job 跟踪：busy 派生、Stop 整批、刷新恢复

**目标**：research 从「一次一个 job」变成「一批 N 个 job」，锁的获取/释放与取消都以整批为单位。

**涉及文件**
- `src/components/health/remediation-ui.ts`：`selectRecoverableHealthJobs` 返回值改 `Partial<Record<Action, RecoverableHealthJob[]>>`；`blockingRecoverableActions` 适配数组
- `src/components/health/health-view.tsx`：
  - `researchJobId: string | null` → `researchBatchRef = { jobIds: Set<string>, origin }` + `researchJobIds` state
  - remediation 来源的 research **不再用 `useJobStream` 判完成**：改由 `health-active-jobs` 轮询 + `persistedBusyActions` 推导；批内 jobId 全部离开 active 列表即释放锁并失效 `lint-latest`
  - `cancelHealthAction('research')` 对批内每个 jobId 并发 cancel（`Promise.allSettled`，409 幂等）
  - 手动 / backlog 来源保留原单 job SSE 链（`ResearchJobMeta.source !== 'remediation'`）
- `src/components/health/__tests__/remediation-ui.test.ts`

**失败测试先写**
1. `selectRecoverableHealthJobs`：3 个 active research job → research 槽位返回 3 条，不是「最新 1 条」
2. 同上，fix/curate/re-ingest 仍各返回长度 1 的数组
3. `blockingRecoverableActions`：数组中任一 `blocksAction` 为 true 即锁住该 action
4. research 槽位同时有 active job 与 `awaiting-approval` 快照 plan → 不重复计入同一 jobId

**验证**
```
npx vitest run src/components/health/__tests__/remediation-ui.test.ts
```
手工：造 3 条 coverage-gap → 点批量 → JobsPanel 三行排队 → 刷新页面按钮仍为 Stop → Stop 后三行全部 cancelled。

**提交**：`feat: Health 研究动作按批跟踪与整批取消`

---

## T3 审批入口移进 finding 行，remediation 来源不再自动弹窗

**目标**：`awaiting-approval` 的 finding 行出现 `Review candidates`，点击才加载 run；批量完成不再劫持焦点。

**涉及文件**
- `src/lib/contracts.ts`：`RemediationPlan` 新增 `runId?: string`
- `src/server/services/remediation-status.ts`：`applyCurrentJob` 把命中的 `run.id` 写入 plan
- `src/components/health/finding-row.tsx`：plan 有 `runId` 且 `status === 'awaiting-approval'` 时渲染 `Review candidates` 按钮，回调上抛 `runId`
- `src/components/health/health-view.tsx`：新增 `openResearchRun(runId)`（直接 `GET /api/research-runs/:id`，不再经 `GET /api/jobs/:id` 取 `result.runId`）；删除 remediation 来源的「完成→自动 setCandidateResult」分支
- `src/server/services/__tests__/remediation-status.test.ts`、`src/components/health/__tests__/remediation-ui.test.ts`
- i18n：`zh-CN.ts` / `en.ts` 新增 `health.reviewCandidates`

**失败测试先写**
1. 快照构建：research job 有对应 run 时，`remediations[findingId].runId === run.id`；无 run 时字段缺失
2. `runId` 只在 research workflow 上出现，fix/curate plan 不带
3. finding-row：`awaiting-approval` + 有 `runId` → 渲染入口；缺 `runId` → 不渲染（不猜测）

**验证**
```
npx vitest run src/server/services/__tests__/remediation-status.test.ts src/components/health/__tests__
```
手工：批量跑完 → 无弹窗自动出现 → 三行各自 `Needs action` → 点开任一行审批 → 其余两行不受影响。

**提交**：`feat: 研究候选审批入口下沉到 finding 行`

---

## T4 整理 / 修复 / 研究三个按钮解耦

**目标**：三者互不阻塞，点击即入队；单按钮自身 in-flight 仍禁用防重复提交。

**涉及文件**
- `src/components/health/health-view.tsx`：删除 curate 的 `|| running || fixing`、fix 的 `|| running || curating`
- `src/components/health/__tests__/remediation-ui.test.ts`：把禁用条件抽成纯函数 `remediationButtonDisabled({ neverRun, targetCount, busy })` 并单测（当前禁用逻辑内联在 JSX 里，测不到）

**失败测试先写**
1. curate 忙时 fix 按钮不禁用；fix 忙时 curate 不禁用
2. lint 运行中三个按钮均不禁用
3. 自身 busy / `neverRun` / 目标数为 0 时仍禁用

**验证**
```
npx vitest run src/components/health/__tests__/remediation-ui.test.ts
```
手工：连点整理 + 修复 + 研究 → JobsPanel 三类任务依次排队执行，无一被拒。

**提交**：`feat: Health 三个处置动作改为互不阻塞的排队`

---

## T5 全量回归与文档

**涉及文件**
- `src/components/CLAUDE.md`（health 段 + 变更记录）
- `src/server/services/CLAUDE.md`（若存在 remediation/research 段）
- `CHANGELOG.md`

**验证**
```
npx vitest run
npm run lint
```

**提交**：`docs: 同步批量研究拆分与动作解耦的模块文档`（与 feat 提交成对）

---

## 风险与回滚

- **T1 的部分创建**：逐个创建 job 无补偿事务；若中途基础设施异常，已创建 job 保留并正常执行，用户重试由 `findDuplicateRemediationJob` 复用——不会重复排队。
- **T2 去掉 research SSE 依赖**：完成判定改为 5s 轮询，最坏情况锁释放延迟 5 秒；换来的是不必为 N 个 job 建 N 条 SSE。
- **T4 陈旧 baseline**：lint 运行中入队的处置动作用的是旧 `lintJobId`。请求期由 `remediate` 的 409 `stale-snapshot` 守住；执行期 finding ID 是内容哈希，仍存在的 finding 照旧匹配，已消失的进入「近期结果」。
- 每个任务独立提交，回滚粒度为单 commit。
