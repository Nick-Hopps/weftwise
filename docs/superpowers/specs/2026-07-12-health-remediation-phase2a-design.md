# Wiki Health Remediation Phase 2A 设计 Spec

日期：2026-07-12

状态：已批准

## 一、目标

Phase 2A 为 Health findings 建立稳定身份、统一处置路由和显式状态闭环。Lint 继续只负责发现问题；用户在 Health 页面明确选择动作后，服务端才把 finding 路由到 Fix、Curate、Research、Re-ingest 或来源人工检查，并在任务参数中保留来源 lint job 与 finding IDs。

```text
lint finding
  → 生成稳定 finding ID
  → remediation-router 生成 workflow / action / status
  → Health 展示逐条与批量处置入口
  → 用户明确触发
  → 服务端重新校验最新 lint 快照
  → 委托既有 workflow
  → job.paramsJson 记录 remediationContext
  → 新 lint 快照判断 fixed / residual
```

本阶段支持：

1. 新 lint 快照直接保存稳定 finding ID；旧快照读取时确定性补算；
2. 九类 Health finding 全部获得明确 workflow、状态、动作和原因；
3. 新增统一 remediation API，按最新快照和 subject 在服务端校验动作；
4. Fix、Curate、Research、Re-ingest 任务记录来源 lint job 与 finding IDs；
5. Health 的逐条动作与批量动作共用同一服务端路由契约；
6. Research 不再用 findings 数组下标定位 coverage gap；
7. 任务完成后重新运行 lint，并显式展示 fixed、awaiting-approval、skipped 或 failed 结果。

## 二、非目标

本阶段不包含：

- lint 完成后自动执行写入、LLM、联网研究或摄入任务；
- 新增 remediation job 类型或 remediation 数据库表；
- Research 候选批准 → Ingest → touched pages 的完整 provenance 链；该部分留给 Phase 2C；
- `wiki.metadata.patch`、`wiki.link.ensure` 或其他新模型工具；
- 修改 Fix / Curate 的 Saga、Vault mutex、Git 提交和 Phase 1C 后置校验语义；
- orphan 自动删除或 orphan-source 无确认删除；
- 对 LLM 不同措辞的 findings 做模糊语义身份匹配；
- 新增 LLM task、prompt、模型路由或修改 `llm-config.example.json`；
- 数据库 schema 迁移。

## 三、当前差距

1. `EnrichedLintFinding` 没有 ID，Health 与 Research 只能把 finding 在数组中的下标当作 `gapId`；筛选、顺序变化或新快照都会使引用漂移。
2. `fix-deterministic.ts::partitionFindings()` 把 orphan、stale-source、coverage-gap、orphan-source、thin-page 统一放进 `ignored`，没有解释负责的工作流。
3. Health UI 自行维护 `FIXABLE_TYPES`、coverage gap 下标、thin-page Research 和 orphan-source 动作，服务端没有统一路由契约。
4. `/api/fix` 只能处理当前 subject 的全部可修 finding，无法消费用户明确选择的 finding scope。
5. `/api/research` 的 `gapIds` 是十进制数组下标，`research-service` 重新按索引解析最近快照。
6. 现有 jobs 没有统一记录是由哪次 lint 的哪些 findings 触发，刷新页面后无法可靠恢复 remediation 状态。
7. stale-source finding 没有 `sourceId`，只能从自然语言描述看出文件名，不能安全驱动来源动作。

## 四、设计原则

