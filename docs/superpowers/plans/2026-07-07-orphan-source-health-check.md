# 孤儿 Source 体检与处置 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ingest 失败（或 job 丢失）后残留的零关联 source 能被 lint 体检报为 `orphan-source` finding，并在 Health 页逐条提供 Retry ingest / Delete source 两个手动处置动作。

**Architecture:** 检测并入 `lint-deterministic.ts`（判定拆为纯函数 + IO 薄包装）；处置为两个新端点 `POST /api/sources/[id]/reingest`（守卫+requeue/新建 job 的内核在 `services/source-reingest.ts`）与 `DELETE /api/sources/[id]`（内核在 `sources/source-delete.ts`：raw 文件 + sidecar + DB 行 + git commit）。Health 页 `FindingRow` 按类型渲染行内按钮。

**Tech Stack:** Next.js 15 Route Handlers、Drizzle + better-sqlite3、vitest。

**设计文档：** `docs/superpowers/specs/2026-07-07-orphan-source-health-check-design.md`

## Global Constraints

- 代码注释/commit message 用中文；commit 不加 AI 署名 trailer。
- 写路由必须 `requireAuth` + `requireCsrf` + `resolveSubjectFromRequest`；`export const runtime = 'nodejs'`。
- `orphan-source` severity 固定 `warning`；不进 Fix issues（`partitionFindings` 的 ignored 桶）；不自动清理。
- 验证命令：`npx tsc --noEmit` + `npx vitest run <file>`（`npm run lint` 不可用，勿跑）。
- 测试环境注意：repo 测试模式=临时 `DATABASE_PATH` + `vi.resetModules()` + 动态 import（参照 `src/server/db/repos/__tests__/sources-repo.test.ts`）。

---

### Task 1: repo 层查询（零关联 source / 按 sourceId 反查 ingest job / 删 source 行）

**Files:**
- Modify: `src/server/db/repos/sources-repo.ts`
- Modify: `src/server/db/repos/jobs-repo.ts`
- Test: `src/server/db/repos/__tests__/sources-repo.test.ts`（追加 describe）
- Test: `src/server/db/repos/__tests__/jobs-repo.test.ts`（追加 describe；若无此文件则新建，setup 模式抄 sources-repo.test.ts）

**Interfaces:**
- Produces: `listUnreferencedSources(subjectId: SubjectId): Source[]`；`deleteSource(id: string): void`；`findLatestIngestJobForSource(subjectId: SubjectId, sourceId: string): Job | null`

- [ ] **Step 1: 写失败测试（sources-repo）**

在 `sources-repo.test.ts` 末尾追加（复用文件顶部既有 beforeEach/afterEach 与 `setup()`；setup 中 `src2` 已有 page_sources 关联，需再插一条无关联 source）：

```ts
describe('sources-repo.listUnreferencedSources / deleteSource', () => {
  it('只返回本 subject 零 page_sources 关联的 source', async () => {
    const repo = await setup();
    const { getRawDb } = await import('../../client');
    getRawDb()
      .prepare(`INSERT INTO sources (id, subject_id, filename, content_hash, parsed_at, metadata_json) VALUES (?,?,?,?,?,?)`)
      .run('src-orphan', 's1', 'orphan.md', 'h9', NOW, '{}');
    const ids = repo.listUnreferencedSources('s1').map((s) => s.id);
    expect(ids).toEqual(['src-orphan']); // src1/src2 有关联，src3 属 s2
  });

  it('deleteSource 删除指定行且不影响其他行', async () => {
    const repo = await setup();
    repo.deleteSource('src1');
    expect(repo.getSource('src1')).toBeNull();
    expect(repo.getSource('src2')).not.toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/sources-repo.test.ts`
Expected: FAIL（`listUnreferencedSources is not a function`）

- [ ] **Step 3: 实现 sources-repo 两函数**

在 `sources-repo.ts`（import 行改为 `import { and, eq, isNull } from 'drizzle-orm';`）追加：

```ts
/** 本 subject 内没有任何 page_sources 关联的 source（孤儿候选，orphan-source 体检用）。 */
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
    .leftJoin(pageSources, eq(pageSources.sourceId, sources.id))
    .where(and(eq(sources.subjectId, subjectId), isNull(pageSources.sourceId)))
    .all();
  return rows.map(rowToSource);
}

/** 删除单个 source 行（调用方负责先确认零关联并清理 raw 文件/sidecar）。 */
export function deleteSource(id: string): void {
  const db = getDb();
  db.delete(sources).where(eq(sources.id, id)).run();
}
```

- [ ] **Step 4: 写失败测试（jobs-repo）**

在 `jobs-repo.test.ts` 追加（若新建文件，beforeEach/afterEach 抄 sources-repo.test.ts，把 mkdtemp 前缀改 `jobs-repo-`；subjects 插入同 setup）：

