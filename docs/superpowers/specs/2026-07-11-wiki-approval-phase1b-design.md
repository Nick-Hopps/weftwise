# Wiki 对话写入审批闭环 Phase 1B 设计 Spec

日期：2026-07-11  
状态：已批准

## 一、目标

Phase 1B 把 Ask AI 的页面写入从“模型可直接调用写工具”收敛为服务端强制的两阶段流程：

```text
用户明确提出写入意图
  → 模型只能生成预览提案
  → 服务端持久化 PendingAction
  → UI 展示变更摘要与 diff
  → 用户按 actionId 明确批准或拒绝
  → 服务端重新规划并校验 Vault HEAD
  → 共享 Service command 执行 Saga 或入队工作流
```

本阶段支持：

1. 页面 `create/update/patch/delete` 的精确预览与批准后执行；
2. `reenrich` 的工作流级预览与批准后入队；
3. PendingAction 状态机、过期、并发抢占、恢复与清理；
4. Query 的 `query:read` / `query:propose` 模式切换；
5. 审批 API、SSE 事件和聊天审批卡片；
6. 页面操作 plan/apply 拆分，并保留现有执行入口的兼容性。

## 二、非目标

本阶段不包含：

- Fix / Curate 的 targeted postcondition verification；该能力属于 Phase 1C；
- `wiki.metadata.patch`、`wiki.link.ensure` 和 remediation router；它们属于 Phase 2；
- History revert、跨 Subject 写入和通用 workflow command 迁移；它们属于 Phase 3；
- 通过聊天文本自动判断“好的”“继续”“批准”为审批；
- 对 reenrich 生成内容提供虚假的确定性 diff；批准对象只是工作流入队动作。

## 三、当前差距

- `query:propose` ToolProfile 已声明 `wiki.preview_change`，但 builtin registry 尚未注册该工具；
- Query runner 始终编译 `query:read`，没有明确写入意图识别；
- Query 已看不到实际页面写工具，但也没有可执行的安全提案路径；
- `executePageCreate/Update/Patch/Delete` 将规划、校验和应用耦合，无法只生成预览；
- Query SSE 只处理回答、引用、工具调用和完成事件，没有 `pending-action`；
- 聊天界面现有 `PendingAction` 只表示“重置对话确认”，会与新的领域对象冲突；
- 数据库没有可验证的审批凭证，无法在服务端区分普通聊天确认与显式按钮审批；
- 当前 `applyChangeset` 在锁内读取 HEAD，但不支持调用方指定期望 HEAD，预览与应用之间缺少防陈旧写入校验。

## 四、设计原则

1. **模型只提案，不执行。** Query 模型只能看到 `wiki.preview_change`，不能看到实际写工具。
2. **批准必须消费 actionId。** 自然语言消息永远不能替代审批 API。
3. **不信任缓存 changeset。** 批准时使用保存的原始 payload 重新规划，不能直接应用 `preview_json` 中的候选结果。
4. **HEAD 校验必须在 Vault 锁内。** 防止“校验通过后、落盘前”出现竞态提交。
5. **Subject 是强隔离边界。** 查询、批准、拒绝和恢复都必须验证 action 所属 Subject。
6. **现有写入路径保持兼容。** worker、Fix、Curate 和页面 API 继续调用原函数名，由薄包装内部执行 `plan → apply`。
7. **页面 diff 与工作流预览分开表达。** create/update/patch/delete 提供精确 unified diff；reenrich 明确说明最终内容尚未生成。
8. **审批记录不进入普通日志。** 完整 payload 只保存在受控表中，工具审计继续脱敏。

## 五、总体架构

```text
Query Route
  ├─ resolveQueryMode(question)
  ├─ query:read ───────────────→ 证据工具
  └─ query:propose
       └─ wiki.preview_change
            └─ pending-action-service
                 ├─ page-operation-planner
                 ├─ reenrich workflow preview
                 └─ pending-actions-repo
                      └─ SSE pending-action

PendingAction Card
  ├─ POST approve ─→ pending-action-service
  │                    ├─ 重新 plan
  │                    ├─ 锁内 HEAD 校验
  │                    ├─ applyChangeset / enqueue reenrich
  │                    └─ 状态与执行引用回写
  └─ POST reject ──→ 原子 pending → rejected
```

主要新增模块：