1. **Lint 只发现，不处置。** 任何有成本或副作用的操作都必须由用户明确触发。
2. **服务端是路由与授权的唯一真实源。** UI 只渲染服务端给出的 actions，不复制 finding 类型白名单。
3. **稳定引用不依赖数组位置。** finding ID 必须能跨排序、筛选、序列化和旧快照读取保持一致。
4. **Subject 隔离必须端到端成立。** ID、快照校验、job 和 workflow 均绑定 subject。
5. **复用现有 workflow。** Router 不写 Vault、不访问数据库、不创建任务；API 编排层委托既有 service/helper。
6. **无安全动作时显式 skipped。** 不得把未处理 finding 静默忽略，也不得为满足闭环而冒险写入。
7. **状态由事实推导。** job 状态、任务结果与后续 lint 快照共同决定处置结果，不相信客户端声明。
8. **破坏性动作保持专用确认。** orphan 不自动删除；orphan-source 删除继续使用专用端点和二次确认。

## 五、方案选择与总体架构

采用“契约优先的纯路由器”方案，不新增任务套任务或持久化状态表。

```text
finding-identity                    remediation-router（纯函数）
       │                                      │
       ├─ lint-service 写新快照 ID             ├─ workflow
       └─ lint-latest 补旧快照 ID              ├─ actions
                                              └─ initial status
                │
                ▼
GET /api/lint/latest
  └─ HealthSnapshot(findings + remediations + recentOutcomes)
                │
                ▼
POST /api/health/remediations
  ├─ auth / csrf / subject
  ├─ latest lint snapshot CAS 校验
  ├─ router action 校验
  ├─ 重复请求去重
  └─ 委托 fix / curate / research / ingest
                │
                ▼
job.paramsJson.remediationContext
                │
                ▼
新 lint 快照 + job result → status resolver
```

主要新增模块：

- `src/server/services/finding-identity.ts`：finding ID 规范化、哈希与去重；
- `src/server/services/remediation-router.ts`：九类 finding 的纯路由表；
- `src/server/services/remediation-status.ts`：根据 snapshot 与关联 job 推导状态；
- `src/server/services/remediation-service.ts`：快照校验、幂等检查和 workflow 委托；
- `src/app/api/health/remediations/route.ts`：统一写入口。

实现时可以在职责不混淆的前提下合并过小文件，但 identity、router、status 三类纯逻辑必须保持可独立测试。

## 六、Finding 身份契约

### 6.1 类型

检查器内部的 `LintFinding` 不要求 ID，因为它生成时可能还没有 subject 上下文。只有可写入快照、返回 API 和进入任务的 `EnrichedLintFinding` 强制包含 ID：

```ts
export interface EnrichedLintFinding extends LintFinding {
  id: string;
  subjectId: SubjectId;
  subjectSlug: string;
}
```

`id` 是 64 位小写 SHA-256 hex。

`LintFinding` 的 `sourceId` 从 orphan-source 专属字段提升为来源相关 finding 可用字段。`checkStaleSourcesForPage()` 必须给 stale-source 写入精确 `sourceId`；`sourceFilename` 仍用于展示和旧快照回退。

### 6.2 ID 算法

规范输入：

```text
lint-finding:v1
subjectId
type
pageSlug
sourceId ?? sourceFilename ?? ""
normalize(description)
```

`normalize(description)` 执行：

1. Unicode NFKC；
2. CRLF / CR 转 LF；
3. 连续空白折叠为一个空格；
4. 首尾清理。

不纳入 ID：

- `severity`：严重度调整不改变问题身份；
- `suggestedFix`：建议文案不是问题身份；
- `failedJobId`：瞬时任务状态；
- `subjectSlug`：subject ID 才是身份；
- findings 数组位置。

完全相同的 findings 生成相同 ID，并在快照写入与旧快照读取时按 ID 去重，保留首次出现顺序。

### 6.3 稳定性边界

- 排序、筛选、页面刷新、序列化和旧快照补算不会改变 ID；
- 同一确定性问题在数据不变时重新 lint，ID 保持一致；
- LLM 如果用不同措辞描述同一语义问题，会生成新 ID；本阶段不做不可靠的语义模糊匹配；
- SHA-256 碰撞按工程上不可行处理，不增加 ordinal 回退，以免重新引入顺序依赖。

### 6.4 新旧快照

