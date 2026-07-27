# 批量 Research 拆分为单主题 job + 处置动作互不阻塞

- 日期：2026-07-27
- 分支：`worktree-feat+research-batch-per-topic-jobs`
- 相关代码：`src/server/services/remediation-service.ts`、`src/server/services/remediation-status.ts`、`src/components/health/{health-view,remediation-ui,finding-row}.tsx`

## 目的

Health 工具栏的批量「研究」按钮**收集范围是全的**（快照里所有 coverage-gap / thin-page），但**执行是被稀释的**：N 个主题合成一个 research job，而整个 job 只有一份固定预算——`MAX_QUERIES = 3`、`MAX_CANDIDATES = 12`、`MAX_RESULTS = 6`（`src/lib/research-plan.ts:8-10`）。

稀释的具体路径：

1. `dedupeQueries` 把 LLM 生成的 query 截到 3 条（`research-service.ts:244`）。prompt 要求「1-2 queries per topic」（`research-prompt.ts:20`），5 个主题就只有前 2-3 个主题拿到 query。
2. `dedupeCandidates` 对**压平后的**候选列表先到先得截到 12 条（`research-plan.ts:51`），而候选是按 query 顺序 push 的——前面主题的检索结果吃掉全部槽位。
3. `applyTriage` 再全局取 top 6，最终审批面上几乎只剩靠前主题的候选。
4. 尾部主题的 finding 因为 `verificationStatus !== 'fixed'` 被判 `failed`（`remediation-status.ts:335-337`），从开放列表移进「近期结果」，**静默消失**，要等下一次 lint 才重新出现。

同时，工具栏三个处置按钮当前互相锁死：「整理」被 `running || fixing` 禁用、「修复」被 `running || curating` 禁用（`health-view.tsx:1272-1299`）。这是纯前端限制——worker 对非 ingest 任务本来就串行独占（`worker.ts:208-215` `decideClaim`），vault 写入另有 vault-mutex 保护，所以排队执行本身是安全的，禁用只是让用户白等。

## 约束

### 已定的决策（盘问结论）

1. **拆分粒度**：1 个主题 = 1 个 finding = 1 个 research job = 1 个 provenance run。不合批。
2. **单次上限 10**：批量按快照顺序（已按严重度分组排序）取前 10 条，按钮显示 `Research (10 / 23)`，剩余留给下一次点击。
3. **审批入口移到 finding 行内**：不再自动弹候选弹窗；`awaiting-approval` 的 finding 行上出现 `Review candidates`，点开才加载该 run。
4. **research 保持单锁**：批量期间 backlog 逐条按钮与手动 topic 输入框继续禁用；工具栏 Stop 取消**整批**（running + 剩余 pending）。
5. **三个处置按钮互不阻塞**：整理 / 修复 / 研究只受各自 in-flight 门控，触发后交给 worker 排队。

### 技术约束

- 非 ingest job 由 worker 串行独占执行，拆出的 N 个 job 自动排队，不会打爆 web search 配额；但批量期间 lint/fix/ingest 全部等待，这是接受的代价（上限 10 就是为它设的）。
- `GlobalJobTracker` / `JobsPanel` 已是多 job 聚合面板，pending 行显示 Queued——**进度呈现无需改动**，也已提供行级取消。
- 「一 job 一 run」是 provenance 现有假设（`persistResearchRun` 按 `researchJobId` 落库）。1 主题/job 与它完全兼容，**provenance 层不改**。
- 手动 topic 与 backlog 的 research 不对应任何 finding 行，必须**保留**「完成后自动打开候选弹窗」这条链，否则候选无处审批。区分依据是已有的 `ResearchJobMeta.source`。
- 拆分后逐个创建 job 不做补偿事务：`findDuplicateRemediationJob` 保证重试时复用既有 job 而非重复排队，部分创建成功后用户重试是安全的。
- Web search 未配置时不能留下「配置缺失但已排了 3 个 job」的状态。检查**保持在 per-job `beforeCreate`** 里：首个创建尝试就会抛出，零 job 被创建；同时保住既有的刻意行为——一批全部命中 duplicate 时根本不校验配置（`remediation-service.test.ts` 已锁定 `isWebSearchConfigured` 不被调用），in-flight job 不因配置变化被拒。

## 成功标准

### 行为