```ts
describe('jobs-repo.findLatestIngestJobForSource', () => {
  async function setupJobs() {
    const { getRawDb } = await import('../../client');
    const db = getRawDb();
    db.prepare(
      `INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`
    ).run('s1', 'sub-a', 'Sub A', '', NOW, NOW);
    const repo = await import('../jobs-repo');
    return { repo };
  }

  it('按 params.sourceId 精确匹配并取最新一条；无命中返回 null', async () => {
    const { repo } = await setupJobs();
    const j1 = repo.enqueueJob('ingest', 's1', { sourceId: 'src-x', filename: 'a.md', subjectId: 's1' });
    const j2 = repo.enqueueJob('ingest', 's1', { sourceId: 'src-x', filename: 'a.md', subjectId: 's1' });
    repo.enqueueJob('ingest', 's1', { sourceId: 'src-y', filename: 'b.md', subjectId: 's1' });
    repo.enqueueJob('lint', 's1', { sourceId: 'src-x' }); // 非 ingest 不算

    const hit = repo.findLatestIngestJobForSource('s1', 'src-x');
    expect(hit?.id).toBe(j2.id);
    expect([j1.id, j2.id]).toContain(hit!.id);
    expect(repo.findLatestIngestJobForSource('s1', 'src-zzz')).toBeNull();
  });
});
```

注意：`enqueueJob` 的实际签名以 `jobs-repo.ts` 现有导出为准（若为 `enqueueJob(type, params, subjectId)` 顺序则相应调整调用），createdAt 同毫秒时 rowid 决定顺序——实现里用「遍历 asc 列表保留最后一个命中」即可稳定取最新。

- [ ] **Step 5: 跑测试确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/jobs-repo.test.ts`
Expected: FAIL（`findLatestIngestJobForSource is not a function`）

- [ ] **Step 6: 实现 jobs-repo 反查**

在 `jobs-repo.ts` 追加（放在 `listJobs` 之后）：

```ts
/**
 * 按 params.sourceId 反查本 subject 最新一条 ingest job（orphan-source 体检/reingest 用）。
 * jobs 表无独立 source_id 列，靠解析 paramsJson 精确匹配；量级为单 subject 的 ingest
 * job 数，个人库场景全量遍历可接受。
 */
export function findLatestIngestJobForSource(
  subjectId: SubjectId,
  sourceId: string
): Job | null {
  const candidates = listJobs({ type: 'ingest', subjectId }); // createdAt asc
  let latest: Job | null = null;
  for (const job of candidates) {
    try {
      const params = JSON.parse(job.paramsJson ?? '{}') as { sourceId?: unknown };
      if (params.sourceId === sourceId) latest = job;
    } catch {
      // params 不可解析 → 跳过
    }
  }
  return latest;
}
```

- [ ] **Step 7: 跑两个测试文件确认通过**

Run: `npx vitest run src/server/db/repos/__tests__/sources-repo.test.ts src/server/db/repos/__tests__/jobs-repo.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/server/db/repos/sources-repo.ts src/server/db/repos/jobs-repo.ts src/server/db/repos/__tests__/
git commit -m "repo 层新增零关联 source 查询/删除与按 sourceId 反查 ingest job"
```

---

### Task 2: 契约扩展 + lint 确定性检查 `checkOrphanSources`

**Files:**
- Modify: `src/lib/contracts.ts:194-200`（LintFinding）
- Modify: `src/server/services/lint-deterministic.ts`
- Modify: `src/components/health/finding-row.tsx:20-38`（TYPE_ICON/TYPE_LABEL 补键，否则 Record 类型报错——本任务只补键保编译，按钮交互在 Task 5）
- Test: `src/server/services/__tests__/lint-deterministic.test.ts`（追加 describe）
- Test: `src/server/services/__tests__/fix-deterministic.test.ts`（追加 1 用例）

**Interfaces:**
- Consumes: Task 1 的 `listUnreferencedSources` / `findLatestIngestJobForSource`
- Produces: `LintFinding` 新增可选字段 `sourceId? / sourceFilename? / failedJobId?: string | null`；纯函数 `buildOrphanSourceFindings(subject, entries: OrphanSourceEntry[]): LintFinding[]`（`OrphanSourceEntry = { source: Source; job: Pick<Job,'id'|'status'> | null }`）；IO 包装 `checkOrphanSources(subject): LintFinding[]` 已并入 `runDeterministicChecksForSubject`

- [ ] **Step 1: 改契约**

`src/lib/contracts.ts` 的 `LintFinding` 改为：

```ts
export interface LintFinding {
  type: 'broken-link' | 'orphan' | 'missing-frontmatter' | 'stale-source' | 'contradiction' | 'missing-crossref' | 'coverage-gap' | 'orphan-source';
  severity: 'critical' | 'warning' | 'info';
  pageSlug: string;
  description: string;
  suggestedFix: string | null;
  /** orphan-source 专属：孤儿 source 的 id/文件名/可续传重试的失败 job（无则 null）。 */
  sourceId?: string;
  sourceFilename?: string;
  failedJobId?: string | null;
}
```

- [ ] **Step 2: 写失败测试（纯函数四分支）**

在 `lint-deterministic.test.ts` 追加：

```ts
import { buildOrphanSourceFindings } from '../lint-deterministic';
import type { Source, Subject } from '@/lib/contracts';

