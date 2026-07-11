# Wiki 对话写入审批闭环 Phase 1B Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Ask AI 增加服务端强制的“预览 → actionId 审批 → 重新规划 → Saga/入队”闭环，使模型不能直接执行页面写入。

**Architecture:** Query 默认编译 `query:read`，明确写入意图才编译只多出 `wiki.preview_change` 的 `query:propose`。预览服务把规范化 payload 和展示预览存入 `pending_actions`；批准 API 原子消费 action、重新规划并在 Vault 锁内校验 HEAD，然后调用共享页面 Saga 或 reenrich 入队服务。

**Tech Stack:** TypeScript 5、Next.js 15 Route Handlers、React 19、Vercel AI SDK 4、Zod、better-sqlite3、Drizzle ORM、Vitest、simple-git。

## Global Constraints

- 当前隔离工作区为 `.worktrees/wiki-approval-phase1b`，分支为 `feat/wiki-approval-phase1b`；执行时不得新建第二个 worktree。
- 所有新增 task、plan、spec、代码注释和 commit message 使用中文；commit message 为一句 Conventional Commit。
- Query 模型永远不能获得 `wiki.create/update/patch/delete/reenrich` 等实际写工具，只能获得 `wiki.preview_change`。
- 普通聊天文本“好的”“继续”“批准”不能消费审批；只有带明确 actionId 的 approve API 可以执行。
- 页面批准必须重新规划，并把 `expectedPreHead` 传入 `applyChangeset` 在 Vault mutex 内校验。
- `create/update/patch/delete` 返回精确 unified diff；`reenrich` 只返回 `diff:null` 的工作流预览。
- pending TTL 固定 30 分钟；终态保留 30 天；完整 payload/diff 不写普通工具日志。
- 本阶段不新增 LLM task、不新增模型调用，不修改 `llm-config.example.json`。
- 每项任务遵循 RED → GREEN → REFACTOR；完成后运行该任务列出的定向测试再提交。

---

## 文件结构

### 新增文件

- `src/server/services/pending-action-payload.ts`：canonical JSON、payload hash 和规范化 payload。
- `src/server/db/repos/pending-actions-repo.ts`：PendingAction CRUD、条件状态流转、过期与 GC。
- `src/server/wiki/unified-diff.ts`：ChangesetEntry 到 unified diff 的唯一格式化实现。
- `src/server/wiki/page-operation-plan.ts`：create/update/patch/delete 的无副作用规划。
- `src/server/services/pending-action-service.ts`：创建预览、列表、批准、拒绝、恢复和维护入口。
- `src/server/services/query-intent.ts`：确定性 `read | propose` 判断。
- `src/server/agents/tools/builtin/wiki-preview-change.ts`：query-only 提案工具。
- `src/components/chat/pending-action-card.tsx`：审批卡片。
- `src/components/chat/pending-action-state.ts`：客户端 actionId upsert 与状态替换纯函数。
- `src/app/api/pending-actions/route.ts`：按 conversation 列表。
- `src/app/api/pending-actions/[id]/approve/route.ts`：批准 action。
- `src/app/api/pending-actions/[id]/reject/route.ts`：拒绝 action。

### 主要修改文件

- `src/lib/contracts.ts`：审批领域类型与 preview 输入类型。
- `src/server/db/schema.ts`、`src/server/db/client.ts`、`drizzle/**`：表、索引和迁移。
- `src/server/wiki/wiki-transaction.ts`：锁内 `expectedPreHead`。
- `src/server/wiki/page-ops.ts`、`src/server/services/page-write.ts`：兼容薄包装和 Service 护栏。
- `src/server/agents/tools/tool-context.ts`、`builtin/index.ts`、`profiles.ts`：提案能力接线。
- `src/server/services/query-tools.ts`、`query-service.ts`：动态 Query profile 与预览回调。
- `src/app/api/query/route.ts`：模式解析和 `pending-action` SSE。
- `src/components/chat/chat-interface.tsx`：卡片恢复、批准、拒绝和 SSE upsert。
- `src/server/jobs/worker.ts`：过期标记、恢复和 30 天清理。
- `src/app/CLAUDE.md`、`src/components/CLAUDE.md`、`src/server/{db,services,wiki}/CLAUDE.md`：边界说明。

---

### Task 1: 审批领域类型与 payload hash

**Files:**
- Modify: `src/lib/contracts.ts`
- Create: `src/server/services/pending-action-payload.ts`
- Test: `src/server/services/__tests__/pending-action-payload.test.ts`

**Interfaces:**
- Consumes: Node `crypto.createHash`、Zod。
- Produces: `PendingActionOperation`、`PendingActionStatus`、`PreviewChangeInput`、`PendingActionPreview`、`PendingActionView`、`canonicalJson()`、`hashPendingActionPayload()`、`normalizePreviewInput()`。

- [ ] **Step 1: 写 canonicalization 与类型边界的失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  hashPendingActionPayload,
  normalizePreviewInput,
} from '../pending-action-payload';

describe('pending-action payload', () => {
  it('对象 key 顺序不影响 canonical JSON 与 hash', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } }))
      .toBe('{"a":{"c":3,"d":4},"b":2}');
    const left = hashPendingActionPayload({
      conversationId: 'c1', subjectId: 's1', operation: 'delete', payload: { slug: 'a' },
    });
    const right = hashPendingActionPayload({
      subjectId: 's1', conversationId: 'c1', payload: { slug: 'a' }, operation: 'delete',
    });
    expect(left).toBe(right);
  });

  it('规范化输入写入服务端 effectiveAt 并裁剪字符串', () => {
    expect(normalizePreviewInput(
      { operation: 'delete', payload: { slug: '  page-a  ' } },
      '2026-07-11T00:00:00.000Z',
    )).toEqual({
      operation: 'delete',
      payload: { slug: 'page-a', effectiveAt: '2026-07-11T00:00:00.000Z' },
    });
  });

  it('拒绝 undefined 与非有限数字', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/unsupported/i);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/finite/i);
  });
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/pending-action-payload.test.ts`  
Expected: FAIL，提示找不到 `pending-action-payload`。

- [ ] **Step 3: 在 contracts 中定义唯一共享类型**

```ts
export type PendingActionOperation = 'create' | 'update' | 'patch' | 'delete' | 'reenrich';
export type PendingActionStatus =
  | 'pending' | 'approved' | 'executing' | 'applied'
  | 'rejected' | 'expired' | 'failed';