- `lint-service` 在每个 subject 的 findings 获得 subject 上下文后立即生成 ID；阶段事件和最终 `resultJson` 使用同一对象；
- `selectLatestFindings()` 每次读取都按规范字段重新计算 ID，不信任 JSON 中已有的 ID；新快照会得到与写入时相同的结果；
- JSON 损坏仍沿用现有行为返回空 findings，不根据残缺数据猜测；
- 旧快照无需迁移数据库，也无需强制用户重新运行 lint。

## 七、Remediation 契约

```ts
export type RemediationStatus =
  | 'fixed'
  | 'queued'
  | 'awaiting-approval'
  | 'skipped'
  | 'failed';

export type RemediationWorkflow =
  | 'fix'
  | 'curate'
  | 'research'
  | 're-ingest'
  | 'source-review';

export type RemediationActionType =
  | 'fix'
  | 'curate'
  | 'research'
  | 're-ingest'
  | 'review-source';

export interface RemediationAction {
  type: RemediationActionType;
  label: string;
  destructive: false;
  href?: string;
}

export interface RemediationPlan {
  findingId: string;
  workflow: RemediationWorkflow;
  status: RemediationStatus;
  actions: RemediationAction[];
  reason: string;
  jobId?: string;
}
```

`delete-source` 不进入通用 action union。它继续由 orphan-source 专用 UI、DELETE API 与二次确认控制，避免通用批量端点意外扩大破坏面。

## 八、九类 Finding 路由

| Finding | Workflow | 默认动作 | 约束 |
|---|---|---|---|
| `missing-frontmatter` | Fix | `fix` | 只执行确定性 frontmatter 修复 |
| `broken-link` | Fix | `fix` | 当前复用受 Guard 保护的 patch；Phase 2B 再切 `wiki.link.ensure` |
| `missing-crossref` | Fix | `fix` | 验证目标页；不得生成无自然锚点的 Related 占位段 |
| `contradiction` | Fix | `fix` | 使用 page/source evidence；证据不足时 skip |
| `orphan` | Curate | `curate` | `scope:'pages'`，只以目标页为 seed，禁止自动删除 |
| `stale-source` | Source review | `review-source` | 用 `sourceId` 导航到来源检查/替换；原文件缺失时不得盲目重试 |
| `coverage-gap` | Research | `research` | 按 finding ID 研究；候选返回后仍需确认 |
| `orphan-source` | Re-ingest | `re-ingest` | Retry ingest；删除仍走专用二次确认 |
| `thin-page` | Research | `research` | 当前 detector 只报告零来源薄页，因此默认 Research；若后续扩展为“有来源薄页”，再新增 Re-enrich 路由 |

每个已知 finding 类型都必须在 router 的穷尽 `switch` 中返回 plan。新增 finding 类型时，TypeScript 必须使 router 和表驱动测试失败，禁止落入默认 ignored 分支。

### 8.1 批量动作

- `fix`：只收集四类 Fix finding IDs，一个 subject 一个 job；
- `curate`：只收集 orphan IDs，把唯一 `pageSlug` 列表作为 `scope:'pages'` seeds；
- `research`：只收集 coverage-gap IDs，一个 subject 一个 job；
- `re-ingest`：每次只接受一个 ID，避免多 job 部分成功；
- All Subjects 视图不允许任何写入或入队动作。

本阶段不暴露没有 finding 会实际产生的 `re-enrich` action，避免新增死 API surface。未来只有在 thin-page detector 能提供“存在有效来源”的结构化事实后，才扩展 workflow/action union。

### 8.2 Fix scope

Fix job params 增加可选 remediation context。存在 context 时，Fix 从指定 lint job 快照中按 ID 解析并只处理这些 findings；不存在时，原 `/api/fix` 仍处理当前 subject 全部 Fix findings，保持兼容。

Fix 不接受 orphan、stale-source、coverage-gap、orphan-source 或 thin-page ID。写后继续复用 Phase 1C 定向 postcondition，不新增第二轮自动修复。

