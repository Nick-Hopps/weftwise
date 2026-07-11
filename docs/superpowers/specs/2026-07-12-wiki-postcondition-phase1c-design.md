# Wiki Fix / Curate 定向后置校验 Phase 1C 设计 Spec

日期：2026-07-12  
状态：已批准

## 一、目标

Phase 1C 为 Fix 与 Curate 补齐共享的定向后置校验闭环。模型或确定性流程完成写入后，系统不再只相信工具调用成功数，而是根据实际已应用的 Saga operation 推导影响范围，检查结构性不变量，并把结果写入 Job、SSE 和健康页。

```text
Fix / Curate 完成写操作
  → 按 jobId + subjectId 读取 applied operations
  → 从 changeset 提取实际创建、更新、删除页面
  → 执行共享确定性后置校验
  → Fix 按需执行一次定向语义复检
  → 生成 clean / residual 报告
  → 完成事件与 resultJson 持久化
```

本阶段支持：

1. 从实际 applied operations 收集本次 Job 的页面变更范围；
2. Fix 与 Curate 共用确定性结构校验器；
3. Fix 对 `contradiction` / `missing-crossref` 按条件执行一次结构化 LLM 复检；
4. 残留问题与校验失败以显式报告结束，不触发重复写入；
5. 健康页和 Job 详情展示校验过程与结果；
6. 保留 Fix 现有自动重新体检，用于刷新完整 Health findings。

## 二、非目标

本阶段不包含：

- 自动执行第二轮修复；
- 因后置校验残留而回滚已成功提交的 Saga；
- stable finding ID 与 Health remediation router；
- `wiki.metadata.patch`、`wiki.link.ensure` 或新的模型工具；
- 全 Subject LLM 复扫；
- Curate 语义复检；
- 新增 LLM task 或修改 `llm-config.example.json`；
- 改变 embedding 入队、Subject 隔离、Vault mutex、Git History 的现有语义。

## 三、当前差距

- `fix-service.ts` 和 `curate-service.ts` 只返回 guard 统计，无法证明写后状态满足预期；
- guard 的 `writes` 是执行计数，不是最终 Vault / SQLite 状态的权威证据；
- 同一个 Job 可产生多个 Changeset，且 Fix 的 frontmatter pre-pass 与工具循环走不同路径；
- `operations-repo.ts` 没有按 `jobId + subjectId + applied` 查询的接口；
- Fix 的语义 finding 只有自然语言描述，没有稳定 finding ID 或结构化目标，无法纯确定性判断是否修复；
- Health 页会在 Fix 完成后重新跑全量 lint，但这是一项独立异步任务，不能作为当前 Fix Job 的后置条件结果；
- Curate 完成后只刷新页面缓存，没有完成摘要或残留状态。

## 四、设计原则

1. **实际 operation 是影响范围的唯一真实源。** 不使用模型陈述、prompt 工作清单或 guard 计数推断写入结果。
2. **共享结构规则，不复制 lint 语义。** Fix 与 Curate 使用同一个确定性校验器；可复用既有 Wiki link 与 orphan 定义时不得重写另一套规则。
3. **定向而非全量。** 只检查本 Job 的实际变更页、删除页及其受影响入链来源。
4. **残留不是执行异常。** 写入已经成功时，后置条件不满足应作为 `completed + residual` 被明确报告。
5. **校验器不得写入。** 后置校验只读 Vault / SQLite，不调用写工具、不入队修复任务。
6. **语义复检有界。** 仅 Fix、仅原始语义 finding、仅发生实际写入时调用一次模型；模型无工具。
7. **失败时保守。** 无法完成校验不能伪装为 clean，也不能重复执行已提交写操作。
8. **UI 不隐藏不确定性。** clean、residual、语义失败必须有不同且可理解的呈现。

## 五、总体架构