export type PreviewChangeInput =
  | { operation: 'create'; payload: { title: string; body: string; summary?: string; tags?: string[] } }
  | { operation: 'update'; payload: { slug: string; title?: string; body: string; summary?: string; tags?: string[] } }
  | { operation: 'patch'; payload: { slug: string; edits: Array<{ oldString: string; newString: string }> } }
  | { operation: 'delete'; payload: { slug: string } }
  | { operation: 'reenrich'; payload: { slug: string } };

export interface PendingActionPreview {
  kind: 'page-change' | 'workflow';
  preHead: string;
  summary: string;
  affectedPages: Array<{ slug: string; action: 'create' | 'update' | 'delete' }>;
  diff: string | null;
  warnings: string[];
}

export interface PendingActionView extends PendingActionPreview {
  actionId: string;
  conversationId: string;
  operation: PendingActionOperation;
  status: PendingActionStatus;
  expiresAt: string;
  operationId: string | null;
  jobId: string | null;
  error: { code: string; message: string } | null;
}
```

- [ ] **Step 4: 实现稳定 canonical JSON、hash 与 Zod 规范化**

```ts
export function hashPendingActionPayload(input: {
  conversationId: string;
  subjectId: string;
  operation: PendingActionOperation;
  payload: unknown;
}): string {
  return createHash('sha256').update(canonicalJson(input)).digest('hex');
}
```

实现要求：递归排序 plain-object key，数组保持顺序；`normalizePreviewInput(input, effectiveAt)` 用判别联合 Zod schema 校验，并对 title/slug 做 `trim()`，把 `effectiveAt` 写入内部 payload。

- [ ] **Step 5: 运行定向测试与类型检查**

Run: `npx vitest run src/server/services/__tests__/pending-action-payload.test.ts && npx tsc --noEmit`  
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/lib/contracts.ts src/server/services/pending-action-payload.ts src/server/services/__tests__/pending-action-payload.test.ts
git commit -m "feat: 定义审批操作与载荷哈希契约"
```

---

### Task 2: PendingAction 表与原子状态仓储

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/client.ts`
- Create: `src/server/db/repos/pending-actions-repo.ts`
- Create: `src/server/db/repos/__tests__/pending-actions-repo.test.ts`
- Modify: `src/server/db/__tests__/indexes.test.ts`
- Create via generator: `drizzle/0002_pending_actions.sql`
- Modify via generator: `drizzle/meta/_journal.json`
- Create via generator: `drizzle/meta/0002_snapshot.json`

**Interfaces:**
- Consumes: Task 1 的 `PendingActionOperation`、`PendingActionStatus`、`PendingActionPreview`。
- Produces: `PendingActionRecord` 与 repo 函数 `createPendingAction`、`getScoped`、`listForConversation`、`claimApproval`、`claimExecution`、`refreshPreview`、`rejectPending`、`markApplied`、`markFailed`、`expirePending`、`pruneTerminal`。

- [ ] **Step 1: 写表结构、条件流转和 GC 的失败测试**

测试用临时 `DATABASE_PATH` 启动真实 SQLite，先创建 Subject 与 Conversation，再断言：

```ts
const created = repo.createPendingAction({
  conversationId: conversation.id,
  subjectId: subject.id,
  operation: 'delete',
  payloadJson: '{"slug":"a"}',
  payloadHash: 'hash',
  previewJson: JSON.stringify(preview),
  createdAt: now,
  expiresAt: later,
});
expect(repo.claimApproval(created.id, subject.id, now)?.status).toBe('approved');
expect(repo.claimApproval(created.id, subject.id, now)).toBeNull();
expect(repo.claimExecution(created.id, subject.id, 'op-1', null, now)).toBe(true);
expect(repo.claimExecution(created.id, subject.id, 'op-2', null, now)).toBe(false);
```

另写用例覆盖 conversation/subject 越界、过期 `pending → expired`、`approved → pending` 刷新、终态 30 天删除、Conversation 删除级联和三个索引存在。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/server/db/repos/__tests__/pending-actions-repo.test.ts src/server/db/__tests__/indexes.test.ts`  
Expected: FAIL，表或 repo 不存在。

- [ ] **Step 3: 添加 Drizzle schema 与幂等运行时建表**

`pending_actions` 包含 spec 中 18 个字段；`operation/status` 使用 CHECK，两个外键均 `ON DELETE CASCADE`。在 `client.ts` 新增 `migratePendingActions()`，调用顺序放在 `migrateMessages()` 之后；在 `ensureIndexes()` 创建：

```sql
CREATE INDEX IF NOT EXISTS pending_actions_conversation_status_idx
  ON pending_actions(conversation_id, status, created_at);
CREATE INDEX IF NOT EXISTS pending_actions_subject_status_expiry_idx
  ON pending_actions(subject_id, status, expires_at);
CREATE INDEX IF NOT EXISTS pending_actions_status_expiry_idx
  ON pending_actions(status, expires_at);
```

- [ ] **Step 4: 实现 repo 的条件 SQL**