- `src/server/db/repos/pending-actions-repo.ts`：审批记录与原子状态流转；
- `src/server/services/pending-action-service.ts`：创建预览、批准、拒绝、恢复；
- `src/server/wiki/page-operation-plan.ts`：页面操作规划、diff 和统一结果类型；
- `src/server/agents/tools/builtin/wiki-preview-change.ts`：query-only 提案工具；
- `src/server/services/query-intent.ts`：确定性 Query 模式判断；
- `src/components/chat/pending-action-card.tsx`：审批卡片；
- `src/app/api/pending-actions/**`：列表、批准和拒绝 API。

## 六、PendingAction 数据模型

新增 `pending_actions` 表：

```ts
interface PendingActionRow {
  id: string;
  conversationId: string;
  subjectId: string;
  operation: 'create' | 'update' | 'patch' | 'delete' | 'reenrich';
  payloadJson: string;
  payloadHash: string;
  previewJson: string;
  status:
    | 'pending'
    | 'approved'
    | 'executing'
    | 'applied'
    | 'rejected'
    | 'expired'
    | 'failed';
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  approvedAt: string | null;
  appliedAt: string | null;
  operationId: string | null;
  jobId: string | null;
  errorJson: string | null;
}
```

约束：

- `conversation_id` 外键指向 `conversations.id`，删除会话时级联清理；
- `subject_id` 外键指向 `subjects.id`，删除 Subject 时级联清理未完成审批；
- `operation` 与 `status` 通过应用层 Zod 和数据库 CHECK 双重约束；
- `payload_json` 保存规范化原始命令，不保存候选 changeset；
- `preview_json` 保存摘要、影响页面、diff、警告、`preHead` 和展示类型；
- `operation_id` 关联页面 Saga；`job_id` 关联 reenrich job；
- `expires_at` 默认为创建后 30 分钟；
- 终态记录保留 30 天，长期审计由 `operations` 与 Git History 承担。

索引：

```text
(conversation_id, status, created_at)
(subject_id, status, expires_at)
(status, expires_at)
```

schema、`client.ts::ensureTables()` 与 Drizzle migration 必须同时更新，并增加 schema/运行时建表一致性测试。

### 6.1 payload canonicalization

`payload_hash` 使用 SHA-256：

```text
sha256(canonicalJson({
  conversationId,
  subjectId,
  operation,
  payload,
}))
```

`canonicalJson` 递归按对象 key 排序，保留数组顺序，拒绝 `undefined`、非有限数字和无法序列化的值。批准时重新计算 hash；不一致返回 `ACTION_PAYLOAD_MISMATCH`，不得执行。

首次预览时由服务端生成 `effectiveAt` 并写入规范化 payload。重新规划复用该时间，避免仅因 `created/updated` 时间变化造成预览与应用 diff 漂移。

## 七、状态机与并发规则

```text
pending ──approve──▶ approved ──claim──▶ executing
   │                                        ├──▶ applied
   ├──reject──▶ rejected                    └──▶ failed
   └──expire──▶ expired

approved ──stale HEAD──▶ pending（刷新 preview，重新审批）
```

状态更新必须使用条件 SQL，不允许“先读后无条件写”：

```sql
UPDATE pending_actions
SET status = 'approved', approved_at = ?, updated_at = ?
WHERE id = ? AND subject_id = ? AND status = 'pending' AND expires_at > ?;
```

规则：

- 并发批准只有一个请求能完成 `pending → approved`；
- `approved → executing` 同样使用条件更新；
- 拒绝只允许 `pending → rejected`；
- 读取或批准时惰性把到期的 `pending` 标记为 `expired`；
- 已 `applied` 的 approve 请求幂等返回当前结果；
- `approved/executing` 返回“处理中”，客户端重新读取状态，不盲目重复提交；
- `rejected/expired/failed` 不可恢复为 pending，必须创建新提案；
- HEAD 变化是唯一允许的回退：刷新预览并执行 `approved → pending`，清空 `approved_at`。

## 八、页面操作 plan/apply

新增统一规划结果：

```ts
interface PlannedPageOperation {
  operation: 'create' | 'update' | 'patch' | 'delete';
  preHead: string;
  changeset: Changeset;
  summary: string;
  affectedPages: Array<{
    slug: string;
    action: 'create' | 'update' | 'delete';
  }>;
  diff: string;
  warnings: string[];
  resultHint: Record<string, unknown>;
}
```

公开函数：

```ts
planPageCreate(...): Promise<PlannedPageOperation>
planPageUpdate(...): Promise<PlannedPageOperation>
planPagePatch(...): Promise<PlannedPageOperation>
planPageDelete(...): Promise<PlannedPageOperation>
applyPlannedPageOperation(plan): Promise<AppliedPageOperation>
```

规划阶段只执行：