```text
operations-repo
  └─ listAppliedForJob(jobId, subjectId)
       └─ operation-scope-collector
            └─ PostconditionScope
                 ├─ deterministic-postcondition-verifier
                 │    ├─ broken links
                 │    ├─ dangling incoming links
                 │    ├─ new orphan pages
                 │    └─ dangling page_sources
                 └─ fix-semantic-postcondition (Fix only, conditional)
                      └─ generateStructuredOutput('lint')

fix-service / curate-service
  └─ postcondition-service
       ├─ emit verify:start
       ├─ build report
       ├─ emit verify:complete
       └─ return result with postconditionStatus
```

主要新增模块：

- `src/server/services/operation-scope-collector.ts`：解析本 Job 的已应用 Changeset；
- `src/server/services/postcondition-verifier.ts`：共享确定性后置校验；
- `src/server/services/fix-semantic-postcondition.ts`：Fix 定向语义复检；
- `src/server/services/postcondition-service.ts`：报告编排、失败降级与事件数据；
- `src/components/health/postcondition-summary.ts`：将报告映射为健康页展示状态的纯函数或轻量组件。

实现时允许在不破坏职责边界的前提下合并过小文件，但 operation 收集、确定性检查、语义检查三类逻辑必须保持可独立测试。

## 六、Operation 影响范围

### 6.1 Repo 查询

`operations-repo.ts` 新增：

```ts
listAppliedForJob(jobId: string, subjectId: SubjectId): OperationRow[]
```

查询约束：

- `job_id = ?`；
- `subject_id = ?`；
- `status = 'applied'`；
- `post_head IS NOT NULL`；
- 按 `rowid ASC` 返回，保证与实际提交顺序一致；
- 不返回 `pending`、`rolled-back`、`reverted` 或其他 Job / Subject 的 operation。

### 6.2 Scope 收集

每行 `changeset_json` 必须使用 Zod 校验为 `ChangesetEntry[]`，不得直接信任数据库 JSON。路径通过现有页面身份辅助函数转换为当前 Subject slug；Subject 外路径、非法路径和非 Wiki 页面路径记录为 scope 解析错误，不进入页面集合。

```ts
interface PostconditionScope {
  jobId: string;
  subjectId: SubjectId;
  createdSlugs: string[];
  updatedSlugs: string[];
  deletedSlugs: string[];
  touchedSlugs: string[];
  operationIds: string[];
}
```

规则：

- 同一 slug 多次变化时，`touchedSlugs` 去重；
- `createdSlugs`、`updatedSlugs`、`deletedSlugs` 表示本 Job 曾执行过的动作，不尝试把多次动作压缩为伪造的单一最终动作；
- 校验器读取当前页面存在性决定最终状态；
- operation JSON 损坏、路径越界或 Subject 不一致必须转成 verification failure，不能静默忽略并返回 clean；
- 没有 applied operation 时返回空 scope，不依赖 guard 的 `writes` 值补造范围。

## 七、共享确定性后置校验

### 7.1 输入与输出

```ts
interface DeterministicPostconditionInput {
  subject: Subject;
  scope: PostconditionScope;
}

interface PostconditionFinding {
  type:
    | 'broken-link'
    | 'dangling-incoming-link'
    | 'orphan-page'
    | 'dangling-page-source'
    | 'contradiction'
    | 'missing-crossref'
    | 'verification-error';
  severity: 'critical' | 'warning' | 'info';
  pageSlug: string | null;
  description: string;
  relatedSlugs?: string[];
}
```

所有 finding 按 `type + pageSlug + description` 稳定排序并去重，保证 resultJson 和测试可复现。错误描述不得包含绝对路径、完整正文、LLM credential 或 source chunk。

### 7.2 检查范围与规则

确定性校验一次读取必要的 pages、links 与 page_sources 快照，然后执行：

1. **受影响存活页的失效链接**
   - 检查当前仍存在的 `touchedSlugs` 的出链；
   - 同 Subject 与跨 Subject 目标均使用现有 wikilink 解析 / page identity 语义；
   - 目标不存在时产生 `broken-link`。

2. **删除后的悬空入链**
   - 对 `deletedSlugs` 中当前确实不存在的页面查找所有入链；
   - 包含当前 Subject 与跨 Subject 来源；
   - 来源仍存在且链接仍指向删除目标时产生 `dangling-incoming-link`；
   - 这覆盖 merge、split、delete 未完整 relink 的残留。