const SUBJECT = { id: 's1', slug: 'sub-a' } as Subject;
const src = (id: string): Source => ({
  id, subjectId: 's1', filename: `${id}.md`, contentHash: 'h', parsedAt: null, metadataJson: '{}',
});

describe('buildOrphanSourceFindings', () => {
  it('pending/running job → 在途，不报', () => {
    expect(buildOrphanSourceFindings(SUBJECT, [
      { source: src('a'), job: { id: 'j1', status: 'pending' } },
      { source: src('b'), job: { id: 'j2', status: 'running' } },
    ])).toEqual([]);
  });

  it('failed job → 报 finding 且携带 failedJobId', () => {
    const [f] = buildOrphanSourceFindings(SUBJECT, [
      { source: src('a'), job: { id: 'j1', status: 'failed' } },
    ]);
    expect(f.type).toBe('orphan-source');
    expect(f.severity).toBe('warning');
    expect(f.pageSlug).toBe('');
    expect(f.sourceId).toBe('a');
    expect(f.sourceFilename).toBe('a.md');
    expect(f.failedJobId).toBe('j1');
  });

  it('查无 job → 报 finding，failedJobId 为 null', () => {
    const [f] = buildOrphanSourceFindings(SUBJECT, [{ source: src('a'), job: null }]);
    expect(f.failedJobId).toBeNull();
  });

  it('completed 但零关联 → 报 finding（溯源丢失异常）', () => {
    const [f] = buildOrphanSourceFindings(SUBJECT, [
      { source: src('a'), job: { id: 'j1', status: 'completed' } },
    ]);
    expect(f.type).toBe('orphan-source');
    expect(f.failedJobId).toBeNull(); // completed job 不可 requeue，按无 job 处置
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/lint-deterministic.test.ts`
Expected: FAIL（`buildOrphanSourceFindings` 未导出）

- [ ] **Step 4: 实现纯函数 + IO 包装并接线**

在 `lint-deterministic.ts` 追加（import 补 `import * as jobsRepo from '../db/repos/jobs-repo';` 与 `Source`、`Job` 类型）：

```ts
export interface OrphanSourceEntry {
  source: Source;
  job: Pick<Job, 'id' | 'status'> | null;
}

/**
 * 孤儿 source 判定（纯函数）：零 page_sources 关联的 source 按其 ingest job 状态分类。
 * pending/running=在途不报；failed=可续传重试；无 job/completed=只能重新入队或删。
 */
export function buildOrphanSourceFindings(
  subject: Subject,
  entries: OrphanSourceEntry[]
): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const { source, job } of entries) {
    if (job && (job.status === 'pending' || job.status === 'running')) continue;
    const failedJobId = job?.status === 'failed' ? job.id : null;
    const reason = !job
      ? 'no ingest job references it (the job may have been pruned or enqueue failed)'
      : job.status === 'failed'
        ? 'its ingest job failed'
        : 'its ingest job completed without linking any page (provenance lost)';
    findings.push({
      type: 'orphan-source',
      severity: 'warning',
      pageSlug: '',
      description: `Orphan source: "${source.filename}" in subject "${subject.slug}" is not referenced by any page — ${reason}.`,
      suggestedFix: 'Retry the ingest to produce pages from it, or delete the source to clean up.',
      sourceId: source.id,
      sourceFilename: source.filename,
      failedJobId,
    });
  }
  return findings;
}

function checkOrphanSources(subject: Subject): LintFinding[] {
  const unreferenced = sourcesRepo.listUnreferencedSources(subject.id);
  return buildOrphanSourceFindings(
    subject,
    unreferenced.map((source) => ({
      source,
      job: jobsRepo.findLatestIngestJobForSource(subject.id, source.id),
    }))
  );
}
```

并在 `runDeterministicChecksForSubject` 末尾（`checkStaleSources` 之后）加一行：

```ts
  findings.push(...checkOrphanSources(subject));
```

- [ ] **Step 5: 补 fix ignored 桶断言**

`fix-deterministic.test.ts` 追加（`partitionFindings` 对未知类型天然入 ignored，零实现改动，加断言防回归）：

```ts
it('orphan-source 归入 ignored 桶（Fix issues 不处理）', () => {
  const { partitionFindings } = await import('../fix-deterministic'); // 若文件是静态 import 则直接用
  const { ignored, frontmatter, llm } = partitionFindings([
    { type: 'orphan-source', severity: 'warning', pageSlug: '', description: 'x', suggestedFix: null },
  ]);
  expect(ignored).toHaveLength(1);
  expect(frontmatter).toHaveLength(0);
  expect(llm).toHaveLength(0);
});
```

（按该测试文件既有 import 风格调整；若顶层已 `import { partitionFindings }` 就不要动态 import。）

- [ ] **Step 6: 补 finding-row 两个 Record 键（仅保编译）**

`finding-row.tsx`：`TYPE_ICON` 加 `'orphan-source': FileX,`（`lucide-react` import 补 `FileX`）；`TYPE_LABEL` 加 `'orphan-source': 'Orphan source',`。

- [ ] **Step 7: 验证**

Run: `npx vitest run src/server/services/__tests__/lint-deterministic.test.ts src/server/services/__tests__/fix-deterministic.test.ts && npx tsc --noEmit`
Expected: 全 PASS，tsc 退出码 0（tsc 会揪出其他遗漏的 `Record<LintFinding['type'],…>` 完整性错误，如 `lib/tool-activity` 等处若有则一并补键）

- [ ] **Step 8: Commit**

```bash
git add src/lib/contracts.ts src/server/services/lint-deterministic.ts src/server/services/__tests__/ src/components/health/finding-row.tsx src/server/services/__tests__/fix-deterministic.test.ts
git commit -m "lint 新增 orphan-source 确定性检查：零关联 source 按 ingest job 状态四分支判定"
```

---

### Task 3: 删除内核 + `DELETE /api/sources/[id]`

**Files:**
- Create: `src/server/sources/source-delete.ts`
- Create: `src/app/api/sources/[id]/route.ts`
- Test: `src/server/sources/__tests__/source-delete.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `deleteSource`；`sources-repo.getSource`；`git-service.commitVaultChanges`
- Produces: `deleteOrphanSource(subject: Pick<Subject,'id'|'slug'>, sourceId: string): Promise<DeleteOrphanSourceResult>`，`DeleteOrphanSourceResult = { ok: true } | { ok: false; code: 'not-found' | 'wrong-subject' | 'still-referenced' }`

- [ ] **Step 1: 写失败测试**

新建 `src/server/sources/__tests__/source-delete.test.ts`（DB 隔离模式同 repos 测试；vault 用临时目录；git commit 用 vi.mock 打桩避免真 git 仓库）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../git/git-service', () => ({ commitVaultChanges: vi.fn(async () => {}) }));

let dir: string;
let prevDb: string | undefined;
let prevVault: string | undefined;
const NOW = '2026-01-01T00:00:00Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-delete-'));
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