1. 校验目标页、保护页、Subject、忠实度与坏链；
2. 生成候选内容和内存 changeset；
3. 调用 `validateChangeset`；
4. 从当前 Vault 内容生成 unified diff；
5. 返回 `preHead`、受影响页、警告和结果提示。

规划阶段不得写文件、SQLite、Git，不得触发 embedding enqueue。

diff 规则：

- create：`/dev/null → wiki/<subject>/<slug>.md`；
- update/patch：当前完整 Markdown → 候选完整 Markdown；
- delete：当前完整 Markdown → `/dev/null`；
- 多页 relink 按路径排序后拼接；
- diff 只写入 `pending_actions.preview_json` 和 API 响应，不写工具审计日志。

现有 `executePageCreate/Update/Patch/Delete` 改为兼容薄包装：

```text
plan → apply
```

embedding enqueue 继续由现有 `page-write.ts` 等 Service 调用层负责，不下沉到 page-ops，避免改变 worker 与后台工作流的触发语义。

### 8.1 锁内 HEAD 校验

`applyChangeset` 通过不破坏现有 `sourceOps` 参数的第三个 options 参数增加可选 HEAD 约束：

```ts
applyChangeset(
  changeset,
  sourceOps?,
  options?: { expectedPreHead?: string },
): Promise<Changeset>;
```

执行顺序固定为：

```text
获得 Vault mutex
  → 读取实际 HEAD
  → 比较 expectedPreHead
  → 不一致：抛 ACTION_STALE_PREVIEW，不创建 operation、不写文件
  → 一致：创建 operation 并继续现有 Saga
```

未传 `expectedPreHead` 的现有 worker/Service 调用保持当前行为。审批路径必须传入重新规划得到的 `preHead`。

## 九、reenrich 工作流预览

reenrich 在 job 执行时才调用 LLM，审批前无法知道最终页面内容，因此使用：

```ts
interface WorkflowPreview {
  kind: 'workflow';
  operation: 'reenrich';
  slug: string;
  summary: string;
  affectedPages: Array<{ slug: string; action: 'update' }>;
  diff: null;
  warnings: string[];
  preHead: string;
}
```

固定警告必须说明：

> 批准的是重新丰富任务，不是确定的内容变更；最终内容将在任务执行后通过 Saga、operation 和 Git History 审计。

批准 reenrich 时调用现有共享 enqueue service，保存并返回 `jobId`。它不经过模型工具 handler，也不伪造内容 diff。

## 十、`wiki.preview_change`

新增 builtin 工具，属性：

```ts
name: 'wiki.preview_change'
sideEffect: 'propose'
```

输入为 Zod 判别联合：

```ts
type PreviewChangeInput =
  | { operation: 'create'; payload: CreatePageInput }
  | { operation: 'update'; payload: UpdatePageInput }
  | { operation: 'patch'; payload: PatchPageInput }
  | { operation: 'delete'; payload: { slug: string } }
  | { operation: 'reenrich'; payload: { slug: string } };
```

Query ToolContext 增加可选能力：

```ts
conversationId?: string;
previewChange?(input: PreviewChangeInput): Promise<PendingActionView>;
onPendingAction?(action: PendingActionView): void;
```

工具 handler 只转发到 context，不直接 import DB、Vault 或 queue。Query context 调用 `pending-action-service.createPreview()`，成功后触发 `onPendingAction`。

返回：

```ts
interface PendingActionView {
  actionId: string;
  conversationId: string;
  operation: PendingActionOperation;
  status: PendingActionStatus;
  summary: string;
  affectedPages: Array<{ slug: string; action: 'create' | 'update' | 'delete' }>;
  diff: string | null;
  warnings: string[];
  expiresAt: string;
  operationId: string | null;
  jobId: string | null;
  error: { code: string; message: string } | null;
}
```

规划失败时不创建 PendingAction。工具返回稳定错误，模型只能解释或修正输入。

## 十一、Query 模式切换

新增纯函数：

```ts
resolveQueryMode(question: string): 'read' | 'propose';
```

规则：

- 默认 `read`；
- 只有同时出现明确写入动作和 Wiki 页面目标时返回 `propose`；
- 支持中英文 create/update/patch/delete/reenrich 意图；
- 教程、假设、能力询问和否定表达保持 `read`；
- 无法确定时保守返回 `read`。

模式只控制工具可见性，不承担授权职责：

```text
read    → query:read
propose → query:propose
```

`query:propose` 只能在原证据工具基础上增加 `wiki.preview_change`；实际 `wiki.create/update/patch/delete/reenrich` 继续保留给 worker 和兼容路径，但不得加入 Query Profile。

