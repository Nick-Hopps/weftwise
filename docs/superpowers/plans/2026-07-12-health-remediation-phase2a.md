# Wiki Health Remediation Phase 2A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为全部 Health findings 增加稳定 ID、服务端统一处置路由和可追踪状态，并彻底删除 Research 对数组下标的依赖。

**Architecture:** 先在 lint 快照边界生成确定性 SHA-256 identity，再用纯 `remediation-router` 和 `remediation-status` 生成 Health 契约；写请求通过统一 API 以 `lintJobId` 做 CAS 校验，并把 `remediationContext` 传给现有 Fix、Curate、Research 与 Re-ingest workflow。UI 只渲染服务端返回的 actions，不再维护 finding 类型白名单。

**Tech Stack:** TypeScript 5、Next.js 15 Route Handlers、React 19、TanStack React Query、Vitest、Drizzle / better-sqlite3、Node `crypto`。

---

## 执行约束

- 工作目录：`.worktrees/health-remediation-phase2a`
- 分支：`feat/health-remediation-phase2a`
- 设计依据：`docs/superpowers/specs/2026-07-12-health-remediation-phase2a-design.md`
- 每个任务严格执行 RED → GREEN → 定向测试 → 中文 Conventional Commit。
- 不新增数据库表或 migration。
- 不新增 LLM task、prompt、模型路由；`llm-config.example.json` 必须保持不变。
- 不运行 `npm run eval:retrieval`，因为本阶段不改 `src/server/search/**` 或检索参数。
- orphan 不得自动删除；orphan-source 删除继续走现有专用 DELETE API 和二次确认。

## 文件职责图

### 新增文件

- `src/server/services/finding-identity.ts`：规范化 finding 字段、计算 SHA-256 ID、稳定去重。
- `src/server/services/remediation-router.ts`：九类 finding 到 workflow/actions/初始状态的穷尽纯映射。
- `src/server/services/remediation-context.ts`：解析 job context、生成幂等 key、查找重复任务。
- `src/server/services/remediation-status.ts`：用当前 lint 快照和近期 jobs 推导 plans / recent outcomes。
- `src/server/services/remediation-service.ts`：CAS 校验、action 校验、workflow 入队编排。
- `src/server/services/source-reingest.ts`：抽取 orphan-source re-ingest/requeue 逻辑，供专用 API 与 remediation API 共用。
- `src/app/api/health/remediations/route.ts`：统一 Health remediation 写入口。
- `src/components/health/remediation-ui.ts`：客户端批量 ID 收集与动作展示纯 helper。

### 主要修改文件

- `src/lib/contracts.ts`：finding ID、remediation、Health snapshot、job context 契约。
- `src/server/services/lint-{service,latest,deterministic}.ts`：新旧快照 identity 与 stale source ID。
- `src/server/db/repos/jobs-repo.ts`、`src/server/jobs/queue.ts`：requeue 前原子合并 context。
- `src/server/services/fix-service.ts`：可选 finding scope。
- `src/server/services/research-service.ts`、`src/app/api/research/route.ts`：稳定 finding IDs。
- `src/app/api/lint/latest/route.ts`：返回 HealthSnapshot。
- `src/components/health/{health-view,finding-row}.tsx`、`src/hooks/use-lint-summary.ts`：plan-driven UI。

## Task 1：共享契约与 Finding Identity

**Files:**
- Create: `src/server/services/finding-identity.ts`
- Create: `src/server/services/__tests__/finding-identity.test.ts`
- Modify: `src/lib/contracts.ts:284-307`
- Modify: `src/components/health/__tests__/lint-findings.test.ts:5-17`

- [ ] **Step 1：先写 identity 失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { findingId, identifyFindings } from '../finding-identity';

const base = {
  type: 'broken-link' as const,
  severity: 'warning' as const,
  pageSlug: 'a',
  description: 'Broken   [[Ghost]]\r\nlink',
  suggestedFix: null,
  subjectId: 's1',
  subjectSlug: 'general',
};