async function setup() {
  const { getRawDb } = await import('../../db/client');
  const db = getRawDb();
  db.prepare(`INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run('s1', 'sub-a', 'Sub A', '', NOW, NOW);
  db.prepare(`INSERT INTO sources (id, subject_id, filename, content_hash, parsed_at, metadata_json) VALUES (?,?,?,?,?,?)`)
    .run('src1', 's1', 'a.md', 'h1', NOW, '{}');
  // raw 文件 + sidecar 落盘
  const rawDir = join(dir, 'vault', 'raw', 'sub-a');
  const metaDir = join(dir, 'vault', '.llm-wiki', 'sources', 'sub-a');
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(metaDir, { recursive: true });
  writeFileSync(join(rawDir, 'a.md'), 'content');
  writeFileSync(join(metaDir, 'src1.json'), '{}');
  return {
    db,
    mod: await import('../source-delete'),
    rawFile: join(rawDir, 'a.md'),
    metaFile: join(metaDir, 'src1.json'),
  };
}

describe('deleteOrphanSource', () => {
  it('零关联 source：删 raw 文件 + sidecar + DB 行并 commit', async () => {
    const { db, mod, rawFile, metaFile } = await setup();
    const result = await mod.deleteOrphanSource({ id: 's1', slug: 'sub-a' }, 'src1');
    expect(result).toEqual({ ok: true });
    expect(existsSync(rawFile)).toBe(false);
    expect(existsSync(metaFile)).toBe(false);
    expect(db.prepare(`SELECT 1 FROM sources WHERE id='src1'`).get()).toBeUndefined();
    const { commitVaultChanges } = await import('../../git/git-service');
    expect(commitVaultChanges).toHaveBeenCalledWith(expect.stringContaining('[subject:sub-a]'));
  });

  it('有 page_sources 关联 → still-referenced，什么都不删', async () => {
    const { db, mod, rawFile } = await setup();
    db.prepare(`INSERT INTO page_sources (subject_id, page_slug, source_id) VALUES ('s1','p1','src1')`).run();
    const result = await mod.deleteOrphanSource({ id: 's1', slug: 'sub-a' }, 'src1');
    expect(result).toEqual({ ok: false, code: 'still-referenced' });
    expect(existsSync(rawFile)).toBe(true);
    expect(db.prepare(`SELECT 1 FROM sources WHERE id='src1'`).get()).toBeDefined();
  });

  it('不存在 → not-found；属其他 subject → wrong-subject', async () => {
    const { mod } = await setup();
    expect(await mod.deleteOrphanSource({ id: 's1', slug: 'sub-a' }, 'nope')).toEqual({ ok: false, code: 'not-found' });
    expect(await mod.deleteOrphanSource({ id: 's2', slug: 'sub-b' }, 'src1')).toEqual({ ok: false, code: 'wrong-subject' });
  });

  it('raw 文件/sidecar 已不在盘上 → best-effort 仍成功删 DB 行', async () => {
    const { db, mod, rawFile, metaFile } = await setup();
    rmSync(rawFile);
    rmSync(metaFile);
    expect(await mod.deleteOrphanSource({ id: 's1', slug: 'sub-a' }, 'src1')).toEqual({ ok: true });
    expect(db.prepare(`SELECT 1 FROM sources WHERE id='src1'`).get()).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/sources/__tests__/source-delete.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `source-delete.ts`**

```ts
/**
 * 孤儿 source 删除内核（供 DELETE /api/sources/[id] 调用）。
 * 守卫：source 存在 + 属于当前 subject + 仍零 page_sources 关联。
 * 删除：raw 文件（含 legacy 平铺路径）+ sidecar（best-effort，缺失不报错）
 * → sources 表行 → git commit（失败非致命，与 subject 级联删除同精神）。
 */
import fs from 'fs';
import path from 'path';
import { vaultPath } from '../config/env';
import * as sourcesRepo from '../db/repos/sources-repo';
import { commitVaultChanges } from '../git/git-service';
import type { Subject } from '@/lib/contracts';

export type DeleteOrphanSourceResult =
  | { ok: true }
  | { ok: false; code: 'not-found' | 'wrong-subject' | 'still-referenced' };

export async function deleteOrphanSource(
  subject: Pick<Subject, 'id' | 'slug'>,
  sourceId: string
): Promise<DeleteOrphanSourceResult> {
  const source = sourcesRepo.getSource(sourceId);
  if (!source) return { ok: false, code: 'not-found' };
  if (source.subjectId !== subject.id) return { ok: false, code: 'wrong-subject' };

  const stillOrphan = sourcesRepo
    .listUnreferencedSources(subject.id)
    .some((s) => s.id === sourceId);
  if (!stillOrphan) return { ok: false, code: 'still-referenced' };

  const safeFilename = path.basename(source.filename);
  const candidates = [
    vaultPath('raw', subject.slug, safeFilename),
    vaultPath('raw', safeFilename), // legacy 平铺
    vaultPath('.llm-wiki', 'sources', subject.slug, `${sourceId}.json`),
    vaultPath('.llm-wiki', 'sources', `${sourceId}.json`), // legacy 平铺
  ];
  for (const p of candidates) {
    try {
      fs.rmSync(p, { force: true });
    } catch {
      // best-effort：文件删不掉不阻断 DB 清理
    }
  }

  sourcesRepo.deleteSource(sourceId);

  try {
    await commitVaultChanges(`[subject:${subject.slug}] Delete orphan source ${safeFilename}`);
  } catch {
    // git failure is non-fatal（同 subjects/[id] DELETE 先例）
  }
  return { ok: true };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/sources/__tests__/source-delete.test.ts`
Expected: PASS

- [ ] **Step 5: 写路由 `src/app/api/sources/[id]/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { deleteOrphanSource } from '@/server/sources/source-delete';

export const runtime = 'nodejs';

/** DELETE /api/sources/[id] — 删除孤儿 source（raw 文件 + sidecar + DB 行 + git commit）。 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const resolution = resolveSubjectFromRequest(request, { required: true });
  if (resolution.error) return resolution.error;

  const { id } = await params;
  const result = await deleteOrphanSource(resolution.subject, id);
  if (!result.ok) {
    const status = result.code === 'still-referenced' ? 409 : 404;
    return NextResponse.json({ error: `Cannot delete source: ${result.code}`, code: result.code }, { status });
  }
  return NextResponse.json({ deleted: true });
}
```

（`wrong-subject` 归 404 不泄漏跨 subject 存在性。）

- [ ] **Step 6: 编译验证 + Commit**

Run: `npx tsc --noEmit`
Expected: 退出码 0

```bash
git add src/server/sources/source-delete.ts src/server/sources/__tests__/source-delete.test.ts src/app/api/sources/\[id\]/route.ts
git commit -m "新增孤儿 source 删除内核与 DELETE /api/sources/[id]（零关联守卫 + best-effort 文件清理 + git commit）"
```

---

### Task 4: 重新 ingest 内核 + `POST /api/sources/[id]/reingest`

**Files:**
- Create: `src/server/services/source-reingest.ts`
- Create: `src/app/api/sources/[id]/reingest/route.ts`
- Test: `src/server/services/__tests__/source-reingest.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `findLatestIngestJobForSource`；`jobs/queue` 的 `enqueue(type, params?, subjectId?) / requeue(id) / get(id)`；`jobs/events` 的 `emit(jobId, type, message, data?)`
- Produces: `reingestOrphanSource(subject: Pick<Subject,'id'|'slug'>, sourceId: string): ReingestResult`，`ReingestResult = { ok: true; jobId: string; mode: 'requeued' | 'new-job' } | { ok: false; code: 'not-found' | 'wrong-subject' | 'already-referenced' | 'in-flight' }`

- [ ] **Step 1: 写失败测试**

新建 `src/server/services/__tests__/source-reingest.test.ts`（DB 隔离同前；queue/events 走真实现——它们只写 SQLite）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;
const NOW = '2026-01-01T00:00:00Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'source-reingest-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const { getRawDb } = await import('../../db/client');
  const db = getRawDb();
  db.prepare(`INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run('s1', 'sub-a', 'Sub A', '', NOW, NOW);
  db.prepare(`INSERT INTO sources (id, subject_id, filename, content_hash, parsed_at, metadata_json) VALUES (?,?,?,?,?,?)`)
    .run('src1', 's1', 'a.md', 'h1', NOW, '{}');
  const jobsRepo = await import('../../db/repos/jobs-repo');
  const mod = await import('../source-reingest');
  return { db, jobsRepo, mod };
}
const SUBJ = { id: 's1', slug: 'sub-a' };

describe('reingestOrphanSource', () => {
  it('无任何 job → 新建 ingest job（params 含 sourceId/filename/subjectId）', async () => {
    const { jobsRepo, mod } = await setup();
    const result = mod.reingestOrphanSource(SUBJ, 'src1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe('new-job');
      const job = jobsRepo.getJob(result.jobId)!;
      expect(job.type).toBe('ingest');
      expect(JSON.parse(job.paramsJson)).toEqual({ sourceId: 'src1', filename: 'a.md', subjectId: 's1' });
    }
  });

  it('存在 failed job → requeue 同一 job（checkpoint 续传）', async () => {
    const { jobsRepo, mod } = await setup();
    const job = jobsRepo.enqueueJob('ingest', 's1', { sourceId: 'src1', filename: 'a.md', subjectId: 's1' });
    jobsRepo.failJob(job.id, new Error('boom'));
    const result = mod.reingestOrphanSource(SUBJ, 'src1');
    expect(result).toMatchObject({ ok: true, mode: 'requeued', jobId: job.id });
    expect(jobsRepo.getJob(job.id)!.status).toBe('pending');
  });

  it('存在 pending/running job → in-flight 拒绝', async () => {
    const { jobsRepo, mod } = await setup();
    jobsRepo.enqueueJob('ingest', 's1', { sourceId: 'src1', filename: 'a.md', subjectId: 's1' });
    expect(mod.reingestOrphanSource(SUBJ, 'src1')).toEqual({ ok: false, code: 'in-flight' });
  });

  it('已有 page_sources 关联 → already-referenced；不存在 → not-found；跨 subject → wrong-subject', async () => {
    const { db, mod } = await setup();
    expect(mod.reingestOrphanSource(SUBJ, 'nope')).toEqual({ ok: false, code: 'not-found' });
    expect(mod.reingestOrphanSource({ id: 's2', slug: 'sub-b' }, 'src1')).toEqual({ ok: false, code: 'wrong-subject' });
    db.prepare(`INSERT INTO page_sources (subject_id, page_slug, source_id) VALUES ('s1','p1','src1')`).run();
    expect(mod.reingestOrphanSource(SUBJ, 'src1')).toEqual({ ok: false, code: 'already-referenced' });
  });

  it('failed 且 result.cancelled=true（用户已终结）→ 不 requeue，新建 job', async () => {
    const { db, jobsRepo, mod } = await setup();
    const job = jobsRepo.enqueueJob('ingest', 's1', { sourceId: 'src1', filename: 'a.md', subjectId: 's1' });
    db.prepare(`UPDATE jobs SET status='failed', result_json='{"cancelled":true}' WHERE id=?`).run(job.id);
    const result = mod.reingestOrphanSource(SUBJ, 'src1');
    expect(result.ok && result.mode).toBe('new-job');
  });
});
```

（`enqueueJob`/`failJob` 实际签名以 `jobs-repo.ts` 为准，与 Task 1 测试一致调整。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/source-reingest.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `source-reingest.ts`**

```ts
/**
 * 孤儿 source 重新 ingest 内核（供 POST /api/sources/[id]/reingest 调用）。
 * 有可续传的 failed job → requeue（等价 /api/jobs/[id]/retry，checkpoint 续传）；
 * 无 job / completed / 已被用户终结（result.cancelled）→ 用同一 sourceId 新建 ingest job。
 */
import * as sourcesRepo from '../db/repos/sources-repo';
import * as jobsRepo from '../db/repos/jobs-repo';
import * as queue from '../jobs/queue';
import * as events from '../jobs/events';
import type { Subject } from '@/lib/contracts';

export type ReingestResult =
  | { ok: true; jobId: string; mode: 'requeued' | 'new-job' }
  | { ok: false; code: 'not-found' | 'wrong-subject' | 'already-referenced' | 'in-flight' };

export function reingestOrphanSource(
  subject: Pick<Subject, 'id' | 'slug'>,
  sourceId: string
): ReingestResult {
  const source = sourcesRepo.getSource(sourceId);
  if (!source) return { ok: false, code: 'not-found' };
  if (source.subjectId !== subject.id) return { ok: false, code: 'wrong-subject' };

  const stillOrphan = sourcesRepo
    .listUnreferencedSources(subject.id)
    .some((s) => s.id === sourceId);
  if (!stillOrphan) return { ok: false, code: 'already-referenced' };

  const job = jobsRepo.findLatestIngestJobForSource(subject.id, sourceId);
  if (job && (job.status === 'pending' || job.status === 'running')) {
    return { ok: false, code: 'in-flight' };
  }

  if (job && job.status === 'failed') {
    // 用户手动终结（result.cancelled）的 job 检查点已清，requeue 无意义 → 走新建分支
    let cancelled = false;
    try {
      cancelled = !!(JSON.parse(job.resultJson ?? '{}') as { cancelled?: unknown }).cancelled;
    } catch {
      // result 不可解析 → 视为可重试
    }
    if (!cancelled) {
      queue.requeue(job.id);
      events.emit(job.id, 'job:retrying', 'Manual retry from Health — resuming from checkpoint', { manual: true });
      return { ok: true, jobId: job.id, mode: 'requeued' };
    }
  }

  const newJob = queue.enqueue(
    'ingest',
    { sourceId, filename: source.filename, subjectId: subject.id },
    subject.id
  );
  return { ok: true, jobId: newJob.id, mode: 'new-job' };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/services/__tests__/source-reingest.test.ts`
Expected: PASS

- [ ] **Step 5: 写路由 `src/app/api/sources/[id]/reingest/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { reingestOrphanSource } from '@/server/services/source-reingest';

export const runtime = 'nodejs';

/** POST /api/sources/[id]/reingest — 重新触发孤儿 source 的 ingest（requeue 或新建 job）。 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const resolution = resolveSubjectFromRequest(request, { required: true });
  if (resolution.error) return resolution.error;

  const { id } = await params;
  const result = reingestOrphanSource(resolution.subject, id);
  if (!result.ok) {
    const status = result.code === 'not-found' || result.code === 'wrong-subject' ? 404 : 409;
    return NextResponse.json({ error: `Cannot reingest source: ${result.code}`, code: result.code }, { status });
  }
  return NextResponse.json({ jobId: result.jobId, mode: result.mode }, { status: 202 });
}
```

- [ ] **Step 6: 编译验证 + Commit**

Run: `npx tsc --noEmit`
Expected: 退出码 0

```bash
git add src/server/services/source-reingest.ts src/server/services/__tests__/source-reingest.test.ts src/app/api/sources/\[id\]/reingest/
git commit -m "新增孤儿 source 重新 ingest 内核与 POST /api/sources/[id]/reingest（requeue 续传或新建 job）"
```

---

### Task 5: Health UI — orphan-source 行内 Retry / Delete 按钮

**Files:**
- Modify: `src/components/health/lint-findings.ts:37-41`（findingHref）
- Modify: `src/components/health/finding-row.tsx`
- Modify: `src/components/health/health-view.tsx`

**Interfaces:**
- Consumes: Task 3/4 的两个端点
- Produces: `FindingRow` 新 props `onReingest?: () => void; onDeleteSource?: () => void; sourceBusy?: boolean`

- [ ] **Step 1: findingHref 对 orphan-source 返回 null**

`lint-findings.ts`：

```ts
export function findingHref(f: EnrichedLintFinding): string | null {
  // coverage-gap 指向尚不存在的建议新页；orphan-source 无对应页面 —— 均不可点击
  if (f.type === 'coverage-gap' || f.type === 'orphan-source') return null;
  return `/wiki/${f.pageSlug}?s=${encodeURIComponent(f.subjectSlug)}`;
}
```

- [ ] **Step 2: FindingRow 渲染文件名 + 双按钮（两步确认删除）**

`finding-row.tsx` 改动三处：

(a) props 扩展：

```ts
export function FindingRow({
  finding,
  showSubject = false,
  onResearch,
  researching = false,
  onReingest,
  onDeleteSource,
  sourceBusy = false,
}: {
  finding: EnrichedLintFinding;
  showSubject?: boolean;
  /** coverage-gap 专属：触发针对本条 gap 的 research job。未传则不渲染按钮。 */
  onResearch?: () => void;
  researching?: boolean;
  /** orphan-source 专属：Retry ingest / Delete source（两步确认）。未传则不渲染。 */
  onReingest?: () => void;
  onDeleteSource?: () => void;
  sourceBusy?: boolean;
}) {
```

(b) 标题行显示名：pageSlug 为空的 orphan-source 显示 `sourceFilename`。把不可点分支（`href` 为 null 的 `<span>`）里的 `{finding.pageSlug}` 改为 `{finding.type === 'orphan-source' ? finding.sourceFilename : finding.pageSlug}`，且 orphan-source 时右侧 Tag 文案用 `source file` 替代 `suggested page`（条件渲染）。

(c) 底部按钮区（`coverage-gap` 分支之后追加；`Trash2`、`RotateCw` 从 `lucide-react` 引入；两步确认用组件内 `useState`，文件顶部补 `import { useState } from 'react';`）：

```tsx
{finding.type === 'orphan-source' && (onReingest || onDeleteSource) && (
  <div className="mt-1 flex items-center gap-2">
    {onReingest && (
      <Button intent="secondary" size="sm" onClick={onReingest} loading={sourceBusy}>
        {!sourceBusy && <RotateCw className="h-3 w-3" />}
        Retry ingest
      </Button>
    )}
    {onDeleteSource && (
      <Button
        intent="secondary"
        size="sm"
        disabled={sourceBusy}
        onClick={() => {
          if (deleteArmed) onDeleteSource();
          else setDeleteArmed(true);
        }}
      >
        <Trash2 className="h-3 w-3" />
        {deleteArmed ? 'Confirm delete' : 'Delete source'}
      </Button>
    )}
  </div>
)}
```

组件体顶部加 `const [deleteArmed, setDeleteArmed] = useState(false);`（armed 态无需自动复位，行会随删除成功从列表消失；若 Button 无 `size="sm"`/`intent` 变体，按 coverage-gap 现有按钮的实际写法对齐）。

- [ ] **Step 3: health-view 接处置 handler**

`health-view.tsx` 在 research 区块之后追加：

```ts
// ── Orphan source：Retry ingest / Delete source ─────────────────────────────
const [sourceBusyId, setSourceBusyId] = useState<string | null>(null);

async function reingestSource(sourceId: string) {
  setSourceBusyId(sourceId);
  try {
    const res = await apiFetch(`/api/sources/${sourceId}/reingest`, { method: 'POST' });
    if (res.ok || res.status === 202) {
      // job 由全局 JobsPanel 追踪；完成后用户可 Re-run 刷新 findings
      queryClient.invalidateQueries({ queryKey: ['jobs'] });
    }
  } finally {
    setSourceBusyId(null);
  }
}

async function deleteSource(sourceId: string) {
  setSourceBusyId(sourceId);
  try {
    const res = await apiFetch(`/api/sources/${sourceId}`, { method: 'DELETE' });
    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ['lint-latest', allSubjects ? 'all' : subjectId] });
      void runLint(); // 快照里该 finding 仍在 → 重跑体检刷新
    }
  } finally {
    setSourceBusyId(null);
  }
}
```

并在 `FindingRow` 渲染处透传（`onResearch` 行之后）：

```tsx
onReingest={f.type === 'orphan-source' && f.sourceId && !allSubjects ? () => reingestSource(f.sourceId!) : undefined}
onDeleteSource={f.type === 'orphan-source' && f.sourceId && !allSubjects ? () => deleteSource(f.sourceId!) : undefined}
sourceBusy={f.sourceId != null && sourceBusyId === f.sourceId}
```

（`switchScope` 里追加 `setSourceBusyId(null);`。）

- [ ] **Step 4: 编译 + 手动验证**

Run: `npx tsc --noEmit`
Expected: 退出码 0

手动验证（可选但推荐，参照 memory：测试 ingest 会污染真实 vault，只做只读/可回收验证）：`npm run dev` 起 Next.js（不起 worker），Health 页确认 orphan-source 行渲染正常、按钮可点、删除走两步确认。

- [ ] **Step 5: Commit**

```bash
git add src/components/health/
git commit -m "Health 页 orphan-source finding 行内 Retry ingest / Delete source 双按钮（删除两步确认）"
```

---

### Task 6: 全量验证 + 文档同步

**Files:**
- Modify: `CLAUDE.md`（根，变更记录表追加一行）
- Modify: `src/server/db/CLAUDE.md` / `src/server/services/CLAUDE.md` / `src/app/CLAUDE.md`（对应 repo 导出 / lint 检查项 / 新路由各补一句）

- [ ] **Step 1: 全量测试 + 编译**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全 PASS（关注 lint-deterministic 既有用例未被 `runDeterministicChecksForSubject` 新增检查破坏——若既有集成式用例因新增 orphan-source findings 断言数量失败，修正断言为按 type 过滤）

- [ ] **Step 2: 更新文档**

根 `CLAUDE.md` 变更记录表追加：

```
| 2026-07-07 | 孤儿 source 体检与处置 | ingest 失败/丢 job 残留的零关联 source：lint 新增 `orphan-source` 确定性检查（纯函数 `buildOrphanSourceFindings` 四分支：在途跳过/failed 可续传/无 job/completed 溯源丢失；repo 层 `listUnreferencedSources`+`findLatestIngestJobForSource`）；Health 逐条行内 Retry ingest（`POST /api/sources/[id]/reingest`：failed job requeue 续传、无 job/已终结新建 job，在途 409）/ Delete source（`DELETE /api/sources/[id]`：零关联守卫 + raw/sidecar best-effort 清理 + DB 行 + git commit，删除两步确认）；不进 Fix issues、不自动清理。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-07-orphan-source-health-check* |
```

三个模块 CLAUDE.md 在对应小节各补一行（sources-repo 新导出、lint-deterministic 新检查、新路由两条）。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md src/server/db/CLAUDE.md src/server/services/CLAUDE.md src/app/CLAUDE.md
git commit -m "文档同步：孤儿 source 体检与处置"
```
