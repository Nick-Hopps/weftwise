# 孤儿 Source 体检与处置 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 体检识别「ingest 失败但已入库」的孤儿 source（新 finding 类型 `orphan-source`），Health 页逐条提供 Retry ingest / Delete source 两个手动处置动作。

**Architecture:** 检测并入现有 lint 确定性检查体系（`lint-deterministic.ts` 新增 `checkOrphanSources`，靠 sources-repo 零关联查询 + jobs-repo 按 paramsJson 反查 ingest job 分类）；处置走两个新路由 `POST /api/sources/[id]/reingest`（requeue 或新建 ingest job）与 `DELETE /api/sources/[id]`（vault 锁内删 raw 文件 + sidecar + DB 行 + git commit）；前端在 `FindingRow` 上按类型渲染双按钮。

**Tech Stack:** Next.js 15 Route Handlers、Drizzle + better-sqlite3、vitest（temp-dir 真实 SQLite 风格 + 路由 mock 风格）、React 19 + TanStack Query。

**Spec:** `docs/superpowers/specs/2026-07-07-orphan-source-health-check-design.md`

## Global Constraints

- 所有领域类型改动集中在 `src/lib/contracts.ts`。
- 写路由必须 `requireAuth(request)` + `requireCsrf(request)` + `resolveSubjectFromRequest(request, { required: true })`，并 `export const runtime = 'nodejs'`。
- git commit message 用中文一句话，subject-scoped 提交带 `[subject:<slug>]` 前缀。
- **`npm run lint` 不可用**（next lint 已弃用且会交互卡住）；校验一律用 `npx tsc --noEmit` + `npx vitest run`。
- 生成代码中的注释用中文。
- `orphan-source` 不进 Fix issues 自动修复、无自动清理 sweep（明确不做）。
- 本仓库无 git remote：如需 worktree，用 `git worktree add <path> HEAD -b feat/orphan-source-health` 手动创建。

---

### Task 1: 契约扩展 — `orphan-source` finding 类型

**Files:**
- Modify: `src/lib/contracts.ts:194-200`（`LintFinding`）
- Test: `src/server/services/__tests__/fix-deterministic.test.ts`（追加）

**Interfaces:**
- Produces: `LintFinding.type` 联合新增 `'orphan-source'`；`LintFinding` 新增可选字段 `sourceId?: string`、`sourceFilename?: string`、`failedJobId?: string | null`。后续所有 task 依赖这三个字段名。

- [ ] **Step 1: 写失败测试 —— `partitionFindings` 把 orphan-source 归入 ignored 桶**

在 `src/server/services/__tests__/fix-deterministic.test.ts` 的 `partitionFindings` 相关 describe 内（或文件末尾新建 describe）追加：

```ts
describe('partitionFindings — orphan-source', () => {
  it('orphan-source 归入 ignored 桶（不进 Fix issues）', async () => {
    const { partitionFindings } = await import('../fix-deterministic');
    const finding = {
      type: 'orphan-source' as const,
      severity: 'warning' as const,
      pageSlug: '',
      description: 'Source "a.md" was ingested but its ingest job failed.',
      suggestedFix: null,
      sourceId: 'src-1',
      sourceFilename: 'a.md',
      failedJobId: 'job-1',
    };
    const { frontmatter, llm, ignored } = partitionFindings([finding]);
    expect(frontmatter).toHaveLength(0);
    expect(llm).toHaveLength(0);
    expect(ignored).toEqual([finding]);
  });
});
```

注意该测试文件顶部若无 `describe/it/expect` 之外的依赖需求则无需 setup（`partitionFindings` 是纯函数）；若文件用了 `vi.resetModules` 的 beforeEach 模板，直接沿用动态 import。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/fix-deterministic.test.ts`
Expected: FAIL —— TS 类型错误（`'orphan-source'` 不在 `LintFinding['type']` 联合中）导致编译失败，或断言失败。

- [ ] **Step 3: 改 contracts**

`src/lib/contracts.ts` 把 `LintFinding` 改为：

```ts
export interface LintFinding {
  type: 'broken-link' | 'orphan' | 'missing-frontmatter' | 'stale-source' | 'contradiction' | 'missing-crossref' | 'coverage-gap' | 'orphan-source';
  severity: 'critical' | 'warning' | 'info';
  pageSlug: string;
  description: string;
  suggestedFix: string | null;
  /** orphan-source 专属：孤儿 source 的 DB id。 */
  sourceId?: string;
  /** orphan-source 专属：source 文件名（pageSlug 为空时的展示替代）。 */
  sourceFilename?: string;
  /** orphan-source 专属：关联的 failed ingest job id；查无 job / job 非 failed 时为 null。 */
  failedJobId?: string | null;
}
```

- [ ] **Step 4: 跑测试确认通过 + 前端 TYPE_ICON/TYPE_LABEL 编译错误确认**

Run: `npx vitest run src/server/services/__tests__/fix-deterministic.test.ts`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: **FAIL**，报 `src/components/health/finding-row.tsx` 的 `TYPE_ICON` / `TYPE_LABEL` 两个 `Record<LintFinding['type'], ...>` 缺 `'orphan-source'` key —— 这是预期的，本 task 先补齐这两处最小映射让编译通过（完整 UI 在 Task 7）：

在 `src/components/health/finding-row.tsx` 顶部 lucide import 中加 `FileX`，并在两个映射中各加一行：

```ts
// TYPE_ICON 中：
  'orphan-source': FileX,
// TYPE_LABEL 中：
  'orphan-source': 'Orphan source',