## 九、API 与任务关联

### 9.1 Health Snapshot

`GET /api/lint/latest` 返回：

```ts
export interface HealthSnapshot extends LintLatestResult {
  remediations: Record<string, RemediationPlan>;
  recentOutcomes: Record<string, RemediationStatus>;
}
```

`selectLatestFindings()` 保持纯函数，只负责选择、解析和 identity normalization。API/service 层再用有界近期 jobs 构造 remediation 状态，避免把 DB 依赖塞入快照解析纯函数。

### 9.2 统一写入口

```http
POST /api/health/remediations
```

```ts
{
  lintJobId: string;
  findingIds: string[];
  action: 'fix' | 'curate' | 'research' | 're-ingest';
}
```

处理顺序：

1. `requireAuth(request)`；
2. `requireCsrf(request)`；
3. `resolveSubjectFromRequest(request, { required: true, body })`；
4. 校验 body、ID 格式与批量上限；
5. 重新查询当前 subject 最新 completed lint；
6. 比较 `lintJobId`，不一致返回 `409 stale-snapshot`；
7. 按 ID 解析全部 findings，任一缺失则整体返回 `409`；
8. 用 router 验证 action 对全部 findings 都合法；
9. 查找相同 idempotency key 的在途或待复检 job；
10. 委托现有 workflow 入队并返回 `202`。

请求使用 lint job ID 作为 compare-and-set token。客户端不能只提交 finding 内容或 page slug，也不能要求服务端“尽量处理仍存在的部分”。

### 9.3 Research API

`POST /api/research` 从：

```ts
{ gapIds: string[] } | { topic: string }
```

改为：

```ts
{ findingIds: string[]; lintJobId: string } | { topic: string }
```

finding IDs 必须命中指定且仍为最新的 subject lint 快照，并全部属于 `coverage-gap`。十进制数组下标直接返回 `400`，不保留容易产生歧义的兼容分支。Health 通过统一 remediation API 调用 Research；topic 分支继续供手动研究和 research backlog 使用。

### 9.4 Remediation Context

所有通过统一入口新建的 job 在原参数上增加：

```ts
remediationContext: {
  lintJobId: string;
  findingIds: string[];
  action: RemediationActionType;
}
```

对于恢复已有 failed ingest job 的分支，新增 jobs repo 原子 helper，在 requeue 前合并 context，不清空 checkpoint。合并只允许修改未运行或失败 job；不得修改 running job 参数。

Idempotency key 为：

```text
subjectId + lintJobId + action + sorted(unique(findingIds))
```

相同 key 已有 pending、running，或 completed 但尚无更新 lint 快照时，返回原 job ID 和 `deduplicated:true`。

## 十、状态推导

```text
awaiting-approval
  ├─ 用户触发任务 → queued
  │    ├─ 新 lint 中 ID 消失 → fixed
  │    ├─ Research 返回候选 → awaiting-approval
  │    ├─ 无安全修改 / 无候选 → skipped
  │    └─ job 失败 / postcondition residual → failed
  └─ 缺少安全前提 → skipped
```

规则：

1. 无关联 job：按 router 返回 `awaiting-approval` 或 `skipped`；
2. job pending/running：`queued`；
3. job completedAt 晚于当前 lint completedAt：`queued`，表示等待复检；
4. missing-frontmatter、broken-link、orphan、orphan-source 对应 workflow 完成，且后续 lint 中原 ID 消失：`recentOutcomes[id] = fixed`；
5. missing-crossref / contradiction 不得只凭 ID 消失判定 fixed；必须同时满足 Phase 1C 对原 finding 的语义后置校验为 resolved，避免 LLM 换一种措辞后被误判为修复；
6. 后续 lint 仍含原 ID，且 job 失败或 postcondition residual：`failed`；
7. Research 有 candidates：`awaiting-approval`；
8. Research 无 candidates：`skipped`；
9. workflow 明确报告无安全修改：`skipped`；
10. 已消失 finding 不重新加入当前 findings 列表，`recentOutcomes` 只用于有界成功/失败提示。

