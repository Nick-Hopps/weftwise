# Subject 级联删除 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 subject 支持一键级联删除——删除 subject 的同时清理其全部关联数据（vault wiki/raw/sidecar 目录 + 所有 subject-scoped SQLite 行）。

**Architecture:** 业务守卫与级联清理收敛到 `subjects-repo.deleteWithContents(id)`（单 SQLite 事务，按子→父删 16 张表，原生 SQL，沿用 `/api/reset?subjectId` 风格）；`DELETE /api/subjects/[id]` 路由负责 404/守卫码映射 + vault 目录 `fs.rmSync` + git commit（同步，无异步 job）；`SubjectDialog` 去掉"空才能删"限制，改为两步确认 + 页数警告。

**Tech Stack:** TypeScript / Next.js 15 Route Handler / better-sqlite3（`getRawDb()` 原生事务）/ Drizzle（仅类型）/ React 19 + TanStack Query / vitest。

## Global Constraints

- 设计单一真实源：`docs/superpowers/specs/2026-06-29-subject-cascade-delete-design.md`，所有取舍以其为准。
- 守卫语义：`general` 不可删（409 `protected`）；有其他 subject 的入站跨主题引用不可删（409 `has-inbound-refs`）；active subject 仅**客户端**拦截，服务端不校验 active。
- `SubjectError.code` 最终联合类型：`'invalid-slug' | 'slug-conflict' | 'not-found' | 'protected' | 'has-inbound-refs'`（**移除** `'not-empty'`）。
- 路由层 code→status 映射：`not-found`→404，其余守卫码→409。
- vault 子目录三处：`wiki/<slug>`、`raw/<slug>`、`.llm-wiki/sources/<slug>`；删除前 `fs.existsSync` 守卫；git commit message 含 `[subject:<slug>]`，git 失败非致命。
- 提交信息用中文，一句话总结；不加 AI 署名 trailer/脚注。
- 测试 DB 走临时 `DATABASE_PATH` + `vi.resetModules()` + 动态 `import`（见现有 `subjects-repo.test.ts`），`getDb()`/`getRawDb()` 首次调用经 `ensureTables` 自动建表并 seed `general`。

---

### Task 1: `subjects-repo` 级联删除核心（`listInboundReferences` + `deleteWithContents` + 错误码）