3. **新孤立页面**
   - 只检查 `createdSlugs` 中当前仍存在、非 meta 的页面；
   - 沿用现有 lint 的 orphan 定义：没有任何同 Subject 或跨 Subject 入链；
   - 产生 `orphan-page`，不把历史无关孤立页纳入本报告。

4. **悬空 page_sources**
   - 检查 scope 中页面相关的 `page_sources` 行；
   - page 不存在、source 不存在或 source 不属于当前 Subject 时产生 `dangling-page-source`；
   - 删除页的残留关联必须纳入；
   - 只读检查，不在校验阶段自动清理脏行。

结构检查不调用全量 `runDeterministicChecksForSubject()`，避免把无关历史 finding 混入本 Job；但应提取或复用其纯规则，保持 broken-link 与 orphan 语义一致。

## 八、Fix 定向语义复检

### 8.1 触发条件

同时满足以下条件才调用模型：

1. 当前服务是 Fix；
2. Fix 初始工作清单包含 `contradiction` 或 `missing-crossref`；
3. scope 至少包含一个 applied operation。

没有实际写入时不调用模型；空 scope 表示本 Job 没有产生需要验证的状态变化，因此后置结果为 clean。原语义 finding 仍保留在 Health 快照和 Fix skipped 统计中，不重复写入本 Job 的 postcondition。纯 `missing-frontmatter` / `broken-link` Fix 也不调用模型。

### 8.2 模型调用

- 使用 `generateStructuredOutput('lint', ...)`，复用现有 lint 模型路由与 usage 记账；
- 不新增 LLM task，不更新 `llm-config.example.json`；
- 单次调用，不提供任何工具；
- 新增窄 Schema，只允许对传入原 finding 返回 `resolved` 或 `residual` 及简短理由；
- 输入包含原 finding、实际触达页当前内容，以及判断该 finding 所必需的相关页内容；
- 单页正文沿用 lint 的字符上限，整体输入必须有界；
- 超出本次复检 finding / 页面 / 字符上限的条目不丢弃，直接保守标记为 residual；
- 模型不得发现和扩展新的 coverage gap，本阶段只复检原 finding；
- 输出缺项、重复项或未知项按 residual 处理。

由于 Phase 1C 尚无 stable finding ID，调用前为每个原 finding 计算本次复检内部 ID：

```text
sha256(type + "\0" + pageSlug + "\0" + description)
```

该 ID 只用于单次请求 / 响应关联，不持久化为未来 remediation ID，也不宣称跨 lint 运行稳定。

### 8.3 失败降级

模型异常、取消、Schema 无效或上下文读取失败时：

- `semanticStatus = 'failed'`；
- 原语义 findings 全部保守转为 residual；
- 错误写入安全化 `verificationError`；
- 不抛出导致 worker 重试的异常；
- 不重新调用 Fix 工具循环。

## 九、报告契约

共享领域类型放入 `src/lib/contracts.ts`：

```ts
type PostconditionStatus = 'clean' | 'residual';
type PostconditionSemanticStatus =
  | 'not-needed'
  | 'clean'
  | 'residual'
  | 'failed';

interface PostconditionReport {
  status: PostconditionStatus;
  checkedAt: string;
  scope: PostconditionScope;
  residualFindings: PostconditionFinding[];
  semanticStatus: PostconditionSemanticStatus;
  verificationError: string | null;
}
```

Fix / Curate 保留现有结果统计，同时新增：

```ts
{
  ...existingTotals,
  postconditionStatus: report.status,
  postcondition: report,
}
```

顶层 `postconditionStatus` 满足原治理 Spec 的稳定消费要求；完整报告集中在 `postcondition`，不把 findings 重复存两份。

状态判定：

- 无 residual 且无 verification error：`clean`；
- 任一 residual 或任一校验阶段失败：`residual`；
- 空 scope 且无错误：`clean`，`semanticStatus = 'not-needed'`；
- Curate 永远使用 `semanticStatus = 'not-needed'`。

## 十、服务接入与执行顺序

Fix / Curate 的顺序固定为：

