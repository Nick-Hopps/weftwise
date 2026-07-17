# weftwise 写工具内核 + 对话删除/创建（Spec 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Ask AI 对话循环新增 `wiki.create` / `wiki.delete` 两个写工具（同步执行、人在环确认），并把删除/创建抽成 `page-ops` 共享执行内核，供后续 Spec 2/3 复用。

**Architecture:** 写动作经 `ToolContext` 可选能力注入（仅 query runner），工具 handler 调 `services/page-write.ts` 包装层 → `wiki/page-ops.ts` 执行内核 → 完整 Saga（`createChangeset → validateChangeset → applyChangeset`，每写一次一个 git commit、可在 History 回滚）→ `enqueueEmbedIndex`。删除规则纯函数 `validateDeleteTarget` 单一来源，DELETE 路由与对话共用。

**Tech Stack:** TypeScript 5 / Next.js 15 / Vercel AI SDK 4（工具循环）/ zod / better-sqlite3 + Drizzle / vitest。

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-06-30-weftwise-write-tools-design.md`（本计划仅实现其 Spec 1）。
- 所有领域类型集中在 `src/lib/contracts.ts`；`@/*` → `src/*` 路径别名。
- 写操作必须经 Saga（`wiki/wiki-transaction`）；不得绕过 `validateChangeset`。
- 保护页 `index` / `log` 与带 `meta` tag 的页永不可删。
- `page-ops` 执行内核**不 emit、不 enqueue embed**（副作用由调用方自持）——与既有 `executePageMerge`/`executePageSplit` 一致。
- 提交信息用中文、一句话总结。
- 测试用 vitest，沿用各模块 `__tests__/` 目录与 `vi.mock` 风格。
- 本 Spec **不**改 packyapi 工具-loop 避让叙事（留 Spec 2/3）；**不**实现 `wiki.update`/`wiki.merge`/`wiki.split` 工具（留 Spec 2/3）。
- `npm run lint` 不可用（项目惯例）；用 `npx tsc --noEmit` + `npx vitest run` 校验。

---

### Task 1: `deriveUniqueSlug` 纯函数（page-identity）+ split-plan 复用

**Files:**
- Modify: `src/server/wiki/page-identity.ts`
- Modify: `src/server/wiki/split-plan.ts:18-52`
- Test: `src/server/wiki/__tests__/page-identity.test.ts`（新建）

**Interfaces:**
- Produces: `deriveUniqueSlug(title: string, taken: Iterable<string>): string` — `normalizeSlug(title) || 'page'` 为 base，与 `taken` 冲突时追加 `-2`/`-3`…，返回唯一 slug。

- [ ] **Step 1: 写失败测试**

创建 `src/server/wiki/__tests__/page-identity.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { deriveUniqueSlug } from '../page-identity';

describe('deriveUniqueSlug', () => {
  it('无冲突 → base slug', () => {
    expect(deriveUniqueSlug('Eigen Values', new Set())).toBe('eigen-values');
  });
  it('冲突 → 追加 -2 / -3', () => {
    expect(deriveUniqueSlug('Foo', new Set(['foo']))).toBe('foo-2');
    expect(deriveUniqueSlug('Foo', new Set(['foo', 'foo-2']))).toBe('foo-3');
  });
  it('空白标题 → page 兜底', () => {
    expect(deriveUniqueSlug('   ', new Set())).toBe('page');
  });
  it('接受数组形式 taken', () => {
    expect(deriveUniqueSlug('Foo', ['foo'])).toBe('foo-2');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/wiki/__tests__/page-identity.test.ts`
Expected: FAIL（`deriveUniqueSlug` is not exported / not a function）

- [ ] **Step 3: 实现 `deriveUniqueSlug`**

在 `src/server/wiki/page-identity.ts` 末尾（`slugFromTitle` 之后）追加：

```ts
/**
 * 从标题派生在给定 slug 集合内唯一的 slug：`normalizeSlug(title)`（空则 `'page'`）为 base，
 * 与 `taken` 冲突时追加 `-2`/`-3`…。纯函数。create 与 split 共用，杜绝两份派生逻辑漂移。
 */