**Files:**
- Modify: `src/server/db/repos/subjects-repo.ts`
- Test: `src/server/db/repos/__tests__/subjects-cascade-delete.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `getById(id)`、`SubjectError`、`create()`；新增对 `getRawDb` 的依赖（从 `../client` 导入）。
- Produces（供 Task 2 路由使用）：
  - `listInboundReferences(id: string): { id: string; slug: string }[]` —— 返回"其他 subject 指向本 subject"的去重 referencing subject 列表。
  - `deleteWithContents(id: string): void` —— 守卫（not-found/protected/has-inbound-refs 抛 `SubjectError`）+ 单事务级联删除全部关联行及 subject 行本身。
  - `SubjectError` 联合类型新增 `'protected' | 'has-inbound-refs'`（本任务**保留** `'not-empty'` 与 `deleteIfEmpty` 以免破坏路由编译，由 Task 2 移除）。

- [ ] **Step 1: 写失败测试**（新建 `src/server/db/repos/__tests__/subjects-cascade-delete.test.ts`）

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'subjects-cascade-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

// 为某 subject 在所有关联表插入一行（pages_fts 由 pages 插入触发器自动写入，不手插）。
function seedSubjectData(sqlite: any, subjectId: string) {
  const now = new Date().toISOString();
  sqlite.prepare(`INSERT INTO pages (subject_id, slug, title, path, summary, content_hash, tags, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(subjectId, 'page-a', 'Page A', `wiki/${subjectId}/page-a.md`, '', 'h1', '[]', now, now);
  sqlite.prepare(`INSERT INTO sources (id, subject_id, filename, content_hash, parsed_at, metadata_json) VALUES (?,?,?,?,?,?)`)
    .run(`src-${subjectId}`, subjectId, 'f.md', 'sh1', now, '{}');
  sqlite.prepare(`INSERT INTO page_sources (subject_id, page_slug, source_id) VALUES (?,?,?)`)
    .run(subjectId, 'page-a', `src-${subjectId}`);
  sqlite.prepare(`INSERT INTO page_aliases (subject_id, old_slug, new_slug, created_at) VALUES (?,?,?,?)`)
    .run(subjectId, 'old-a', 'page-a', now);
  sqlite.prepare(`INSERT INTO wiki_links (subject_id, source_slug, target_subject_id, target_slug, context) VALUES (?,?,?,?,?)`)
    .run(subjectId, 'page-a', subjectId, 'page-a', '');
  sqlite.prepare(`INSERT INTO page_embeddings (subject_id, slug, model, content_hash, dim, vector, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(subjectId, 'page-a', 'm', 'h', 1, Buffer.from([0]), now);
  sqlite.prepare(`INSERT INTO page_maturity (subject_id, slug, passes, last_enriched_at, interval_days, next_due_at, state, priority, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(subjectId, 'page-a', 0, null, 1, now, 'active', 0, now);
  sqlite.prepare(`INSERT INTO page_renditions (subject_id, slug, canonical_hash, profile_version, rendered_md, model, updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(subjectId, 'page-a', 'ch', 1, 'md', null, now);
  sqlite.prepare(`INSERT INTO profile_signals (user_id, type, subject_id, slug, created_at) VALUES (?,?,?,?,?)`)
    .run('local', 'too-hard', subjectId, 'page-a', now);
  sqlite.prepare(`INSERT INTO conversations (id, subject_id, title, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run(`conv-${subjectId}`, subjectId, 'C', now, now);
  sqlite.prepare(`INSERT INTO messages (id, conversation_id, role, content, citations_json, created_at) VALUES (?,?,?,?,?,?)`)
    .run(`msg-${subjectId}`, `conv-${subjectId}`, 'user', 'hi', null, now);
  sqlite.prepare(`INSERT INTO jobs (id, type, status, subject_id, params_json, created_at) VALUES (?,?,?,?,?,?)`)
    .run(`job-${subjectId}`, 'ingest', 'completed', subjectId, '{}', now);
  sqlite.prepare(`INSERT INTO job_events (id, job_id, type, message, data_json, created_at) VALUES (?,?,?,?,?,?)`)
    .run(`ev-${subjectId}`, `job-${subjectId}`, 'log', 'm', null, now);
  sqlite.prepare(`INSERT INTO ingest_checkpoints (job_id, kind, key, data_json, created_at) VALUES (?,?,?,?,?)`)
    .run(`job-${subjectId}`, 'plan', 'k', '{}', now);
  sqlite.prepare(`INSERT INTO operations (id, job_id, subject_id, pre_head, post_head, changeset_json, status) VALUES (?,?,?,?,?,?,?)`)
    .run(`op-${subjectId}`, `job-${subjectId}`, subjectId, 'pre', 'post', '{}', 'applied');
}

const SUBJECT_TABLES = [
  'pages', 'sources', 'page_sources', 'page_aliases', 'wiki_links',
  'page_embeddings', 'page_maturity', 'page_renditions', 'profile_signals',
  'conversations', 'operations', 'jobs', 'pages_fts',
];

function totalRowsForSubject(sqlite: any, subjectId: string): number {
  let total = 0;
  for (const t of SUBJECT_TABLES) {
    const r = sqlite.prepare(`SELECT COUNT(*) AS c FROM ${t} WHERE subject_id = ?`).get(subjectId) as { c: number };
    total += Number(r.c);
  }
  return total;
}

describe('subjects-repo deleteWithContents', () => {
  it('purges every subject-scoped table + the subject row, leaving general/other intact', async () => {
    const { randomUUID } = await import('crypto');
    const subjectsRepo = await import('../subjects-repo');
    const { getRawDb } = await import('../../client');
    const sqlite = getRawDb();

    const target = subjectsRepo.create({ slug: `t-${randomUUID().slice(0, 8)}`, name: 'Target' });
    const other = subjectsRepo.create({ slug: `o-${randomUUID().slice(0, 8)}`, name: 'Other' });
    seedSubjectData(sqlite, target.id);
    seedSubjectData(sqlite, other.id);

    expect(totalRowsForSubject(sqlite, target.id)).toBeGreaterThan(0);

    subjectsRepo.deleteWithContents(target.id);

    // subject 行与全部关联行清零
    expect(subjectsRepo.getById(target.id)).toBeNull();
    expect(totalRowsForSubject(sqlite, target.id)).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ?`).get(`conv-${target.id}`) as { c: number }).c).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM job_events WHERE job_id = ?`).get(`job-${target.id}`) as { c: number }).c).toBe(0);
    expect((sqlite.prepare(`SELECT COUNT(*) AS c FROM ingest_checkpoints WHERE job_id = ?`).get(`job-${target.id}`) as { c: number }).c).toBe(0);

    // 其他 subject 与 general 不受影响
    expect(subjectsRepo.getById(other.id)).not.toBeNull();
    expect(totalRowsForSubject(sqlite, other.id)).toBeGreaterThan(0);
    expect(subjectsRepo.getBySlug('general')).not.toBeNull();
  });

  it('refuses to delete the general subject', async () => {
    const subjectsRepo = await import('../subjects-repo');
    const { SubjectError } = subjectsRepo;
    const general = subjectsRepo.getBySlug('general')!;
    expect(() => subjectsRepo.deleteWithContents(general.id)).toThrow(SubjectError);
    try {
      subjectsRepo.deleteWithContents(general.id);
    } catch (e: any) {
      expect(e.code).toBe('protected');
    }
    expect(subjectsRepo.getBySlug('general')).not.toBeNull();
  });

  it('refuses to delete a subject with inbound cross-subject references', async () => {
    const { randomUUID } = await import('crypto');
    const subjectsRepo = await import('../subjects-repo');
    const { getRawDb } = await import('../../client');
    const sqlite = getRawDb();

    const target = subjectsRepo.create({ slug: `t-${randomUUID().slice(0, 8)}`, name: 'Target' });
    const other = subjectsRepo.create({ slug: `o-${randomUUID().slice(0, 8)}`, name: 'Other' });
    // other 指向 target 的入站链接
    sqlite.prepare(`INSERT INTO wiki_links (subject_id, source_slug, target_subject_id, target_slug, context) VALUES (?,?,?,?,?)`)
      .run(other.id, 'o-page', target.id, 'page-a', '');

    expect(() => subjectsRepo.deleteWithContents(target.id)).toThrow(/referenced by other subjects/i);
    expect(subjectsRepo.getById(target.id)).not.toBeNull();
  });
});

describe('subjects-repo listInboundReferences', () => {
  it('returns distinct other-subject referrers, excluding intra-subject links', async () => {
    const { randomUUID } = await import('crypto');
    const subjectsRepo = await import('../subjects-repo');
    const { getRawDb } = await import('../../client');
    const sqlite = getRawDb();

    const target = subjectsRepo.create({ slug: `t-${randomUUID().slice(0, 8)}`, name: 'Target' });
    const other = subjectsRepo.create({ slug: `o-${randomUUID().slice(0, 8)}`, name: 'Other' });

    // 同一 other 两条入站（应去重为 1）+ 一条 target 自指（应排除）
    const ins = sqlite.prepare(`INSERT INTO wiki_links (subject_id, source_slug, target_subject_id, target_slug, context) VALUES (?,?,?,?,?)`);
    ins.run(other.id, 'p1', target.id, 'page-a', '');
    ins.run(other.id, 'p2', target.id, 'page-a', '');
    ins.run(target.id, 'page-a', target.id, 'page-a', '');

    const refs = subjectsRepo.listInboundReferences(target.id);
    expect(refs).toHaveLength(1);
    expect(refs[0].slug).toBe(other.slug);

    expect(subjectsRepo.listInboundReferences(other.id)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd <worktree> && ./node_modules/.bin/vitest run src/server/db/repos/__tests__/subjects-cascade-delete.test.ts`
Expected: FAIL —— `deleteWithContents is not a function` / `listInboundReferences is not a function`。

- [ ] **Step 3: 实现 repo 改动**（编辑 `src/server/db/repos/subjects-repo.ts`）

3a. 顶部 import 增加 `getRawDb`：

```ts
import { getDb, getRawDb } from '../client';
```

> 注：现有为 `import { getDb } from '../client';`，改为同时导入 `getRawDb`。

3b. `SubjectError` 联合类型新增两码（本任务保留 `not-empty`）：

```ts
export class SubjectError extends Error {
  constructor(public code: 'invalid-slug' | 'slug-conflict' | 'not-empty' | 'not-found' | 'protected' | 'has-inbound-refs', message: string) {
    super(message);
    this.name = 'SubjectError';
  }
}
```

3c. 在文件末尾追加两个函数：

```ts
/**
 * 列出"其他 subject 指向本 subject"的去重 referencing subject（用于删除前的入站引用守卫）。
 * 仅计 subject_id ≠ id 的 wiki_links（排除本 subject 自指链接）。
 */
export function listInboundReferences(id: string): { id: string; slug: string }[] {
  const sqlite = getRawDb();
  return sqlite
    .prepare(
      `SELECT DISTINCT s.id AS id, s.slug AS slug
         FROM wiki_links wl
         JOIN subjects s ON s.id = wl.subject_id
        WHERE wl.target_subject_id = ? AND wl.subject_id != ?`
    )
    .all(id, id) as { id: string; slug: string }[];
}

/**
 * 级联删除 subject 及其全部关联数据（单事务，按子→父顺序原生删除）。
 * 守卫：subject 不存在→not-found；general→protected；有入站跨主题引用→has-inbound-refs。
 * 仅清理 DB 行；vault 目录与 git commit 由路由层负责。
 */
export function deleteWithContents(id: string): void {
  const subject = getById(id);
  if (!subject) {
    throw new SubjectError('not-found', `Subject ${id} not found`);
  }
  if (subject.slug === 'general') {
    throw new SubjectError('protected', `The general subject can't be deleted`);
  }
  const inbound = listInboundReferences(id);
  if (inbound.length > 0) {
    const names = inbound.map((s) => s.slug);
    const shown = names.slice(0, 5).join(', ');
    const suffix = names.length > 5 ? ', …' : '';
    throw new SubjectError(
      'has-inbound-refs',
      `This subject is referenced by other subjects (${shown}${suffix}). Remove those cross-subject links first.`
    );
  }

  const sqlite = getRawDb();
  const purge = sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM conversations WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM page_renditions WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM page_maturity WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM page_embeddings WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM page_sources WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM pages_fts WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM wiki_links WHERE subject_id = ? OR target_subject_id = ?`).run(id, id);
    sqlite.prepare(`DELETE FROM page_aliases WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM pages WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM sources WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM profile_signals WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM ingest_checkpoints WHERE job_id IN (SELECT id FROM jobs WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM job_events WHERE job_id IN (SELECT id FROM jobs WHERE subject_id = ?)`).run(id);
    sqlite.prepare(`DELETE FROM operations WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM jobs WHERE subject_id = ?`).run(id);
    sqlite.prepare(`DELETE FROM subjects WHERE id = ?`).run(id);
  });
  purge();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd <worktree> && ./node_modules/.bin/vitest run src/server/db/repos/__tests__/subjects-cascade-delete.test.ts`
Expected: PASS（5 用例全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/server/db/repos/subjects-repo.ts src/server/db/repos/__tests__/subjects-cascade-delete.test.ts
git commit -m "feat(subject-delete): subjects-repo 新增级联删除 deleteWithContents 与入站引用守卫"
```

---

### Task 2: `DELETE /api/subjects/[id]` 路由级联删除 + 清理 vault + 移除 deleteIfEmpty

**Files:**
- Modify: `src/app/api/subjects/[id]/route.ts`
- Modify: `src/server/db/repos/subjects-repo.ts`（删 `deleteIfEmpty` + 联合类型去 `not-empty`）

**Interfaces:**
- Consumes（来自 Task 1）：`subjectsRepo.deleteWithContents(id)`、`subjectsRepo.getById(id)`、`SubjectError`（codes 含 `not-found`/`protected`/`has-inbound-refs`）。
- Consumes（既有）：`vaultPath(...)`（`@/server/config/env`）、`commitVaultChanges(msg)`（`@/server/git/git-service`）。
- Produces：`DELETE /api/subjects/[id]` 行为——404（不存在）/ 409（protected 或 has-inbound-refs）/ 200 `{ ok: true, subjectId }`（成功，已删 vault 目录 + git commit）。

- [ ] **Step 1: 改路由 import**（编辑 `src/app/api/subjects/[id]/route.ts` 顶部）

将：
```ts
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import { SubjectError } from '@/server/db/repos/subjects-repo';
import { deleteBySubject as deleteRenditionsBySubject } from '@/server/db/repos/renditions-repo';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { AugmentationLevelSchema } from '@/lib/contracts';
```
改为：
```ts
import fs from 'fs';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import { SubjectError } from '@/server/db/repos/subjects-repo';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { vaultPath } from '@/server/config/env';
import { commitVaultChanges } from '@/server/git/git-service';
import { AugmentationLevelSchema } from '@/lib/contracts';
```

> 移除 `renditions-repo` 导入（renditions 清理已并入 `deleteWithContents`）；新增 `fs` / `vaultPath` / `commitVaultChanges`。

- [ ] **Step 2: 重写 DELETE handler**

将现有 `export async function DELETE(...) { ... }`（含 `deleteIfEmpty` + `deleteRenditionsBySubject` 的实现）整体替换为：

```ts
export async function DELETE(request: NextRequest, { params }: SubjectRouteContext) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const { id } = await params;
  const subject = subjectsRepo.getById(id);
  if (!subject) {
    return NextResponse.json({ error: 'Subject not found' }, { status: 404 });
  }

  // 级联清理 DB（含守卫：general / 入站跨主题引用）。
  try {
    subjectsRepo.deleteWithContents(id);
  } catch (err) {
    if (err instanceof SubjectError) {
      const status = err.code === 'not-found' ? 404 : 409;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    throw err;
  }

  // 清理该 subject 的 vault 子目录。
  for (const dir of [
    vaultPath('wiki', subject.slug),
    vaultPath('raw', subject.slug),
    vaultPath('.llm-wiki', 'sources', subject.slug),
  ]) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  try {
    await commitVaultChanges(`[subject:${subject.slug}] Delete subject and all contents`);
  } catch {
    // git failure is non-fatal
  }

  return NextResponse.json({ ok: true, subjectId: id });
}
```

- [ ] **Step 3: 删除 repo 中的 `deleteIfEmpty` 并去掉 `not-empty` 码**（编辑 `src/server/db/repos/subjects-repo.ts`）

3a. 删除整个 `deleteIfEmpty` 函数：

```ts
export function deleteIfEmpty(id: string): void {
  const subject = getById(id);
  if (!subject) {
    throw new SubjectError('not-found', `Subject ${id} not found`);
  }
  const pageCount = countPages(id);
  if (pageCount > 0) {
    throw new SubjectError(
      'not-empty',
      `Subject "${subject.slug}" still contains ${pageCount} page(s)`
    );
  }
  const db = getDb();
  db.delete(subjects).where(eq(subjects.id, id)).run();
}
```

3b. `SubjectError` 联合类型去掉 `'not-empty'`，最终为：

```ts
export class SubjectError extends Error {
  constructor(public code: 'invalid-slug' | 'slug-conflict' | 'not-found' | 'protected' | 'has-inbound-refs', message: string) {
    super(message);
    this.name = 'SubjectError';
  }
}
```

- [ ] **Step 4: 类型检查 + 跑相关测试**

Run: `cd <worktree> && ./node_modules/.bin/tsc --noEmit; echo "tsc exit: $?"`
Expected: `tsc exit: 0`（无 `deleteIfEmpty`/`not-empty` 残留引用、无未用导入报错）。

Run: `cd <worktree> && ./node_modules/.bin/vitest run src/server/db/repos/__tests__/subjects-cascade-delete.test.ts`
Expected: PASS（确认 repo 改动未回归）。

- [ ] **Step 5: 提交**

```bash
git add src/app/api/subjects/[id]/route.ts src/server/db/repos/subjects-repo.ts
git commit -m "feat(subject-delete): DELETE /api/subjects/[id] 级联删除并清理 vault 目录"
```

---

### Task 3: `SubjectDialog` 危险区改为可删非空 + 两步确认 + 页数警告

**Files:**
- Modify: `src/components/subjects/subject-dialog.tsx`（`EditSubjectBody` 的 `canDelete` 与危险区 JSX）

**Interfaces:**
- Consumes：`subject.pageCount`（来自 `fetchSubjects()` → `SubjectListEntry`）、`subject.slug`、`isActive`（来自 `useCurrentSubject`）、既有 `confirmArmed` / `deleteMutation`。
- Produces：UI 行为——非空且非 active 且非 general 时可两步删除（armed 显示页数警告）；general / active 显示对应禁用说明；删除失败（如 409 has-inbound-refs）经既有 `error` 状态展示。

- [ ] **Step 1: 改 `canDelete`**（`EditSubjectBody` 内，约 `src/components/subjects/subject-dialog.tsx:302`）

将：
```ts
  const canDelete = subject.pageCount === 0 && !isActive;
```
改为：
```ts
  // 允许删除非空 subject（级联清理由后端处理）；仅 active 与 general 仍禁删。
  const canDelete = !isActive && subject.slug !== 'general';
```

- [ ] **Step 2: 重写危险区 JSX**

将 `EditSubjectBody` 末尾的 danger zone 块（`<div className="border-t border-border bg-subtle/40 px-4 py-3"> ... </div>`）整体替换为：

```tsx
      <div className="border-t border-border bg-subtle/40 px-4 py-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-foreground-tertiary">
          Danger zone
        </p>
        {canDelete ? (
          <>
            {confirmArmed && (
              <p className="mb-2 text-xs text-danger">
                This permanently deletes &ldquo;{subject.name}&rdquo; and its {subject.pageCount}{' '}
                {subject.pageCount === 1 ? 'page' : 'pages'} and all sources. This can&apos;t be undone.
              </p>
            )}
            <Button
              intent={confirmArmed ? 'danger' : 'outline'}
              size="sm"
              type="button"
              loading={deleteMutation.isPending}
              onClick={() => {
                if (!confirmArmed) {
                  setConfirmArmed(true);
                  return;
                }
                deleteMutation.mutate(subject.id);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {confirmArmed ? 'Click again to confirm' : 'Delete subject'}
            </Button>
          </>
        ) : (
          <p className="text-xs text-foreground-tertiary">
            {subject.slug === 'general'
              ? "The general subject can't be deleted."
              : 'This subject is currently active. Switch to another subject before deleting.'}
          </p>
        )}
      </div>
```

> `deleteMutation.onError` 既有逻辑（`setError(err.message); setConfirmArmed(false)`）会把 409 `has-inbound-refs` 的 message 显示在表单的 `{error && <p className="text-xs text-danger">{error}</p>}` 行——无需新增错误展示。

- [ ] **Step 3: 类型检查**

Run: `cd <worktree> && ./node_modules/.bin/tsc --noEmit; echo "tsc exit: $?"`
Expected: `tsc exit: 0`。

> 组件无单测（见 `src/components/CLAUDE.md`），以 `tsc` + Task 4 的手动冒烟为准。

- [ ] **Step 4: 提交**

```bash
git add src/components/subjects/subject-dialog.tsx
git commit -m "feat(subject-delete): SubjectDialog 支持删除非空 subject 并加两步确认与页数警告"
```

---

### Task 4: 全量校验 + 手动冒烟

**Files:** 无（仅校验）

- [ ] **Step 1: 跑全量测试 + 类型检查**

Run: `cd <worktree> && ./node_modules/.bin/vitest run; echo "---"; ./node_modules/.bin/tsc --noEmit; echo "tsc exit: $?"`
Expected: 全部测试 PASS（含新增 5 用例）；`tsc exit: 0`。

- [ ] **Step 2: 手动冒烟（dev）**

启动 `npm run dev:all`，验证：
1. 新建一个 subject、ingest 一两页内容；切到 general（使目标 subject 非 active）。
2. 打开该 subject 的设置弹窗 → Danger zone 显示 `Delete subject`；点一次出现页数警告 + `Click again to confirm`；再点删除成功，弹窗关闭、subjects 列表不再含它。
3. 检查 `data/vault/wiki/<slug>`、`raw/<slug>`、`.llm-wiki/sources/<slug>` 已消失；`git -C data/vault log -1` 有 `[subject:<slug>] Delete subject and all contents` 提交。
4. general 的设置弹窗 Danger zone 显示 `The general subject can't be deleted.`（无删除按钮）。
5. 构造跨主题引用（subject B 的页面写 `[[A:somepage]]`，ingest 后）→ 删 A 第二次确认时表单显示 `referenced by other subjects (...)` 错误，A 未被删。

- [ ] **Step 3: 收尾**

按 `superpowers:finishing-a-development-branch` 决定合并方式（默认：回合 main、清理 worktree）。

---

## Self-Review

**1. Spec coverage（逐节对照 spec）：**
- §4.1 数据清理 16 表顺序 → Task 1 Step 3c `deleteWithContents` 逐表覆盖 ✓
- §4.2 三道守卫（general/inbound/active）→ general+inbound 在 Task 1（repo 抛码）、active 在 Task 3（客户端 `canDelete`）✓
- §4.3 路由（404→守卫码→delete→fs→git→200）→ Task 2 Step 2 ✓；移除 `deleteIfEmpty`/`not-empty` → Task 2 Step 3 ✓
- §4.4 UI（canDelete/两步/页数警告/general 文案/onError）→ Task 3 ✓
- §五 测试（repo purge + 守卫 + listInboundReferences；路由按本仓惯例以 repo 单测覆盖业务逻辑）→ Task 1 测试 + Task 4 全量 ✓
- §六 已知限制（在途 job / 不改写引用）→ 设计接受，无需任务

**2. Placeholder scan：** 无 TBD/TODO；所有代码步给出完整代码与具体命令/期望输出。

**3. Type consistency：** `deleteWithContents(id: string): void`、`listInboundReferences(id: string): { id: string; slug: string }[]` 在 Task 1 定义、Task 2 路由消费，签名一致；`SubjectError.code` 在 Task 1（含 `not-empty` 过渡）→ Task 2（去 `not-empty`）演进，路由映射只用 `not-found`/其余→409，与最终联合类型一致。