`streamAgenticQuery` 接收 `conversationId` 与 `mode`，Route 在编译工具前完成会话创建和模式解析。Query Prompt 增加说明：预览不是已应用变更，回答中不得宣称写入成功。

本阶段不新增 LLM task、不新增模型调用，不修改 `llm-config.example.json`。

## 十二、审批 Service 与 API

### 12.1 创建预览

`createPreview()`：

1. 验证 conversation 属于当前 Subject；
2. 规范化输入并加入 `effectiveAt`；
3. 调用页面 planner 或 reenrich workflow planner；
4. 计算 payload hash；
5. 保存 `pending` action；
6. 返回 `PendingActionView`。

### 12.2 批准

`approvePendingAction()`：

1. 按 actionId + Subject 读取，并执行惰性过期与恢复；
2. 原子 `pending → approved`；
3. 重新计算 payload hash；
4. 解析原始 payload 并重新规划；
5. 若新 `preHead` 与已批准预览不同，更新预览并退回 `pending`，返回 409；
6. 页面操作原子 `approved → executing`，预写 `operationId`，调用带 `expectedPreHead` 的 apply；
7. reenrich 原子 `approved → executing`，入队后写入 `jobId`；
8. 成功写 `applied/appliedAt`，失败写 `failed/errorJson`。

批准不再进入模型循环，也不调用 builtin 写工具 handler。

### 12.3 API

```text
GET  /api/pending-actions?conversationId=...
POST /api/pending-actions/[id]/approve
POST /api/pending-actions/[id]/reject
```

安全规则：

- GET：`requireAuth` + Subject 解析 + conversation Subject 校验；
- approve/reject：`requireAuth` + `requireCsrf` + `resolveSubjectFromRequest(required:true)`；
- 跨 Subject、跨 Conversation 或不存在的 action 统一返回 404；
- 请求体不接受 payload、operation 或 preview，客户端只能提交 actionId；
- 返回错误使用稳定 code，不暴露绝对路径、正文或配置秘密。

主要响应：

| 场景 | HTTP | code/结果 |
|---|---:|---|
| 应用成功 | 200 | `applied` + operationId/jobId |
| 已应用重复批准 | 200 | 幂等返回当前结果 |
| 正在处理 | 409 | `ACTION_IN_PROGRESS` |
| HEAD 变化 | 409 | `ACTION_STALE_PREVIEW` + 刷新后的 action |
| 已拒绝或失败 | 409 | `ACTION_ALREADY_CONSUMED` |
| 已过期 | 410 | `ACTION_EXPIRED` |
| payload 校验失败 | 409 | `ACTION_PAYLOAD_MISMATCH` |

## 十三、SSE 与聊天 UI

Query Route 增加：

```text
event: pending-action
data: PendingActionView
```

事件由 `onPendingAction` 在工具成功持久化后即时发出。`tool-call` 审计事件仍只返回脱敏参数摘要。

聊天侧改动：

- 现有重置确认类型重命名为 `PendingResetConfirmation`；
- 新增 `pendingActions: Map<actionId, PendingActionView>` 或等价的不可变状态；
- SSE `pending-action` 事件按 actionId upsert；
- 进入或切换 conversation 时调用 GET 恢复卡片；
- conversation/Subject 切换时清理旧状态并取消未完成请求；
- approve/reject 使用 `useApiFetch()` 自动携带 Subject；
- 网络结果不确定时 GET 当前 action，不盲目重复 approve。

`PendingActionCard` 展示：

- 操作类型、状态和过期时间；
- 摘要与受影响页面；
- 页面操作的可折叠 unified diff；
- reenrich 的工作流说明和 `diff unavailable`；
- warnings；
- pending 状态下的“批准”“拒绝”按钮；
- approved/executing 的处理中状态；
- applied/rejected/expired/failed 的终态信息。

“好的”“继续”“批准”等消息继续作为普通 Query 输入处理，不能调用 approve API。

## 十四、恢复、过期与 GC

### 14.1 Saga 结果恢复

进入页面操作 `executing` 前保存计划使用的 `operationId`。读取 action 或执行维护清理时：

- action 为 `executing` 且 operation 为 `applied`：修正 action 为 `applied`；
- operation 为 `rolled-back/failed`：修正 action 为 `failed`；
- operation 尚未产生终态且超过恢复窗口：标记 `failed`，提示重新预览；
- action 为 `approved` 且超过恢复窗口：标记 `failed`。