状态解析只扫描当前 subject 有界数量的近期 jobs；具体上限使用命名常量并覆盖测试，不能无界解析整个 jobs 表。

## 十一、Health UI

`FindingRow` 改为消费 `RemediationPlan`：

- 展示 status tag、workflow label 和 reason；
- 从 `plan.actions` 渲染按钮，不再按 finding.type 维护动作分支；
- `review-source` 仅导航，不创建任务；
- orphan-source 的 Delete Source 仍是专用二次确认控件；
- job 完成后触发现有 lint 刷新闭环；
- `409 stale-snapshot` 时自动刷新查询，并显示“体检结果已更新，请重新确认”；
- All Subjects 视图只展示 plans，不渲染可执行按钮；
- `recentOutcomes` 以有界 banner/toast 展示，不把已修复 finding 重新画成问题行。

批量按钮不再持有 `FIXABLE_TYPES` 或 coverage gap 数组下标：

- Fix issues：筛选 `plan.actions` 含 `fix` 的 IDs；
- Tidy structure：筛选 `curate`；
- Research gaps：筛选 `research`；
- 全部动作提交当前 `data.jobId` 作为 `lintJobId`。

## 十二、错误、并发与幂等

| 状态码 | 场景 |
|---|---|
| `400` | 空 ID、非 64 位 hex、非法 action、action/type 不匹配、批量混入不兼容 finding、超过上限 |
| `401/403` | 既有 Auth / CSRF 拒绝 |
| `409 stale-snapshot` | lint job 已过期、ID 不存在或 subject 不匹配 |
| `409 in-flight` | 同一来源正在摄入，或存在不可复用的冲突任务 |
| `422` | Web Search 未配置、来源文件缺失、workflow 前提不足 |
| `500` | 入队、repo 或服务编排异常 |

约束：

- 批量请求必须先完成全部校验，再创建任务；
- Fix、Curate、Research 各自只创建一个 job，因此不会部分入队；
- Re-ingest 限制单 ID；
- 相同 idempotency key 重复请求返回既有 job，不重复创建；
- 异常不能降级为 `skipped`；只有 workflow 明确无安全动作时才能 skipped；
- 删除来源仍使用现有 in-flight 守卫和 Vault lock；
- Router 为纯函数，不捕获 I/O 异常或改变状态。

## 十三、测试策略

### 13.1 Finding Identity

- 排序、筛选和重新序列化不改变 ID；
- 空白、换行与 Unicode 规范化；
- severity、suggestedFix、failedJobId 不影响 ID；
- subject、type、pageSlug、sourceId 或规范化 description 变化会改变 ID；
- 相同 ID 去重并保留首次顺序；
- stale-source 生成精确 sourceId。

### 13.2 Lint Snapshot

- 新快照重新计算后得到与写入时一致的 ID；
- 旧快照自动补算 ID；
- JSON 内伪造或非法 ID 被规范计算结果覆盖；
- 损坏 JSON 维持空结果；
- phase events 与最终 resultJson 使用相同 ID。

### 13.3 Router 与 Status

- 九类 finding 表驱动映射全部覆盖；
- orphan 永无删除动作；
- stale-source 无 sourceId 时 skipped；
- 当前 thin-page 默认 Research；
- action/type 不匹配拒绝；
- pending/running、completed-before-lint、completed-after-lint、failed、Research candidates/no-candidates；
- 新 lint 中 ID 消失后生成 fixed outcome；
- jobs 扫描保持有界。

### 13.4 API

- Auth、CSRF、subject 隔离；
- stale lint job、跨 subject ID、数字下标 ID；
- 批量全部校验、上限和重复请求去重；
- job 参数携带正确 remediationContext；
- All Subjects 不能写；
- Research topic 分支保持兼容；
- Research findingIds 分支只接受 coverage-gap。