```text
完成现有写操作
  → 保持现有 embedding enqueue 条件
  → emit <service>:verify:start
  → 读取 applied operations 并执行校验
  → emit <service>:verify:complete
  → emit <service>:complete（带 postconditionStatus / residualCount）
  → return result（带完整 postcondition）
```

Fix 必须在构建工作清单时保留本轮语义 findings，供写后复检使用。Curate 的“候选不足，无操作”早退路径也必须生成空 scope clean 报告，不能继续返回旧的不完整结果。

后置校验不位于 Vault mutex 内：所有写操作已经通过各自 Saga 完成；校验读取的是写后当前状态。若校验期间又发生其他合法提交，报告反映读取时状态，`checkedAt` 记录完成时间。本阶段不引入跨整个 Job 持锁。

## 十一、失败语义

### 11.1 残留问题

- residual finding 不抛异常；
- Job 最终状态仍为 `completed`；
- `postconditionStatus = 'residual'`；
- 不自动 rollback，不自动重试，不自动新建 Fix Job。

### 11.2 校验基础设施异常

operation JSON 损坏、DB 查询失败、Vault 读取失败或确定性校验器异常时：

- 捕获并生成 `verification-error` finding；
- `verificationError` 保存安全化摘要；
- Job 仍以 `completed + residual` 结束，避免 worker 将整个已写入 Job 重新排队并重复修改；
- 原有写入计数和 operation / History 继续保留。

只有发生在原有写入流程中的错误继续沿用现有 worker 失败 / 重试语义；“写操作尚未成功”与“写后验证发现残留”必须严格区分。

### 11.3 取消

若用户取消发生在写入阶段，沿用现有行为。进入后置校验后不再开启新的写操作；语义复检应继续接入 `queue.isCancelRequested(job.id)`。取消导致语义复检未完成时按 `semanticStatus = 'failed'` 保守报告，不重放写入。

## 十二、SSE 与健康页

新增命名事件并注册到 `use-job-stream.ts`：

```text
fix:verify:start
fix:verify:complete
curate:verify:start
curate:verify:complete
```

完成事件 data 至少包含：

```ts
{
  postconditionStatus: 'clean' | 'residual';
  residualCount: number;
  semanticStatus: PostconditionSemanticStatus;
  postcondition: PostconditionReport;
}
```

Health UI：

- Fix / Curate clean：绿色提示“后置校验通过，未发现残留问题”；
- residual：黄色提示，展示残留数量、语义状态和前几项摘要；
- semantic failed：明确说明结构检查已完成、语义复检失败、相关问题需人工确认；
- Fix 现有自动重新体检继续执行，用于刷新完整 findings 列表；
- Curate 增加完成摘要，并继续刷新 pages / lint-latest 缓存；
- Job 详情复用现有事件时间线，不新增第二条 SSE 或独立详情接口；
- UI 文案不得把 `completed + residual` 渲染为完全成功或执行失败。

## 十三、测试策略

### 13.1 Operation scope

- 只返回当前 `jobId + subjectId` 的 applied operations；
- 忽略 pending、rolled-back、reverted、其他 Job 和其他 Subject；
- 多 Changeset 按提交顺序合并并去重 slug；
- create/update/delete 路径解析正确；
- JSON 损坏、Subject 越界和非法 Wiki 路径不会静默返回 clean。

### 13.2 确定性校验

- 受影响存活页的同主题 / 跨主题 broken link；
- 删除、merge、split 后仍存在的悬空入链；
- 新建页无入链时报 orphan，历史无关 orphan 不进入报告；
- 悬空 page_sources 的 page 缺失、source 缺失和 Subject 错配；
- meta 页排除、结果去重与稳定排序；
- 空 scope 返回 clean。

### 13.3 Fix 语义复检

- 只有语义 finding 且发生实际相关写入时调用一次 LLM；
- 使用 `lint` 路由，不提供工具；
- 无写入、纯确定性 finding、Curate 均不调用；
- resolved / residual 映射正确；
- 缺项、未知项、Schema 错误、模型异常和取消均保守 residual；
- 不产生 coverage-gap 或新 finding。