```

Run: `npx tsc --noEmit`
Expected: PASS（0 错误）

- [ ] **Step 5: Commit**

```bash
git add src/lib/contracts.ts src/server/services/__tests__/fix-deterministic.test.ts src/components/health/finding-row.tsx
git commit -m "feat: LintFinding 新增 orphan-source 类型与 source 元数据字段"
```

---

### Task 2: sources-repo — 零关联查询 + 删除

**Files:**
- Modify: `src/server/db/repos/sources-repo.ts`
- Test: `src/server/db/repos/__tests__/sources-repo.test.ts`（追加 describe）

**Interfaces:**
- Consumes: 现有 `sources` / `pageSources` Drizzle schema、`rowToSource`。
- Produces: `listUnreferencedSources(subjectId: SubjectId): Source[]`（该 subject 下无任何 page_sources 关联的 source）；`deleteSource(id: string): void`。Task 4/5/6 依赖这两个签名。

- [ ] **Step 1: 写失败测试**

`src/server/db/repos/__tests__/sources-repo.test.ts` 已有 temp-dir + `setup()` 模板（内含 s1/s2 两 subject、src1/src2/src3 三 source、page_sources 关联：src1/src2 已被 s1 的 page-a 引用，src3 被 s2 引用）。文件末尾追加：

```ts
describe('listUnreferencedSources / deleteSource', () => {
  it('只返回本 subject 下零 page_sources 关联的 source', async () => {
    const repo = await setup();
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    // s1 加一个无关联的 source；s2 也加一个（验证 subject 隔离）
    const insSrc = db.prepare(
      `INSERT INTO sources (id, subject_id, filename, content_hash, parsed_at, metadata_json)
       VALUES (?,?,?,?,?,?)`
    );
    insSrc.run('src-orphan', 's1', 'orphan.md', 'h9', null, '{}');
    insSrc.run('src-orphan-2', 's2', 'other.md', 'h10', null, '{}');

    const result = repo.listUnreferencedSources('s1');
    expect(result.map((s) => s.id)).toEqual(['src-orphan']);
    expect(result[0].filename).toBe('orphan.md');
  });

  it('全部已关联时返回空数组', async () => {
    const repo = await setup();
    expect(repo.listUnreferencedSources('s1')).toEqual([]);
  });

  it('deleteSource 删除 sources 行且不触碰其他行', async () => {
    const repo = await setup();
    repo.deleteSource('src1');
    expect(repo.getSource('src1')).toBeNull();
    expect(repo.getSource('src2')).not.toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/sources-repo.test.ts`
Expected: FAIL —— `repo.listUnreferencedSources is not a function`

- [ ] **Step 3: 实现**

`src/server/db/repos/sources-repo.ts`：drizzle-orm import 加 `isNull`（`import { and, eq, isNull } from 'drizzle-orm';`），文件末尾（`rowToSource` 之前）追加：

```ts
/**
 * 本 subject 下没有任何 page_sources 关联的 source（孤儿 source 候选，
 * 是否真正「孤儿」还要结合 ingest job 状态判定，见 lint-deterministic::checkOrphanSources）。
 */
export function listUnreferencedSources(subjectId: SubjectId): Source[] {
  const db = getDb();
  const rows = db
    .select({
      id: sources.id,
      subjectId: sources.subjectId,
      filename: sources.filename,
      contentHash: sources.contentHash,
      parsedAt: sources.parsedAt,
      metadataJson: sources.metadataJson,
    })
    .from(sources)
    .leftJoin(
      pageSources,
      and(eq(pageSources.sourceId, sources.id), eq(pageSources.subjectId, sources.subjectId))
    )
    .where(and(eq(sources.subjectId, subjectId), isNull(pageSources.sourceId)))
    .all();
  return rows.map(rowToSource);
}

/** 删除单个 source 行（raw 文件与 sidecar 的清理由调用方负责，见 source-store::deleteRawSourceFiles）。 */
export function deleteSource(id: string): void {
  const db = getDb();
  db.delete(sources).where(eq(sources.id, id)).run();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/db/repos/__tests__/sources-repo.test.ts`
Expected: PASS（全部用例，含既有的）

- [ ] **Step 5: Commit**

```bash
git add src/server/db/repos/sources-repo.ts src/server/db/repos/__tests__/sources-repo.test.ts
git commit -m "feat: sources-repo 新增零关联查询 listUnreferencedSources 与 deleteSource"
```

---

### Task 3: jobs-repo — 按 sourceId 反查最新 ingest job

**Files:**
- Modify: `src/server/db/repos/jobs-repo.ts`
- Test: `src/server/db/repos/__tests__/jobs-repo.test.ts`（追加 describe）

**Interfaces:**
- Consumes: 既有 `JobRow` interface、`rowToJobFromRaw(row: JobRow): Job`（jobs-repo.ts:350-380 一带，模块私有，直接复用）。
- Produces: `findLatestIngestJobBySourceId(subjectId: SubjectId, sourceId: string): Job | null`。Task 4/5 依赖。

- [ ] **Step 1: 写失败测试**

`src/server/db/repos/__tests__/jobs-repo.test.ts` 沿用文件顶部 temp-dir 模板，文件末尾追加（不复用该文件既有 `setup()`——它只灌 job_events；本 describe 自建数据）：

```ts
describe('findLatestIngestJobBySourceId', () => {
  async function setupJobs() {
    const repo = await import('../jobs-repo');
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    // subjectId 列无 FK 校验依赖（jobs.subject_id 可空、无强制外键行为阻断插入），直接 enqueue
    const j1 = repo.enqueueJob('ingest', { sourceId: 'src-a', filename: 'a.md', subjectId: 's1' }, 's1');
    const j2 = repo.enqueueJob('ingest', { sourceId: 'src-a', filename: 'a.md', subjectId: 's1' }, 's1');
    const j3 = repo.enqueueJob('ingest', { sourceId: 'src-b', filename: 'b.md', subjectId: 's1' }, 's1');
    const j4 = repo.enqueueJob('lint', { subjectId: 's1' }, 's1');
    // j1 旧且 failed，j2 新且 pending；created_at 由 enqueue 顺序天然递增，
    // 但同毫秒可能相等 → 显式拉开时间差保证排序确定
    db.prepare(`UPDATE jobs SET created_at = ?, status = 'failed' WHERE id = ?`).run('2026-01-01T00:00:00Z', j1.id);
    db.prepare(`UPDATE jobs SET created_at = ? WHERE id = ?`).run('2026-01-02T00:00:00Z', j2.id);
    return { repo, j1, j2, j3, j4 };
  }

  it('命中同 subject 同 sourceId 的最新一条 ingest job', async () => {
    const { repo, j2 } = await setupJobs();
    const found = repo.findLatestIngestJobBySourceId('s1', 'src-a');
    expect(found?.id).toBe(j2.id);
    expect(found?.status).toBe('pending');
  });

  it('LIKE 粗筛后仍做 JSON 精确匹配（子串误命中不算）', async () => {
    const { repo } = await setupJobs();
    // 'src-' 是 src-a 的前缀子串，LIKE '%"sourceId":"src-"%' 不会命中 src-a 行——
    // 反向验证：查询不存在的 sourceId 返回 null
    expect(repo.findLatestIngestJobBySourceId('s1', 'src-')).toBeNull();
  });

  it('不同 subject / 非 ingest 类型不命中', async () => {
    const { repo } = await setupJobs();
    expect(repo.findLatestIngestJobBySourceId('s2', 'src-a')).toBeNull();
    // j4 是 lint job，params 无 sourceId，天然不命中；再验证 src-b 只命中 ingest
    expect(repo.findLatestIngestJobBySourceId('s1', 'src-b')?.type).toBe('ingest');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/jobs-repo.test.ts`
Expected: FAIL —— `findLatestIngestJobBySourceId is not a function`

- [ ] **Step 3: 实现**

`src/server/db/repos/jobs-repo.ts` 追加（放在 `requeueJob` 之后即可）：

```ts
/**
 * 按 params 里的 sourceId 反查该 subject 最新一条 ingest job。
 * jobs 表无独立 sourceId 列，先用 LIKE 对 params_json 粗筛，再 JSON 解析精确匹配，
 * 防止 sourceId 是其他 id 子串时误命中。找不到返回 null。
 */
export function findLatestIngestJobBySourceId(
  subjectId: SubjectId,
  sourceId: string
): Job | null {
  const sqlite = getRawDb();
  const rows = sqlite
    .prepare(
      `SELECT * FROM jobs
       WHERE type = 'ingest' AND subject_id = ? AND params_json LIKE ?
       ORDER BY created_at DESC`
    )
    .all(subjectId, `%"sourceId":${JSON.stringify(sourceId)}%`) as JobRow[];
  for (const row of rows) {
    try {
      const params = JSON.parse(row.params_json ?? '{}') as { sourceId?: unknown };
      if (params.sourceId === sourceId) return rowToJobFromRaw(row);
    } catch {
      // params 不可解析 → 跳过该行
    }
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/db/repos/__tests__/jobs-repo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/db/repos/jobs-repo.ts src/server/db/repos/__tests__/jobs-repo.test.ts
git commit -m "feat: jobs-repo 新增按 sourceId 反查最新 ingest job"
```

---

### Task 4: lint-deterministic — `checkOrphanSources` 四分支检测

**Files:**
- Modify: `src/server/services/lint-deterministic.ts`
- Test: `src/server/services/__tests__/lint-deterministic.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 2 `listUnreferencedSources`、Task 3 `findLatestIngestJobBySourceId`、Task 1 契约字段。
- Produces: `checkOrphanSources(subject: Subject): LintFinding[]`（导出，供单测直测）；并入 `runDeterministicChecksForSubject` 输出。

- [ ] **Step 1: 写失败测试**

`src/server/services/__tests__/lint-deterministic.test.ts` 沿用文件顶部 temp-dir + env 模板，文件末尾追加：

```ts
describe('checkOrphanSources', () => {
  async function setupOrphans() {
    const subjectsRepo = await import('@/server/db/repos/subjects-repo');
    const jobsRepo = await import('@/server/db/repos/jobs-repo');
    const { getRawDb } = await import('@/server/db/client');
    const db = getRawDb();
    const s = subjectsRepo.create({ slug: 's-orph', name: 'S' });

    const insSrc = db.prepare(
      `INSERT INTO sources (id, subject_id, filename, content_hash, parsed_at, metadata_json)
       VALUES (?,?,?,?,?,?)`
    );
    // 五个 source，全部零 page_sources 关联，job 状态各不同
    insSrc.run('src-failed', s.id, 'failed.md', 'h1', null, '{}');
    insSrc.run('src-running', s.id, 'running.md', 'h2', null, '{}');
    insSrc.run('src-pending', s.id, 'pending.md', 'h3', null, '{}');
    insSrc.run('src-nojob', s.id, 'nojob.md', 'h4', null, '{}');
    insSrc.run('src-done', s.id, 'done.md', 'h5', null, '{}');
    // 第六个 source 已被页面引用 → 不进候选
    insSrc.run('src-linked', s.id, 'linked.md', 'h6', null, '{}');
    db.prepare(`INSERT INTO page_sources (subject_id, page_slug, source_id) VALUES (?,?,?)`)
      .run(s.id, 'some-page', 'src-linked');

    const mkJob = (sourceId: string, filename: string, status: string) => {
      const j = jobsRepo.enqueueJob('ingest', { sourceId, filename, subjectId: s.id }, s.id);
      db.prepare(`UPDATE jobs SET status = ? WHERE id = ?`).run(status, j.id);
      return j;
    };
    const failedJob = mkJob('src-failed', 'failed.md', 'failed');
    mkJob('src-running', 'running.md', 'running');
    mkJob('src-pending', 'pending.md', 'pending');
    mkJob('src-done', 'done.md', 'completed');

    const { checkOrphanSources } = await import('@/server/services/lint-deterministic');
    return { s, failedJob, checkOrphanSources };
  }

  it('failed job → 报 finding 且带 failedJobId', async () => {
    const { s, failedJob, checkOrphanSources } = await setupOrphans();
    const findings = checkOrphanSources(s);
    const f = findings.find((x) => x.sourceId === 'src-failed');
    expect(f).toBeDefined();
    expect(f!.type).toBe('orphan-source');
    expect(f!.severity).toBe('warning');
    expect(f!.pageSlug).toBe('');
    expect(f!.sourceFilename).toBe('failed.md');
    expect(f!.failedJobId).toBe(failedJob.id);
  });

  it('pending / running job → 跳过（在途，正常）', async () => {
    const { s, checkOrphanSources } = await setupOrphans();
    const findings = checkOrphanSources(s);
    expect(findings.find((x) => x.sourceId === 'src-running')).toBeUndefined();
    expect(findings.find((x) => x.sourceId === 'src-pending')).toBeUndefined();
  });

  it('查无 job → 报 finding 且 failedJobId 为 null', async () => {
    const { s, checkOrphanSources } = await setupOrphans();
    const f = checkOrphanSources(s).find((x) => x.sourceId === 'src-nojob');
    expect(f).toBeDefined();
    expect(f!.failedJobId).toBeNull();
  });

  it('completed 但零关联 → 报 finding（溯源丢失）且 failedJobId 为 null', async () => {
    const { s, checkOrphanSources } = await setupOrphans();
    const f = checkOrphanSources(s).find((x) => x.sourceId === 'src-done');
    expect(f).toBeDefined();
    expect(f!.failedJobId).toBeNull();
    expect(f!.description).toContain('completed');
  });

  it('已被页面引用的 source 不报', async () => {
    const { s, checkOrphanSources } = await setupOrphans();
    expect(checkOrphanSources(s).find((x) => x.sourceId === 'src-linked')).toBeUndefined();
  });

  it('并入 runDeterministicChecksForSubject 输出', async () => {
    const { s } = await setupOrphans();
    const { runDeterministicChecksForSubject } = await import('@/server/services/lint-deterministic');
    const all = runDeterministicChecksForSubject(s);
    expect(all.filter((x) => x.type === 'orphan-source').length).toBe(3); // failed + nojob + done
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/lint-deterministic.test.ts`
Expected: FAIL —— `checkOrphanSources` 未导出

- [ ] **Step 3: 实现**

`src/server/services/lint-deterministic.ts`：

顶部 import 区加：

```ts
import * as jobsRepo from '../db/repos/jobs-repo';
```

`runDeterministicChecksForSubject` 的 findings 收集处加一行（`checkStaleSources` 之后）：

```ts
  findings.push(...checkOrphanSources(subject));
```

文件末尾追加：

```ts
/**
 * 孤儿 source 检测：零 page_sources 关联的 source，按其 ingest job 状态分类——
 *   pending/running → 在途，跳过（正常状态，不报）；
 *   failed          → 报（可 checkpoint 续传重试，带 failedJobId）；
 *   查无 job        → 报（enqueue 失败或 job 行已清理，failedJobId=null）；
 *   completed       → 报（ingest 成功但溯源丢失，属异常，failedJobId=null）。
 * 顶部文档注释的覆盖清单同步补：orphan sources。
 */
export function checkOrphanSources(subject: Subject): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const source of sourcesRepo.listUnreferencedSources(subject.id)) {
    const job = jobsRepo.findLatestIngestJobBySourceId(subject.id, source.id);
    if (job && (job.status === 'pending' || job.status === 'running')) continue;

    const failedJobId = job?.status === 'failed' ? job.id : null;
    const description = !job
      ? `Orphan source: "${source.filename}" (subject: ${subject.slug}) is not referenced by any wiki page and has no ingest job on record.`
      : job.status === 'failed'
        ? `Orphan source: "${source.filename}" (subject: ${subject.slug}) was saved but its ingest job failed — no wiki page references it.`
        : `Orphan source: "${source.filename}" (subject: ${subject.slug}) has a completed ingest job but no wiki page references it (provenance lost).`;

    findings.push({
      type: 'orphan-source',
      severity: 'warning',
      pageSlug: '',
      description,
      suggestedFix:
        'Retry the ingest to (re)build pages from this source, or delete the source if it is no longer needed.',
      sourceId: source.id,
      sourceFilename: source.filename,
      failedJobId,
    });
  }
  return findings;
}
```

同时把文件顶部 doc comment 的覆盖清单改为：`覆盖：broken wikilinks / orphan pages / missing frontmatter / stale sources / orphan sources。`

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/services/__tests__/lint-deterministic.test.ts`
Expected: PASS（全部用例，含既有的——注意既有用例断言 findings 数量/类型集合的地方若被新增 orphan-source 干扰，属于既有 setup 里插入过 sources 的情况；本文件既有 setup 未插 sources 表数据，不受影响）

Run: `npx vitest run src/server/services/__tests__/fix-service.test.ts src/server/services/__tests__/fix-deterministic.test.ts src/server/services/__tests__/lint-latest.test.ts`
Expected: PASS（回归确认 fix 工作清单与快照读取不受新类型影响）

- [ ] **Step 5: Commit**

```bash
git add src/server/services/lint-deterministic.ts src/server/services/__tests__/lint-deterministic.test.ts
git commit -m "feat: lint 确定性检查新增孤儿 source 检测（四分支 job 状态分类）"
```

---

### Task 5: `POST /api/sources/[id]/reingest` 路由

**Files:**
- Create: `src/app/api/sources/[id]/reingest/route.ts`
- Test: `src/app/api/sources/[id]/reingest/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `sourcesRepo.getSource` / `listUnreferencedSources`、`jobsRepo.findLatestIngestJobBySourceId`、`queue.requeue/enqueue/get`、`events.emit`。
- Produces: `POST /api/sources/<id>/reingest` → 202 `{ jobId }`；404（不存在/跨 subject）；409 `{ error: 'already-referenced' | 'in-flight' }`。前端 Task 7 依赖。

- [ ] **Step 1: 写失败测试**

创建 `src/app/api/sources/[id]/reingest/__tests__/route.test.ts`（mock 风格仿 `src/app/api/research-backlog/[id]/__tests__/route.test.ts`）：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockGetSource = vi.fn();
const mockListUnreferenced = vi.fn();
const mockFindJob = vi.fn();
const mockRequeue = vi.fn();
const mockEnqueue = vi.fn();
const mockEmit = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...a: unknown[]) => mockResolve(...a),
}));
vi.mock('@/server/db/repos/sources-repo', () => ({
  getSource: (...a: unknown[]) => mockGetSource(...a),
  listUnreferencedSources: (...a: unknown[]) => mockListUnreferenced(...a),
}));
vi.mock('@/server/db/repos/jobs-repo', () => ({
  findLatestIngestJobBySourceId: (...a: unknown[]) => mockFindJob(...a),
}));
vi.mock('@/server/jobs/queue', () => ({
  requeue: (...a: unknown[]) => mockRequeue(...a),
  enqueue: (...a: unknown[]) => mockEnqueue(...a),
}));
vi.mock('@/server/jobs/events', () => ({ emit: (...a: unknown[]) => mockEmit(...a) }));

import { POST } from '../route';

const SUBJECT = { id: 's1', slug: 'general' };
const SOURCE = { id: 'src1', subjectId: 's1', filename: 'a.md', contentHash: 'h', parsedAt: null, metadataJson: '{}' };

function call(id: string) {
  const req = new NextRequest(`http://localhost/api/sources/${id}/reingest`, { method: 'POST' });
  return POST(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockReturnValue({ subject: SUBJECT, error: null });
  mockGetSource.mockReturnValue(SOURCE);
  mockListUnreferenced.mockReturnValue([SOURCE]);
  mockFindJob.mockReturnValue(null);
  mockEnqueue.mockReturnValue({ id: 'new-job' });
});

describe('POST /api/sources/[id]/reingest', () => {
  it('source 不存在 → 404', async () => {
    mockGetSource.mockReturnValue(null);
    expect((await call('missing')).status).toBe(404);
  });

  it('source 属其他 subject → 404', async () => {
    mockGetSource.mockReturnValue({ ...SOURCE, subjectId: 'other' });
    expect((await call('src1')).status).toBe(404);
  });

  it('已被页面引用 → 409 already-referenced', async () => {
    mockListUnreferenced.mockReturnValue([]);
    const res = await call('src1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already-referenced');
  });

  it('同源 job 在途（pending/running）→ 409 in-flight', async () => {
    mockFindJob.mockReturnValue({ id: 'j1', status: 'running', resultJson: null });
    const res = await call('src1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('in-flight');
    expect(mockRequeue).not.toHaveBeenCalled();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('有 failed job → requeue 原 job（checkpoint 续传），202 回原 jobId', async () => {
    mockFindJob.mockReturnValue({ id: 'j1', status: 'failed', resultJson: null });
    const res = await call('src1');
    expect(res.status).toBe(202);
    expect((await res.json()).jobId).toBe('j1');
    expect(mockRequeue).toHaveBeenCalledWith('j1');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('failed job 已被用户终结（cancelled）→ 不 requeue，新建 ingest job', async () => {
    mockFindJob.mockReturnValue({ id: 'j1', status: 'failed', resultJson: JSON.stringify({ cancelled: true }) });
    const res = await call('src1');
    expect(res.status).toBe(202);
    expect((await res.json()).jobId).toBe('new-job');
    expect(mockRequeue).not.toHaveBeenCalled();
    expect(mockEnqueue).toHaveBeenCalledWith(
      'ingest',
      { sourceId: 'src1', filename: 'a.md', subjectId: 's1' },
      's1',
    );
  });

  it('查无 job / job completed → 新建 ingest job，202 回新 jobId', async () => {
    const res = await call('src1');
    expect(res.status).toBe(202);
    expect((await res.json()).jobId).toBe('new-job');
    expect(mockEnqueue).toHaveBeenCalledWith(
      'ingest',
      { sourceId: 'src1', filename: 'a.md', subjectId: 's1' },
      's1',
    );

    mockEnqueue.mockClear();
    mockFindJob.mockReturnValue({ id: 'j1', status: 'completed', resultJson: null });
    const res2 = await call('src1');
    expect(res2.status).toBe(202);
    expect(mockEnqueue).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run "src/app/api/sources/[id]/reingest/__tests__/route.test.ts"`
Expected: FAIL —— `../route` 模块不存在

- [ ] **Step 3: 实现路由**

创建 `src/app/api/sources/[id]/reingest/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as sourcesRepo from '@/server/db/repos/sources-repo';
import * as jobsRepo from '@/server/db/repos/jobs-repo';
import * as queue from '@/server/jobs/queue';
import * as events from '@/server/jobs/events';

export const runtime = 'nodejs';

/**
 * POST /api/sources/[id]/reingest —— 重新触发孤儿 source 的 ingest。
 * 有可续传的 failed job 时 requeue 原 job（checkpoint 续传）；
 * 查无 job / job 已 completed / failed 但已被用户终结（cancelled）时新建 ingest job。
 * 前端统一只调本端点，无需区分有无历史 job。
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const resolution = resolveSubjectFromRequest(request, { required: true });
  if (resolution.error) return resolution.error;
  const subject = resolution.subject;

  const { id } = await params;
  const source = sourcesRepo.getSource(id);
  if (!source || source.subjectId !== subject.id) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }

  // 仍需零关联：已被页面引用的 source 不是孤儿，不允许经此端点重跑
  const unreferenced = sourcesRepo.listUnreferencedSources(subject.id).some((s) => s.id === id);
  if (!unreferenced) {
    return NextResponse.json({ error: 'already-referenced' }, { status: 409 });
  }

  const job = jobsRepo.findLatestIngestJobBySourceId(subject.id, id);
  if (job && (job.status === 'pending' || job.status === 'running')) {
    return NextResponse.json({ error: 'in-flight' }, { status: 409 });
  }

  if (job && job.status === 'failed') {
    // 已被用户手动终结的 job 检查点已清，requeue 会复活它——改走新建分支
    let cancelled = false;
    try {
      cancelled = !!(JSON.parse(job.resultJson ?? '{}') as { cancelled?: unknown }).cancelled;
    } catch {
      // result 不可解析 → 视为可 requeue
    }
    if (!cancelled) {
      queue.requeue(job.id);
      events.emit(job.id, 'job:retrying', 'Manual re-ingest — resuming from checkpoint', { manual: true });
      return NextResponse.json({ jobId: job.id }, { status: 202 });
    }
  }

  const newJob = queue.enqueue(
    'ingest',
    { sourceId: source.id, filename: source.filename, subjectId: subject.id },
    subject.id,
  );
  return NextResponse.json({ jobId: newJob.id }, { status: 202 });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run "src/app/api/sources/[id]/reingest/__tests__/route.test.ts"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/sources/[id]/reingest"
git commit -m "feat: 新增 POST /api/sources/[id]/reingest 孤儿 source 重摄入端点"
```

---

### Task 6: `DELETE /api/sources/[id]` 路由 + source-store 文件清理

**Files:**
- Modify: `src/server/sources/source-store.ts`（新增 `deleteRawSourceFiles`）
- Create: `src/app/api/sources/[id]/route.ts`（目录已存在，只有 `raw/route.ts` 子路由，无冲突）
- Test: `src/server/sources/__tests__/source-store-delete.test.ts`（新建）
- Test: `src/app/api/sources/[id]/__tests__/route.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 `deleteSource` / `listUnreferencedSources`、`acquireVaultLock(): Promise<Release>`（`Release` 是 `() => void`，`src/server/wiki/vault-mutex.ts:136`）、`commitVaultChanges(message, files?)`（`src/server/git/git-service.ts:69`）。
- Produces: `deleteRawSourceFiles(subjectSlug: string, filename: string, sourceId: string): void`（best-effort，不抛错）；`DELETE /api/sources/<id>` → 200 `{ deleted: true }`；404；409 `{ error: 'already-referenced' }`。

- [ ] **Step 1: 写 source-store 失败测试**

创建 `src/server/sources/__tests__/source-store-delete.test.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;
let prevVault: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-store-del-'));
  prevDb = process.env.DATABASE_PATH;
  prevVault = process.env.VAULT_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  process.env.VAULT_PATH = join(dir, 'vault');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  process.env.VAULT_PATH = prevVault;
  rmSync(dir, { recursive: true, force: true });
});

describe('deleteRawSourceFiles', () => {
  it('删除 subject-scoped raw 文件与 sidecar（含 legacy 平铺 sidecar），不删 legacy 平铺 raw', async () => {
    const vault = join(dir, 'vault');
    const rawDir = join(vault, 'raw', 'subj');
    const metaDir = join(vault, '.llm-wiki', 'sources', 'subj');
    mkdirSync(rawDir, { recursive: true });
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(join(rawDir, 'a.md'), 'content');
    writeFileSync(join(metaDir, 'id-1.json'), '{}');
    // legacy 平铺 sidecar（UUID 命名，无歧义 → 可删）
    writeFileSync(join(vault, '.llm-wiki', 'sources', 'id-1.json'), '{}');
    // legacy 平铺 raw（按 filename 命名，可能属于其他 subject → 不删）
    writeFileSync(join(vault, 'raw', 'a.md'), 'legacy content');

    const { deleteRawSourceFiles } = await import('../source-store');
    deleteRawSourceFiles('subj', 'a.md', 'id-1');

    expect(existsSync(join(rawDir, 'a.md'))).toBe(false);
    expect(existsSync(join(metaDir, 'id-1.json'))).toBe(false);
    expect(existsSync(join(vault, '.llm-wiki', 'sources', 'id-1.json'))).toBe(false);
    expect(existsSync(join(vault, 'raw', 'a.md'))).toBe(true); // legacy raw 保留
  });

  it('文件不存在时静默返回（best-effort）', async () => {
    const { deleteRawSourceFiles } = await import('../source-store');
    expect(() => deleteRawSourceFiles('subj', 'ghost.md', 'no-such-id')).not.toThrow();
  });

  it('拒绝越权 filename（路径穿越防护）', async () => {
    const vault = join(dir, 'vault');
    mkdirSync(join(vault, 'raw', 'subj'), { recursive: true });
    writeFileSync(join(vault, 'escape.md'), 'outside');
    const { deleteRawSourceFiles } = await import('../source-store');
    deleteRawSourceFiles('subj', '../../escape.md', 'id-x');
    expect(existsSync(join(vault, 'escape.md'))).toBe(true); // basename 化后只会找 raw/subj/escape.md
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/sources/__tests__/source-store-delete.test.ts`
Expected: FAIL —— `deleteRawSourceFiles` 未导出

- [ ] **Step 3: 实现 `deleteRawSourceFiles`**

`src/server/sources/source-store.ts` 文件末尾追加：

```ts
/**
 * 删除 source 的落盘文件：subject-scoped raw 文件 + sidecar（含 legacy 平铺 sidecar）。
 * Best-effort：文件缺失/删除失败均静默。
 * 刻意**不删** legacy 平铺 raw（vault/raw/<filename>）——它按 filename 命名，
 * 可能与其他 subject 的同名 source 共享，删除有误伤风险；由 stale-source 检查兜底提示。
 */
export function deleteRawSourceFiles(
  subjectSlug: string,
  filename: string,
  sourceId: string
): void {
  const safeFilename = path.basename(filename);
  const candidates = [
    path.join(rawDirFor(subjectSlug), safeFilename),
    path.join(sourcesMetaDirFor(subjectSlug), `${sourceId}.json`),
    vaultPath('.llm-wiki', 'sources', `${sourceId}.json`), // legacy 平铺 sidecar（UUID 命名，无歧义）
  ];
  for (const p of candidates) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // best-effort
    }
  }
}
```

Run: `npx vitest run src/server/sources/__tests__/source-store-delete.test.ts`
Expected: PASS

- [ ] **Step 4: 写 DELETE 路由失败测试**

创建 `src/app/api/sources/[id]/__tests__/route.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockResolve = vi.fn();
const mockGetSource = vi.fn();
const mockListUnreferenced = vi.fn();
const mockDeleteSource = vi.fn();
const mockDeleteFiles = vi.fn();
const mockCommit = vi.fn();
const mockRelease = vi.fn();
const mockAcquire = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (...a: unknown[]) => mockResolve(...a),
}));
vi.mock('@/server/db/repos/sources-repo', () => ({
  getSource: (...a: unknown[]) => mockGetSource(...a),
  listUnreferencedSources: (...a: unknown[]) => mockListUnreferenced(...a),
  deleteSource: (...a: unknown[]) => mockDeleteSource(...a),
}));
vi.mock('@/server/sources/source-store', () => ({
  deleteRawSourceFiles: (...a: unknown[]) => mockDeleteFiles(...a),
}));
vi.mock('@/server/git/git-service', () => ({
  commitVaultChanges: (...a: unknown[]) => mockCommit(...a),
}));
vi.mock('@/server/wiki/vault-mutex', () => ({
  acquireVaultLock: (...a: unknown[]) => mockAcquire(...a),
}));

import { DELETE } from '../route';

const SUBJECT = { id: 's1', slug: 'general' };
const SOURCE = { id: 'src1', subjectId: 's1', filename: 'a.md', contentHash: 'h', parsedAt: null, metadataJson: '{}' };

function call(id: string) {
  const req = new NextRequest(`http://localhost/api/sources/${id}`, { method: 'DELETE' });
  return DELETE(req, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockResolve.mockReturnValue({ subject: SUBJECT, error: null });
  mockGetSource.mockReturnValue(SOURCE);
  mockListUnreferenced.mockReturnValue([SOURCE]);
  mockAcquire.mockResolvedValue(mockRelease);
  mockCommit.mockResolvedValue('sha');
});

describe('DELETE /api/sources/[id]', () => {
  it('source 不存在 / 跨 subject → 404，不动锁', async () => {
    mockGetSource.mockReturnValue(null);
    expect((await call('missing')).status).toBe(404);
    mockGetSource.mockReturnValue({ ...SOURCE, subjectId: 'other' });
    expect((await call('src1')).status).toBe(404);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('已被页面引用 → 409 already-referenced', async () => {
    mockListUnreferenced.mockReturnValue([]);
    const res = await call('src1');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('already-referenced');
    expect(mockDeleteSource).not.toHaveBeenCalled();
  });

  it('正常删除：锁内 fs → DB → git commit，最后释放锁', async () => {
    const res = await call('src1');
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
    expect(mockDeleteFiles).toHaveBeenCalledWith('general', 'a.md', 'src1');
    expect(mockDeleteSource).toHaveBeenCalledWith('src1');
    expect(mockCommit).toHaveBeenCalledWith('[subject:general] Delete orphan source a.md');
    expect(mockRelease).toHaveBeenCalled();
  });

  it('commit 抛错时仍释放锁并返回 500', async () => {
    mockCommit.mockRejectedValue(new Error('git broke'));
    const res = await call('src1');
    expect(res.status).toBe(500);
    expect(mockRelease).toHaveBeenCalled();
  });
});
```

Run: `npx vitest run "src/app/api/sources/[id]/__tests__/route.test.ts"`
Expected: FAIL —— `../route` 模块不存在

- [ ] **Step 5: 实现 DELETE 路由**

创建 `src/app/api/sources/[id]/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as sourcesRepo from '@/server/db/repos/sources-repo';
import { deleteRawSourceFiles } from '@/server/sources/source-store';
import { commitVaultChanges } from '@/server/git/git-service';
import { acquireVaultLock } from '@/server/wiki/vault-mutex';

export const runtime = 'nodejs';

/**
 * DELETE /api/sources/[id] —— 删除孤儿 source（零 page_sources 关联才允许）。
 * vault 锁内：删 raw 文件 + sidecar（best-effort）→ 删 sources 行 → git commit。
 * 关联的 failed job 行不动（留着无害；reingest 端点靠 source 存在性校验兜底）。
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const resolution = resolveSubjectFromRequest(request, { required: true });
  if (resolution.error) return resolution.error;
  const subject = resolution.subject;

  const { id } = await params;
  const source = sourcesRepo.getSource(id);
  if (!source || source.subjectId !== subject.id) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }

  const unreferenced = sourcesRepo.listUnreferencedSources(subject.id).some((s) => s.id === id);
  if (!unreferenced) {
    return NextResponse.json({ error: 'already-referenced' }, { status: 409 });
  }

  const release = await acquireVaultLock();
  try {
    deleteRawSourceFiles(subject.slug, source.filename, source.id);
    sourcesRepo.deleteSource(source.id);
    await commitVaultChanges(`[subject:${subject.slug}] Delete orphan source ${source.filename}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Failed to delete source: ${msg}` }, { status: 500 });
  } finally {
    release();
  }

  return NextResponse.json({ deleted: true });
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run "src/app/api/sources/[id]/__tests__/route.test.ts" src/server/sources/__tests__/source-store-delete.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/server/sources/source-store.ts src/server/sources/__tests__/source-store-delete.test.ts "src/app/api/sources/[id]/route.ts" "src/app/api/sources/[id]/__tests__"
git commit -m "feat: 新增 DELETE /api/sources/[id] 孤儿 source 删除端点（vault 锁内 fs+DB+git）"
```

---

### Task 7: Health UI — orphan-source 行双按钮

> 本仓库无组件测试先例，本 task 用 `npx tsc --noEmit` + 手动走查验证（无新增单测）。

**Files:**
- Modify: `src/components/health/lint-findings.ts`（`findingHref`）
- Modify: `src/components/health/finding-row.tsx`
- Modify: `src/components/health/health-view.tsx`

**Interfaces:**
- Consumes: Task 1 契约字段（`sourceId`/`sourceFilename`）、Task 5/6 两个端点。
- Produces: `FindingRow` 新增可选 props `onReingestSource?: () => void`、`onDeleteSource?: () => void`、`sourceActing?: boolean`。

- [ ] **Step 1: `findingHref` 对 orphan-source 返回 null**

`src/components/health/lint-findings.ts` 的 `findingHref`：

```ts
export function findingHref(f: EnrichedLintFinding): string | null {
  // coverage-gap 指向尚不存在的建议新页；orphan-source 无对应页面 —— 均不可点击
  if (f.type === 'coverage-gap' || f.type === 'orphan-source') return null;
  return `/wiki/${f.pageSlug}?s=${encodeURIComponent(f.subjectSlug)}`;
}
```

- [ ] **Step 2: `FindingRow` 渲染 sourceFilename + 双按钮（两步确认删除）**

`src/components/health/finding-row.tsx` 整体调整：

1. import 区：`lucide-react` 增加 `RefreshCw, Trash2`（`FileX` Task 1 已加）；`react` 加 `useState`。
2. props 增加：

```ts
export function FindingRow({
  finding,
  showSubject = false,
  onResearch,
  researching = false,
  onReingestSource,
  onDeleteSource,
  sourceActing = false,
}: {
  finding: EnrichedLintFinding;
  showSubject?: boolean;
  /** coverage-gap 专属：触发针对本条 gap 的 research job。未传则不渲染按钮。 */
  onResearch?: () => void;
  researching?: boolean;
  /** orphan-source 专属：重新触发 ingest / 删除 source。未传则不渲染按钮。 */
  onReingestSource?: () => void;
  onDeleteSource?: () => void;
  sourceActing?: boolean;
}) {
```

3. 组件体内加两步确认状态（放在 `const Icon = ...` 之前）：

```ts
  const [deleteArmed, setDeleteArmed] = useState(false);
```

4. 名称展示：orphan-source 无 pageSlug，用 `sourceFilename` 替代。把现有 `href ? <Link .../> : <span ...>suggested page</span>` 三元改为：

```tsx
          {href ? (
            <Link href={href} className="text-sm font-medium text-accent hover:underline truncate">
              {finding.pageSlug}
            </Link>
          ) : finding.type === 'orphan-source' ? (
            <span className="text-sm font-medium text-foreground truncate">
              {finding.sourceFilename ?? finding.sourceId}
            </span>
          ) : (
            <span className="text-sm font-medium text-foreground truncate inline-flex items-center">
              {finding.pageSlug}
              <Tag tone="neutral" size="sm" className="ml-1.5">
                suggested page
              </Tag>
            </span>
          )}
```

5. 在现有 coverage-gap Research 按钮块之后追加 orphan-source 动作条：

```tsx
        {finding.type === 'orphan-source' && (onReingestSource || onDeleteSource) && (
          <div className="mt-1 flex items-center gap-2">
            {onReingestSource && (
              <Button intent="secondary" size="sm" onClick={onReingestSource} loading={sourceActing}>
                {!sourceActing && <RefreshCw className="h-3 w-3" />}
                Retry ingest
              </Button>
            )}
            {onDeleteSource && (
              <Button
                intent={deleteArmed ? 'danger' : 'secondary'}
                size="sm"
                disabled={sourceActing}
                onClick={() => {
                  if (!deleteArmed) {
                    setDeleteArmed(true);
                    return;
                  }
                  setDeleteArmed(false);
                  onDeleteSource();
                }}
              >
                <Trash2 className="h-3 w-3" />
                {deleteArmed ? 'Confirm delete' : 'Delete source'}
              </Button>
            )}
          </div>
        )}
```

注意：若 `Button` 组件无 `danger` intent（实现时以 `src/components/ui/button.tsx` 的 cva 变体为准），armed 态改用 `intent="secondary"` + `className="text-danger border-danger/40"`。

- [ ] **Step 3: `health-view.tsx` 接线**

`src/components/health/health-view.tsx`：

1. state 区（`typeFilter` 附近）追加：

```ts
  // orphan-source 行内动作：处置成功后本地隐藏该行（快照要等下次 lint 才刷新）
  const [handledSourceIds, setHandledSourceIds] = useState<Set<string>>(new Set());
  const [sourceActing, setSourceActing] = useState<string | null>(null);
```

2. `switchScope` 内追加重置：

```ts
    setHandledSourceIds(new Set());
    setSourceActing(null);
```

3. 已处置行过滤加在 `visibleFindings` 层（⚠️ **不要**动 `allFindings`——`coverageGapIds` 用 `allFindings` 的数组下标作为 gapId，服务端按最近快照同一顺序校验，在 `allFindings` 层过滤会造成下标漂移、Research gaps 指错条目）：

```ts
  const visibleFindings = useMemo(() => {
    const notHandled = allFindings.filter(
      (f) => !(f.type === 'orphan-source' && f.sourceId && handledSourceIds.has(f.sourceId)),
    );
    return typeFilter ? notHandled.filter((f) => f.type === typeFilter) : notHandled;
  }, [allFindings, typeFilter, handledSourceIds]);
```

4. 在 `confirmIngest` 之后新增两个 handler：

```ts
  async function reingestSource(sourceId: string) {
    setSourceActing(sourceId);
    try {
      const res = await apiFetch(`/api/sources/${sourceId}/reingest`, { method: 'POST' });
      if (res.status === 202) {
        // 新 job 会出现在全局 JobsPanel；本行标记已处置并本地隐藏
        setHandledSourceIds((prev) => new Set(prev).add(sourceId));
      }
    } finally {
      setSourceActing(null);
    }
  }

  async function deleteSource(sourceId: string) {
    setSourceActing(sourceId);
    try {
      const res = await apiFetch(`/api/sources/${sourceId}`, { method: 'DELETE' });
      if (res.ok) {
        setHandledSourceIds((prev) => new Set(prev).add(sourceId));
        queryClient.invalidateQueries({ queryKey: ['sources'] });
      }
    } finally {
      setSourceActing(null);
    }
  }
```

5. `FindingRow` 渲染处（分组列表内）追加三个 props（与 `onResearch` 并列；`allSubjects` 时不提供动作，与其他 subject-scoped 动作一致）：

```tsx
                        onReingestSource={
                          f.type === 'orphan-source' && f.sourceId && !allSubjects
                            ? () => reingestSource(f.sourceId!)
                            : undefined
                        }
                        onDeleteSource={
                          f.type === 'orphan-source' && f.sourceId && !allSubjects
                            ? () => deleteSource(f.sourceId!)
                            : undefined
                        }
                        sourceActing={f.type === 'orphan-source' && f.sourceId === sourceActing}
```

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `npx tsc --noEmit`
Expected: PASS（0 错误）

Run: `npx vitest run`
Expected: PASS（全部用例）

- [ ] **Step 5: 手动走查（可选但推荐，需 dev 环境）**

启动 `npm run dev:all`，向当前 subject 上传一个必然失败的 ingest（或直接在 DB 里造一个零关联 source + failed job），进 `/health` → Run health check → 确认出现 "Orphan source" warning 行、双按钮工作、处置后行消失。
⚠️ 注意（memory 教训）：测试 ingest 会污染真实 vault——用完 `git -C data/vault log` 确认并清理，或全程用临时 `VAULT_PATH`/`DATABASE_PATH` 环境起 dev。

- [ ] **Step 6: Commit**

```bash
git add src/components/health/lint-findings.ts src/components/health/finding-row.tsx src/components/health/health-view.tsx
git commit -m "feat: Health 页 orphan-source 行内 Retry ingest / Delete source 双按钮"
```

---

### Task 8: 文档同步 + 收尾验证

**Files:**
- Modify: `CLAUDE.md`（根，变更记录表追加一行）
- Modify: `src/server/db/CLAUDE.md`（sources-repo 接口清单补两函数）
- Modify: `src/app/CLAUDE.md`（API 表补两路由）

**Interfaces:** 无代码接口；纯文档。

- [ ] **Step 1: 更新三处文档**

1. 根 `CLAUDE.md` 变更记录表追加：

```markdown
| 2026-07-07 | 孤儿 source 体检与处置 | ingest 失败但 source 已入库的残留物此前不可见——lint 确定性检查新增 `orphan-source` finding（`checkOrphanSources`：零 page_sources 关联 + ingest job 状态四分支分类，pending/running 在途跳过；finding 携带 `sourceId`/`sourceFilename`/`failedJobId`）；Health 页逐条双按钮处置——`POST /api/sources/[id]/reingest`（有可续传 failed job 时 requeue 原 job，否则新建 ingest job；已引用/在途 409）+ `DELETE /api/sources/[id]`（零关联守卫，vault 锁内删 subject-scoped raw+sidecar+DB 行+git commit；legacy 平铺 raw 因跨 subject 歧义刻意不删）；新增 `sources-repo.listUnreferencedSources/deleteSource`、`jobs-repo.findLatestIngestJobBySourceId`、`source-store.deleteRawSourceFiles`；`orphan-source` 归 fix ignored 桶（不自动修）、无自动清理。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-07-orphan-source-health-check* |
```

2. `src/server/db/CLAUDE.md` 的 `sources-repo.ts` 小节行尾补：

```markdown
- `listUnreferencedSources(subjectId)` —— 零 page_sources 关联的 source（孤儿候选）；`deleteSource(id)` —— 删单行（文件清理归 source-store）；`findLatestIngestJobBySourceId(subjectId, sourceId)`（jobs-repo）—— params_json LIKE 粗筛 + JSON 精确匹配反查最新 ingest job
```

3. `src/app/CLAUDE.md` API 表追加两行：

```markdown
| `/api/sources/[id]/reingest` | POST | 🆕 孤儿 source 重摄入：有可续传 failed job → requeue（checkpoint 续传）；查无 job/completed/cancelled → 新建 ingest job；已被页面引用 409 `already-referenced`、在途 409 `in-flight` |
| `/api/sources/[id]` | DELETE | 🆕 删除孤儿 source（零关联守卫 409）：vault 锁内删 raw 文件+sidecar（best-effort）→ 删 sources 行 → git commit `[subject:<slug>]` |
```

- [ ] **Step 2: 最终全量验证**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 两者均 PASS

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md src/server/db/CLAUDE.md src/app/CLAUDE.md
git commit -m "docs: 同步孤儿 source 体检与处置的模块文档与变更记录"
```