### 13.5 Workflow 编排

- Fix 只消费指定 IDs；无 context 时保持全量行为；
- Curate 只获得 orphan 对应页面 seeds；
- Research 只解析指定 coverage gaps；
- Requeue ingest 原子合并 context 且保留 checkpoint；
- Re-ingest 多 ID 被拒绝；
- Phase 1C postcondition 行为不回归。

### 13.6 UI

- 服务端 plan 驱动行内按钮；
- status tag、workflow 和 reason 展示；
- 批量按钮从 actions 收集 ID；
- `409` 自动刷新并提示；
- orphan-source 删除仍二次确认；
- All Subjects 保持只读；
- fixed recent outcome 不重新渲染 finding 行。

### 13.7 全量验证

```bash
npm test
npm run lint
npx tsc --noEmit
npm run build
```

本阶段不改检索算法或参数，无需运行 `npm run eval:retrieval`。

## 十四、文档与配置

实现完成后更新：

- `src/lib/CLAUDE.md`：finding / remediation 共享契约；
- `src/server/services/CLAUDE.md`：identity、router、status、Fix scope 与 Research ID；
- `src/app/CLAUDE.md`：remediation API 和 Research 请求变化；
- `src/components/CLAUDE.md`：Health plan-driven UI；
- 原治理 Spec 的阶段状态（如仓库既有文档采用阶段勾选方式）。

本阶段不新增 LLM task、模型、prompt 或 provider，因此 `llm-config.example.json` 必须保持不变。实施时若发现必须新增 LLM task，应暂停并重新评审设计，不能顺手扩大配置范围。

## 十五、预计文件变更

```text
src/lib/contracts.ts
src/server/services/finding-identity.ts
src/server/services/remediation-router.ts
src/server/services/remediation-status.ts
src/server/services/remediation-service.ts
src/server/services/lint-service.ts
src/server/services/lint-latest.ts
src/server/services/lint-deterministic.ts
src/server/services/fix-service.ts
src/server/services/research-service.ts
src/server/jobs/queue.ts
src/server/db/repos/jobs-repo.ts
src/app/api/health/remediations/route.ts
src/app/api/lint/latest/route.ts
src/app/api/research/route.ts
src/components/health/health-view.tsx
src/components/health/finding-row.tsx
src/hooks/use-lint-summary.ts
```

测试文件按对应模块放入现有 `__tests__/`。具体实现可以通过复用 helper 减少文件数量，但不得把 server-only hash、DB 查询或入队逻辑移入客户端。

## 十六、验收标准

1. 每条 Health finding 都有 64 位稳定 ID、明确 workflow、状态、原因和可用动作；
2. Research 和 Health 不再使用 findings 数组下标；
3. 历史 lint 快照无需重跑即可显示和处置；
4. lint 完成不会自动触发任何写入、LLM、联网或摄入任务；
5. stale snapshot、跨 subject finding 和非法 action 被服务端拒绝；
6. Fix、Curate、Research 只消费用户确认的 finding scope；
7. orphan 不自动删除，orphan-source 删除仍需二次确认；
8. 通过统一入口创建或恢复的 job 都能追溯到 lint job 与 finding IDs；
9. 重复点击不会创建重复任务；
10. 任务完成后新 lint 能把结果归类为 fixed、awaiting-approval、skipped 或 failed；
11. All Subjects 模式保持只读；
12. 定向测试、全量 Vitest、ESLint、TypeScript 与生产构建通过；
13. `llm-config.example.json` 无变更。

## 十七、后续阶段

- Phase 2B：`wiki.metadata.patch`、`wiki.link.ensure`，并替换 Fix 链接修复中的通用 patch；
- Phase 2C：Research finding → candidate approval → ingest job → touched pages 完整 provenance；
- Phase 2D：统一 Query save-to-wiki 与 shared create plan/apply 路径。