export function deriveUniqueSlug(title: string, taken: Iterable<string>): string {
  const set = taken instanceof Set ? taken : new Set(taken);
  const base = normalizeSlug(title) || 'page';
  let slug = base;
  let n = 2;
  while (set.has(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/server/wiki/__tests__/page-identity.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: split-plan 改用 `deriveUniqueSlug`**

修改 `src/server/wiki/split-plan.ts`：把第 5 行 import 改为同时引入 `deriveUniqueSlug`，并用它替换内联派生循环。

第 5 行（`normalizeSlug` 重构后在 split-plan 内不再直接使用，整行替换为）：
```ts
import { deriveUniqueSlug } from './page-identity';
```

将 `planSplitPages` 内（第 28-36 行）的内联 base/while 循环：
```ts
  for (const p of pages) {
    const base = normalizeSlug(p.title) || 'page';
    let slug = base;
    let n = 2;
    while (taken.has(slug)) {
      slug = `${base}-${n}`;
      n += 1;
    }
    taken.add(slug);
```
替换为：
```ts
  for (const p of pages) {
    const slug = deriveUniqueSlug(p.title, taken);
    taken.add(slug);
```

- [ ] **Step 6: 运行 split-plan 回归测试**

Run: `npx vitest run src/server/wiki/__tests__/split-plan.test.ts`
Expected: PASS（行为不变）

- [ ] **Step 7: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 8: Commit**

```bash
git add src/server/wiki/page-identity.ts src/server/wiki/split-plan.ts src/server/wiki/__tests__/page-identity.test.ts
git commit -m "feat(wiki): 抽取 deriveUniqueSlug 纯函数，split-plan 改为复用"
```

---

### Task 2: `executePageDelete` / `executePageCreate` 执行内核（page-ops）

**Files:**
- Modify: `src/server/wiki/page-ops.ts`
- Test: `src/server/wiki/__tests__/page-ops-create-delete.test.ts`（新建）

**Interfaces:**
- Consumes: `deriveUniqueSlug`（Task 1）；既有 `createChangeset` / `validateChangeset` / `applyChangeset`（`wiki-transaction`）、`buildWikiPath`（`page-identity`）、`serializeFrontmatter`（`frontmatter`）、`pagesRepo.getBacklinks` / `pagesRepo.getAllPages`。
- Produces:
  - `executePageDelete(jobId: string, subject: Subject, slug: string): Promise<{ deletedSlug: string; brokenBacklinks: number }>`
  - `executePageCreate(jobId: string, subject: Subject, input: { title: string; body: string; summary?: string; tags?: string[] }): Promise<{ createdSlug: string }>`

- [ ] **Step 1: 写失败测试**

创建 `src/server/wiki/__tests__/page-ops-create-delete.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// 捕获 changeset 条目；validate 默认通过；apply 空跑
const txMocks = vi.hoisted(() => ({
  createChangeset: vi.fn((jobId: string, subject: { id: string; slug: string }, entries: unknown[]) => ({
    id: jobId, subjectId: subject.id, subjectSlug: subject.slug, entries,
    preHead: null, postHead: null, status: 'pending',
  })),
  validateChangeset: vi.fn(() => ({ valid: true, errors: [] as string[] })),
  applyChangeset: vi.fn(async () => undefined),
}));
vi.mock('../wiki-transaction', () => txMocks);

const repoMocks = vi.hoisted(() => ({
  getBacklinks: vi.fn(() => [] as Array<{ slug: string }>),
  getAllPages: vi.fn(() => [] as Array<{ slug: string }>),
  getTitleToSlugMap: vi.fn(() => new Map()), // merge/split 用，本测试不触发
}));
vi.mock('../../db/repos/pages-repo', () => repoMocks);

// 中和 import-time 重依赖（page-ops 顶层为 merge/split 引入，create/delete 不调用）
vi.mock('../../llm/provider-registry', () => ({ generateStructuredOutput: vi.fn() }));
vi.mock('../../db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));

import { executePageDelete, executePageCreate } from '../page-ops';

const subject = { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as never;

describe('executePageDelete', () => {
  beforeEach(() => {
    txMocks.applyChangeset.mockClear();
    txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [] });
    repoMocks.getBacklinks.mockReset();
  });
  it('构造 delete 条目并 apply，返回 deletedSlug', async () => {
    repoMocks.getBacklinks.mockReturnValue([]);
    const out = await executePageDelete('j1', subject, 'eigen');
    expect(out.deletedSlug).toBe('eigen');
    expect(txMocks.applyChangeset).toHaveBeenCalledOnce();
    const cs = txMocks.applyChangeset.mock.calls[0][0] as { entries: Array<{ action: string; path: string; content: unknown }> };
    expect(cs.entries).toEqual([{ action: 'delete', path: 'wiki/general/eigen.md', content: null }]);
  });
  it('brokenBacklinks = 入站数（排除自引用）', async () => {
    repoMocks.getBacklinks.mockReturnValue([{ slug: 'a' }, { slug: 'b' }, { slug: 'eigen' }]);
    const out = await executePageDelete('j1', subject, 'eigen');
    expect(out.brokenBacklinks).toBe(2);
  });
  it('validateChangeset 失败 → 抛错，不 apply', async () => {
    txMocks.validateChangeset.mockReturnValueOnce({ valid: false, errors: ['bad'] });
    await expect(executePageDelete('j1', subject, 'eigen')).rejects.toThrow(/invalid/);
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });
});

describe('executePageCreate', () => {
  beforeEach(() => {
    txMocks.applyChangeset.mockClear();
    txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [] });
    repoMocks.getAllPages.mockReset();
  });
  it('title 派生唯一 slug（冲突加后缀）并 create', async () => {
    repoMocks.getAllPages.mockReturnValue([{ slug: 'foo' }]);
    const out = await executePageCreate('j1', subject, { title: 'Foo', body: 'hello world' });
    expect(out.createdSlug).toBe('foo-2');
    const cs = txMocks.applyChangeset.mock.calls[0][0] as { entries: Array<{ action: string; path: string; content: string }> };
    expect(cs.entries[0].action).toBe('create');
    expect(cs.entries[0].path).toBe('wiki/general/foo-2.md');
    expect(cs.entries[0].content).toContain('title: Foo');
    expect(cs.entries[0].content).toContain('hello world');
  });
  it('validateChangeset 失败（如坏链）→ 抛错', async () => {
    repoMocks.getAllPages.mockReturnValue([]);
    txMocks.validateChangeset.mockReturnValueOnce({ valid: false, errors: ['broken link'] });
    await expect(executePageCreate('j1', subject, { title: 'X', body: '[[Ghost]]' })).rejects.toThrow(/invalid/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/wiki/__tests__/page-ops-create-delete.test.ts`
Expected: FAIL（`executePageDelete` / `executePageCreate` 未导出）

- [ ] **Step 3: 实现两个执行内核**

在 `src/server/wiki/page-ops.ts` 修改 import 行 11（`buildWikiPath`）以同时引入 `deriveUniqueSlug`：
```ts
import { buildWikiPath, deriveUniqueSlug } from './page-identity';
```

在文件末尾追加：

```ts
/**
 * 删除一页：构造 delete changeset → validate → apply。
 * 返回删除 slug + 删后变坏链的入站引用数（本 subject，排除自引用）。不 emit / 不 enqueue。
 * 调用方需先校验目标合法（保护页/存在性，见 services/page-write.ts::validateDeleteTarget）。
 */
export async function executePageDelete(
  jobId: string,
  subject: Subject,
  slug: string,
): Promise<{ deletedSlug: string; brokenBacklinks: number }> {
  const brokenBacklinks = pagesRepo
    .getBacklinks(subject.id, slug)
    .filter((b) => b.slug !== slug).length;

  const entries: ChangesetEntry[] = [
    { action: 'delete', path: buildWikiPath(subject.slug, slug), content: null },
  ];
  const changeset = createChangeset(jobId, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) throw new Error(`delete changeset invalid: ${validation.errors.join('; ')}`);
  await applyChangeset(changeset);

  return { deletedSlug: slug, brokenBacklinks };
}

/**
 * 新建一页：title 派生唯一 slug（`deriveUniqueSlug`，排除本 subject 已有 slug）→ 确定性拼
 * frontmatter（系统拥有 created/updated/sources）→ create changeset → validate（拦坏链）→ apply。
 * 不 emit / 不 enqueue。
 */
export async function executePageCreate(
  jobId: string,
  subject: Subject,
  input: { title: string; body: string; summary?: string; tags?: string[] },
): Promise<{ createdSlug: string }> {
  const existing = new Set(pagesRepo.getAllPages(subject.id).map((p) => p.slug));
  const slug = deriveUniqueSlug(input.title, existing);

  const now = new Date().toISOString();
  const frontmatter: WikiFrontmatter = {
    title: input.title,
    created: now,
    updated: now,
    tags: input.tags ?? [],
    sources: [],
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
  };
  const content = serializeFrontmatter(frontmatter, input.body);

  const entries: ChangesetEntry[] = [
    { action: 'create', path: buildWikiPath(subject.slug, slug), content },
  ];
  const changeset = createChangeset(jobId, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) throw new Error(`create changeset invalid: ${validation.errors.join('; ')}`);
  await applyChangeset(changeset);

  return { createdSlug: slug };
}
```

> `serializeFrontmatter` / `createChangeset` / `validateChangeset` / `applyChangeset` / `ChangesetEntry` / `Subject` / `WikiFrontmatter` / `pagesRepo` 在 `page-ops.ts` 顶部均已 import（merge/split 复用），无需新增除 `deriveUniqueSlug` 外的 import。

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/server/wiki/__tests__/page-ops-create-delete.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/server/wiki/page-ops.ts src/server/wiki/__tests__/page-ops-create-delete.test.ts
git commit -m "feat(wiki): page-ops 新增 executePageDelete/executePageCreate 执行内核"
```

---

### Task 3: `page-write.ts` 校验纯函数 + 对话路径包装

**Files:**
- Create: `src/server/services/page-write.ts`
- Test: `src/server/services/__tests__/page-write.test.ts`（新建）

**Interfaces:**
- Consumes: `executePageDelete` / `executePageCreate`（Task 2）；`pagesRepo.getPageBySlug`；`enqueueEmbedIndex`（`embedding-service`）。
- Produces:
  - `PROTECTED_SYSTEM_PAGES: Set<string>`（`{'index','log'}`）
  - `validateDeleteTarget(slug: string, page: { tags: string[] } | null): string | null`
  - `deletePageInSubject(subject: Subject, slug: string): Promise<{ deletedSlug: string; brokenBacklinks: number }>`
  - `createPageInSubject(subject: Subject, input: { title: string; body: string; summary?: string; tags?: string[] }): Promise<{ createdSlug: string }>`

- [ ] **Step 1: 写失败测试**

创建 `src/server/services/__tests__/page-write.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const repoMocks = vi.hoisted(() => ({ getPageBySlug: vi.fn() }));
vi.mock('@/server/db/repos/pages-repo', () => repoMocks);

const opsMocks = vi.hoisted(() => ({
  executePageDelete: vi.fn(async () => ({ deletedSlug: 'eigen', brokenBacklinks: 2 })),
  executePageCreate: vi.fn(async () => ({ createdSlug: 'foo' })),
}));
vi.mock('@/server/wiki/page-ops', () => opsMocks);

const embedMocks = vi.hoisted(() => ({ enqueueEmbedIndex: vi.fn() }));
vi.mock('../embedding-service', () => embedMocks);

import { validateDeleteTarget, deletePageInSubject, createPageInSubject } from '../page-write';

const subject = { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as never;

describe('validateDeleteTarget', () => {
  it('保护页 index/log → 错误', () => {
    expect(validateDeleteTarget('index', { tags: [] })).toMatch(/protected/);
    expect(validateDeleteTarget('log', { tags: [] })).toMatch(/protected/);
  });
  it('页不存在 → 错误', () => {
    expect(validateDeleteTarget('ghost', null)).toMatch(/not found/);
  });
  it('meta 标签页 → 错误', () => {
    expect(validateDeleteTarget('m', { tags: ['meta'] })).toMatch(/meta/);
  });
  it('正常页 → null', () => {
    expect(validateDeleteTarget('eigen', { tags: ['math'] })).toBeNull();
  });
});

describe('deletePageInSubject', () => {
  beforeEach(() => {
    repoMocks.getPageBySlug.mockReset();
    opsMocks.executePageDelete.mockClear();
    embedMocks.enqueueEmbedIndex.mockClear();
  });
  it('正常页 → 执行删除 + enqueue embed', async () => {
    repoMocks.getPageBySlug.mockReturnValue({ slug: 'eigen', tags: ['math'] });
    const out = await deletePageInSubject(subject, 'eigen');
    expect(opsMocks.executePageDelete).toHaveBeenCalledOnce();
    expect(embedMocks.enqueueEmbedIndex).toHaveBeenCalledWith('s1');
    expect(out).toEqual({ deletedSlug: 'eigen', brokenBacklinks: 2 });
  });
  it('保护页 → 抛错，不执行', async () => {
    repoMocks.getPageBySlug.mockReturnValue({ slug: 'index', tags: ['meta'] });
    await expect(deletePageInSubject(subject, 'index')).rejects.toThrow(/protected/);
    expect(opsMocks.executePageDelete).not.toHaveBeenCalled();
  });
  it('缺页 → 抛错', async () => {
    repoMocks.getPageBySlug.mockReturnValue(null);
    await expect(deletePageInSubject(subject, 'ghost')).rejects.toThrow(/not found/);
  });
});

describe('createPageInSubject', () => {
  beforeEach(() => {
    opsMocks.executePageCreate.mockClear();
    embedMocks.enqueueEmbedIndex.mockClear();
  });
  it('正常 → 执行创建 + enqueue embed', async () => {
    const out = await createPageInSubject(subject, { title: 'Foo', body: 'x' });
    expect(opsMocks.executePageCreate).toHaveBeenCalledOnce();
    expect(embedMocks.enqueueEmbedIndex).toHaveBeenCalledWith('s1');
    expect(out).toEqual({ createdSlug: 'foo' });
  });
  it('空标题 → 抛错，不执行', async () => {
    await expect(createPageInSubject(subject, { title: '  ', body: 'x' })).rejects.toThrow(/title/);
    expect(opsMocks.executePageCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/services/__tests__/page-write.test.ts`
Expected: FAIL（`../page-write` 不存在）

- [ ] **Step 3: 实现 `page-write.ts`**

创建 `src/server/services/page-write.ts`：

```ts
/**
 * 页面写操作的对话路径包装（供 query 工具循环调用）。
 * 删除规则纯函数化（validateDeleteTarget，路由与对话单一来源），执行复用
 * wiki/page-ops 内核，写后触发向量回填。语义沿用 DELETE /api/pages 路由 + executePageCreate。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import { executePageDelete, executePageCreate } from '../wiki/page-ops';
import { enqueueEmbedIndex } from './embedding-service';
import type { Subject } from '@/lib/contracts';

/** 受保护、永不可删的系统页（任何 subject）。删除规则唯一来源，路由与对话共用。 */
export const PROTECTED_SYSTEM_PAGES = new Set(['index', 'log']);

/** 纯校验：可删返回 null，否则返回面向用户的错误消息。page=null 表示该 subject 下未找到。 */
export function validateDeleteTarget(
  slug: string,
  page: { tags: string[] } | null,
): string | null {
  if (PROTECTED_SYSTEM_PAGES.has(slug)) return `Cannot delete protected system page "${slug}".`;
  if (!page) return `Page "${slug}" not found in this subject.`;
  if (page.tags.includes('meta')) return `Cannot delete meta page "${slug}".`;
  return null;
}

/** 校验目标页后同步删除（Saga）+ 触发向量 prune；校验失败抛 Error（消息可直接转述）。 */
export async function deletePageInSubject(
  subject: Subject,
  slug: string,
): Promise<{ deletedSlug: string; brokenBacklinks: number }> {
  const page = pagesRepo.getPageBySlug(subject.id, slug);
  const err = validateDeleteTarget(slug, page);
  if (err) throw new Error(err);
  const result = await executePageDelete(crypto.randomUUID(), subject, slug);
  enqueueEmbedIndex(subject.id);
  return result;
}

/** 同步新建一页（Saga）+ 触发向量回填；title 派生唯一 slug（永不冲突）。 */
export async function createPageInSubject(
  subject: Subject,
  input: { title: string; body: string; summary?: string; tags?: string[] },
): Promise<{ createdSlug: string }> {
  const title = input.title?.trim();
  if (!title) throw new Error('A page title is required.');
  const result = await executePageCreate(crypto.randomUUID(), subject, {
    ...input,
    title,
    body: input.body ?? '',
  });
  enqueueEmbedIndex(subject.id);
  return result;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/server/services/__tests__/page-write.test.ts`
Expected: PASS（10 用例）

- [ ] **Step 5: 类型检查 + Commit**

Run: `npx tsc --noEmit`
Expected: 无错误

```bash
git add src/server/services/page-write.ts src/server/services/__tests__/page-write.test.ts
git commit -m "feat(services): 新增 page-write（validateDeleteTarget + delete/createPageInSubject）"
```

---

### Task 4: `wiki.create` / `wiki.delete` 工具 + ToolContext 写能力 + 注册

**Files:**
- Modify: `src/server/agents/types.ts:33`
- Modify: `src/server/agents/tools/tool-context.ts`
- Create: `src/server/agents/tools/builtin/wiki-delete.ts`
- Create: `src/server/agents/tools/builtin/wiki-create.ts`
- Modify: `src/server/agents/tools/builtin/index.ts`
- Test: `src/server/agents/tools/builtin/__tests__/wiki-delete.test.ts`（新建）
- Test: `src/server/agents/tools/builtin/__tests__/wiki-create.test.ts`（新建）

**Interfaces:**
- Consumes: `ToolDef`（types）、`ToolContext`（tool-context）。
- Produces:
  - `ToolSideEffect` 增加 `'destructive' | 'create'`。
  - `ToolContext.deletePage?(slug): Promise<{ deletedSlug: string; brokenBacklinks: number }>`、`ToolContext.createPage?(input: { title; body; summary?; tags? }): Promise<{ createdSlug: string }>`。
  - `wikiDeleteTool`（`wiki.delete`）、`wikiCreateTool`（`wiki.create`），并在 `createBuiltinToolRegistry()` 注册。

- [ ] **Step 1: 写失败测试（两个工具 handler）**

创建 `src/server/agents/tools/builtin/__tests__/wiki-delete.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { wikiDeleteTool } from '../wiki-delete';
import type { ToolContext } from '../../tool-context';

const baseCtx = { subject: { id: 's', slug: 'general' } } as ToolContext;

describe('wiki.delete tool', () => {
  it('能力存在 → 删除并返回 ok + deletedSlug + 坏链提示', async () => {
    const deletePage = vi.fn().mockResolvedValue({ deletedSlug: 'eigen', brokenBacklinks: 3 });
    const out = await wikiDeleteTool.handler({ slug: 'eigen' }, { ...baseCtx, deletePage });
    expect(deletePage).toHaveBeenCalledWith('eigen');
    expect(out).toEqual(expect.objectContaining({ ok: true, deletedSlug: 'eigen', brokenBacklinks: 3 }));
    expect(out.message).toContain('eigen');
    expect(out.message).toMatch(/broken links/);
    expect(out.message).toMatch(/revert/i);
  });
  it('无坏链 → 消息不含坏链句', async () => {
    const deletePage = vi.fn().mockResolvedValue({ deletedSlug: 'eigen', brokenBacklinks: 0 });
    const out = await wikiDeleteTool.handler({ slug: 'eigen' }, { ...baseCtx, deletePage });
    expect(out.message).not.toMatch(/broken links/);
  });
  it('能力缺失 → ok:false，不抛', async () => {
    const out = await wikiDeleteTool.handler({ slug: 'x' }, baseCtx);
    expect(out.ok).toBe(false);
    expect(out.deletedSlug).toBeNull();
  });
  it('执行抛错 → 捕获为 ok:false + message', async () => {
    const deletePage = vi.fn().mockRejectedValue(new Error('Cannot delete protected system page "index".'));
    const out = await wikiDeleteTool.handler({ slug: 'index' }, { ...baseCtx, deletePage });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/protected/);
  });
});
```

创建 `src/server/agents/tools/builtin/__tests__/wiki-create.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { wikiCreateTool } from '../wiki-create';
import type { ToolContext } from '../../tool-context';

const baseCtx = { subject: { id: 's', slug: 'general' } } as ToolContext;

describe('wiki.create tool', () => {
  it('能力存在 → 创建并返回 ok + createdSlug', async () => {
    const createPage = vi.fn().mockResolvedValue({ createdSlug: 'foo-2' });
    const out = await wikiCreateTool.handler({ title: 'Foo', body: 'hi' }, { ...baseCtx, createPage });
    expect(createPage).toHaveBeenCalledWith({ title: 'Foo', body: 'hi' });
    expect(out).toEqual(expect.objectContaining({ ok: true, createdSlug: 'foo-2' }));
    expect(out.message).toContain('foo-2');
  });
  it('能力缺失 → ok:false，不抛', async () => {
    const out = await wikiCreateTool.handler({ title: 'X', body: 'y' }, baseCtx);
    expect(out.ok).toBe(false);
    expect(out.createdSlug).toBeNull();
  });
  it('执行抛错 → 捕获为 ok:false + message', async () => {
    const createPage = vi.fn().mockRejectedValue(new Error('create changeset invalid: broken link'));
    const out = await wikiCreateTool.handler({ title: 'X', body: '[[Ghost]]' }, { ...baseCtx, createPage });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/invalid/);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-delete.test.ts src/server/agents/tools/builtin/__tests__/wiki-create.test.ts`
Expected: FAIL（工具文件不存在）

- [ ] **Step 3: 扩展 `ToolSideEffect` 联合**

修改 `src/server/agents/types.ts` 第 33 行：

```ts
export type ToolSideEffect = 'none' | 'commit' | 'enqueue' | 'destructive' | 'create';
```

- [ ] **Step 4: ToolContext 增写能力**

修改 `src/server/agents/tools/tool-context.ts`，在 `reenrich?` 字段之后（`agent?` 之前）插入：

```ts
  /** query 侧同步删除一页（Saga）；ingest 不传 → 工具在 ingest 中调用会优雅报错。 */
  deletePage?(slug: string): Promise<{ deletedSlug: string; brokenBacklinks: number }>;
  /** query 侧同步新建一页（Saga）；ingest 不传。 */
  createPage?(input: { title: string; body: string; summary?: string; tags?: string[] }):
    Promise<{ createdSlug: string }>;
```

- [ ] **Step 5: 实现 `wiki-delete.ts`**

创建 `src/server/agents/tools/builtin/wiki-delete.ts`：

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ slug: z.string().trim().min(1) });
const OutputSchema = z.object({
  ok: z.boolean(),
  deletedSlug: z.string().nullable(),
  brokenBacklinks: z.number().nullable(),
  message: z.string(),
});

export const wikiDeleteTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.delete',
  source: 'builtin',
  description:
    'Permanently delete ONE wiki page by slug in the current subject. This CHANGES the wiki and removes the page. ' +
    'Only call after the user has explicitly confirmed which page to delete in a PRIOR turn. ' +
    'Other pages that link to it are left with broken links (count reported back). ' +
    'The deletion is recorded in History and can be reverted.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'destructive',
  async handler({ slug }, ctx) {
    if (!ctx.deletePage) {
      return { ok: false, deletedSlug: null, brokenBacklinks: null, message: 'Deleting a page is not available in this context.' };
    }
    try {
      const { deletedSlug, brokenBacklinks } = await ctx.deletePage(slug);
      const brokenNote =
        brokenBacklinks > 0
          ? ` ${brokenBacklinks} other page(s) linked to it and now have broken links — run a Health check to fix them.`
          : '';
      return {
        ok: true,
        deletedSlug,
        brokenBacklinks,
        message: `Deleted "${deletedSlug}".${brokenNote} This deletion is recorded in History and can be reverted.`,
      };
    } catch (err) {
      return { ok: false, deletedSlug: null, brokenBacklinks: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 6: 实现 `wiki-create.ts`**

创建 `src/server/agents/tools/builtin/wiki-create.ts`：

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  title: z.string().trim().min(1),
  body: z
    .string()
    .describe('Markdown content of the page WITHOUT a frontmatter block — the system writes frontmatter (title/timestamps/tags) deterministically.'),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  createdSlug: z.string().nullable(),
  message: z.string(),
});

export const wikiCreateTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.create',
  source: 'builtin',
  description:
    'Create a NEW wiki page in the current subject from a title and markdown body. This CHANGES the wiki. ' +
    'The slug is derived from the title automatically (a numeric suffix is added on conflict). ' +
    'Use [[Page Title]] wikilinks only to pages that already exist; broken links are rejected. ' +
    'Only call after the user has explicitly confirmed they want the page created.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'create',
  async handler(input, ctx) {
    if (!ctx.createPage) {
      return { ok: false, createdSlug: null, message: 'Creating a page is not available in this context.' };
    }
    try {
      const { createdSlug } = await ctx.createPage(input);
      return { ok: true, createdSlug, message: `Created "${input.title}" (slug: ${createdSlug}).` };
    } catch (err) {
      return { ok: false, createdSlug: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 7: 注册两工具**

修改 `src/server/agents/tools/builtin/index.ts`：加 import 与 register。

import 段（`wikiReenrichTool` 之后）：
```ts
import { wikiDeleteTool } from './wiki-delete';
import { wikiCreateTool } from './wiki-create';
```

`createBuiltinToolRegistry()` 内（`r.register(wikiReenrichTool as ToolDef);` 之后）：
```ts
  r.register(wikiDeleteTool as ToolDef);
  r.register(wikiCreateTool as ToolDef);
```

- [ ] **Step 8: 运行测试确认通过 + 类型检查**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-delete.test.ts src/server/agents/tools/builtin/__tests__/wiki-create.test.ts`
Expected: PASS（7 用例）

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 9: Commit**

```bash
git add src/server/agents/types.ts src/server/agents/tools/tool-context.ts src/server/agents/tools/builtin/wiki-delete.ts src/server/agents/tools/builtin/wiki-create.ts src/server/agents/tools/builtin/index.ts src/server/agents/tools/builtin/__tests__/wiki-delete.test.ts src/server/agents/tools/builtin/__tests__/wiki-create.test.ts
git commit -m "feat(agents): 新增 wiki.create/wiki.delete 写工具 + ToolContext 写能力"
```

---

### Task 5: 接入 Ask AI 工具循环（query-service + query-tools）

**Files:**
- Modify: `src/server/services/query-service.ts:49`
- Modify: `src/server/services/query-tools.ts`
- Test: `src/server/services/__tests__/query-tools.test.ts`（追加）

**Interfaces:**
- Consumes: `deletePageInSubject` / `createPageInSubject`（Task 3）；`wiki.create` / `wiki.delete`（Task 4，已注册）；`ToolContext.deletePage?` / `createPage?`（Task 4）。
- Produces: `buildQueryToolContext(subject, accessed)` 返回的 `ToolContext` 含 `deletePage` / `createPage` 实现；`queryToolDefs` 解析出 `wiki.create` / `wiki.delete`。

- [ ] **Step 1: 追加 buildQueryToolContext 写能力测试**

修改 `src/server/services/__tests__/query-tools.test.ts`：在文件顶部既有 `vi.mock('@/server/jobs/queue', ...)` 之后追加 page-write mock：

```ts
const mockDeletePage = vi.fn();
const mockCreatePage = vi.fn();
vi.mock('../page-write', () => ({
  deletePageInSubject: (...a: unknown[]) => mockDeletePage(...a),
  createPageInSubject: (...a: unknown[]) => mockCreatePage(...a),
}));
```

在文件末尾追加 describe 块：

```ts
describe('buildQueryToolContext - delete/create', () => {
  beforeEach(() => {
    mockDeletePage.mockReset();
    mockCreatePage.mockReset();
  });
  it('deletePage 委托 deletePageInSubject(subject, slug)', async () => {
    mockDeletePage.mockResolvedValue({ deletedSlug: 'eigen', brokenBacklinks: 1 });
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    const out = await ctx.deletePage!('eigen');
    expect(mockDeletePage).toHaveBeenCalledWith(SUBJECT, 'eigen');
    expect(out).toEqual({ deletedSlug: 'eigen', brokenBacklinks: 1 });
  });
  it('createPage 委托 createPageInSubject(subject, input)', async () => {
    mockCreatePage.mockResolvedValue({ createdSlug: 'foo' });
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    const input = { title: 'Foo', body: 'x' };
    const out = await ctx.createPage!(input);
    expect(mockCreatePage).toHaveBeenCalledWith(SUBJECT, input);
    expect(out).toEqual({ createdSlug: 'foo' });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/services/__tests__/query-tools.test.ts`
Expected: FAIL（`ctx.deletePage` / `ctx.createPage` 为 undefined）

- [ ] **Step 3: query-tools 注入写能力**

修改 `src/server/services/query-tools.ts`：在 import 段（`import { enqueueReenrich } from './reenrich-enqueue';` 之后）追加：

```ts
import { deletePageInSubject, createPageInSubject } from './page-write';
```

在 `buildQueryToolContext` 返回对象内、`reenrich` 方法之后追加：

```ts
    async deletePage(slug) {
      return deletePageInSubject(subject, slug);
    },
    async createPage(input) {
      return createPageInSubject(subject, input);
    },
```

- [ ] **Step 4: query-service 解析新工具**

修改 `src/server/services/query-service.ts` 第 49 行：

```ts
const queryToolDefs = createBuiltinToolRegistry().resolve(['wiki.read', 'wiki.search', 'wiki.list', 'wiki.reenrich', 'wiki.create', 'wiki.delete']);
```

- [ ] **Step 5: 运行测试确认通过 + 类型检查**

Run: `npx vitest run src/server/services/__tests__/query-tools.test.ts`
Expected: PASS（既有用例 + 2 新用例）

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/server/services/query-service.ts src/server/services/query-tools.ts src/server/services/__tests__/query-tools.test.ts
git commit -m "feat(query): Ask AI 工具循环接入 wiki.create/wiki.delete 写能力"
```

---

### Task 6: 系统提示写动作纪律（query-prompt）

**Files:**
- Modify: `src/server/llm/prompts/query-prompt.ts:128-157`
- Test: `src/server/llm/prompts/__tests__/query-prompt.test.ts`（追加）

**Interfaces:**
- Produces: `QUERY_AGENTIC_SYSTEM_PROMPT` 工具清单含 `wiki_create` / `wiki_delete`，并含 "Creating a page" / "Deleting a page" 纪律段。

- [ ] **Step 1: 追加提示断言测试**

修改 `src/server/llm/prompts/__tests__/query-prompt.test.ts`：把现有第 2 行 import 改为同时引入常量——
```ts
import { buildQueryUserPrompt, QUERY_AGENTIC_SYSTEM_PROMPT } from '../query-prompt';
```
并在文件末尾追加：

```ts
describe('QUERY_AGENTIC_SYSTEM_PROMPT - 写工具纪律', () => {
  it('工具清单含 wiki_create / wiki_delete', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_create');
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_delete');
  });
  it('删除段要求后续轮确认、禁止同轮删除', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/Deleting a page/i);
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/confirm/i);
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/LATER turn|later turn/);
  });
  it('创建段存在', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/Creating a page/i);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/llm/prompts/__tests__/query-prompt.test.ts`
Expected: FAIL（提示尚未含 wiki_create/wiki_delete）

- [ ] **Step 3: 更新工具清单**

修改 `src/server/llm/prompts/query-prompt.ts`，在 `QUERY_AGENTIC_SYSTEM_PROMPT` 的 `## Tools` 段、`wiki_reenrich` 行之后追加两行：

```
- \`wiki_create\`: create a NEW page from a title + markdown body (slug auto-derived). This CHANGES the wiki — only under the rules in "Creating a page" below.
- \`wiki_delete\`: permanently delete ONE page by slug. This CHANGES the wiki — only under the rules in "Deleting a page" below.
```

- [ ] **Step 4: 追加 Creating / Deleting 纪律段**

在 `QUERY_AGENTIC_SYSTEM_PROMPT` 末尾（"Re-enriching a page" 段之后、模板反引号结束之前）追加：

```
## Creating a page
Use \`wiki_create\` ONLY when the user explicitly asks to create/add a new page. Never on your own initiative.
1. Confirm with the user what page you will create — restate the intended title and a one-line summary of the body — and only call it AFTER they agree.
2. The slug is derived from the title automatically; if the title collides, a numeric suffix is added. Report the final slug back.
3. The body is markdown WITHOUT a frontmatter block. Only use [[wikilinks]] to pages that already exist (use \`wiki_list\`/\`wiki_search\` to check) — broken links are rejected and the create fails.

## Deleting a page
Use \`wiki_delete\` ONLY when the user explicitly asks to delete/remove a page. Never on your own initiative. Deletion is a destructive action.
1. Identify the target page. If the user refers to "this page"/"here" and a current page is given, use that slug. If they name a page, resolve its exact slug via \`wiki_list\`/\`wiki_search\`.
2. If the target is ambiguous — no current page, or several could match — ASK which page; do not guess.
3. ALWAYS confirm before deleting: restate which page you will delete (title + slug) and ask the user to confirm. Do NOT call \`wiki_delete\` in the same turn you ask — only call it in a LATER turn, after the user clearly agrees (e.g. "yes", "go ahead").
4. After deleting, tell the user it is done, report how many other pages now have broken links (if any), and note the deletion is recorded in History and can be reverted.
```

- [ ] **Step 5: 运行测试确认通过 + 类型检查**

Run: `npx vitest run src/server/llm/prompts/__tests__/query-prompt.test.ts`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 6: Commit**

```bash
git add src/server/llm/prompts/query-prompt.ts src/server/llm/prompts/__tests__/query-prompt.test.ts
git commit -m "feat(prompt): Ask AI 系统提示加 wiki_create/wiki_delete 写动作确认纪律"
```

---

### Task 7: UI 工具活动映射（tool-activity）

**Files:**
- Modify: `src/lib/tool-activity.ts`
- Test: `src/lib/__tests__/tool-activity.test.ts`（新建）

**Interfaces:**
- Produces: `toolActivityIcon` / `toolActivityVerb` / `summarizeToolArgs` 支持 `wiki_create`（➕/Creating/title）与 `wiki_delete`（🗑/Deleting/slug）。

- [ ] **Step 1: 写失败测试**

创建 `src/lib/__tests__/tool-activity.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { toolActivityIcon, toolActivityVerb, summarizeToolArgs } from '../tool-activity';

describe('tool-activity - wiki_create/wiki_delete', () => {
  it('图标', () => {
    expect(toolActivityIcon('wiki_create')).toBe('➕');
    expect(toolActivityIcon('wiki_delete')).toBe('🗑');
  });
  it('动词', () => {
    expect(toolActivityVerb('wiki_create')).toBe('Creating');
    expect(toolActivityVerb('wiki_delete')).toBe('Deleting');
  });
  it('参数摘要：create 取 title，delete 取 slug', () => {
    expect(summarizeToolArgs('wiki_create', { title: 'Foo' })).toBe('Foo');
    expect(summarizeToolArgs('wiki_delete', { slug: 'eigen' })).toBe('eigen');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/__tests__/tool-activity.test.ts`
Expected: FAIL（返回默认 `•` / 工具名 / 空串）

- [ ] **Step 3: 实现映射**

修改 `src/lib/tool-activity.ts`：

`toolActivityIcon` 的 switch 内 `wiki_reenrich` 之后加：
```ts
    case 'wiki_create': return '➕';
    case 'wiki_delete': return '🗑';
```

`toolActivityVerb` 的 switch 内 `wiki_reenrich` 之后加：
```ts
    case 'wiki_create': return 'Creating';
    case 'wiki_delete': return 'Deleting';
```

`summarizeToolArgs` 内、`wiki_read || wiki_reenrich` 那行之后加：
```ts
  if (tool === 'wiki_delete') return typeof a.slug === 'string' ? a.slug : '';
  if (tool === 'wiki_create') return typeof a.title === 'string' ? a.title : '';
```

- [ ] **Step 4: 运行测试确认通过 + 类型检查**

Run: `npx vitest run src/lib/__tests__/tool-activity.test.ts`
Expected: PASS（3 用例）

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/lib/tool-activity.ts src/lib/__tests__/tool-activity.test.ts
git commit -m "feat(ui): 聊天工具活动支持 wiki_create/wiki_delete 图标与摘要"
```

---

### Task 8: DELETE 路由 DRY（复用 validateDeleteTarget + executePageDelete）

**Files:**
- Modify: `src/app/api/pages/[...slug]/route.ts`

**Interfaces:**
- Consumes: `validateDeleteTarget` / `PROTECTED_SYSTEM_PAGES`（page-write，Task 3）、`executePageDelete`（page-ops，Task 2）。
- Produces: `DELETE /api/pages/<...slug>` 响应附 `brokenBacklinks` 字段；删除规则改由 `validateDeleteTarget` 单一源裁定。

- [ ] **Step 1: 改 import**

修改 `src/app/api/pages/[...slug]/route.ts` 顶部 import：删除第 26 行的本地 `const PROTECTED_SYSTEM_PAGES = new Set(['index', 'log']);`，并追加：

```ts
import { validateDeleteTarget } from '@/server/services/page-write';
import { executePageDelete } from '@/server/wiki/page-ops';
```

> `createChangeset` / `validateChangeset` / `applyChangeset` 的 import 保留——`PUT` 仍使用它们。

- [ ] **Step 2: 重写 DELETE handler 主体**

把 `DELETE` 函数（第 165-205 行）中 `const slug = slugParts.join('/');` 之后的全部主体替换为：

```ts
  const existing = pagesRepo.getPageBySlug(subject.id, slug);
  const validationError = validateDeleteTarget(slug, existing);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: existing ? 400 : 404 });
  }

  const { brokenBacklinks } = await executePageDelete(crypto.randomUUID(), subject, slug);
  // 删除后触发向量回填（prune 孤儿；未配置 embedding 时 no-op）
  enqueueEmbedIndex(subject.id);
  return NextResponse.json({ ok: true, slug, subjectId: subject.id, brokenBacklinks });
```

> `buildWikiPath` 仍被 `PUT`（route 第 121/141 行）使用，保留 import。`enqueueEmbedIndex` import 已存在。

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 4: 回归全量测试**

Run: `npx vitest run`
Expected: PASS（全绿，无回归）

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/pages/[...slug]/route.ts"
git commit -m "refactor(api): DELETE /api/pages 复用 validateDeleteTarget+executePageDelete，附 brokenBacklinks"
```

---

### Task 9: 文档更新（CLAUDE.md）

**Files:**
- Modify: `src/lib/CLAUDE.md`
- Modify: `src/server/agents/CLAUDE.md`
- Modify: `src/server/services/CLAUDE.md`
- Modify: `src/server/wiki/CLAUDE.md`
- Modify: `src/app/CLAUDE.md`
- Modify: `CLAUDE.md`（根 changelog）

**Interfaces:** 无代码接口；仅文档同步。

- [ ] **Step 1: 各模块文档补条目**

- `src/server/wiki/CLAUDE.md`：`page-ops.ts` 行补 `executePageDelete` / `executePageCreate`；`page-identity.ts` 加 `deriveUniqueSlug`（create/split 共用）；测试小节加 `page-identity`(deriveUniqueSlug) 与 `page-ops-create-delete`；changelog 加一行。
- `src/server/services/CLAUDE.md`：相关文件清单加 `page-write.ts`（`validateDeleteTarget` + `delete/createPageInSubject`）；changelog 加一行。
- `src/server/agents/CLAUDE.md`：`tools/builtin/` 清单加 `wiki-delete.ts` / `wiki-create.ts`；`tool-context.ts` 描述补 `deletePage?` / `createPage?` 写能力；`ToolSideEffect` 提及 `destructive`/`create`；changelog 加一行。
- `src/lib/CLAUDE.md`：`tool-activity.ts` 行补 `wiki_create`(➕)/`wiki_delete`(🗑) 映射；changelog 加一行。
- `src/app/CLAUDE.md`：`/api/pages/[...slug]` DELETE 行补「复用 `validateDeleteTarget`+`executePageDelete`，响应附 `brokenBacklinks`」；changelog 加一行。

- [ ] **Step 2: 根 CLAUDE.md changelog 加行**

在 `CLAUDE.md` 第九节变更记录表末尾追加：

```
| 2026-06-30 | 对话创建/删除页面（weftwise Tools Spec 1）| 新增共享语义级写工具内核：`page-ops` 补 `executePageCreate`/`executePageDelete`（不 emit/enqueue）+ `deriveUniqueSlug`（create/split 共用）；`services/page-write.ts`（`validateDeleteTarget` 删除规则单一源 + `delete/createPageInSubject` 同步 Saga+embed 回填）；builtin 工具 `wiki.create`/`wiki.delete`（`ToolDef.sideEffect` 加 `create`/`destructive`）+ `ToolContext.createPage?/deletePage?`（仅 query 注入）；Ask AI 工具循环 resolve 二工具 + 系统提示加写动作确认纪律（删除须后续轮确认、禁同轮）；`tool-activity` 加 ➕/🗑 映射；DELETE 路由 DRY 复用 + 附 brokenBacklinks。每写一次一个 git commit 可回滚。Spec 2(curate→tool-loop)/Spec 3(fix→tool-loop) 待续。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-30-weftwise-write-tools* |
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/CLAUDE.md src/server/agents/CLAUDE.md src/server/services/CLAUDE.md src/server/wiki/CLAUDE.md src/app/CLAUDE.md CLAUDE.md
git commit -m "docs: 同步 weftwise Tools Spec 1（对话创建/删除）模块文档与 changelog"
```

---

## 收尾验证

- [ ] **全量测试 + 类型检查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿、无类型错误。

- [ ] **手动冒烟（可选，需 dev:all + 配置 LLM）**

在 Ask AI 对话中：①「删除 X 页」→ 模型应复述并请确认 → 「确认」→ 后续轮调用 `wiki_delete` → 回复含坏链提示与可回滚；②「创建一个关于 Y 的页」→ 复述确认 → `wiki_create` → 回复最终 slug。到 History 页确认两次操作各为一条可回滚记录。

> 注意：手动冒烟会写入真实 vault（用户 `dev:all` 的 worker 共享 DB）。验证后如需清理：到 History 页回滚，或 `git revert` 对应 commit。