这覆盖“Git 已提交，但进程在回写 action 前退出”的窗口。reenrich 的后续执行状态由 jobs 表跟踪；action 在成功入队后即标记 `applied`，语义是“调度动作已应用”。

### 14.2 过期与清理

- pending TTL 固定 30 分钟；
- GET、approve 和 repo list 时先惰性标记到期 action；
- 维护 tick best-effort 标记到期 action，并删除 30 天前的终态记录；
- 清理失败只记脱敏日志，不影响 worker 主流程。

## 十五、错误码与审计

新增稳定错误码：

- `ACTION_NOT_FOUND`
- `ACTION_EXPIRED`
- `ACTION_IN_PROGRESS`
- `ACTION_ALREADY_CONSUMED`
- `ACTION_STALE_PREVIEW`
- `ACTION_PAYLOAD_MISMATCH`
- `ACTION_PLAN_INVALID`
- `ACTION_APPLY_FAILED`

工具与 API 日志只记录：

```ts
{
  profileId,
  tool,
  sideEffect,
  subjectId,
  pageSlugs,
  actionId,
  operationId?,
  jobId?,
  durationMs,
  outcome,
}
```

禁止记录 `payload_json`、完整 diff、页面正文、source chunk 和任何 LLM credential。

## 十六、测试策略

严格执行 RED → GREEN → REFACTOR。

### 16.1 Planner

- create/update/patch/delete 生成正确 changeset、affectedPages 和统一 diff；
- update 改标题包含 backlink relink；
- patch 精确唯一匹配规则保持不变；
- delete 保护页与 meta 页被拒绝；
- 坏链与忠实度护栏保持不变；
- 规划后 Vault、pages、operations 和 Git HEAD 均不变；
- `effectiveAt` 相同时重复规划输出稳定。

### 16.2 PendingAction repo

- schema、外键、CHECK 和索引存在；
- canonical JSON 与 payload hash 稳定；
- pending → approved → executing → applied/failed；
- reject、expire、stale 回退；
- 并发条件更新只有一个调用成功；
- Conversation/Subject 隔离与级联清理；
- 30 天 GC 边界。

### 16.3 工具与 Query

- builtin registry 注册 `wiki.preview_change`；
- `query:read` 看不到 preview，`query:propose` 只能额外看到 preview；
- Query Profile 永远不包含实际写工具；
- 中英文明确写入意图、教程问题、否定表达和模糊表达分类；
- preview 成功触发 `pending-action`，失败不落库；
- Query 回答不得把 preview 描述为已应用。

### 16.4 API 与 Saga

- auth、CSRF、required Subject 和 conversation scope；
- 批准成功、拒绝、过期、重复批准和处理中；
- payload hash 不匹配；
- preview 后 HEAD 变化返回刷新预览，不落盘；
- expected HEAD 在 Vault 锁内校验；
- 同一 action 最多产生一个 operation 或一个 reenrich job；
- apply 失败写 failed，并保留 Saga 回滚行为；
- operation 已应用但 action 未回写时可恢复。

### 16.5 SSE 与 UI

- SSE parser 接收 `pending-action`；
- actionId upsert，不重复渲染；
- 刷新/切换会话后恢复；
- approve/reject loading 与终态；
- stale 响应替换预览并重新启用按钮；
- 普通聊天确认文本不能触发 API；
- 卡片按钮具备键盘焦点、禁用状态和可读状态标签。

## 十七、验收标准

1. 用户未通过 actionId 批准前，页面文件、索引、Git 和 jobs 均不发生写入；
2. create/update/patch/delete 展示与实际应用一致的 diff；
3. reenrich 明确展示为工作流批准，不声称已有内容 diff；
4. Vault HEAD 变化时旧预览绝不执行，用户必须重新批准；
5. 并发批准最多执行一次；
6. 刷新页面或重新进入会话后仍能看到未终结审批；
7. Query 模型永远看不到实际页面写工具；
8. 既有 worker、Fix、Curate 和页面 API 写入行为保持兼容；
9. `llm-config.example.json` 与 task route 不变；
10. 以下检查全部通过：

```text
npm test -- --run
npm run lint
npx tsc --noEmit
npm run build
```

## 十八、实施顺序

1. 数据模型、repo、canonical hash 与状态机；
2. 页面操作 plan/apply 与锁内 expected HEAD；
3. PendingAction service 和 reenrich workflow preview；
4. `wiki.preview_change`、ToolContext 与 Query mode；
5. API 与 SSE；
6. 审批卡片与会话恢复；
7. 崩溃恢复、过期、GC 与文档同步；
8. 全量验证并确认 LLM 示例配置无变化。