describe('finding identity', () => {
  it('规范化空白且忽略非身份字段', () => {
    const first = findingId(base);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(findingId({
      ...base,
      severity: 'critical',
      description: 'Broken [[Ghost]] link',
      suggestedFix: 'changed',
      failedJobId: 'job-x',
    })).toBe(first);
  });

  it('subject、类型、页面、来源或描述变化会改变 ID', () => {
    const first = findingId(base);
    expect(findingId({ ...base, subjectId: 's2' })).not.toBe(first);
    expect(findingId({ ...base, pageSlug: 'b' })).not.toBe(first);
    expect(findingId({ ...base, sourceId: 'src-1' })).not.toBe(first);
    expect(findingId({ ...base, description: 'other' })).not.toBe(first);
  });

  it('按 ID 去重并保留首次出现顺序', () => {
    const result = identifyFindings([base, { ...base }, { ...base, pageSlug: 'b' }]);
    expect(result).toHaveLength(2);
    expect(result.map((finding) => finding.pageSlug)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2：运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/finding-identity.test.ts`

Expected: FAIL，提示无法解析 `../finding-identity` 或导出不存在。

- [ ] **Step 3：增加共享契约**

在 `src/lib/contracts.ts` 中把来源字段注释扩展到 stale-source，并加入以下契约：

```ts
export interface EnrichedLintFinding extends LintFinding {
  id: string;
  subjectId: SubjectId;
  subjectSlug: string;
}

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

export interface RemediationContext {
  lintJobId: string;
  findingIds: string[];
  action: Exclude<RemediationActionType, 'review-source'>;
}

export interface HealthSnapshot extends LintLatestResult {
  remediations: Record<string, RemediationPlan>;
  recentOutcomes: Record<string, RemediationStatus>;
}
```

- [ ] **Step 4：实现 identity 纯函数**

```ts
import { createHash } from 'node:crypto';
import type { EnrichedLintFinding, LintFinding, SubjectId } from '@/lib/contracts';

type FindingWithSubject = LintFinding & {
  subjectId: SubjectId;
  subjectSlug: string;
  id?: string;
};

function normalizedDescription(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findingId(finding: FindingWithSubject): string {
  const identity = [
    'lint-finding:v1',
    finding.subjectId,
    finding.type,
    finding.pageSlug,
    finding.sourceId ?? finding.sourceFilename ?? '',
    normalizedDescription(finding.description),
  ].join('\0');
  return createHash('sha256').update(identity).digest('hex');
}

export function identifyFindings(
  findings: FindingWithSubject[],
): EnrichedLintFinding[] {
  const unique = new Map<string, EnrichedLintFinding>();
  for (const finding of findings) {
    const id = findingId(finding);
    if (!unique.has(id)) unique.set(id, { ...finding, id });
  }
  return [...unique.values()];
}
```

- [ ] **Step 5：运行测试确认 GREEN**

给 `lint-findings.test.ts` 的 `f()` fixture 增加 `id: 'a'.repeat(64)`，然后运行：

Run: `npx vitest run src/server/services/__tests__/finding-identity.test.ts src/components/health/__tests__/lint-findings.test.ts`

Expected: PASS。

Run: `npx tsc --noEmit`

Expected: PASS，新增必填 ID 未留下类型缺口。

- [ ] **Step 6：提交 Task 1**

```bash
git add src/lib/contracts.ts src/server/services/finding-identity.ts src/server/services/__tests__/finding-identity.test.ts src/components/health/__tests__/lint-findings.test.ts
git commit -m "feat: 增加 Health finding 稳定身份契约"
```

## Task 2：Lint 新旧快照接入稳定 ID

**Files:**
- Modify: `src/server/services/lint-service.ts:76-136`
- Modify: `src/server/services/lint-latest.ts:1-34`
- Modify: `src/server/services/lint-deterministic.ts:175-194`
- Modify: `src/server/services/__tests__/lint-latest.test.ts`
- Modify: `src/server/services/__tests__/lint-deterministic.test.ts`

- [ ] **Step 1：为旧快照与 stale-source 写失败测试**

在 `lint-latest.test.ts` 增加：

```ts
it('旧快照补算 ID、覆盖伪造 ID，并按规范 ID 去重', () => {
  const raw = {
    ...finding('warning'),
    id: 'spoofed',
    description: 'same   issue',
  };
  const result = selectLatestFindings([
    job({ resultJson: JSON.stringify({ findings: [raw, { ...raw, description: 'same issue' }] }) }),
  ]);
  expect(result.findings).toHaveLength(1);
  expect(result.findings[0].id).toMatch(/^[a-f0-9]{64}$/);
  expect(result.findings[0].id).not.toBe('spoofed');
});
```

在 `lint-deterministic.test.ts` 的 stale source 用例增加：

```ts
expect(findings[0]).toMatchObject({
  type: 'stale-source',
  sourceId: 'src-stale',
});
```

- [ ] **Step 2：运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/lint-latest.test.ts src/server/services/__tests__/lint-deterministic.test.ts`

Expected: FAIL，旧快照没有 ID，stale-source 没有 sourceId。

- [ ] **Step 3：在 lint-latest 统一规范化读取结果**

```ts
import { identifyFindings } from './finding-identity';

// JSON 解析成功后：
const raw = parsed.findings as Array<EnrichedLintFinding & { id?: string }>;
findings = identifyFindings(raw);
```

空列表、损坏 JSON、最新 completedAt 选择和 bySeverity 逻辑保持不变。

- [ ] **Step 4：在 lint-service 写入和事件发出前生成同一批 ID**

为单 subject finding 使用同一个 helper：

```ts
function enrichFindings(subject: Subject, findings: LintFinding[]): EnrichedLintFinding[] {
  return identifyFindings(
    findings.map((finding) => ({
      ...finding,
      subjectId: subject.id,
      subjectSlug: subject.slug,
    })),
  );
}
```

确定性与语义阶段都先得到 `enrichedFindings`，再同时用于 `allFindings.push(...)` 和事件 `data.findings`，保证 job event 与最终 resultJson 的 ID 相同。

- [ ] **Step 5：给 stale-source 写入精确 sourceId**

```ts
findings.push({
  type: 'stale-source',
  severity: 'info',
  pageSlug: page.slug,
  description: `Source file "${source.filename}" linked to "${page.slug}" (subject: ${subject.slug}) is missing or changed on disk.`,
  suggestedFix: 'Re-ingest the source file to update the wiki page content.',
  sourceId: source.id,
  sourceFilename: source.filename,
});
```

- [ ] **Step 6：运行定向测试和类型检查**

Run: `npx vitest run src/server/services/__tests__/finding-identity.test.ts src/server/services/__tests__/lint-latest.test.ts src/server/services/__tests__/lint-deterministic.test.ts`

Expected: PASS。

Run: `npx tsc --noEmit`

Expected: PASS。

- [ ] **Step 7：提交 Task 2**

```bash
git add src/server/services/lint-service.ts src/server/services/lint-latest.ts src/server/services/lint-deterministic.ts src/server/services/__tests__/lint-latest.test.ts src/server/services/__tests__/lint-deterministic.test.ts
git commit -m "feat: 在 Lint 快照中持久化稳定 finding ID"
```

## Task 3：九类 Finding 的纯 Remediation Router

**Files:**
- Create: `src/server/services/remediation-router.ts`
- Create: `src/server/services/__tests__/remediation-router.test.ts`

- [ ] **Step 1：写九类映射的表驱动失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { routeFinding } from '../remediation-router';
import type { EnrichedLintFinding, LintFinding } from '@/lib/contracts';

function finding(type: LintFinding['type'], over: Partial<EnrichedLintFinding> = {}): EnrichedLintFinding {
  return {
    id: type.padEnd(64, '0').slice(0, 64),
    type,
    severity: 'warning',
    pageSlug: 'page-a',
    description: type,
    suggestedFix: null,
    subjectId: 's1',
    subjectSlug: 'general',
    ...over,
  };
}

describe('routeFinding', () => {
  it.each([
    ['missing-frontmatter', 'fix', 'fix'],
    ['broken-link', 'fix', 'fix'],
    ['missing-crossref', 'fix', 'fix'],
    ['contradiction', 'fix', 'fix'],
    ['orphan', 'curate', 'curate'],
    ['coverage-gap', 'research', 'research'],
    ['thin-page', 'research', 'research'],
  ] as const)('%s → %s', (type, workflow, action) => {
    const plan = routeFinding(finding(type));
    expect(plan).toMatchObject({ workflow, status: 'awaiting-approval' });
    expect(plan.actions.map((item) => item.type)).toContain(action);
  });

  it('stale-source 有来源时只导航，无来源时 skipped', () => {
    expect(routeFinding(finding('stale-source', { sourceId: 'src-1' }))).toMatchObject({
      workflow: 'source-review',
      status: 'awaiting-approval',
      actions: [{ type: 'review-source', href: '/sources?sourceId=src-1' }],
    });
    expect(routeFinding(finding('stale-source'))).toMatchObject({ status: 'skipped', actions: [] });
  });

  it('orphan-source 只有 re-ingest，router 不提供删除动作', () => {
    const plan = routeFinding(finding('orphan-source', { sourceId: 'src-1', pageSlug: '' }));
    expect(plan.actions.map((item) => item.type)).toEqual(['re-ingest']);
  });

  it('All Subjects 只读时移除执行动作', () => {
    expect(routeFinding(finding('broken-link'), { readOnly: true }).actions).toEqual([]);
  });
});
```

- [ ] **Step 2：运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/remediation-router.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3：实现穷尽 router**

```ts
import type {
  EnrichedLintFinding,
  RemediationAction,
  RemediationPlan,
  RemediationWorkflow,
} from '@/lib/contracts';

function action(
  type: RemediationAction['type'],
  label: string,
  href?: string,
): RemediationAction {
  return { type, label, destructive: false, ...(href ? { href } : {}) };
}

function plan(
  finding: EnrichedLintFinding,
  workflow: RemediationWorkflow,
  reason: string,
  actions: RemediationAction[],
  readOnly: boolean,
): RemediationPlan {
  return {
    findingId: finding.id,
    workflow,
    status: actions.length === 0 ? 'skipped' : 'awaiting-approval',
    actions: readOnly ? [] : actions,
    reason,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported lint finding type: ${String(value)}`);
}

export function routeFinding(
  finding: EnrichedLintFinding,
  options: { readOnly?: boolean } = {},
): RemediationPlan {
  const readOnly = options.readOnly === true;
  switch (finding.type) {
    case 'missing-frontmatter':
      return plan(finding, 'fix', 'Fix can repair required frontmatter deterministically.', [action('fix', 'Fix this issue')], readOnly);
    case 'broken-link':
      return plan(finding, 'fix', 'Fix can relink or unwrap the broken target under write guards.', [action('fix', 'Fix this link')], readOnly);
    case 'missing-crossref':
      return plan(finding, 'fix', 'Fix can add a verified natural cross-reference.', [action('fix', 'Add cross-reference')], readOnly);
    case 'contradiction':
      return plan(finding, 'fix', 'Fix can inspect page and source evidence before reconciling the claim.', [action('fix', 'Review contradiction')], readOnly);
    case 'orphan':
      return plan(finding, 'curate', 'Curate can inspect this page and its neighbors without auto-deleting it.', [action('curate', 'Tidy this page')], readOnly);
    case 'stale-source':
      return finding.sourceId
        ? plan(
            finding,
            'source-review',
            'The source must be reviewed or replaced before it can be ingested safely.',
            [action('review-source', 'Review source', `/sources?sourceId=${encodeURIComponent(finding.sourceId)}`)],
            readOnly,
          )
        : plan(finding, 'source-review', 'The finding has no source ID, so no safe source action is available.', [], readOnly);
    case 'coverage-gap':
      return plan(finding, 'research', 'Research can discover candidate sources; ingestion still requires confirmation.', [action('research', 'Research this gap')], readOnly);
    case 'orphan-source':
      return finding.sourceId
        ? plan(finding, 're-ingest', 'Retry ingestion or use the separately confirmed delete action.', [action('re-ingest', 'Retry ingest')], readOnly)
        : plan(finding, 're-ingest', 'The finding has no source ID, so ingestion cannot be retried safely.', [], readOnly);
    case 'thin-page':
      return plan(finding, 'research', 'This detector reports a short page with no sources, so research is the safe next step.', [action('research', 'Research this topic')], readOnly);
    default:
      return assertNever(finding.type);
  }
}
```

`readOnly` 只移除 actions，不改变 workflow/reason；如果基础 plan 本来可执行，状态仍为 `awaiting-approval`，表示它在 subject-scoped 模式下可处置。相应测试将 All Subjects 断言改为只检查 actions 为空。

- [ ] **Step 4：运行测试确认 GREEN**

Run: `npx vitest run src/server/services/__tests__/remediation-router.test.ts`

Expected: PASS，全部九类映射覆盖。

- [ ] **Step 5：提交 Task 3**

```bash
git add src/server/services/remediation-router.ts src/server/services/__tests__/remediation-router.test.ts
git commit -m "feat: 增加 Health finding 统一处置路由"
```

## Task 4：Job Remediation Context、幂等键与原子 Requeue

**Files:**
- Create: `src/server/services/remediation-context.ts`
- Create: `src/server/services/__tests__/remediation-context.test.ts`
- Modify: `src/server/db/repos/jobs-repo.ts`
- Modify: `src/server/db/repos/__tests__/jobs-repo.test.ts`
- Modify: `src/server/jobs/queue.ts`

- [ ] **Step 1：写 context 与 repo 失败测试**

`remediation-context.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { contextKey, findDuplicateRemediationJob, readRemediationContext } from '../remediation-context';

const context = { lintJobId: 'lint-1', findingIds: ['b', 'a', 'a'], action: 'fix' as const };

it('幂等键对 findingIds 去重排序', () => {
  expect(contextKey('s1', context)).toBe('s1\0lint-1\0fix\0a,b');
});

it('安全解析 paramsJson，损坏 JSON 返回 null', () => {
  expect(readRemediationContext({ paramsJson: JSON.stringify({ remediationContext: context }) } as never))
    .toEqual({ ...context, findingIds: ['a', 'b'] });
  expect(readRemediationContext({ paramsJson: '{' } as never)).toBeNull();
});

it('找到 pending/running 或完成但待复检的重复任务', () => {
  const jobs = [{
    id: 'job-1', subjectId: 's1', status: 'running', completedAt: null,
    paramsJson: JSON.stringify({ remediationContext: context }),
  }] as never;
  expect(findDuplicateRemediationJob(jobs, 's1', context, '2026-07-12T00:00:00Z')?.id).toBe('job-1');
});
```

在 jobs repo 集成测试增加：

```ts
it('failed ingest 合并 context 后 requeue，保留原参数与 checkpoint', async () => {
  const { repo } = await setupJobs();
  const { getRawDb } = await import('../../client');
  const sqlite = getRawDb();
  const failed = repo.enqueueJob(
    'ingest',
    { sourceId: 'src-x', filename: 'a.md', subjectId: 's1' },
    's1',
  );
  repo.failJob(failed.id, new Error('boom'));
  sqlite.prepare(
    'INSERT INTO ingest_checkpoints (job_id, kind, key, data_json, created_at) VALUES (?,?,?,?,?)',
  ).run(failed.id, 'writer-page', 'a', '{}', NOW);

  const context = { lintJobId: 'lint-1', findingIds: ['a'.repeat(64)], action: 're-ingest' };
  const requeued = repo.requeueJobWithParams(failed.id, { remediationContext: context });

  expect(requeued?.status).toBe('pending');
  expect(JSON.parse(requeued!.paramsJson)).toEqual({
    sourceId: 'src-x',
    filename: 'a.md',
    subjectId: 's1',
    remediationContext: context,
  });
  const checkpoint = sqlite
    .prepare('SELECT COUNT(*) AS count FROM ingest_checkpoints WHERE job_id = ?')
    .get(failed.id) as { count: number };
  expect(checkpoint.count).toBe(1);
});
```

- [ ] **Step 2：运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/remediation-context.test.ts src/server/db/repos/__tests__/jobs-repo.test.ts`

Expected: FAIL，context 模块与 repo helper 不存在。

- [ ] **Step 3：实现 context 纯 helper**

```ts
import type { Job, RemediationContext } from '@/lib/contracts';

const ACTIONS = new Set<RemediationContext['action']>(['fix', 'curate', 'research', 're-ingest']);

export function normalizeRemediationContext(context: RemediationContext): RemediationContext {
  return {
    lintJobId: context.lintJobId,
    findingIds: [...new Set(context.findingIds)].sort(),
    action: context.action,
  };
}

export function readRemediationContext(job: Pick<Job, 'paramsJson'>): RemediationContext | null {
  try {
    const parsed = JSON.parse(job.paramsJson) as { remediationContext?: Partial<RemediationContext> };
    const context = parsed.remediationContext;
    if (
      !context ||
      typeof context.lintJobId !== 'string' ||
      !Array.isArray(context.findingIds) ||
      !context.findingIds.every((id) => typeof id === 'string') ||
      !ACTIONS.has(context.action as RemediationContext['action'])
    ) return null;
    return normalizeRemediationContext(context as RemediationContext);
  } catch {
    return null;
  }
}

export function contextKey(subjectId: string, context: RemediationContext): string {
  const normalized = normalizeRemediationContext(context);
  return [subjectId, normalized.lintJobId, normalized.action, normalized.findingIds.join(',')].join('\0');
}

export function findDuplicateRemediationJob(
  jobs: Job[],
  subjectId: string,
  context: RemediationContext,
  lintRanAt: string | null,
): Job | null {
  const expected = contextKey(subjectId, context);
  let duplicate: Job | null = null;
  for (const job of jobs) {
    if (job.subjectId !== subjectId || job.status === 'failed') continue;
    const current = readRemediationContext(job);
    if (!current || contextKey(subjectId, current) !== expected) continue;
    const reusable = job.status === 'pending' || job.status === 'running' || (
      job.status === 'completed' &&
      (!lintRanAt || !job.completedAt || job.completedAt > lintRanAt)
    );
    if (reusable && (!duplicate || job.createdAt > duplicate.createdAt)) duplicate = job;
  }
  return duplicate;
}
```

- [ ] **Step 4：实现原子 merge + requeue**

在 `jobs-repo.ts` 增加：

```ts
export function requeueJobWithParams(
  jobId: string,
  patch: Record<string, unknown>,
): Job | null {
  const sqlite = getRawDb();
  const tx = sqlite.transaction(() => {
    const row = sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId) as JobRow | undefined;
    if (!row || row.status !== 'failed') return null;
    const current = JSON.parse(row.params_json ?? '{}') as Record<string, unknown>;
    sqlite.prepare(`
      UPDATE jobs
      SET params_json = ?, status = 'pending', lease_expires_at = NULL,
          heartbeat_at = NULL, cancel_requested = 0
      WHERE id = ? AND status = 'failed'
    `).run(JSON.stringify({ ...current, ...patch }), jobId);
    return getJob(jobId);
  });
  return tx();
}
```

不得删除 `ingest_checkpoints`。在 `queue.ts` 暴露：

```ts
export function requeueJobWithParams(
  jobId: string,
  patch: Record<string, unknown>,
): Job | null {
  return jobsRepo.requeueJobWithParams(jobId, patch);
}
```

- [ ] **Step 5：运行测试确认 GREEN**

Run: `npx vitest run src/server/services/__tests__/remediation-context.test.ts src/server/db/repos/__tests__/jobs-repo.test.ts`

Expected: PASS。

- [ ] **Step 6：提交 Task 4**

```bash
git add src/server/services/remediation-context.ts src/server/services/__tests__/remediation-context.test.ts src/server/db/repos/jobs-repo.ts src/server/db/repos/__tests__/jobs-repo.test.ts src/server/jobs/queue.ts
git commit -m "feat: 关联处置任务与来源 finding"
```

## Task 5：Remediation 状态推导

**Files:**
- Create: `src/server/services/remediation-status.ts`
- Create: `src/server/services/__tests__/remediation-status.test.ts`

- [ ] **Step 1：写状态机失败测试**

覆盖以下输入：

```ts
const broken: EnrichedLintFinding = {
  id: 'a'.repeat(64), type: 'broken-link', severity: 'warning', pageSlug: 'a',
  description: 'broken', suggestedFix: null, subjectId: 's1', subjectSlug: 'general',
};
const gap: EnrichedLintFinding = {
  id: 'b'.repeat(64), type: 'coverage-gap', severity: 'info', pageSlug: 'topic',
  description: 'topic gap', suggestedFix: null, subjectId: 's1', subjectSlug: 'general',
};
const fixContext = { lintJobId: 'lint-1', findingIds: [broken.id], action: 'fix' as const };
const researchContext = { lintJobId: 'lint-1', findingIds: [gap.id], action: 'research' as const };

function lintResult(findings: EnrichedLintFinding[], ranAt = '2026-07-12T10:00:00Z'): LintLatestResult {
  return {
    jobId: 'lint-1', ranAt, findings,
    bySeverity: { critical: 0, warning: findings.length, info: 0 },
  };
}

function job(
  status: Job['status'],
  context: RemediationContext,
  over: Partial<Job> = {},
): Job {
  return {
    id: 'job-1', type: context.action === 'research' ? 'research' : 'fix', status,
    subjectId: 's1', paramsJson: JSON.stringify({ remediationContext: context }),
    resultJson: null, createdAt: '2026-07-12T10:00:30Z', startedAt: null,
    completedAt: status === 'completed' || status === 'failed' ? '2026-07-12T10:01:00Z' : null,
    leaseExpiresAt: null, heartbeatAt: null, attemptCount: 1, ...over,
  };
}

it.each([
  ['pending', 'queued'],
  ['running', 'queued'],
  ['failed', 'failed'],
] as const)('%s job → %s', (jobStatus, expected) => {
  const snapshot = buildHealthSnapshot(lintResult([broken]), [job(jobStatus, fixContext)]);
  expect(snapshot.remediations[broken.id].status).toBe(expected);
});

it('Fix 完成晚于当前 lint 时保持 queued，等下一次 lint 复检', () => {
  const snapshot = buildHealthSnapshot(lintResult([broken], '2026-07-12T10:00:00Z'), [
    job('completed', fixContext, { completedAt: '2026-07-12T10:01:00Z' }),
  ]);
  expect(snapshot.remediations[broken.id].status).toBe('queued');
});

it('后续 lint 中 ID 消失且后置校验 clean → recent outcome fixed', () => {
  const snapshot = buildHealthSnapshot(lintResult([], '2026-07-12T10:02:00Z'), [
    job('completed', fixContext, {
      completedAt: '2026-07-12T10:01:00Z',
      resultJson: JSON.stringify({ postconditionStatus: 'clean', semanticStatus: 'clean' }),
    }),
  ]);
  expect(snapshot.recentOutcomes[broken.id]).toBe('fixed');
});

it('Research 有候选等待批准，无候选 skipped', () => {
  const withCandidates = job('completed', researchContext, {
    resultJson: JSON.stringify({ candidates: [{ url: 'https://example.com' }] }),
  });
  const withoutCandidates = job('completed', researchContext, {
    resultJson: JSON.stringify({ candidates: [] }),
  });
  expect(buildHealthSnapshot(lintResult([gap], '2026-07-12T10:02:00Z'), [withCandidates]).remediations[gap.id].status)
    .toBe('awaiting-approval');
  expect(buildHealthSnapshot(lintResult([gap], '2026-07-12T10:02:00Z'), [withoutCandidates]).remediations[gap.id].status)
    .toBe('skipped');
});
```

```ts
it('复检后仍存在：有写入 failed，无写入 skipped', () => {
  const withWrites = job('completed', fixContext, {
    completedAt: '2026-07-12T10:01:00Z',
    resultJson: JSON.stringify({ writes: 1, postconditionStatus: 'clean' }),
  });
  const noWrites = job('completed', fixContext, {
    completedAt: '2026-07-12T10:01:00Z',
    resultJson: JSON.stringify({ writes: 0, postconditionStatus: 'clean' }),
  });
  expect(buildHealthSnapshot(lintResult([broken], '2026-07-12T10:02:00Z'), [withWrites]).remediations[broken.id].status)
    .toBe('failed');
  expect(buildHealthSnapshot(lintResult([broken], '2026-07-12T10:02:00Z'), [noWrites]).remediations[broken.id].status)
    .toBe('skipped');
});

it('语义后置校验非 clean 时不得产生 fixed outcome', () => {
  const snapshot = buildHealthSnapshot(lintResult([], '2026-07-12T10:02:00Z'), [
    job('completed', fixContext, {
      completedAt: '2026-07-12T10:01:00Z',
      resultJson: JSON.stringify({ writes: 1, postconditionStatus: 'residual', semanticStatus: 'residual' }),
    }),
  ]);
  expect(snapshot.recentOutcomes[broken.id]).toBe('failed');
});

it('只扫描最后 MAX_REMEDIATION_JOBS 条', () => {
  const old = job('running', fixContext, { id: 'old', createdAt: '2026-01-01T00:00:00Z' });
  const noise = Array.from({ length: MAX_REMEDIATION_JOBS }, (_, index) =>
    job('completed', {
      lintJobId: 'lint-1',
      findingIds: [String(index).padStart(64, '0')],
      action: 'fix',
    }, { createdAt: `2026-07-12T10:${String(index % 60).padStart(2, '0')}:00Z` }),
  );
  expect(buildHealthSnapshot(lintResult([broken]), [old, ...noise]).remediations[broken.id].jobId)
    .toBeUndefined();
});
```

- [ ] **Step 2：运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/remediation-status.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3：实现有界状态解析**

```ts
import type { HealthSnapshot, Job, LintLatestResult, RemediationPlan, RemediationStatus } from '@/lib/contracts';
import { readRemediationContext } from './remediation-context';
import { routeFinding } from './remediation-router';

export const MAX_REMEDIATION_JOBS = 200;

function resultObject(job: Job): Record<string, unknown> {
  try {
    return job.resultJson ? JSON.parse(job.resultJson) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function completedOutcome(job: Job): RemediationStatus {
  const context = readRemediationContext(job);
  const result = resultObject(job);
  if (job.status === 'failed') return 'failed';
  if (context?.action === 'research') {
    return Array.isArray(result.candidates) && result.candidates.length > 0
      ? 'awaiting-approval'
      : 'skipped';
  }
  if ((context?.action === 'fix' || context?.action === 'curate') && result.writes === 0) {
    return 'skipped';
  }
  if (result.postconditionStatus === 'residual' || result.semanticStatus === 'failed' || result.semanticStatus === 'residual') {
    return 'failed';
  }
  return 'fixed';
}

function withJobStatus(plan: RemediationPlan, job: Job, lintRanAt: string | null): RemediationPlan {
  if (job.status === 'pending' || job.status === 'running') {
    return { ...plan, status: 'queued', jobId: job.id };
  }
  if (job.status === 'failed') return { ...plan, status: 'failed', jobId: job.id };
  if (!lintRanAt || !job.completedAt || job.completedAt > lintRanAt) {
    return { ...plan, status: 'queued', jobId: job.id };
  }
  const outcome = completedOutcome(job);
  return {
    ...plan,
    status: outcome === 'fixed' ? 'failed' : outcome,
    jobId: job.id,
  };
}

export function buildHealthSnapshot(
  lint: LintLatestResult,
  jobs: Job[],
  options: { readOnly?: boolean } = {},
): HealthSnapshot {
  const bounded = [...jobs]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(-MAX_REMEDIATION_JOBS);
  const related = new Map<string, Job[]>();
  for (const job of bounded) {
    const context = readRemediationContext(job);
    if (!context) continue;
    for (const id of context.findingIds) {
      const list = related.get(id) ?? [];
      list.push(job);
      related.set(id, list);
    }
  }

  const remediations: Record<string, RemediationPlan> = {};
  const currentIds = new Set(lint.findings.map((finding) => finding.id));
  for (const finding of lint.findings) {
    const initial = routeFinding(finding, { readOnly: options.readOnly });
    const latestJob = related.get(finding.id)?.at(-1);
    remediations[finding.id] = latestJob
      ? withJobStatus(initial, latestJob, lint.ranAt)
      : initial;
  }

  const recentOutcomes: Record<string, RemediationStatus> = {};
  for (const [id, candidates] of related) {
    if (currentIds.has(id)) continue;
    const latestJob = candidates.at(-1);
    if (!latestJob || !lint.ranAt || !latestJob.completedAt || latestJob.completedAt > lint.ranAt) continue;
    const context = readRemediationContext(latestJob);
    if (!context || context.action === 'research') continue;
    recentOutcomes[id] = completedOutcome(latestJob);
  }
  return { ...lint, remediations, recentOutcomes };
}
```

- [ ] **Step 4：运行测试确认 GREEN**

Run: `npx vitest run src/server/services/__tests__/remediation-status.test.ts src/server/services/__tests__/remediation-router.test.ts`

Expected: PASS。

- [ ] **Step 5：提交 Task 5**

```bash
git add src/server/services/remediation-status.ts src/server/services/__tests__/remediation-status.test.ts
git commit -m "feat: 推导 Health finding 处置状态"
```

## Task 6：Fix 按稳定 Finding Scope 执行

**Files:**
- Modify: `src/server/services/fix-service.ts`
- Modify: `src/server/services/__tests__/fix-service.test.ts`

- [ ] **Step 1：写 scoped Fix 失败测试**

先把现有 queue mock 改为可控制 `list/get/cancel`：

```ts
const queueMock = vi.hoisted(() => ({
  list: vi.fn(() => []),
  get: vi.fn(),
  isCancelRequested: vi.fn(() => false),
}));
vi.mock('@/server/jobs/queue', () => queueMock);
```

准备同一 lint 快照包含 `broken-link:a`、`broken-link:b` 和 `coverage-gap:c`，job params 只指定 `broken-link:a` ID：

```ts
it('remediation context 只处理指定且属于 Fix 的 finding ID', async () => {
  latestMock.selectLatestFindings.mockReturnValueOnce({
    jobId: 'lint-1', ranAt: '2026-07-12T10:00:00Z', bySeverity: { critical: 0, warning: 2, info: 1 },
    findings: [brokenA, brokenB, coverageC],
  });
  lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([brokenA, brokenB]);

  await runFixJob(job({
    remediationContext: { lintJobId: 'lint-1', findingIds: [brokenA.id], action: 'fix' },
  }), vi.fn());

  const prompt = getFixPrompt();
  expect(prompt).toContain(brokenA.description);
  expect(prompt).not.toContain(brokenB.description);
  expect(prompt).not.toContain(coverageC.description);
});
```

```ts
it.each([
  ['lint job 不存在', null, [brokenA.id]],
  ['lint job 属于其他 subject', { ...lintJob, subjectId: 's2' }, [brokenA.id]],
  ['finding 不属于 Fix', lintJob, [coverageC.id]],
] as const)('%s 时拒绝执行', async (_label, storedLintJob, findingIds) => {
  queueMock.get.mockReturnValue(storedLintJob);
  await expect(runFixJob(job({
    remediationContext: { lintJobId: 'lint-1', findingIds: [...findingIds], action: 'fix' },
  }), vi.fn())).rejects.toThrow();
  expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
  expect(txMock.applyChangeset).not.toHaveBeenCalled();
});

it('无 remediation context 时保留全量 Fix 行为', async () => {
  lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([brokenA, brokenB]);
  await runFixJob(job({ subjectId: 's1' }), vi.fn());
  const prompt = getFixPrompt();
  expect(prompt).toContain(brokenA.description);
  expect(prompt).toContain(brokenB.description);
});
```

- [ ] **Step 2：运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/fix-service.test.ts`

Expected: FAIL，Fix 仍处理全部 fresh findings。

- [ ] **Step 3：实现 scope 解析**

把 params 改为：

```ts
interface FixParams {
  subjectId?: string;
  remediationContext?: RemediationContext;
}
```

```ts
const FIX_TYPES = new Set<LintFinding['type']>([
  'missing-frontmatter', 'broken-link', 'missing-crossref', 'contradiction',
]);

function selectedFixFindings(
  freshDeterministic: EnrichedLintFinding[],
  snapshot: LintLatestResult,
  context?: RemediationContext,
): { deterministic: EnrichedLintFinding[]; semantic: EnrichedLintFinding[] } {
  const snapshotSemantic = snapshot.findings.filter(
    (finding) => finding.type === 'missing-crossref' || finding.type === 'contradiction',
  );
  if (!context) return { deterministic: freshDeterministic, semantic: snapshotSemantic };
  if (snapshot.jobId !== context.lintJobId) throw new Error('Fix lint snapshot mismatch');

  const requested = new Set(context.findingIds);
  const snapshotMatches = snapshot.findings.filter((finding) => requested.has(finding.id));
  if (snapshotMatches.length !== requested.size) throw new Error('Fix finding scope is stale');
  if (snapshotMatches.some((finding) => !FIX_TYPES.has(finding.type))) {
    throw new Error('Fix remediation contains a non-fix finding');
  }

  return {
    deterministic: freshDeterministic.filter((finding) => requested.has(finding.id)),
    semantic: snapshotSemantic.filter((finding) => requested.has(finding.id)),
  };
}

function lintSnapshotForFix(subjectId: string, context?: RemediationContext): LintLatestResult {
  if (!context) {
    return selectLatestFindings(queue.list({ type: 'lint', status: 'completed', subjectId }));
  }
  const lintJob = queue.get(context.lintJobId);
  if (!lintJob || lintJob.type !== 'lint' || lintJob.status !== 'completed' || lintJob.subjectId !== subjectId) {
    throw new Error('Fix lint snapshot is missing or belongs to another subject');
  }
  return selectLatestFindings([lintJob]);
}
```

`runFixJob()` 先把 fresh deterministic findings 通过 `identifyFindings()` 加上当前 subject identity，再调用 `lintSnapshotForFix()` 与 `selectedFixFindings()`。将返回的 deterministic 与 semantic 送入现有 `buildFixWorklist()`。

- [ ] **Step 4：确保语义后置校验只接收选中 findings**

`verifyJobPostconditions({ semanticFindings })` 只传 selected `missing-crossref` / `contradiction`，不能把同快照未授权 finding 带入模型复检。

- [ ] **Step 5：运行 Fix 与后置校验回归**

Run: `npx vitest run src/server/services/__tests__/fix-service.test.ts src/server/services/__tests__/postcondition-service.test.ts src/server/services/__tests__/fix-semantic-postcondition.test.ts`

Expected: PASS。

- [ ] **Step 6：提交 Task 6**

```bash
git add src/server/services/fix-service.ts src/server/services/__tests__/fix-service.test.ts
git commit -m "feat: 限定 Fix 只处理已确认 findings"
```

## Task 7：Research 改用稳定 Finding IDs

**Files:**
- Modify: `src/server/services/research-service.ts`
- Modify: `src/server/services/__tests__/research-service.test.ts`
- Modify: `src/app/api/research/route.ts`
- Modify: `src/app/api/research/__tests__/route.test.ts`

- [ ] **Step 1：把现有 gapIds 测试改成 findingIds 失败测试**

```ts
it('findingIds 只从指定最新 lint 快照解析 coverage-gap', () => {
  queueMock.get.mockReturnValue(lintJobWithIdentifiedFindings());
  expect(resolveTopicsFromFindingIds('s1', 'lint-1', [coverageGap.id]))
    .toEqual(['gRPC streaming']);
  expect(() => resolveTopicsFromFindingIds('s1', 'lint-1', [brokenLink.id]))
    .toThrow(/coverage-gap/);
});

it('数字下标 gapIds 被 API 拒绝', async () => {
  const response = await POST(req({ gapIds: ['1'] }));
  expect(response.status).toBe(400);
  expect(mockEnqueue).not.toHaveBeenCalled();
});
```

保留 topic、Web Search 未配置和 subject 解析失败测试。

- [ ] **Step 2：运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/research-service.test.ts src/app/api/research/__tests__/route.test.ts`

Expected: FAIL，仍只有 `resolveTopicsFromGapIds`。

- [ ] **Step 3：实现精确 lint job 解析**

```ts
interface ResearchParams {
  findingIds?: string[];
  lintJobId?: string;
  topic?: string;
  subjectId?: string;
  remediationContext?: RemediationContext;
}

export function resolveTopicsFromFindingIds(
  subjectId: string,
  lintJobId: string,
  findingIds: string[],
): string[] {
  const lintJob = queue.get(lintJobId);
  if (!lintJob || lintJob.type !== 'lint' || lintJob.status !== 'completed' || lintJob.subjectId !== subjectId) {
    throw new Error('Research lint snapshot is missing or belongs to another subject');
  }
  const snapshot = selectLatestFindings([lintJob]);
  const requested = new Set(findingIds);
  const matches = snapshot.findings.filter((finding) => requested.has(finding.id));
  if (matches.length !== requested.size || matches.some((finding) => finding.type !== 'coverage-gap')) {
    throw new Error('Research findingIds must reference coverage-gap findings');
  }
  return [...new Set(matches.map((finding) => finding.description))];
}
```

- [ ] **Step 4：更新 Research API 契约**

```ts
const hasFindingIds = Array.isArray(body.findingIds) && body.findingIds.length > 0;
const hasTopic = typeof body.topic === 'string' && body.topic.trim().length > 0;
if ('gapIds' in body) {
  return NextResponse.json({ error: 'gapIds is no longer supported; use findingIds with lintJobId' }, { status: 400 });
}
if (hasFindingIds === hasTopic) {
  return NextResponse.json({ error: 'Provide either findingIds or topic' }, { status: 400 });
}

let findingIds: string[] | undefined;
let lintJobId: string | undefined;
let remediationContext: RemediationContext | undefined;
if (hasFindingIds) {
  findingIds = body.findingIds as string[];
  lintJobId = typeof body.lintJobId === 'string' ? body.lintJobId : undefined;
  if (!lintJobId || findingIds.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
    return NextResponse.json({ error: 'findingIds require a current lintJobId and 64 character hex IDs' }, { status: 400 });
  }
  const latest = selectLatestFindings(
    queue.list({ type: 'lint', status: 'completed', subjectId: subject.id }),
  );
  if (latest.jobId !== lintJobId) {
    return NextResponse.json({ error: 'Research lint snapshot is stale' }, { status: 409 });
  }
  try {
    resolveTopicsFromFindingIds(subject.id, lintJobId, findingIds);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid findingIds' }, { status: 400 });
  }
  remediationContext = normalizeRemediationContext({
    lintJobId, findingIds, action: 'research',
  });
}

const topic = hasTopic ? (body.topic as string).trim() : undefined;
const job = queue.enqueue('research', {
  findingIds,
  lintJobId,
  topic,
  subjectId: subject.id,
  ...(remediationContext ? { remediationContext } : {}),
}, subject.id);
```

Web Search 配置检查保持在入队前；topic 分支不创建 remediationContext。入队参数彻底删除 `gapIds`。

- [ ] **Step 5：运行测试确认 GREEN**

Run: `npx vitest run src/server/services/__tests__/research-service.test.ts src/app/api/research/__tests__/route.test.ts`

Expected: PASS，源码中只允许测试拒绝场景或历史文档出现 `gapIds`。

Run: `rg -n "resolveTopicsFromGapIds|gapIds" src/server src/app src/components`

Expected: 仅剩下一任务尚未修改的 Health UI；server/app 不再包含生产调用。

- [ ] **Step 6：提交 Task 7**

```bash
git add src/server/services/research-service.ts src/server/services/__tests__/research-service.test.ts src/app/api/research/route.ts src/app/api/research/__tests__/route.test.ts
git commit -m "feat: 使用稳定 finding ID 触发 Research"
```

## Task 8：统一 Remediation Service 与 API

**Files:**
- Create: `src/server/services/source-reingest.ts`
- Create: `src/server/services/remediation-service.ts`
- Create: `src/server/services/__tests__/remediation-service.test.ts`
- Create: `src/app/api/health/remediations/route.ts`
- Create: `src/app/api/health/remediations/__tests__/route.test.ts`
- Modify: `src/app/api/sources/[id]/reingest/route.ts`
- Modify: `src/app/api/sources/[id]/reingest/__tests__/route.test.ts`

- [ ] **Step 1：写 service 编排失败测试**

覆盖：

```ts
it('stale lintJobId 返回 409 且不入队', async () => {
  await expect(remediate({ subject, lintJobId: 'old', findingIds: [broken.id], action: 'fix' }))
    .rejects.toMatchObject({ status: 409, code: 'stale-snapshot' });
  expect(queueMock.enqueue).not.toHaveBeenCalled();
});

it('Fix 批量一次入队并携带 remediationContext', async () => {
  const result = await remediate({
    subject, lintJobId: 'lint-1', findingIds: [broken.id, contradiction.id], action: 'fix',
  });
  expect(queueMock.enqueue).toHaveBeenCalledWith('fix', {
    subjectId: 's1',
    remediationContext: {
      lintJobId: 'lint-1',
      findingIds: [broken.id, contradiction.id].sort(),
      action: 'fix',
    },
  }, 's1');
  expect(result).toMatchObject({ jobId: 'job-1', deduplicated: false });
});

it('Curate 只把 orphan pageSlug 作为 seeds', async () => {
  await remediate({ subject, lintJobId: 'lint-1', findingIds: [orphan.id], action: 'curate' });
  expect(queueMock.enqueue).toHaveBeenCalledWith('curate', expect.objectContaining({
    scope: 'pages', slugs: [orphan.pageSlug],
  }), 's1');
});

it('重复请求返回原 job', async () => {
  queueMock.list.mockReturnValue([duplicateJob]);
  expect(await remediate(request)).toMatchObject({ jobId: duplicateJob.id, deduplicated: true });
});
```

```ts
it('Research 未配置 Web Search → 422', async () => {
  webSearchMock.isWebSearchConfigured.mockReturnValue(false);
  await expect(remediate({
    subject, lintJobId: 'lint-1', findingIds: [gap.id], action: 'research',
  })).rejects.toMatchObject({ status: 422, code: 'web-search-not-configured' });
});

it('action 与 finding 类型不匹配 → 400', async () => {
  await expect(remediate({
    subject, lintJobId: 'lint-1', findingIds: [orphan.id], action: 'fix',
  })).rejects.toMatchObject({ status: 400, code: 'action-not-allowed' });
});

it('任意 finding ID 缺失则整体 stale，不部分入队', async () => {
  await expect(remediate({
    subject,
    lintJobId: 'lint-1',
    findingIds: [broken.id, 'f'.repeat(64)],
    action: 'fix',
  })).rejects.toMatchObject({ status: 409, code: 'stale-snapshot' });
  expect(queueMock.enqueue).not.toHaveBeenCalled();
});

it('超过 100 IDs 或 Re-ingest 多 ID → 400', async () => {
  const tooMany = Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(64, '0'));
  await expect(remediate({ subject, lintJobId: 'lint-1', findingIds: tooMany, action: 'fix' }))
    .rejects.toMatchObject({ status: 400, code: 'invalid-finding-count' });
  await expect(remediate({
    subject, lintJobId: 'lint-1', findingIds: [orphanSource.id, secondOrphanSource.id], action: 're-ingest',
  })).rejects.toMatchObject({ status: 400, code: 'invalid-reingest-scope' });
});

it('orphan-source 的 source 不属于当前 subject → 409', async () => {
  sourceReingestMock.reingestOrphanSource.mockImplementation(() => {
    throw new SourceReingestError(404, 'source-not-found', 'Source not found');
  });
  await expect(remediate({
    subject, lintJobId: 'lint-1', findingIds: [orphanSource.id], action: 're-ingest',
  })).rejects.toMatchObject({ status: 409, code: 'source-not-found' });
});
```

- [ ] **Step 2：写 Route Handler 失败测试**

```ts
it('成功返回 202 与幂等标记', async () => {
  remediateMock.mockResolvedValue({ jobId: 'job-1', deduplicated: false });
  const response = await POST(request({
    lintJobId: 'lint-1', findingIds: ['a'.repeat(64)], action: 'fix', subjectId: 's1',
  }));
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ jobId: 'job-1', deduplicated: false });
});

it('service 的稳定错误码原样返回', async () => {
  remediateMock.mockRejectedValue(
    new RemediationRequestError(409, 'stale-snapshot', 'Health snapshot changed'),
  );
  const response = await POST(request({
    lintJobId: 'old', findingIds: ['a'.repeat(64)], action: 'fix', subjectId: 's1',
  }));
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'Health snapshot changed', code: 'stale-snapshot',
  });
});

it('Auth、CSRF 或 subject 解析失败时不调用 service', async () => {
  authMock.mockReturnValueOnce(NextResponse.json({ error: 'unauthorized' }, { status: 401 }));
  expect((await POST(request({}))).status).toBe(401);
  expect(remediateMock).not.toHaveBeenCalled();
});
```

```ts
it('CSRF、subject 与 JSON 错误均在编排前返回', async () => {
  csrfMock.mockReturnValueOnce(NextResponse.json({ error: 'csrf' }, { status: 403 }));
  expect((await POST(request({}))).status).toBe(403);

  subjectMock.mockReturnValueOnce({
    subject: null,
    error: NextResponse.json({ error: 'subject' }, { status: 404 }),
  });
  expect((await POST(request({ subjectId: 'missing' }))).status).toBe(404);

  const invalid = new NextRequest('http://localhost/api/health/remediations', {
    method: 'POST', body: '{',
  });
  expect((await POST(invalid)).status).toBe(400);
  expect(remediateMock).not.toHaveBeenCalled();
});
```

- [ ] **Step 3：运行测试确认 RED**

Run: `npx vitest run src/server/services/__tests__/remediation-service.test.ts src/app/api/health/remediations/__tests__/route.test.ts`

Expected: FAIL，新模块不存在。

- [ ] **Step 4：抽取 orphan-source re-ingest helper**

```ts
import type { RemediationContext } from '@/lib/contracts';
import * as sourcesRepo from '../db/repos/sources-repo';
import * as jobsRepo from '../db/repos/jobs-repo';
import * as queue from '../jobs/queue';
import * as events from '../jobs/events';

export class SourceReingestError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly code: 'source-not-found' | 'already-referenced' | 'in-flight' | 'requeue-conflict',
    message: string,
  ) {
    super(message);
  }
}

export function reingestOrphanSource(input: {
  subjectId: string;
  sourceId: string;
  remediationContext?: RemediationContext;
}): { jobId: string } {
  const source = sourcesRepo.getSource(input.sourceId);
  if (!source || source.subjectId !== input.subjectId) {
    throw new SourceReingestError(404, 'source-not-found', 'Source not found');
  }
  const unreferenced = sourcesRepo
    .listUnreferencedSources(input.subjectId)
    .some((candidate) => candidate.id === source.id);
  if (!unreferenced) {
    throw new SourceReingestError(409, 'already-referenced', 'Source is already referenced');
  }

  const previous = jobsRepo.findLatestIngestJobForSource(input.subjectId, source.id);
  if (previous && (previous.status === 'pending' || previous.status === 'running')) {
    throw new SourceReingestError(409, 'in-flight', 'Source ingestion is already in flight');
  }

  if (previous?.status === 'failed') {
    let cancelled = false;
    try {
      cancelled = Boolean(JSON.parse(previous.resultJson ?? '{}').cancelled);
    } catch {
      cancelled = false;
    }
    if (!cancelled) {
      const requeued = queue.requeueJobWithParams(
        previous.id,
        input.remediationContext ? { remediationContext: input.remediationContext } : {},
      );
      if (!requeued) {
        throw new SourceReingestError(409, 'requeue-conflict', 'Failed ingest job changed before retry');
      }
      events.emit(previous.id, 'job:retrying', 'Manual re-ingest — resuming from checkpoint', { manual: true });
      return { jobId: previous.id };
    }
  }

  const created = queue.enqueue('ingest', {
    sourceId: source.id,
    filename: source.filename,
    subjectId: input.subjectId,
    ...(input.remediationContext ? { remediationContext: input.remediationContext } : {}),
  }, input.subjectId);
  return { jobId: created.id };
}
```

专用 `/api/sources/[id]/reingest` 调用该 helper；捕获 `SourceReingestError` 后用 `error.status` 和 `{ error: error.code }` 返回，保持既有 `already-referenced` / `in-flight` 响应契约。

- [ ] **Step 5：实现 remediation service**

定义：

```ts
export const MAX_REMEDIATION_FINDINGS = 100;

export class RemediationRequestError extends Error {
  constructor(
    readonly status: 400 | 409 | 422,
    readonly code: string,
    message: string,
  ) { super(message); }
}

export async function remediate(input: {
  subject: Subject;
  lintJobId: string;
  findingIds: string[];
  action: Exclude<RemediationActionType, 'review-source'>;
}): Promise<{ jobId: string; deduplicated: boolean }>;
```

函数主体按以下代码实现：

```ts
export async function remediate(input: {
  subject: Subject;
  lintJobId: string;
  findingIds: string[];
  action: Exclude<RemediationActionType, 'review-source'>;
}): Promise<{ jobId: string; deduplicated: boolean }> {
  const ids = [...new Set(input.findingIds)].sort();
  if (ids.length === 0 || ids.length > MAX_REMEDIATION_FINDINGS) {
    throw new RemediationRequestError(400, 'invalid-finding-count', 'findingIds must contain 1-100 values');
  }
  if (ids.some((id) => !/^[a-f0-9]{64}$/.test(id))) {
    throw new RemediationRequestError(400, 'invalid-finding-id', 'findingIds must be 64 character lowercase hex values');
  }

  const lint = selectLatestFindings(
    queue.list({ type: 'lint', status: 'completed', subjectId: input.subject.id }),
  );
  if (lint.jobId !== input.lintJobId) {
    throw new RemediationRequestError(409, 'stale-snapshot', 'Health snapshot changed');
  }

  const byId = new Map(lint.findings.map((finding) => [finding.id, finding]));
  const findings = ids.map((id) => byId.get(id)).filter((finding): finding is EnrichedLintFinding => Boolean(finding));
  if (findings.length !== ids.length) {
    throw new RemediationRequestError(409, 'stale-snapshot', 'One or more findings are no longer current');
  }
  const actionAllowed = findings.every((finding) =>
    routeFinding(finding).actions.some((candidate) => candidate.type === input.action),
  );
  if (!actionAllowed) {
    throw new RemediationRequestError(400, 'action-not-allowed', 'The action is not valid for every selected finding');
  }

  const context = normalizeRemediationContext({
    lintJobId: input.lintJobId,
    findingIds: ids,
    action: input.action,
  });
  const duplicate = findDuplicateRemediationJob(
    queue.list({ subjectId: input.subject.id }),
    input.subject.id,
    context,
    lint.ranAt,
  );
  if (duplicate) return { jobId: duplicate.id, deduplicated: true };

  if (input.action === 'fix') {
    const job = queue.enqueue('fix', { subjectId: input.subject.id, remediationContext: context }, input.subject.id);
    return { jobId: job.id, deduplicated: false };
  }
  if (input.action === 'curate') {
    const slugs = [...new Set(findings.map((finding) => finding.pageSlug))];
    const job = queue.enqueue('curate', {
      scope: 'pages', slugs, subjectId: input.subject.id, remediationContext: context,
    }, input.subject.id);
    return { jobId: job.id, deduplicated: false };
  }
  if (input.action === 'research') {
    if (!isWebSearchConfigured()) {
      throw new RemediationRequestError(422, 'web-search-not-configured', 'Web search is not configured');
    }
    const job = queue.enqueue('research', {
      findingIds: ids,
      lintJobId: input.lintJobId,
      subjectId: input.subject.id,
      remediationContext: context,
    }, input.subject.id);
    return { jobId: job.id, deduplicated: false };
  }
  if (ids.length !== 1 || findings.length !== 1 || !findings[0].sourceId) {
    throw new RemediationRequestError(400, 'invalid-reingest-scope', 'Re-ingest requires exactly one source finding');
  }
  try {
    const result = reingestOrphanSource({
      subjectId: input.subject.id,
      sourceId: findings[0].sourceId,
      remediationContext: context,
    });
    return { jobId: result.jobId, deduplicated: false };
  } catch (error) {
    if (error instanceof SourceReingestError) {
      throw new RemediationRequestError(error.status === 404 ? 409 : error.status, error.code, error.message);
    }
    throw error;
  }
}
```

- [ ] **Step 6：实现统一 Route Handler**

Route 使用以下主体，确保鉴权顺序和错误契约固定：

```ts
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', code: 'invalid-json' }, { status: 400 });
  }
  const resolution = resolveSubjectFromRequest(request, { required: true, body });
  if (resolution.error) return resolution.error;

  try {
    const result = await remediate({
      subject: resolution.subject,
      lintJobId: typeof body.lintJobId === 'string' ? body.lintJobId : '',
      findingIds: Array.isArray(body.findingIds) ? body.findingIds.filter((id): id is string => typeof id === 'string') : [],
      action: body.action as 'fix' | 'curate' | 'research' | 're-ingest',
    });
    return NextResponse.json(result, { status: 202 });
  } catch (error) {
    if (error instanceof RemediationRequestError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error('[health-remediation] request failed', error);
    return NextResponse.json({ error: 'Health remediation failed', code: 'internal-error' }, { status: 500 });
  }
}
```

- [ ] **Step 7：运行定向测试确认 GREEN**

Run: `npx vitest run src/server/services/__tests__/remediation-service.test.ts src/app/api/health/remediations/__tests__/route.test.ts src/app/api/sources/[id]/reingest/__tests__/route.test.ts`

Expected: PASS。

- [ ] **Step 8：提交 Task 8**

```bash
git add src/server/services/source-reingest.ts src/server/services/remediation-service.ts src/server/services/__tests__/remediation-service.test.ts src/app/api/health/remediations/route.ts src/app/api/health/remediations/__tests__/route.test.ts src/app/api/sources/[id]/reingest/route.ts src/app/api/sources/[id]/reingest/__tests__/route.test.ts
git commit -m "feat: 增加 Health 统一处置入口"
```

## Task 9：Lint Latest 返回 HealthSnapshot

**Files:**
- Modify: `src/app/api/lint/latest/route.ts`
- Modify: `src/app/api/lint/latest/__tests__/route.test.ts`
- Modify: `src/hooks/use-lint-summary.ts`

- [ ] **Step 1：写 API snapshot 失败测试**

```ts
it('subject-scoped 返回 remediation plans 与 recent outcomes', async () => {
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockList.mockImplementation((filter) => filter.type === 'lint' ? [lintJobWithFinding] : [fixJob]);
  const body = await (await call()).json();
  expect(body.remediations[findingId]).toMatchObject({ workflow: 'fix' });
  expect(body.recentOutcomes).toEqual(expect.any(Object));
});

it('allSubjects=1 返回只读 plans', async () => {
  const body = await (await call('?allSubjects=1')).json();
  expect(Object.values(body.remediations).every((plan: any) => plan.actions.length === 0)).toBe(true);
});
```

- [ ] **Step 2：运行测试确认 RED**

Run: `npx vitest run src/app/api/lint/latest/__tests__/route.test.ts`

Expected: FAIL，响应没有 remediations。

- [ ] **Step 3：接入 buildHealthSnapshot**

Subject 模式：

```ts
const lint = selectLatestFindings(
  queue.list({ type: 'lint', status: 'completed', subjectId: subject.id }),
);
return NextResponse.json(
  buildHealthSnapshot(lint, queue.list({ subjectId: subject.id })),
);
```

All Subjects 模式仍只选 `subjectId === null` 的全量 lint job，并传 `{ readOnly: true }`；状态 jobs 使用 `queue.list()`，由 status builder 自身有界截断。

- [ ] **Step 4：更新 hook 类型和空值**

```ts
const EMPTY: HealthSnapshot = {
  jobId: null,
  ranAt: null,
  bySeverity: { critical: 0, warning: 0, info: 0 },
  findings: [],
  remediations: {},
  recentOutcomes: {},
};
```

`queryFn` 返回类型改为 `Promise<HealthSnapshot>`。

- [ ] **Step 5：运行测试与类型检查**

Run: `npx vitest run src/app/api/lint/latest/__tests__/route.test.ts src/server/services/__tests__/remediation-status.test.ts`

Expected: PASS。

Run: `npx tsc --noEmit`

Expected: PASS。

- [ ] **Step 6：提交 Task 9**

```bash
git add src/app/api/lint/latest/route.ts src/app/api/lint/latest/__tests__/route.test.ts src/hooks/use-lint-summary.ts
git commit -m "feat: 在 Health 快照中返回处置计划"
```

## Task 10：Health UI 改为 Plan-Driven

**Files:**
- Create: `src/components/health/remediation-ui.ts`
- Create: `src/components/health/__tests__/remediation-ui.test.ts`
- Modify: `src/components/health/health-view.tsx`
- Modify: `src/components/health/finding-row.tsx`

- [ ] **Step 1：写客户端纯 helper 失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { actionFindingIds, actionForFinding } from '../remediation-ui';

it('批量 ID 只来自服务端允许的 action', () => {
  expect(actionFindingIds(snapshot, 'fix')).toEqual([broken.id]);
  expect(actionFindingIds(snapshot, 'research')).toEqual([gap.id]);
});

it('找不到 plan 或 action 时不返回客户端猜测', () => {
  expect(actionForFinding(snapshot, unknown.id, 'fix')).toBeNull();
  expect(actionForFinding(snapshot, gap.id, 'fix')).toBeNull();
});
```

- [ ] **Step 2：运行测试确认 RED**

Run: `npx vitest run src/components/health/__tests__/remediation-ui.test.ts`

Expected: FAIL，helper 不存在。

- [ ] **Step 3：实现客户端纯 helper**

```ts
export function actionForFinding(
  snapshot: HealthSnapshot,
  findingId: string,
  action: RemediationActionType,
): RemediationAction | null {
  return snapshot.remediations[findingId]?.actions.find((item) => item.type === action) ?? null;
}

export function actionFindingIds(
  snapshot: HealthSnapshot,
  action: RemediationActionType,
): string[] {
  return snapshot.findings
    .filter((finding) => actionForFinding(snapshot, finding.id, action) !== null)
    .map((finding) => finding.id);
}
```

- [ ] **Step 4：改造 FindingRow**

Props 改为：

```ts
{
  finding: EnrichedLintFinding;
  plan: RemediationPlan;
  showSubject?: boolean;
  acting?: boolean;
  onAction?: (action: RemediationAction) => void;
  onDeleteSource?: () => void;
}
```

从 `@/components/ui/button` 同时导入 `Button, buttonVariants`，并用以下结构替换现有按 finding.type 生成 Research/Re-ingest 按钮的分支：

```tsx
<div className="flex items-center gap-2 flex-wrap">
  <Tag tone={plan.status === 'failed' ? 'danger' : plan.status === 'queued' ? 'accent' : 'neutral'} size="sm">
    {plan.status}
  </Tag>
  <span className="text-xs text-foreground-tertiary">{plan.workflow}</span>
</div>
<p className="text-xs text-foreground-tertiary">{plan.reason}</p>
{plan.actions.length > 0 && (
  <div className="mt-1 flex items-center gap-2 flex-wrap">
    {plan.actions.map((item) =>
      item.type === 'review-source' && item.href ? (
        <Link
          key={item.type}
          href={item.href}
          className={buttonVariants({ intent: 'secondary', size: 'sm' })}
        >
          {item.label}
        </Link>
      ) : (
        <Button
          key={item.type}
          intent="secondary"
          size="sm"
          loading={acting}
          onClick={() => onAction?.(item)}
        >
          {item.label}
        </Button>
      ),
    )}
  </div>
)}
```

orphan-source Delete Source 区块保留，但只由 `onDeleteSource` 控制，并继续使用原 `deleteArmed` 两次点击状态；不得根据 finding.type 自行增加 Research/Re-ingest 按钮。

- [ ] **Step 5：改造 HealthView 的统一动作函数**

新增独立错误状态，不能复用 Research 候选错误：

```ts
const [remediationError, setRemediationError] = useState<string | null>(null);
```

```ts
async function runRemediation(
  action: 'fix' | 'curate' | 'research' | 're-ingest',
  findingIds: string[],
) {
  if (!data?.jobId || findingIds.length === 0) return;
  setRemediationError(null);
  const response = await apiFetch('/api/health/remediations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      subjectId,
      lintJobId: data.jobId,
      findingIds,
      action,
    }),
  });
  if (response.status === 409) {
    await queryClient.invalidateQueries({ queryKey: ['lint-latest', subjectId] });
    setRemediationError('体检结果已更新，请重新确认。');
    return;
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    setRemediationError(payload.error ?? `Remediation request failed (${response.status})`);
    return;
  }
  const { jobId } = await response.json() as { jobId: string };
  switch (action) {
    case 'fix':
      setFixJobId(jobId);
      break;
    case 'curate':
      setCurateJobId(jobId);
      break;
    case 'research':
      setResearchJobId(jobId);
      break;
    case 're-ingest':
      setReingestJobId(jobId);
      break;
  }
  await queryClient.invalidateQueries({ queryKey: ['lint-latest', subjectId] });
}
```

批量按钮分别使用 `actionFindingIds(data, 'fix'|'curate'|'research')`。删除 `FIXABLE_TYPES`、`coverageGapIds`、`allFindings.indexOf(f)` 和 `gapIds`。手动 topic Research 继续调用 `/api/research { topic, subjectId }`。

Curate 完成和 orphan-source 删除成功后必须像 Fix/Re-ingest 一样触发新 lint，而不是只 invalid 当前旧快照：

```ts
if (curateStatus === 'completed') {
  const verification = [...curateEvents]
    .reverse()
    .find((event) => event.type === 'curate:verify:complete');
  setCuratePostcondition(extractPostconditionReport(verification));
  queryClient.invalidateQueries({ queryKey: ['pages'] });
  setCurateJobId(null);
  void runLint();
}

if (res.ok) {
  setHandledSourceIds((previous) => new Set(previous).add(sourceId));
  queryClient.invalidateQueries({ queryKey: ['sources'] });
  void runLint();
}
```

在 Research error 旁增加 remediation error，并展示有界 recent outcomes：

```tsx
{remediationError && (
  <div className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
    {remediationError}
  </div>
)}

{data && Object.keys(data.recentOutcomes).length > 0 && (
  <div className="rounded-md border border-success/40 bg-success-bg px-3 py-2 text-sm text-success">
    Recently verified: {Object.values(data.recentOutcomes).filter((status) => status === 'fixed').length} fixed
    {' · '}{Object.values(data.recentOutcomes).filter((status) => status === 'failed').length} failed
    {' · '}{Object.values(data.recentOutcomes).filter((status) => status === 'skipped').length} skipped
  </div>
)}
```

- [ ] **Step 6：接通行内 action 与稳定 key**

每行：

```tsx
<FindingRow
  key={finding.id}
  finding={finding}
  plan={data.remediations[finding.id]}
  showSubject={allSubjects}
  onAction={(action) => {
    if (action.type !== 'review-source') {
      void runRemediation(action.type, [finding.id]);
    }
  }}
  onDeleteSource={
    finding.type === 'orphan-source' && finding.sourceId && !allSubjects
      ? () => deleteSource(finding.sourceId!)
      : undefined
  }
/>
```

All Subjects plans 没有 actions，因此只展示状态与原因。

- [ ] **Step 7：运行 UI helper、相关回归与类型检查**

Run: `npx vitest run src/components/health/__tests__/remediation-ui.test.ts src/components/health/__tests__/lint-findings.test.ts src/components/health/__tests__/postcondition-summary.test.ts src/hooks/__tests__/job-stream-logic.test.ts`

Expected: PASS。

Run: `rg -n "gapIds|coverageGapIds|FIXABLE_TYPES|allFindings\.indexOf" src/components/health src/hooks`

Expected: 无输出。

Run: `npx tsc --noEmit`

Expected: PASS。

- [ ] **Step 8：提交 Task 10**

```bash
git add src/components/health/remediation-ui.ts src/components/health/__tests__/remediation-ui.test.ts src/components/health/health-view.tsx src/components/health/finding-row.tsx
git commit -m "feat: 使用服务端处置计划驱动 Health 交互"
```

## Task 11：文档、全量验证与阶段验收

**Files:**
- Modify: `src/lib/CLAUDE.md`
- Modify: `src/server/services/CLAUDE.md`
- Modify: `src/app/CLAUDE.md`
- Modify: `src/components/CLAUDE.md`
- Verify unchanged: `llm-config.example.json`

- [ ] **Step 1：更新模块文档**

写入以下准确事实：

- `src/lib/CLAUDE.md`：`EnrichedLintFinding.id`、Remediation/HealthSnapshot 契约；
- `src/server/services/CLAUDE.md`：identity、九类 router、status、有界 job 扫描、Fix scope、Research findingIds；
- `src/app/CLAUDE.md`：`POST /api/health/remediations` 请求/响应/错误码，`POST /api/research` 新契约；
- `src/components/CLAUDE.md`：Health actions 由服务端 plan 驱动、All Subjects 只读、orphan-source 删除确认不变。

每个文档在变更日志增加 `2026-07-12` 的 Phase 2A 条目。

- [ ] **Step 2：验证不存在数组下标协议和死 action**

Run: `rg -n "resolveTopicsFromGapIds|gapIds|coverageGapIds|findings 数组下标" src`

Expected: 无生产代码命中；允许测试中“拒绝旧 gapIds”的用例文案。

Run: `rg -n "action:.*re-enrich|'re-enrich'.*Remediation" src`

Expected: 无 remediation action 命中；既有 re-enrich job/workflow 不受影响。

- [ ] **Step 3：运行全量测试**

Run: `npm test`

Expected: 所有测试文件和用例 PASS，0 failures。

- [ ] **Step 4：运行 ESLint**

Run: `npm run lint`

Expected: exit 0；允许仓库既有 warnings，不允许新增 errors。

- [ ] **Step 5：运行 TypeScript 检查**

Run: `npx tsc --noEmit`

Expected: exit 0。

- [ ] **Step 6：运行生产构建**

Run: `npm run build`

Expected: exit 0，Next.js production build 成功。

- [ ] **Step 7：确认配置和工作树范围**

Run: `git diff --exit-code main -- llm-config.example.json`

Expected: exit 0，无差异。

Run: `git diff --check main...HEAD`

Expected: 无输出。

Run: `git status --short`

Expected: 只包含四份 CLAUDE.md 文档修改。

- [ ] **Step 8：提交文档与验收结果**

```bash
git add src/lib/CLAUDE.md src/server/services/CLAUDE.md src/app/CLAUDE.md src/components/CLAUDE.md
git commit -m "docs: 记录 Health 修复闭环 Phase 2A"
```

- [ ] **Step 9：最终核验提交和工作树**

Run: `git status --short`

Expected: 无输出。

Run: `git log --oneline main..HEAD`

Expected: 包含设计 Spec、执行 Plan 及 Task 1-11 的中文 Conventional Commits。

## 完成定义

- 九类 finding 均有稳定 ID 与服务端 remediation plan；
- 新旧 lint 快照使用同一 identity 算法；
- Research 不再接受数组下标；
- Fix/Curate/Research/Re-ingest 只在用户明确触发后执行；
- 所有统一入口任务带 `remediationContext`；
- stale snapshot、跨 subject 与 action/type 不匹配在服务端失败；
- orphan 无自动删除，orphan-source 删除确认与 in-flight 守卫不回归；
- Health 逐条/批量动作都来自 plan.actions；
- 全量测试、lint、typecheck、build 通过；
- `llm-config.example.json` 无差异。