### 13.4 服务集成

- Fix / Curate 所有返回路径都有 `postconditionStatus`；
- 完成事件含完整报告和 residual 数量；
- residual 与 verification error 不让 Job 进入 failed / retry；
- 校验失败不触发第二次写入、rollback 或 embedding enqueue；
- Fix 自动重新体检行为不变；
- Curate 少于两个候选页的早退路径返回 clean 报告。

### 13.5 UI

- clean、residual、semantic failed 映射为不同提示；
- Fix / Curate verify 事件可被 SSE hook 接收；
- residual 摘要有界，不能把完整正文带入 UI；
- 现有 Job 详情仍使用同一 events/status 数据源。

## 十四、验收标准

1. Fix 和 Curate 的所有成功结果都包含顶层 `postconditionStatus` 与完整 `postcondition`；
2. 影响范围只来自当前 Job / Subject 的 applied operations；
3. 写后 broken link、删除目标悬空入链、新 orphan 与悬空 page_sources 可被定向发现；
4. Fix 语义 finding 仅在必要时复检一次，且复用 `lint` 配置；
5. residual 与校验异常均以 `completed + residual` 显式呈现，不重复写入；
6. Health 页可区分 clean、residual 与语义失败；
7. `llm-config.example.json` 不发生变化；
8. 新增测试通过，且全量 Vitest、ESLint、TypeScript 与生产构建通过；
9. Subject 隔离、Saga、Vault mutex、SQLite 索引、embedding 与 Git History 不变式保持不变。

## 十五、已考虑并否决的替代

### 15.1 写后重跑完整 lint

否决。完整 lint 会扫描无关历史问题，并执行昂贵且非确定的全 Subject 语义分析，无法准确表达“本 Job 是否留下残留”。Fix 完成后的自动 lint 可继续用于刷新健康页，但不是当前 Job 的 postcondition。

### 15.2 Fix 与 Curate 各自复制校验规则

否决。broken-link、orphan 与 page identity 语义会随时间漂移，两套实现容易产生互相矛盾的结果。

### 15.3 完全确定性验证 Fix 语义 finding

否决。当前 `LintFinding` 只有自然语言描述，`contradiction` / `missing-crossref` 缺少结构化目标与稳定 ID，纯规则无法可靠判断修复结果。Phase 1C 使用一次有界复检，stable finding ID 留给 Phase 2。

### 15.4 residual 直接让 Job failed

否决。此时 Saga 与 Git commit 已成功，worker retry 可能重复执行工具写入。应把执行状态与质量状态拆开：Job `completed`，postcondition `residual`。

### 15.5 residual 自动回滚

否决。多个 Changeset 可能已经提交，后置 finding 也不等于所有写入都无效。自动回滚会丢弃有效修改，并可能与后续合法提交冲突。

## 十六、影响文件预估

```text
src/lib/contracts.ts
src/server/db/repos/operations-repo.ts
src/server/db/repos/__tests__/operations-repo.test.ts
src/server/services/operation-scope-collector.ts                 # 新增
src/server/services/postcondition-verifier.ts                    # 新增
src/server/services/fix-semantic-postcondition.ts                # 新增
src/server/services/postcondition-service.ts                     # 新增
src/server/services/fix-service.ts
src/server/services/curate-service.ts
src/server/services/__tests__/operation-scope-collector.test.ts  # 新增
src/server/services/__tests__/postcondition-verifier.test.ts     # 新增
src/server/services/__tests__/fix-semantic-postcondition.test.ts # 新增
src/server/services/__tests__/fix-service.test.ts
src/server/services/__tests__/curate-service.test.ts
src/hooks/use-job-stream.ts
src/hooks/__tests__/job-stream-logic.test.ts
src/components/health/postcondition-summary.ts                   # 新增或并入 health-view
src/components/health/health-view.tsx
src/components/health/__tests__/postcondition-summary.test.ts    # 新增
src/server/services/CLAUDE.md
src/server/db/CLAUDE.md
src/components/CLAUDE.md
```

明确不修改：

```text
llm-config.example.json
src/server/agents/tools/**
src/server/agents/skills/**
```