1. 快照有 N（≤10）条可研究 finding 时，点批量研究创建 **N 个** research job，每个 job 的 `remediationContext.findingIds` 长度为 1；N > 10 时只启动前 10 个，按钮标注剩余条数。
2. 每个 job 的 3 条 query / 12 个候选 / 6 个结果预算**完整服务于单个主题**——不再有主题拿不到 query。
3. 每个 finding 的行内状态独立推进：Queued → Researching → Needs action（`Review candidates`）→ 批准后 Queued（importing/verifying）→ 终态。审批弹窗只在点击行内入口时打开。
4. 工具栏 Stop 取消整批：批内所有 pending + running job 都被取消，409 按已终态幂等收敛；取消后 research 锁释放，按钮回到 idle。
5. 刷新页面后，批内仍在 pending/running 的 job 全部被恢复为 busy（不是只恢复最新一个），`awaiting-approval` 的行内入口照旧可用。
6. 「整理」「修复」「研究」三个按钮任意组合可连续点击，各自入队；单个按钮在自身 in-flight 期间仍禁用（防重复提交）。lint 运行中不再阻塞三者。
7. 手动 topic 与 backlog 逐条 research 行为不变（仍自动弹候选弹窗）。

### 不做

- 不改 `MAX_QUERIES` / `MAX_CANDIDATES` / `MAX_RESULTS` 的数值（单主题下 3 条 query 已够，放大属于另一个质量调优议题）。
- 不做候选到主题的归因（1 主题/job 后天然一一对应，triage prompt 无需带主题归属）。
- 不开放批量上限的 Settings 配置项（YAGNI，先验证手感）。
- 不放开 research 单锁，不支持批量期间追加 backlog research。

### 验证

- `npx vitest run src/server/services/__tests__/remediation-service.test.ts src/components/health/__tests__/remediation-ui.test.ts`（新增用例覆盖拆分数量、上限拒绝、零 job 创建、dedup 复用、多 job 恢复、按钮禁用矩阵）
- `npx vitest run`（全量回归，2844 用例基线）
- `npm run lint`
- 真实环境走一遍：造 ≥3 条 coverage-gap → 点批量研究 → JobsPanel 出现 3 个排队 job → 逐行审批 → Stop 中途取消。

## 契约变更

| 位置 | 变更 |
|------|------|
| `POST /api/health/remediations` 响应 | `{ jobId, deduplicated }` → `{ jobIds: string[], deduplicated: boolean }`（非 research 动作恒为长度 1；`deduplicated` 表示**全部**为复用） |
| `remediate()` 返回值 | 同上 |
| `RemediationPlan` | 新增可选 `runId?: string`——research 计划直接带上 provenance run ID，行内入口无需再走 `GET /api/jobs/:id` 取 `result.runId` |
| `selectRecoverableHealthJobs()` 返回值 | `Partial<Record<Action, RecoverableHealthJob>>` → `Partial<Record<Action, RecoverableHealthJob[]>>`（research 可多个，其余长度 1） |
| `MAX_RESEARCH_BATCH_JOBS` | 新增服务端常量 = 10；research 动作收到 > 10 个 findingIds 时 400 `invalid-research-batch`（上限是资源边界，不能只靠 UI 好意） |

## 取舍记录

- **为什么不是「按主题公平分配」**（改 query schema 带主题归属 + 候选轮询截断）：那样仍是一个 job 一个 run，`run.findings` 含多条 finding，候选到 finding 的归因依旧靠后续 verification lint 反推；1 主题/job 把归因变成结构性事实，且反而**不需要**动 provenance 与审批弹窗的语义。
- **为什么不自动弹审批弹窗**：串行执行 10 个 job 会在几十分钟内陆续完成，自动弹窗会反复劫持焦点，且弹窗期间看不到其他 finding 的进展。
- **为什么保留 research 单锁**：放开需要把 action gate 从「每 action 单锁」改成「每 job 集合」，并重新定义 `persistedBusyActions` / `selectRecoverableHealthJobs` 的归属，收益只是批量期间能追加 backlog 条目——不值当。
- **为什么删掉 fix ↔ curate 互斥是安全的**：worker `decideClaim` 保证同时只跑一个非 ingest job；`perFindingOutcomes` 按 finding 归因，两者结果互不覆盖；postcondition 各自以 `context.lintJobId` 为 baseline，`completedAfterSnapshot` 独立成立。