`claimApproval` 必须使用单条带 `status='pending' AND expires_at > ?` 的 UPDATE，并以 `changes === 1` 判断抢占成功；`claimExecution` 只允许 `approved`；`rejectPending` 只允许 `pending`；`refreshPreview` 只允许 `approved → pending` 并清空 approval/execution/error 字段。

- [ ] **Step 5: 生成迁移并检查 SQL**

Run: `npm run db:generate -- --name pending_actions`  
Expected: 生成 `drizzle/0002_pending_actions.sql`、journal 和 snapshot；SQL 含表、CHECK、外键和索引。若 drizzle-kit 生成的文件名带自动前缀，保留生成器产物并在本计划勾选记录实际文件名，不手工伪造 snapshot。

- [ ] **Step 6: 运行定向测试**

Run: `npx vitest run src/server/db/repos/__tests__/pending-actions-repo.test.ts src/server/db/__tests__/indexes.test.ts src/server/db/repos/__tests__/subjects-cascade-delete.test.ts`  
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/server/db/schema.ts src/server/db/client.ts src/server/db/repos/pending-actions-repo.ts src/server/db/repos/__tests__/pending-actions-repo.test.ts src/server/db/__tests__/indexes.test.ts drizzle
git commit -m "feat: 增加审批状态表与原子流转仓储"
```

---

### Task 3: Saga 锁内 expected HEAD

**Files:**
- Modify: `src/server/wiki/wiki-transaction.ts`
- Modify: `src/server/wiki/__tests__/wiki-transaction.test.ts`

**Interfaces:**
- Consumes: `getVaultHead()`、`acquireVaultLock()`。
- Produces: `ApplyChangesetOptions`、`ActionStalePreviewError`、兼容签名 `applyChangeset(changeset, sourceOps?, options?)`。

- [ ] **Step 1: 写 HEAD 不匹配时零写入的失败测试**

```ts
it('expectedPreHead 不匹配时在锁内拒绝且不创建 operation/写文件', async () => {
  const cs = makeChangeset([{ action: 'create', path: 'wiki/general/a.md', content: VALID_CONTENT }]);
  await expect(applyChangeset(cs, undefined, { expectedPreHead: 'older-sha' }))
    .rejects.toMatchObject({ code: 'ACTION_STALE_PREVIEW' });
  expect(mutexMocks.acquireVaultLock.mock.invocationCallOrder[0])
    .toBeLessThan(gitMocks.getVaultHead.mock.invocationCallOrder[0]);
  expect(dbMocks.prepare).not.toHaveBeenCalled();
  expect(storeMocks.writeVaultFiles).not.toHaveBeenCalled();
  expect(gitMocks.commitVaultChanges).not.toHaveBeenCalled();
  expect(mutexMocks.release).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/server/wiki/__tests__/wiki-transaction.test.ts -t "expectedPreHead"`  
Expected: FAIL，`applyChangeset` 不接受第三参数或未拒绝 stale HEAD。

- [ ] **Step 3: 在获取 mutex 后、创建 operation 前校验 HEAD**

```ts
export interface ApplyChangesetOptions { expectedPreHead?: string }

export class ActionStalePreviewError extends Error {
  readonly code = 'ACTION_STALE_PREVIEW';
  constructor(readonly expectedHead: string, readonly actualHead: string) {
    super('Vault HEAD changed after preview; refresh and approve the new preview.');
    this.name = 'ActionStalePreviewError';
  }
}
```

`applyChangeset` 进入锁后先取 `preHead`；若 options 指定值不匹配立即抛错。匹配时复用该 `preHead` 写 operation，不重复读取 HEAD。

- [ ] **Step 4: 运行 Saga 全文件测试**

Run: `npx vitest run src/server/wiki/__tests__/wiki-transaction.test.ts src/server/wiki/__tests__/recovery.test.ts`  
Expected: PASS，原两参数调用行为不变。

- [ ] **Step 5: 提交**

```bash
git add src/server/wiki/wiki-transaction.ts src/server/wiki/__tests__/wiki-transaction.test.ts
git commit -m "feat: 在 Saga 锁内校验审批预览版本"
```

---

### Task 4: 无副作用页面 planner 与 unified diff

**Files:**
- Create: `src/server/wiki/unified-diff.ts`
- Create: `src/server/wiki/page-operation-plan.ts`
- Create: `src/server/wiki/__tests__/unified-diff.test.ts`
- Create: `src/server/wiki/__tests__/page-operation-plan.test.ts`
- Modify: `src/server/wiki/page-ops.ts`
- Modify: `src/server/wiki/__tests__/page-ops-create-delete.test.ts`
- Modify: `src/server/wiki/__tests__/page-ops-update.test.ts`
- Modify: `src/server/wiki/__tests__/page-ops-patch.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `applyChangeset(..., options)`、现有 page identity/frontmatter/relink/validation 函数。
- Produces: `PlannedPageOperation`、四个 core planner、`applyPlannedPageOperation`，以及供 Query 审批复用保护页/忠实度护栏的四个 `plan*InSubject` Service planner。

- [ ] **Step 1: 写无外部依赖的 unified diff 失败测试**

```ts
expect(buildUnifiedDiff([
  { action: 'update', path: 'wiki/general/a.md', before: 'old\n', after: 'new\n' },
])).toContain('--- a/wiki/general/a.md');
expect(result).toContain('+++ b/wiki/general/a.md');
expect(result).toContain('-old');
expect(result).toContain('+new');
```

另覆盖 create 的 `--- /dev/null`、delete 的 `+++ /dev/null` 与多路径字典序。

- [ ] **Step 2: 写 planner 无副作用与稳定输出的失败测试**

覆盖：

- create 使用 `effectiveAt` 生成稳定 frontmatter 与唯一 slug；
- update 改标题同时产生 backlink entries；
- patch 复用 `applyPatchEdits` 的唯一匹配规则；
- delete 返回 broken backlink warning/结果提示；
- planner 调用后 `applyChangeset`、embedding enqueue、写文件均未发生；
- `preHead` 来自 `getVaultHead()`；
- `effectiveAt` 相同且 HEAD/页面不变时 diff 完全相同。

- [ ] **Step 3: 运行 planner 测试确认 RED**

Run: `npx vitest run src/server/wiki/__tests__/unified-diff.test.ts src/server/wiki/__tests__/page-operation-plan.test.ts`  
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现统一规划类型与 diff 生成**

```ts
export interface PlannedPageOperation<ResultHint extends Record<string, unknown> = Record<string, unknown>> {
  operation: 'create' | 'update' | 'patch' | 'delete';
  preHead: string;
  changeset: Changeset;
  summary: string;
  affectedPages: Array<{ slug: string; action: 'create' | 'update' | 'delete' }>;
  diff: string;
  warnings: string[];
  resultHint: ResultHint;
}

export interface PagePlanMeta { effectiveAt: string }

export function planPageCreate(
  jobId: string,
  subject: Subject,
  input: { title: string; body: string; summary?: string; tags?: string[] } & PagePlanMeta,
): Promise<PlannedPageOperation<{ createdSlug: string }>>;
export function planPageUpdate(
  jobId: string,
  subject: Subject,
  input: { slug: string; title?: string; body: string; summary?: string; tags?: string[] } & PagePlanMeta,
): Promise<PlannedPageOperation<{ updatedSlug: string; referencesUpdated: number }>>;
export function planPagePatch(
  jobId: string,
  subject: Subject,
  input: { slug: string; edits: Array<{ oldString: string; newString: string }> } & PagePlanMeta,
): Promise<PlannedPageOperation<{ updatedSlug: string; appliedEdits: number }>>;
export function planPageDelete(
  jobId: string,
  subject: Subject,
  input: { slug: string } & PagePlanMeta,
): Promise<PlannedPageOperation<{ deletedSlug: string; brokenBacklinks: number }>>;

export async function applyPlannedPageOperation<T extends Record<string, unknown>>(
  plan: PlannedPageOperation<T>,
): Promise<T & { operationId: string }> {
  const applied = await applyChangeset(plan.changeset, undefined, { expectedPreHead: plan.preHead });
  return { ...plan.resultHint, operationId: applied.id };
}
```

四个 core planner 从现有 execute 函数提取确定性构造逻辑，只把 `new Date()` 换成 payload 的 `effectiveAt`；规划完成后调用 `validateChangeset` 并读取每个 entry 的 before 内容生成 diff，不调用 apply。

- [ ] **Step 5: 把 execute 函数改成兼容薄包装**

```ts
export async function executePageDelete(jobId: string, subject: Subject, slug: string) {
  const plan = await planPageDelete(jobId, subject, { slug, effectiveAt: new Date().toISOString() });
  const { operationId: _operationId, ...result } = await applyPlannedPageOperation(plan);
  return result;
}
```

create/update/patch 使用相同结构；merge/split 不改。`page-write.ts` 继续在成功 execute 后 enqueue embedding，planner 不触发 embedding。

同时在 `page-write.ts` 增加以下 Service planner，先运行现有保护页、存在性、delete/meta 和 update fidelity 护栏，再调用 core planner；PendingAction service 只能调用这些 Service planner：

```ts
planCreatePageInSubject(subject, input, effectiveAt): Promise<PlannedPageOperation>
planUpdatePageInSubject(subject, input, effectiveAt): Promise<PlannedPageOperation>
planPatchPageInSubject(subject, input, effectiveAt): Promise<PlannedPageOperation>
planDeletePageInSubject(subject, slug, effectiveAt): Promise<PlannedPageOperation>
```

现有 `create/update/patch/deletePageInSubject` 改为调用相应 Service planner → `applyPlannedPageOperation` → enqueue embedding，确保预览与同步写入共享同一套护栏。

- [ ] **Step 6: 运行页面操作回归**

Run: `npx vitest run src/server/wiki/__tests__/unified-diff.test.ts src/server/wiki/__tests__/page-operation-plan.test.ts src/server/wiki/__tests__/page-ops-create-delete.test.ts src/server/wiki/__tests__/page-ops-update.test.ts src/server/wiki/__tests__/page-ops-patch.test.ts src/server/services/__tests__/page-write.test.ts src/server/services/__tests__/page-write-patch.test.ts`  
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/server/wiki src/server/services/page-write.ts src/server/services/__tests__/page-write.test.ts src/server/services/__tests__/page-write-patch.test.ts
git commit -m "refactor: 拆分页面变更规划与应用"
```

---

### Task 5: 创建 PendingAction 预览服务

**Files:**
- Create: `src/server/services/pending-action-service.ts`
- Create: `src/server/services/__tests__/pending-action-service-preview.test.ts`
- Modify: `src/server/services/reenrich-enqueue.ts`

**Interfaces:**
- Consumes: Tasks 1–4 的 normalize/hash、repo、四个 `plan*InSubject` Service planner、`validateReenrichTarget`、`getVaultHead()`。
- Produces: `createPendingActionPreview()`、`listPendingActions()`、`PendingActionError`。

- [ ] **Step 1: 写页面与 reenrich 预览失败测试**

```ts
const view = await createPendingActionPreview({
  conversationId: 'c1',
  subject,
  input: { operation: 'delete', payload: { slug: 'page-a' } },
  now: new Date('2026-07-11T00:00:00.000Z'),
});
expect(view).toMatchObject({
  conversationId: 'c1', operation: 'delete', status: 'pending', diff: expect.any(String),
});
expect(repoMocks.createPendingAction).toHaveBeenCalledWith(expect.objectContaining({
  expiresAt: '2026-07-11T00:30:00.000Z',
}));
```

reenrich 用例断言 `diff:null`、固定警告、目标校验和未调用 queue；跨 Subject conversation、planner 失败均不落库。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/pending-action-service-preview.test.ts`  
Expected: FAIL，service 不存在。

- [ ] **Step 3: 实现错误类型和 view 映射**

```ts
export class PendingActionError extends Error {
  constructor(
    readonly code: PendingActionErrorCode,
    message: string,
    readonly httpStatus: number,
    readonly action?: PendingActionView,
  ) {
    super(message);
    this.name = 'PendingActionError';
  }
}
```

同文件定义并导出稳定联合类型：

```ts
export type PendingActionErrorCode =
  | 'ACTION_NOT_FOUND'
  | 'ACTION_EXPIRED'
  | 'ACTION_IN_PROGRESS'
  | 'ACTION_ALREADY_CONSUMED'
  | 'ACTION_STALE_PREVIEW'
  | 'ACTION_PAYLOAD_MISMATCH'
  | 'ACTION_PLAN_INVALID'
  | 'ACTION_APPLY_FAILED';
```

`createPendingActionPreview` 先验证 conversation subject，再 normalize、plan、hash、保存；只有 repo create 成功后返回 view。`listPendingActions` 调 repo 的过期/恢复入口后映射 JSON，损坏 JSON 作为 `ACTION_PLAN_INVALID` 失败记录处理，不把异常 payload 返回客户端。

- [ ] **Step 4: 抽出 reenrich 的纯工作流 planner**

在 `reenrich-enqueue.ts` 新增：

```ts
export async function planReenrich(subjectId: string, slug: string): Promise<PendingActionPreview> {
  const page = pagesRepo.getPageBySlug(subjectId, slug);
  const error = validateReenrichTarget(slug, page);
  if (error) throw new Error(error);
  return {
    kind: 'workflow', preHead: await getVaultHead(),
    summary: `重新丰富页面 ${slug}`,
    affectedPages: [{ slug, action: 'update' }], diff: null,
    warnings: [REENRICH_APPROVAL_WARNING],
  };
}
```

现有 `enqueueReenrich` 保持签名与行为。

- [ ] **Step 5: 运行预览与 reenrich 回归**

Run: `npx vitest run src/server/services/__tests__/pending-action-service-preview.test.ts src/server/services/__tests__/reenrich-enqueue.test.ts`  
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/server/services/pending-action-service.ts src/server/services/reenrich-enqueue.ts src/server/services/__tests__/pending-action-service-preview.test.ts src/server/services/__tests__/reenrich-enqueue.test.ts
git commit -m "feat: 增加页面与工作流审批预览服务"
```

---

### Task 6: 批准、拒绝与崩溃恢复服务

**Files:**
- Modify: `src/server/services/pending-action-service.ts`
- Create: `src/server/services/__tests__/pending-action-service-approval.test.ts`
- Modify: `src/server/db/repos/operations-repo.ts`

**Interfaces:**
- Consumes: `applyPlannedPageOperation()`、`enqueueReenrich()`、repo 条件状态函数、`operationsRepo.getById()`。
- Produces: `approvePendingAction()`、`rejectPendingAction()`、`recoverPendingActions()`、`maintainPendingActions()`。

- [ ] **Step 1: 写批准状态机失败测试**

覆盖以下独立用例：

```ts
await expect(approvePendingAction({ id: 'a1', subject, now }))
  .resolves.toMatchObject({ status: 'applied', operationId: 'op-1' });
expect(repoMocks.claimApproval).toHaveBeenCalledTimes(1);
expect(repoMocks.claimExecution).toHaveBeenCalledWith(
  'a1', subject.id, 'op-1', null, expect.any(String),
);
```

- payload hash 被篡改：抛 `ACTION_PAYLOAD_MISMATCH`，不 apply；
- replan HEAD 变化：`refreshPreview` 后抛 409 `ACTION_STALE_PREVIEW`，不 apply；
- apply 失败：`markFailed`，错误消息脱敏；
- reenrich：只调用 `enqueueReenrich` 一次并写 jobId；
- 已 applied：幂等返回；approved/executing：`ACTION_IN_PROGRESS`；expired：410；
- reject 只消费 pending；
- executing + operation applied/rolled-back 的恢复；
- approved/executing 超恢复窗口标 failed。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/pending-action-service-approval.test.ts`  
Expected: FAIL，批准/恢复函数不存在。

- [ ] **Step 3: 实现重新规划与执行分派**

`approvePendingAction` 的固定顺序： scoped read/expire/recover → conditional approve → recompute hash → parse payload → replan → stale refresh → conditional executing → apply/enqueue → applied；catch 中 stale 单独回 pending，其余失败写脱敏 error。

页面 `operationId` 使用重新规划得到的 `changeset.id`，在 apply 前传给 `claimExecution`；reenrich 在 enqueue 成功返回 jobId 后立即标记 applied，语义为“调度动作已执行”。

- [ ] **Step 4: 实现恢复与维护入口**

```ts
export function maintainPendingActions(now = new Date()): {
  expired: number; recovered: number; pruned: number;
} {
  const expired = pendingActionsRepo.expirePending(now.toISOString());
  const recovered = recoverPendingActions(now);
  const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60_000).toISOString();
  const pruned = pendingActionsRepo.pruneTerminal(cutoff);
  return { expired, recovered, pruned };
}
```

恢复只读取 `operations.status`，不自行操作 Git；Git/Saga 恢复仍由现有 wiki recovery 负责。

- [ ] **Step 5: 运行 approval 与 operation 回归**

Run: `npx vitest run src/server/services/__tests__/pending-action-service-approval.test.ts src/server/db/repos/__tests__/operations-repo.test.ts src/server/wiki/__tests__/recovery.test.ts`  
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/server/services/pending-action-service.ts src/server/services/__tests__/pending-action-service-approval.test.ts src/server/db/repos/operations-repo.ts
git commit -m "feat: 实现审批消费与异常恢复状态机"
```

---

### Task 7: `wiki.preview_change` 与动态 Query profile

**Files:**
- Create: `src/server/agents/tools/builtin/wiki-preview-change.ts`
- Create: `src/server/agents/tools/builtin/__tests__/wiki-preview-change.test.ts`
- Modify: `src/server/agents/tools/builtin/index.ts`
- Modify: `src/server/agents/tools/builtin/__tests__/registry.test.ts`
- Modify: `src/server/agents/tools/tool-context.ts`
- Modify: `src/server/agents/tools/profiles.ts`
- Modify: `src/server/agents/tools/__tests__/profiles.test.ts`
- Create: `src/server/services/query-intent.ts`
- Create: `src/server/services/__tests__/query-intent.test.ts`
- Modify: `src/server/services/query-tools.ts`
- Modify: `src/server/services/query-service.ts`
- Modify: `src/server/services/__tests__/resolve-query-tools.test.ts`
- Modify: `src/server/services/__tests__/query-service-agentic.test.ts`
- Modify: `src/server/llm/prompts/query-prompt.ts`
- Modify: `src/server/llm/prompts/__tests__/query-prompt.test.ts`

**Interfaces:**
- Consumes: `createPendingActionPreview()` 与 Task 1 的输入/输出类型。
- Produces: builtin `wiki.preview_change`、`resolveQueryMode()`、`resolveQueryTools(mode)`、支持 `conversationId/onPendingAction` 的 `streamAgenticQuery()`。

- [ ] **Step 1: 写工具注册、Profile 隔离和意图分类失败测试**

```ts
expect(resolveToolProfile('query:read').tools).not.toContain('wiki.preview_change');
expect(resolveToolProfile('query:propose').tools).toContain('wiki.preview_change');
for (const write of ['wiki.create', 'wiki.update', 'wiki.patch', 'wiki.delete', 'wiki.reenrich']) {
  expect(resolveToolProfile('query:propose').tools).not.toContain(write);
}
expect(resolveQueryMode('请删除 wiki 页面 old-note')).toBe('propose');
expect(resolveQueryMode('如何删除 wiki 页面？')).toBe('read');
expect(resolveQueryMode('Do not delete the page')).toBe('read');
```

分类测试覆盖五类操作的中英文明确命令、教程/假设/否定/模糊表达。

- [ ] **Step 2: 写 builtin handler 与 Query context 回调失败测试**

handler 测试断言输入转发到 `ctx.previewChange`，成功后调用一次 `ctx.onPendingAction` 并返回 view；能力未注入时抛稳定错误。Query service 测试断言 propose 模式编译 preview，read 模式不编译，`conversationId` 被绑定到预览服务。

- [ ] **Step 3: 运行测试确认 RED**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-preview-change.test.ts src/server/agents/tools/__tests__/profiles.test.ts src/server/services/__tests__/query-intent.test.ts src/server/services/__tests__/resolve-query-tools.test.ts src/server/services/__tests__/query-service-agentic.test.ts`  
Expected: FAIL。

- [ ] **Step 4: 注册 query-only preview 工具并扩展 ToolContext**

```ts
previewChange?(input: PreviewChangeInput): Promise<PendingActionView>;
onPendingAction?(action: PendingActionView): void;
conversationId?: string;
```

handler 不 import DB/service；调用 `ctx.previewChange` 后再调用 `ctx.onPendingAction`。`compile.ts::scopeToolContext` 对无 page allow-set 的 Query 保持原对象；不把 preview 能力注入 Fix/Curate/Ingest context。

- [ ] **Step 5: 实现保守 Query 模式判断与动态编译**

`resolveQueryMode` 先识别教程/否定表达并返回 read，再要求“写动作 + wiki/page/知识库/页面目标”同时命中才返回 propose。`resolveQueryTools(mode)` 与 `compileQueryTools` 使用 mode 选择 profile。

`buildQueryToolContext(subject, accessed, options?)` 仅在 options 同时提供 `conversationId` 与 `onPendingAction` 时注入：

```ts
previewChange: (input) => createPendingActionPreview({
  conversationId: options.conversationId,
  subject,
  input,
}),
onPendingAction: options.onPendingAction,
```

- [ ] **Step 6: 更新 Query prompt 的提案语义并运行测试**

Prompt 必须明确：“preview 只是等待用户按钮审批的提案，不得声称页面已修改；不要要求用户在聊天中回复确认。”

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-preview-change.test.ts src/server/agents/tools/builtin/__tests__/registry.test.ts src/server/agents/tools/__tests__/profiles.test.ts src/server/services/__tests__/query-intent.test.ts src/server/services/__tests__/resolve-query-tools.test.ts src/server/services/__tests__/query-service-agentic.test.ts src/server/llm/prompts/__tests__/query-prompt.test.ts`  
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/server/agents src/server/services/query-intent.ts src/server/services/query-tools.ts src/server/services/query-service.ts src/server/services/__tests__/query-intent.test.ts src/server/services/__tests__/resolve-query-tools.test.ts src/server/services/__tests__/query-service-agentic.test.ts src/server/llm/prompts/query-prompt.ts src/server/llm/prompts/__tests__/query-prompt.test.ts
git commit -m "feat: 接入写入预览工具与动态查询权限"
```

---

### Task 8: Query SSE 发出 PendingAction

**Files:**
- Modify: `src/app/api/query/route.ts`
- Modify: `src/app/api/query/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `resolveQueryMode()`、Task 7 新签名 `streamAgenticQuery({ mode, conversationId, onPendingAction, ... })`。
- Produces: SSE `event: pending-action`，data 为 `PendingActionView`。

- [ ] **Step 1: 写模式与 SSE 回调失败测试**

在 route mock 的 `streamAgenticQuery` 实现中调用传入的 `onPendingAction(action)`，断言响应包含：

```text
event: pending-action
data: {"actionId":"a1",...}
```

另断言普通问题传 `mode:'read'`，明确删除请求传 `mode:'propose'`，两者都传已创建/校验后的 `activeConversationId`。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/app/api/query/__tests__/route.test.ts`  
Expected: FAIL，route 未传 mode/callback 或未发事件。

- [ ] **Step 3: 在 stream start 内接线 mode 与 pending-action**

```ts
const mode = resolveQueryMode(trimmedQuestion);
const { stream: answerStream, accessed } = streamAgenticQuery({
  question: trimmedQuestion,
  subject,
  history,
  currentPageSlug: pageSlug,
  conversationId: activeConversationId,
  mode,
  onPendingAction: (action) => emit('pending-action', action),
  abortSignal: request.signal,
});
```

不把 action 写入 messages 表；刷新恢复由独立 GET API 完成。

- [ ] **Step 4: 运行 route 与 Query service 测试**

Run: `npx vitest run src/app/api/query/__tests__/route.test.ts src/server/services/__tests__/query-service-agentic.test.ts`  
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/app/api/query/route.ts src/app/api/query/__tests__/route.test.ts
git commit -m "feat: 通过查询流推送审批操作"
```

---

### Task 9: PendingAction 列表、批准与拒绝 API

**Files:**
- Create: `src/app/api/pending-actions/route.ts`
- Create: `src/app/api/pending-actions/__tests__/route.test.ts`
- Create: `src/app/api/pending-actions/[id]/approve/route.ts`
- Create: `src/app/api/pending-actions/[id]/approve/__tests__/route.test.ts`
- Create: `src/app/api/pending-actions/[id]/reject/route.ts`
- Create: `src/app/api/pending-actions/[id]/reject/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `listPendingActions()`、`approvePendingAction()`、`rejectPendingAction()`、`PendingActionError`。
- Produces: 三个 spec 定义的 Route Handler。

- [ ] **Step 1: 写 GET 列表失败测试**

覆盖：缺 `conversationId` 返回 400；required Subject；conversation 不存在/跨 Subject 返回 404；成功调用 service 并返回 `{ actions }`。

- [ ] **Step 2: 写 approve/reject 失败测试**

覆盖 auth/CSRF/required Subject 被调用，路由 params 解包，成功 200；`ACTION_STALE_PREVIEW` 409 带刷新 action；expired 410；not found/跨 Subject 404；请求体中的 payload/operation 被忽略，service 只收到 `{id, subject}`。

- [ ] **Step 3: 运行测试确认 RED**

Run: `npx vitest run src/app/api/pending-actions`  
Expected: FAIL，route 不存在。

- [ ] **Step 4: 实现统一错误响应映射**

在三个 route 内使用同一小型私有 helper 或新增 `src/app/api/pending-actions/error-response.ts`：

```ts
return NextResponse.json(
  { error: err.message, code: err.code, action: err.action ?? null },
  { status: err.httpStatus },
);
```

非 `PendingActionError` 统一 500 `{code:'ACTION_APPLY_FAILED'}`，不返回 stack/path。

- [ ] **Step 5: 实现安全中间件顺序**

GET：auth → parse query → `resolveSubjectFromRequest(required:true)` → conversation scope → service。POST：auth → CSRF → parse body → required Subject → service。reject/approve 请求体只用于 subject resolution。

- [ ] **Step 6: 运行全部新 route 测试**

Run: `npx vitest run src/app/api/pending-actions src/app/api/query/__tests__/route.test.ts`  
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/app/api/pending-actions
git commit -m "feat: 增加审批操作查询与处理接口"
```

---

### Task 10: 审批卡片与聊天状态恢复

**Files:**
- Create: `src/components/chat/pending-action-state.ts`
- Create: `src/components/chat/__tests__/pending-action-state.test.ts`
- Create: `src/components/chat/pending-action-card.tsx`
- Modify: `src/components/chat/chat-interface.tsx`
- Modify: `src/lib/api-fetch.ts`

**Interfaces:**
- Consumes: `PendingActionView`、三个 API、SSE `pending-action`。
- Produces: `upsertPendingAction(current, next)`、`replacePendingActions(next)`、`PendingActionCard`。

- [ ] **Step 1: 写 actionId upsert 与会话替换失败测试**

```ts
expect(upsertPendingAction([pending], { ...pending, status: 'applied' }))
  .toEqual([{ ...pending, status: 'applied' }]);
expect(upsertPendingAction([], pending)).toEqual([pending]);
expect(replacePendingActions(actionsForC2)).toEqual(actionsForC2);
```

另覆盖排序稳定性：按 `expiresAt`/actionId 保持服务端顺序，不重复卡片。

- [ ] **Step 2: 运行纯状态测试确认 RED**

Run: `npx vitest run src/components/chat/__tests__/pending-action-state.test.ts`  
Expected: FAIL，helper 不存在。

- [ ] **Step 3: 实现可访问审批卡片**

Props：

```ts
interface PendingActionCardProps {
  action: PendingActionView;
  busy: boolean;
  onApprove(actionId: string): void;
  onReject(actionId: string): void;
}
```

pending 显示两个按钮；approved/executing 显示 `role="status"`；diff 用可折叠 `<details><pre>`；workflow 显示“最终内容将在任务完成后产生”；终态禁用按钮。警告用列表展示，禁止把 diff 当 HTML 注入。

- [ ] **Step 4: 重命名 reset 状态并接入 SSE upsert**

`type PendingAction` 改为 `type PendingResetConfirmation = { kind:'reset' } | null`，状态名改 `pendingResetConfirmation`。新增 `const [pendingActions, setPendingActions] = useState<PendingActionView[]>([])`；SSE 分支：

```ts
} else if (event === 'pending-action') {
  setPendingActions((current) => upsertPendingAction(current, data as PendingActionView));
}
```

普通聊天确认逻辑只能读取 reset 状态，绝不读取 `pendingActions`。

- [ ] **Step 5: 实现会话恢复和批准/拒绝**

加载 conversation 时并行请求 messages 与 `/api/pending-actions?conversationId=...`；切换 Subject/Conversation 时取消旧请求并替换 action 列表。POST body 必须包含当前 `subjectId`；API 返回 action 后 upsert。

批准页面变更成功后 invalidate `pages/page-detail/graph/search/backlinks/context/frontmatter/history` 并 `router.refresh()`；返回 jobId 时 dispatch `wiki:job-started`。

- [ ] **Step 6: 修正 useApiFetch 写请求说明并运行验证**

保持 hook 只自动为 GET 加 subject；注释明确 approve/reject body 负责 subjectId。运行：

Run: `npx vitest run src/components/chat/__tests__/pending-action-state.test.ts && npx tsc --noEmit`  
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add src/components/chat src/lib/api-fetch.ts
git commit -m "feat: 在聊天中展示并处理审批卡片"
```

---

### Task 11: 维护清理、架构文档与全量验收

**Files:**
- Modify: `src/server/jobs/worker.ts`
- Modify: `src/server/jobs/__tests__/worker.test.ts`
- Modify: `src/app/CLAUDE.md`
- Modify: `src/components/CLAUDE.md`
- Modify: `src/server/db/CLAUDE.md`
- Modify: `src/server/services/CLAUDE.md`
- Modify: `src/server/wiki/CLAUDE.md`
- Modify: `docs/superpowers/plans/2026-07-11-wiki-approval-phase1b.md`

**Interfaces:**
- Consumes: `maintainPendingActions()`。
- Produces: worker 启动与每分钟 tick 的 best-effort 审批卫生维护；完成勾选的执行记录。

- [ ] **Step 1: 写 worker 维护接线失败测试**

mock `maintainPendingActions`，启动 worker 后断言立即调用一次；推进 fake timer 60 秒后再次调用；抛错时记录 `[maintenance] pending_actions maintenance failed` 且 worker 不退出。

- [ ] **Step 2: 运行测试确认 RED**

Run: `npx vitest run src/server/jobs/__tests__/worker.test.ts`  
Expected: FAIL，worker 未调用审批维护。

- [ ] **Step 3: 接入启动与周期维护**

新增 `maintainPendingActionsTick()`，记录非零 expired/recovered/pruned；在 `startWorker` 的启动清理和 `maintenanceId` 回调中调用，位置与 job_events/operations/usage 清理并列，独立于 `maintenanceEnabled`。

- [ ] **Step 4: 更新模块文档**

文档必须记录：

- Query `read/propose` 工具边界；
- `pending_actions` 表、TTL、30 天保留和两个执行引用；
- page plan/apply 与锁内 HEAD；
- 三个 API、SSE `pending-action` 和卡片恢复；
- reenrich 只审批调度动作；
- `llm-config.example.json` 不变。

- [ ] **Step 5: 运行全量测试、lint、类型检查和构建**

Run: `npm test -- --run`  
Expected: 全部测试 PASS。

Run: `npm run lint`  
Expected: exit 0。

Run: `npx tsc --noEmit`  
Expected: exit 0。

Run: `npm run build`  
Expected: Next.js production build 成功。

Run: `npx vitest run src/server/llm/__tests__/config-example.test.ts`  
Expected: PASS，且 `git diff -- llm-config.example.json` 无输出。

- [ ] **Step 6: 检查审批安全不变量**

Run: `rg -n "wiki\.(create|update|patch|delete|reenrich)" src/server/agents/tools/profiles.ts`  
Expected: `query:read`/`query:propose` 不包含这些实际写工具；出现项只属于 Fix/Curate 或常量定义。

Run: `git diff --check && git status --short`  
Expected: 无 whitespace error；只包含本任务文档与计划勾选更新。

- [ ] **Step 7: 更新计划勾选并提交最终文档**

把本计划已完成步骤改为 `[x]`，在末尾追加实际验证摘要和测试数量，然后提交：

```bash
git add src/server/jobs/worker.ts src/server/jobs/__tests__/worker.test.ts src/app/CLAUDE.md src/components/CLAUDE.md src/server/db/CLAUDE.md src/server/services/CLAUDE.md src/server/wiki/CLAUDE.md docs/superpowers/plans/2026-07-11-wiki-approval-phase1b.md
git commit -m "docs: 记录 Wiki 审批闭环实现与验证结果"
```

---

## 最终完成条件

- 11 个任务全部完成并各自提交；
- worktree 干净；
- 全量测试、lint、TypeScript 和生产构建全部通过；
- Query Profile 无实际写工具；
- 未批准 action 不产生文件、数据库索引、Git 或 job 写入；
- stale HEAD 和并发批准测试通过；
- `llm-config.example.json` 无变更；
- 使用 `superpowers:verification-before-completion` 复核证据；
- 使用 `superpowers:finishing-a-development-branch` 按仓库约定从主分支执行 `--no-ff` 合并，合并 message 含 `feat/wiki-approval-phase1b`，然后删除分支和 worktree。
