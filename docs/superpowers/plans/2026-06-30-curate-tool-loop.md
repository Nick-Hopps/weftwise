# Curate Tool-Loop 改造（Spec 2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `curate` 任务从 triage→confirm→execute 结构化流水线改造为自驱 tool-loop agent（模型读页后调 `wiki.merge`/`wiki.split`/`wiki.delete`/`wiki.create`），auto 路径安全靠工具层硬护栏。

**Architecture:** worker 调 `generateTextWithTools('curate', …)` 驱动单 agent 工具循环；写工具能力经 worker 侧 `buildCurateToolContext` 注入，每个写能力先过 `createCurateGuard`（caps 计数器 + seed 强制 + auto 禁 create + 保护页），再调既有 page-ops 内核并 emit `curate:*` 事件。

**Tech Stack:** TypeScript 5 / Next.js 15 / Vercel AI SDK 4（`generateTextWithTools`）/ zod / better-sqlite3 + Drizzle / vitest。

## Global Constraints

- 设计文档：`docs/superpowers/specs/2026-06-30-curate-tool-loop-design.md`。Spec 1（共享写工具内核 + 对话删除/创建）已并入 main。
- 领域类型集中在 `src/lib/contracts.ts`；路径别名 `@/*` → `src/*`。
- 写操作必须经 page-ops 内核（Saga：createChangeset→validateChangeset→applyChangeset）；每写一次一个 git commit、可在 History 回滚。**不绕过 `validateChangeset`。**
- 保护页 `index`/`log` 永不被结构操作触及。
- **auto 安全靠工具层确定性闸门**（计数器 caps≤5×4 + seed 限制 + auto 禁 create + 保护页），**非系统提示**；提示只叮嘱保守。
- `page-ops` 执行内核（Spec 1 已建）不 emit/不 enqueue；emit + enqueueEmbedIndex 由 curate 调用方负责。
- 提交信息用中文、一句话总结。测试 vitest，沿用各模块 `__tests__/`。
- **每个任务结束 tsc clean + 相关测试绿；退休旧代码与重写服务在同一任务（Task 5）落地，避免中间态 tsc 断裂。**
- `npm run lint` 不可用；用 `npx tsc --noEmit` + `npx vitest run` 校验。
- **commit 时务必用具体文件路径 `git add <paths>`，禁止 `git add -A`/`git add .`**（防 worktree 的 node_modules 符号链接等混入）。

---

### Task 1: `createCurateGuard` 硬护栏纯函数（curate-plan.ts 新增）

**Files:**
- Modify: `src/server/wiki/curate-plan.ts`（新增 `createCurateGuard` + 类型；保留 `expandScopeWithNeighbors`/`applyDecisionCaps`/`restrictToSeed` 不动——后者在 Task 5 退休）
- Test: `src/server/wiki/__tests__/curate-plan.test.ts`（追加 `createCurateGuard` 用例；现有用例不动）

**Interfaces:**
- Produces:
  - `interface CurateCaps { merge: number; split: number; delete: number; create: number }`
  - `interface GuardDecision { ok: boolean; reason?: string }`
  - `interface CurateGuard { canMerge(a,b): GuardDecision; canSplit(slug): GuardDecision; canDelete(slug): GuardDecision; canCreate(): GuardDecision; record(op:'merge'|'split'|'delete'|'create'): void; totals(): { merge; split; delete; create; writes } }`
  - `createCurateGuard(opts: { seedSet: Set<string> | null; caps: CurateCaps }): CurateGuard`

- [ ] **Step 1: 写失败测试**（追加到 `curate-plan.test.ts` 末尾）

```ts
import { createCurateGuard } from '../curate-plan';

describe('createCurateGuard', () => {
  const caps = { merge: 2, split: 2, delete: 2, create: 2 };
  it('manual（seedSet=null）放行，达 cap 后拒', () => {
    const g = createCurateGuard({ seedSet: null, caps });
    expect(g.canMerge('a', 'b').ok).toBe(true);
    g.record('merge'); g.record('merge');
    const d = g.canMerge('a', 'b');
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/limit of 2 merges/);
  });
  it('self-merge 与保护页被拒', () => {
    const g = createCurateGuard({ seedSet: null, caps });
    expect(g.canMerge('a', 'a').ok).toBe(false);
    expect(g.canMerge('index', 'b').ok).toBe(false);
    expect(g.canSplit('log').ok).toBe(false);
    expect(g.canDelete('index').ok).toBe(false);
  });
  it('auto（seedSet 非空）：写必须涉及 seed', () => {
    const g = createCurateGuard({ seedSet: new Set(['x']), caps });
    expect(g.canMerge('x', 'y').ok).toBe(true);   // x 在 seed
    expect(g.canMerge('y', 'z').ok).toBe(false);  // 都不在 seed
    expect(g.canMerge('y', 'z').reason).toMatch(/changed page/);
    expect(g.canSplit('y').ok).toBe(false);
    expect(g.canDelete('x').ok).toBe(true);
  });
  it('auto 禁 create；manual 允许且受 cap', () => {
    expect(createCurateGuard({ seedSet: new Set(['x']), caps }).canCreate().ok).toBe(false);
    const g = createCurateGuard({ seedSet: null, caps });
    expect(g.canCreate().ok).toBe(true);
    g.record('create'); g.record('create');
    expect(g.canCreate().ok).toBe(false);
  });
  it('totals 累加准确', () => {
    const g = createCurateGuard({ seedSet: null, caps });
    g.record('merge'); g.record('split'); g.record('delete');
    expect(g.totals()).toEqual({ merge: 1, split: 1, delete: 1, create: 0, writes: 3 });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/wiki/__tests__/curate-plan.test.ts`
Expected: FAIL（`createCurateGuard` 未导出）

- [ ] **Step 3: 实现 `createCurateGuard`**（追加到 `src/server/wiki/curate-plan.ts` 末尾）

```ts
export interface CurateCaps { merge: number; split: number; delete: number; create: number }
export interface GuardDecision { ok: boolean; reason?: string }
export interface CurateGuard {
  canMerge(aSlug: string, bSlug: string): GuardDecision;
  canSplit(slug: string): GuardDecision;
  canDelete(slug: string): GuardDecision;
  canCreate(): GuardDecision;
  record(op: 'merge' | 'split' | 'delete' | 'create'): void;
  totals(): { merge: number; split: number; delete: number; create: number; writes: number };
}

const GUARD_META = new Set(['index', 'log']);

/**
 * 工具层硬护栏：caps 计数器 + seed 强制（auto） + auto 禁 create + 保护页。
 * seedSet=null = 手动全库（不限 scope，仍受 caps/保护页约束）。纯工厂，便于单测。
 */
export function createCurateGuard(opts: { seedSet: Set<string> | null; caps: CurateCaps }): CurateGuard {
  const { seedSet, caps } = opts;
  const counts = { merge: 0, split: 0, delete: 0, create: 0 };
  const seedOk = (slug: string) => seedSet === null || seedSet.has(slug);
  return {
    canMerge(a, b) {
      if (a === b) return { ok: false, reason: 'cannot merge a page with itself' };
      if (GUARD_META.has(a) || GUARD_META.has(b)) return { ok: false, reason: 'cannot merge a protected page (index/log)' };
      if (counts.merge >= caps.merge) return { ok: false, reason: `reached the limit of ${caps.merge} merges` };
      if (!seedOk(a) && !seedOk(b)) return { ok: false, reason: 'merge must involve a changed page in this run' };
      return { ok: true };
    },
    canSplit(slug) {
      if (GUARD_META.has(slug)) return { ok: false, reason: 'cannot split a protected page (index/log)' };
      if (counts.split >= caps.split) return { ok: false, reason: `reached the limit of ${caps.split} splits` };
      if (!seedOk(slug)) return { ok: false, reason: 'split must involve a changed page in this run' };
      return { ok: true };
    },
    canDelete(slug) {
      if (GUARD_META.has(slug)) return { ok: false, reason: 'cannot delete a protected page (index/log)' };
      if (counts.delete >= caps.delete) return { ok: false, reason: `reached the limit of ${caps.delete} deletes` };
      if (!seedOk(slug)) return { ok: false, reason: 'delete must involve a changed page in this run' };
      return { ok: true };
    },
    canCreate() {
      if (seedSet !== null) return { ok: false, reason: 'creating new pages is only allowed in manual curation' };
      if (counts.create >= caps.create) return { ok: false, reason: `reached the limit of ${caps.create} creates` };
      return { ok: true };
    },
    record(op) { counts[op] += 1; },
    totals() { return { ...counts, writes: counts.merge + counts.split + counts.delete + counts.create }; },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/server/wiki/__tests__/curate-plan.test.ts`
Expected: PASS（新 5 用例 + 现有用例全绿）

- [ ] **Step 5: 类型检查 + Commit**

Run: `npx tsc --noEmit` → 无错误

```bash
git add src/server/wiki/curate-plan.ts src/server/wiki/__tests__/curate-plan.test.ts
git commit -m "feat(wiki): 新增 createCurateGuard 硬护栏（caps+seed+auto禁create+保护页）"
```

---

### Task 2: `wiki.merge` / `wiki.split` 工具 + ToolContext 能力 + 注册

**Files:**
- Modify: `src/server/agents/types.ts`（`ToolSideEffect` += `'merge' | 'split'`）
- Modify: `src/server/agents/tools/tool-context.ts`（`ToolContext` += `mergePages?` / `splitPage?`）
- Create: `src/server/agents/tools/builtin/wiki-merge.ts`
- Create: `src/server/agents/tools/builtin/wiki-split.ts`
- Modify: `src/server/agents/tools/builtin/index.ts`（注册）
- Test: `src/server/agents/tools/builtin/__tests__/wiki-merge.test.ts`、`wiki-split.test.ts`

**Interfaces:**
- Consumes: `ToolDef`（types）、`ToolContext`（tool-context）。
- Produces:
  - `ToolContext.mergePages?(targetSlug, sourceSlug): Promise<{ mergedSlug: string; deletedSlug: string; referencesRepointed: number }>`
  - `ToolContext.splitPage?(slug, hint?): Promise<{ primarySlug: string; pageSlugs: string[]; referencesRepointed: number }>`
  - `wikiMergeTool`（`wiki.merge`）、`wikiSplitTool`（`wiki.split`），注册进 `createBuiltinToolRegistry()`。

- [ ] **Step 1: 写失败测试**

`src/server/agents/tools/builtin/__tests__/wiki-merge.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { wikiMergeTool } from '../wiki-merge';
import type { ToolContext } from '../../tool-context';

const baseCtx = { subject: { id: 's', slug: 'general' } } as ToolContext;

describe('wiki.merge tool', () => {
  it('能力存在 → 合并并返回 ok + 计数', async () => {
    const mergePages = vi.fn().mockResolvedValue({ mergedSlug: 'a', deletedSlug: 'b', referencesRepointed: 2 });
    const out = await wikiMergeTool.handler({ targetSlug: 'a', sourceSlug: 'b' }, { ...baseCtx, mergePages });
    expect(mergePages).toHaveBeenCalledWith('a', 'b');
    expect(out).toEqual(expect.objectContaining({ ok: true, mergedSlug: 'a', deletedSlug: 'b', referencesRepointed: 2 }));
    expect(out.message).toContain('a');
  });
  it('能力缺失 → ok:false 不抛', async () => {
    const out = await wikiMergeTool.handler({ targetSlug: 'a', sourceSlug: 'b' }, baseCtx);
    expect(out.ok).toBe(false);
    expect(out.mergedSlug).toBeNull();
  });
  it('抛错（如 guard 拒）→ ok:false + message', async () => {
    const mergePages = vi.fn().mockRejectedValue(new Error('reached the limit of 5 merges'));
    const out = await wikiMergeTool.handler({ targetSlug: 'a', sourceSlug: 'b' }, { ...baseCtx, mergePages });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/limit of 5 merges/);
  });
});
```

`src/server/agents/tools/builtin/__tests__/wiki-split.test.ts`：
```ts
import { describe, it, expect, vi } from 'vitest';
import { wikiSplitTool } from '../wiki-split';
import type { ToolContext } from '../../tool-context';

const baseCtx = { subject: { id: 's', slug: 'general' } } as ToolContext;

describe('wiki.split tool', () => {
  it('能力存在 → 拆分并返回 ok + primary/pages', async () => {
    const splitPage = vi.fn().mockResolvedValue({ primarySlug: 'a', pageSlugs: ['a', 'a-2'], referencesRepointed: 1 });
    const out = await wikiSplitTool.handler({ slug: 'a', hint: 'by topic' }, { ...baseCtx, splitPage });
    expect(splitPage).toHaveBeenCalledWith('a', 'by topic');
    expect(out).toEqual(expect.objectContaining({ ok: true, primarySlug: 'a', pageSlugs: ['a', 'a-2'] }));
  });
  it('能力缺失 → ok:false 不抛', async () => {
    const out = await wikiSplitTool.handler({ slug: 'a' }, baseCtx);
    expect(out.ok).toBe(false);
    expect(out.primarySlug).toBeNull();
  });
  it('抛错 → ok:false + message', async () => {
    const splitPage = vi.fn().mockRejectedValue(new Error('split must produce at least 2 pages'));
    const out = await wikiSplitTool.handler({ slug: 'a' }, { ...baseCtx, splitPage });
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/at least 2 pages/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-merge.test.ts src/server/agents/tools/builtin/__tests__/wiki-split.test.ts`
Expected: FAIL（工具文件不存在）

- [ ] **Step 3: 扩展 `ToolSideEffect`**（`src/server/agents/types.ts` 第 33 行）

```ts
export type ToolSideEffect = 'none' | 'commit' | 'enqueue' | 'destructive' | 'create' | 'merge' | 'split';
```

- [ ] **Step 4: ToolContext 增能力**（`src/server/agents/tools/tool-context.ts`，在 `createPage?` 之后插入）

```ts
  /** curate 侧合并两页（Saga）；仅 worker curate runner 注入。 */
  mergePages?(targetSlug: string, sourceSlug: string):
    Promise<{ mergedSlug: string; deletedSlug: string; referencesRepointed: number }>;
  /** curate 侧拆分一页（Saga）；仅 worker curate runner 注入。 */
  splitPage?(slug: string, hint?: string):
    Promise<{ primarySlug: string; pageSlugs: string[]; referencesRepointed: number }>;
```

- [ ] **Step 5: 实现 `wiki-merge.ts`**

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ targetSlug: z.string().trim().min(1), sourceSlug: z.string().trim().min(1) });
const OutputSchema = z.object({
  ok: z.boolean(),
  mergedSlug: z.string().nullable(),
  deletedSlug: z.string().nullable(),
  referencesRepointed: z.number().nullable(),
  message: z.string(),
});

export const wikiMergeTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.merge',
  source: 'builtin',
  description:
    'Merge ONE wiki page (sourceSlug) into another (targetSlug) in the current subject: the source content is folded into the target, the source page is deleted, and references to it are repointed to the target. This CHANGES the wiki. Only merge pages that SUBSTANTIALLY duplicate each other.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'merge',
  async handler({ targetSlug, sourceSlug }, ctx) {
    if (!ctx.mergePages) {
      return { ok: false, mergedSlug: null, deletedSlug: null, referencesRepointed: null, message: 'Merging pages is not available in this context.' };
    }
    try {
      const { mergedSlug, deletedSlug, referencesRepointed } = await ctx.mergePages(targetSlug, sourceSlug);
      return { ok: true, mergedSlug, deletedSlug, referencesRepointed, message: `Merged "${deletedSlug}" into "${mergedSlug}" (${referencesRepointed} reference(s) repointed).` };
    } catch (err) {
      return { ok: false, mergedSlug: null, deletedSlug: null, referencesRepointed: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 6: 实现 `wiki-split.ts`**

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ slug: z.string().trim().min(1), hint: z.string().optional() });
const OutputSchema = z.object({
  ok: z.boolean(),
  primarySlug: z.string().nullable(),
  pageSlugs: z.array(z.string()).nullable(),
  message: z.string(),
});

export const wikiSplitTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.split',
  source: 'builtin',
  description:
    'Split ONE overloaded wiki page (slug) in the current subject into multiple independent pages (one primary page carries the original topic; references repoint to it). This CHANGES the wiki. Only split a page that bundles MULTIPLE DISTINCT topics. Optionally pass a hint describing how to divide it.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'split',
  async handler({ slug, hint }, ctx) {
    if (!ctx.splitPage) {
      return { ok: false, primarySlug: null, pageSlugs: null, message: 'Splitting pages is not available in this context.' };
    }
    try {
      const { primarySlug, pageSlugs } = await ctx.splitPage(slug, hint);
      return { ok: true, primarySlug, pageSlugs, message: `Split "${slug}" into ${pageSlugs.length} page(s) (primary: "${primarySlug}").` };
    } catch (err) {
      return { ok: false, primarySlug: null, pageSlugs: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 7: 注册**（`src/server/agents/tools/builtin/index.ts`）

import 段（`wikiCreateTool` 之后）：
```ts
import { wikiMergeTool } from './wiki-merge';
import { wikiSplitTool } from './wiki-split';
```
`createBuiltinToolRegistry()` 内（`r.register(wikiCreateTool as ToolDef);` 之后）：
```ts
  r.register(wikiMergeTool as ToolDef);
  r.register(wikiSplitTool as ToolDef);
```

- [ ] **Step 8: 运行确认通过 + 类型检查**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-merge.test.ts src/server/agents/tools/builtin/__tests__/wiki-split.test.ts`
Expected: PASS（6 用例）
Run: `npx tsc --noEmit` → 无错误

- [ ] **Step 9: Commit**

```bash
git add src/server/agents/types.ts src/server/agents/tools/tool-context.ts src/server/agents/tools/builtin/wiki-merge.ts src/server/agents/tools/builtin/wiki-split.ts src/server/agents/tools/builtin/index.ts src/server/agents/tools/builtin/__tests__/wiki-merge.test.ts src/server/agents/tools/builtin/__tests__/wiki-split.test.ts
git commit -m "feat(agents): 新增 wiki.merge/wiki.split 写工具 + ToolContext merge/split 能力"
```

---

### Task 3: `buildCurateToolContext`（curate 侧 worker ToolContext）

**Files:**
- Create: `src/server/services/curate-tools.ts`
- Test: `src/server/services/__tests__/curate-tools.test.ts`

**Interfaces:**
- Consumes: `CurateGuard`（Task 1）；`executePageMerge/Split/Delete/Create`（page-ops，Spec 1/既有）；`ToolContext`（含 Task 2 的 mergePages?/splitPage?）。
- Produces: `buildCurateToolContext(subject: Subject, deps: { guard: CurateGuard; jobId: string; emit: (type: string, message: string, data?: Record<string, unknown>) => void }): ToolContext`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const opsMocks = vi.hoisted(() => ({
  executePageMerge: vi.fn(async () => ({ mergedSlug: 'a', deletedSlug: 'b', referencesRepointed: 1 })),
  executePageSplit: vi.fn(async () => ({ sourceSlug: 'a', pageSlugs: ['a', 'a-2'], primarySlug: 'a', referencesRepointed: 0 })),
  executePageDelete: vi.fn(async () => ({ deletedSlug: 'x', brokenBacklinks: 0 })),
  executePageCreate: vi.fn(async () => ({ createdSlug: 'new' })),
}));
vi.mock('@/server/wiki/page-ops', () => opsMocks);
// 读侧依赖（本测试只测写侧，给最小桩）
vi.mock('@/server/db/repos/pages-repo', () => ({
  getPageBySlug: vi.fn(() => null), getAllPages: vi.fn(() => []), isMetaPage: () => false,
}));
vi.mock('@/server/search/hybrid-retrieval', () => ({ hybridRankSlugs: vi.fn(async () => []) }));
vi.mock('@/server/wiki/wiki-store', () => ({ readPageInSubject: vi.fn(() => null) }));

import { buildCurateToolContext } from '../curate-tools';
import { createCurateGuard } from '@/server/wiki/curate-plan';

const subject = { id: 's1', slug: 'general', name: 'G', description: '', createdAt: '', updatedAt: '' } as never;

function ctxWith(seedSet: Set<string> | null) {
  const emit = vi.fn();
  const guard = createCurateGuard({ seedSet, caps: { merge: 5, split: 5, delete: 5, create: 5 } });
  return { ctx: buildCurateToolContext(subject, { guard, jobId: 'j1', emit }), emit };
}

describe('buildCurateToolContext write capabilities', () => {
  beforeEach(() => { Object.values(opsMocks).forEach((m) => m.mockClear()); });
  it('mergePages 通过 guard → 执行 + emit curate:merge', async () => {
    const { ctx, emit } = ctxWith(null);
    const res = await ctx.mergePages!('a', 'b');
    expect(opsMocks.executePageMerge).toHaveBeenCalledWith('j1', subject, { targetSlug: 'a', sourceSlug: 'b' });
    expect(emit).toHaveBeenCalledWith('curate:merge', expect.any(String), expect.any(Object));
    expect(res).toEqual({ mergedSlug: 'a', deletedSlug: 'b', referencesRepointed: 1 });
  });
  it('guard 拒（保护页）→ emit curate:skip 且抛错，不执行', async () => {
    const { ctx, emit } = ctxWith(null);
    await expect(ctx.mergePages!('index', 'b')).rejects.toThrow(/protected/);
    expect(opsMocks.executePageMerge).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('curate:skip', expect.stringContaining('protected'), expect.any(Object));
  });
  it('auto（seedSet）createPage 被 guard 拒', async () => {
    const { ctx } = ctxWith(new Set(['a']));
    await expect(ctx.createPage!({ title: 'X', body: 'y' })).rejects.toThrow(/manual curation/);
    expect(opsMocks.executePageCreate).not.toHaveBeenCalled();
  });
  it('splitPage 通过 → 执行 + 返回 primary/pages + emit curate:split', async () => {
    const { ctx, emit } = ctxWith(null);
    const res = await ctx.splitPage!('a', 'hint');
    expect(opsMocks.executePageSplit).toHaveBeenCalledWith('j1', subject, { sourceSlug: 'a', hint: 'hint' });
    expect(res).toEqual({ primarySlug: 'a', pageSlugs: ['a', 'a-2'], referencesRepointed: 0 });
    expect(emit).toHaveBeenCalledWith('curate:split', expect.any(String), expect.any(Object));
  });
  it('deletePage 通过 → 执行 + emit curate:delete', async () => {
    const { ctx, emit } = ctxWith(null);
    await ctx.deletePage!('x');
    expect(opsMocks.executePageDelete).toHaveBeenCalledWith('j1', subject, 'x');
    expect(emit).toHaveBeenCalledWith('curate:delete', expect.any(String), expect.any(Object));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/services/__tests__/curate-tools.test.ts`
Expected: FAIL（`../curate-tools` 不存在）

- [ ] **Step 3: 实现 `curate-tools.ts`**

```ts
/**
 * Curate tool-loop 的 worker 侧 ToolContext。
 * 只读：已提交 vault（readPageInSubject）+ 混合检索（hybridRankSlugs）+ 列举（过滤 meta）——与 query-tools 读侧同构。
 * 写：merge/split/delete/create 各先过 CurateGuard，allow→调 page-ops 内核→guard.record→emit curate:* 事件；
 *     deny→emit curate:skip + 抛错（工具层 catch 成 ok:false，把 reason 透传给模型）。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import { hybridRankSlugs } from '@/server/search/hybrid-retrieval';
import { readPageInSubject } from '../wiki/wiki-store';
import { executePageMerge, executePageSplit, executePageDelete, executePageCreate } from '../wiki/page-ops';
import type { CurateGuard } from '../wiki/curate-plan';
import type { Subject } from '@/lib/contracts';
import type { ToolContext } from '@/server/agents/tools/tool-context';

const LIST_CAP = 200;
const SEARCH_LIMIT_DEFAULT = 8;

export function buildCurateToolContext(
  subject: Subject,
  deps: {
    guard: CurateGuard;
    jobId: string;
    emit: (type: string, message: string, data?: Record<string, unknown>) => void;
  },
): ToolContext {
  const { guard, jobId, emit } = deps;
  return {
    subject,
    async readPage(slug) {
      const page = pagesRepo.getPageBySlug(subject.id, slug);
      const doc = readPageInSubject(subject.slug, slug);
      if (!page || !doc) return null;
      return { title: page.title, markdown: doc.body };
    },
    async search(query, limit) {
      const slugs = await hybridRankSlugs(subject.id, query, limit ?? SEARCH_LIMIT_DEFAULT);
      const hits: Array<{ slug: string; title: string; summary: string }> = [];
      for (const slug of slugs) {
        const p = pagesRepo.getPageBySlug(subject.id, slug);
        if (!p || pagesRepo.isMetaPage(p)) continue;
        hits.push({ slug, title: p.title, summary: p.summary ?? '' });
      }
      return hits;
    },
    async listPages() {
      return pagesRepo
        .getAllPages(subject.id)
        .filter((p) => !pagesRepo.isMetaPage(p))
        .slice(0, LIST_CAP)
        .map((p) => ({ slug: p.slug, title: p.title, summary: p.summary ?? '', tags: (p.tags ?? []).filter((t) => t !== 'meta') }));
    },
    emit,
    async mergePages(targetSlug, sourceSlug) {
      const d = guard.canMerge(targetSlug, sourceSlug);
      if (!d.ok) { emit('curate:skip', `Skip merge ${sourceSlug}→${targetSlug}: ${d.reason}`, { targetSlug, sourceSlug, reason: d.reason }); throw new Error(d.reason); }
      emit('curate:merge', `Merging "${sourceSlug}" into "${targetSlug}"…`, { targetSlug, sourceSlug });
      const res = await executePageMerge(jobId, subject, { targetSlug, sourceSlug });
      guard.record('merge');
      return res;
    },
    async splitPage(slug, hint) {
      const d = guard.canSplit(slug);
      if (!d.ok) { emit('curate:skip', `Skip split ${slug}: ${d.reason}`, { slug, reason: d.reason }); throw new Error(d.reason); }
      emit('curate:split', `Splitting "${slug}"…`, { sourceSlug: slug });
      const res = await executePageSplit(jobId, subject, { sourceSlug: slug, hint });
      guard.record('split');
      return { primarySlug: res.primarySlug, pageSlugs: res.pageSlugs, referencesRepointed: res.referencesRepointed };
    },
    async deletePage(slug) {
      const d = guard.canDelete(slug);
      if (!d.ok) { emit('curate:skip', `Skip delete ${slug}: ${d.reason}`, { slug, reason: d.reason }); throw new Error(d.reason); }
      emit('curate:delete', `Deleting "${slug}"…`, { slug });
      const res = await executePageDelete(jobId, subject, slug);
      guard.record('delete');
      return res;
    },
    async createPage(input) {
      const d = guard.canCreate();
      if (!d.ok) { emit('curate:skip', `Skip create "${input.title}": ${d.reason}`, { title: input.title, reason: d.reason }); throw new Error(d.reason); }
      const res = await executePageCreate(jobId, subject, input);
      guard.record('create');
      emit('curate:create', `Created "${res.createdSlug}".`, { slug: res.createdSlug });
      return res;
    },
  };
}
```

> `new Error(d.reason)` 合法（`Error` 构造接受 `string | undefined`）；deny 分支 `d.reason` 由 guard 保证非空。

- [ ] **Step 4: 运行确认通过 + 类型检查**

Run: `npx vitest run src/server/services/__tests__/curate-tools.test.ts` → PASS（5 用例）
Run: `npx tsc --noEmit` → 无错误

- [ ] **Step 5: Commit**

```bash
git add src/server/services/curate-tools.ts src/server/services/__tests__/curate-tools.test.ts
git commit -m "feat(services): 新增 buildCurateToolContext（guard 把守 + emit 的 worker 写能力）"
```

---

### Task 4: `CURATE_AGENTIC_SYSTEM_PROMPT` + `buildCurateAgenticUserPrompt`

**Files:**
- Modify: `src/server/llm/prompts/curate-prompt.ts`（**新增** agentic prompt + builder；旧 triage/confirm 暂留，Task 5 退休）
- Test: `src/server/llm/prompts/__tests__/curate-prompt.test.ts`（追加 agentic 断言；现有 triage/confirm 测试暂留，Task 5 一并清理）

**Interfaces:**
- Produces: `CURATE_AGENTIC_SYSTEM_PROMPT: string`；`buildCurateAgenticUserPrompt(pages: { slug; title; summary; tags: string[]; bodyChars: number }[], ctx: PromptContext, opts: { auto: boolean }): string`

- [ ] **Step 1: 写失败测试**（追加到现有 `curate-prompt.test.ts` 末尾）

```ts
import { CURATE_AGENTIC_SYSTEM_PROMPT, buildCurateAgenticUserPrompt } from '../curate-prompt';

describe('CURATE_AGENTIC_SYSTEM_PROMPT', () => {
  it('列出四个写工具且强调保守 + 无人确认', () => {
    for (const t of ['wiki_merge', 'wiki_split', 'wiki_delete', 'wiki_create', 'wiki_read']) {
      expect(CURATE_AGENTIC_SYSTEM_PROMPT).toContain(t);
    }
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/conservative/i);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/no human|NO human/);
    expect(CURATE_AGENTIC_SYSTEM_PROMPT).toMatch(/index|log/);
  });
});

describe('buildCurateAgenticUserPrompt', () => {
  const pages = [{ slug: 'a', title: 'A', summary: 's', tags: ['t'], bodyChars: 100 }];
  const ctx = { language: 'English', subject: { slug: 'general', name: 'G', description: '' } };
  it('列出 scope 页 + auto 模式禁建页提示', () => {
    const auto = buildCurateAgenticUserPrompt(pages, ctx, { auto: true });
    expect(auto).toContain('`a`');
    expect(auto).toMatch(/AUTOMATIC/);
    expect(auto).toMatch(/do NOT create/i);
  });
  it('manual 模式无禁建页提示', () => {
    const manual = buildCurateAgenticUserPrompt(pages, ctx, { auto: false });
    expect(manual).toMatch(/MANUAL/);
    expect(manual).not.toMatch(/do NOT create/i);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/llm/prompts/__tests__/curate-prompt.test.ts`
Expected: FAIL（agentic 导出不存在）

- [ ] **Step 3: 新增 agentic prompt + builder**（追加到 `curate-prompt.ts` 末尾）

```ts
// ── Agentic（tool-loop 策展）─────────────────────────────────────────────────

export const CURATE_AGENTIC_SYSTEM_PROMPT = `You are a conservative wiki curator maintaining the structure of a personal knowledge base. You run as an autonomous background job: NO human will review or confirm your actions.

## Tools
- \`wiki_list\` / \`wiki_search\` / \`wiki_read\`: inspect pages. ALWAYS \`wiki_read\` a page's full body before doing anything structural to it.
- \`wiki_merge\`: fold one page into another (source deleted, references repointed). Only when two pages SUBSTANTIALLY duplicate each other.
- \`wiki_split\`: split one overloaded page that bundles MULTIPLE DISTINCT topics into separate pages.
- \`wiki_delete\`: delete a page only when it is genuinely redundant, empty, or fully absorbed elsewhere. Never delete a page with unique content.
- \`wiki_create\`: create a new hub/overview page when it genuinely helps (manual runs only; this tool is unavailable in automatic runs).

## Be conservative — the most important rule
- When in doubt, do NOTHING. A clean wiki with a few large pages beats an over-fragmented or wrongly-merged one.
- Related or cross-linked is NOT the same as duplicate. Long is NOT the same as multi-topic. Act only on clear cases.
- There is no human gate — you must self-gate every action; inspect with \`wiki_read\` before acting.
- Operations are capped and (in automatic runs) restricted to recently-changed pages. If a tool returns ok:false (limit reached / out of scope / protected), stop attempting that action.
- Never touch the \`index\` or \`log\` pages.

## When done
Stop calling tools and briefly state what you changed, or that nothing needed changing.`;

export function buildCurateAgenticUserPrompt(
  pages: { slug: string; title: string; summary: string; tags: string[]; bodyChars: number }[],
  ctx: PromptContext,
  opts: { auto: boolean },
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
  const subjectSection = ctx.subject
    ? `## Active subject (workspace)\n- **Name**: ${ctx.subject.name}\n- **Slug**: \`${ctx.subject.slug}\`\n\n`
    : '';
  const modeNote = opts.auto
    ? 'This is an AUTOMATIC run after new content was ingested. Only tidy pages related to the recent changes; do NOT create new pages.\n\n'
    : 'This is a MANUAL "tidy structure" run over the whole subject.\n\n';
  const list = pages
    .map(
      (p) =>
        `- slug: \`${p.slug}\` | title: "${p.title}" | size: ${p.bodyChars} chars | tags: ${p.tags.join(', ') || '(none)'}\n  summary: ${p.summary || '(none)'}`,
    )
    .join('\n');
  return `${languageDirective}${subjectSection}${modeNote}Below are the pages in scope. Inspect them with your tools and perform conservative structural maintenance (merge duplicates, split multi-topic pages, delete redundant pages). When unsure, leave things as they are.

## Pages (${pages.length})
${list}`;
}
```

- [ ] **Step 4: 运行确认通过 + 类型检查**

Run: `npx vitest run src/server/llm/prompts/__tests__/curate-prompt.test.ts` → PASS
Run: `npx tsc --noEmit` → 无错误

- [ ] **Step 5: Commit**

```bash
git add src/server/llm/prompts/curate-prompt.ts src/server/llm/prompts/__tests__/curate-prompt.test.ts
git commit -m "feat(prompt): 新增 CURATE_AGENTIC_SYSTEM_PROMPT + buildCurateAgenticUserPrompt"
```

---

### Task 5: 重写 `curate-service` 为 tool-loop + 退休旧 triage/confirm

**Files:**
- Modify: `src/server/services/curate-service.ts`（整体重写 `runCurateJob`）
- Modify: `src/server/llm/prompts/curate-prompt.ts`（删除 triage/confirm 三套 schema+prompt+builder+类型）
- Modify: `src/server/wiki/curate-plan.ts`（删除 `applyDecisionCaps`/`restrictToSeed`/`CurateLimits` + `import type { CurateTriage }`）
- Modify: `src/server/wiki/__tests__/curate-plan.test.ts`（删除 `applyDecisionCaps`/`restrictToSeed` 用例）
- Modify: `src/server/llm/prompts/__tests__/curate-prompt.test.ts`（删除 triage/confirm 用例，仅留 agentic）
- Test: `src/server/services/__tests__/curate-service.test.ts`（新建，mock 驱动）

**Interfaces:**
- Consumes: `createCurateGuard`/`expandScopeWithNeighbors`（curate-plan）；`buildCurateToolContext`（curate-tools）；`createBuiltinToolRegistry`（agents/tools/builtin）；`compileToolSet`（agents/tools/compile）；`generateTextWithTools`（provider-registry）；`CURATE_AGENTIC_SYSTEM_PROMPT`/`buildCurateAgenticUserPrompt`（curate-prompt）。
- Produces: `runCurateJob` 行为（tool-loop 驱动）；`registerHandler('curate', runCurateJob)`（不变）。`CURATE_MAX_STEPS = 40` 常量。

- [ ] **Step 1: 写失败测试**（`curate-service.test.ts`，新建）

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock 路径用 @/server/... 绝对别名（解析到与 SUT import 同一模块；与 query-tools.test 一致）
vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));
const genMock = vi.hoisted(() => ({ generateTextWithTools: vi.fn(async () => ({ text: 'done' })) }));
vi.mock('@/server/llm/provider-registry', () => genMock);
vi.mock('@/server/db/repos/subjects-repo', () => ({ getById: vi.fn(() => ({ id: 's1', slug: 'general', name: 'G', description: '' })) }));
const pagesMock = vi.hoisted(() => ({
  getAllPages: vi.fn(() => [{ slug: 'a', tags: [] }, { slug: 'b', tags: [] }]),
  getAllLinks: vi.fn(() => []),
  getPageBySlug: vi.fn(() => null), isMetaPage: () => false,
}));
vi.mock('@/server/db/repos/pages-repo', () => pagesMock);
vi.mock('@/server/wiki/wiki-store', () => ({
  readPageInSubject: vi.fn(() => ({ frontmatter: { title: 'T', summary: 's', tags: [] }, body: 'body' })),
}));
vi.mock('@/server/db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));
vi.mock('@/server/services/embedding-service', () => ({ enqueueEmbedIndex: vi.fn() }));
// curate-tools 透传引入；本测试不触发搜索，mock 防 import-time 副作用
vi.mock('@/server/search/hybrid-retrieval', () => ({ hybridRankSlugs: vi.fn(async () => []) }));

import { runCurateJob } from '../curate-service';

function job(params: object) {
  return { id: 'j1', subjectId: 's1', paramsJson: JSON.stringify(params) } as never;
}

describe('runCurateJob (tool-loop)', () => {
  beforeEach(() => { genMock.generateTextWithTools.mockClear(); });
  it('manual：驱动 generateTextWithTools(curate) + emit start/complete', async () => {
    const emit = vi.fn();
    const res = await runCurateJob(job({ scope: 'subject', subjectId: 's1' }), emit);
    expect(genMock.generateTextWithTools).toHaveBeenCalledTimes(1);
    const [task, opts] = genMock.generateTextWithTools.mock.calls[0];
    expect(task).toBe('curate');
    expect(Object.keys(opts.tools)).toEqual(expect.arrayContaining(['wiki_merge', 'wiki_split', 'wiki_delete', 'wiki_create', 'wiki_read']));
    expect(emit).toHaveBeenCalledWith('curate:start', expect.any(String), expect.any(Object));
    expect(emit).toHaveBeenCalledWith('curate:complete', expect.any(String), expect.any(Object));
    expect(res).toHaveProperty('writes');
  });
  it('scope<2 → 提前 complete，不调 LLM', async () => {
    pagesMock.getAllPages.mockReturnValueOnce([{ slug: 'a', tags: [] }]);
    const emit = vi.fn();
    await runCurateJob(job({ scope: 'subject', subjectId: 's1' }), emit);
    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('curate:complete', expect.stringMatching(/Nothing to curate/), expect.any(Object));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/services/__tests__/curate-service.test.ts`
Expected: FAIL（`runCurateJob` 未导出 / 仍是旧实现，工具断言不符）

> 注：`runCurateJob` 当前未 export。Step 3 的重写需 `export async function runCurateJob`（便于测试），保持文件末尾 `registerHandler('curate', runCurateJob)`。

- [ ] **Step 3: 重写 `curate-service.ts`**（整体替换文件）

```ts
/**
 * Curate service — 任务类型 'curate'：tool-loop 驱动的页面策展。
 * 模型读页后自行调 wiki.merge/split/delete/create；写能力经 CurateGuard 硬护栏把守。
 * params: { scope: 'pages' | 'subject'; slugs?: string[]; subjectId }
 *  - 'pages'(auto)：scope = slugs(本次 ingest 受影响页) + 本-subject 邻居；seed 限制生效。
 *  - 'subject'(manual)：scope = 全 subject 非 meta 页；无 seed 限制、允许 create。
 */
import { registerHandler } from '../jobs/worker';
import { enqueueEmbedIndex } from './embedding-service';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { readPageInSubject } from '../wiki/wiki-store';
import { expandScopeWithNeighbors, createCurateGuard } from '../wiki/curate-plan';
import { buildCurateToolContext } from './curate-tools';
import { createBuiltinToolRegistry } from '@/server/agents/tools/builtin';
import { compileToolSet } from '@/server/agents/tools/compile';
import { generateTextWithTools } from '../llm/provider-registry';
import { CURATE_AGENTIC_SYSTEM_PROMPT, buildCurateAgenticUserPrompt } from '../llm/prompts/curate-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { Job } from '@/lib/contracts';

const PROTECTED_SYSTEM_PAGES = new Set(['index', 'log']);
/** 工具循环最大步数（bound 读取轮次；写次数由 guard caps 真正兜底）。 */
export const CURATE_MAX_STEPS = 40;
const CURATE_CAPS = { merge: 5, split: 5, delete: 5, create: 5 };

const curateToolDefs = createBuiltinToolRegistry().resolve([
  'wiki.read', 'wiki.search', 'wiki.list', 'wiki.merge', 'wiki.split', 'wiki.delete', 'wiki.create',
]);

export async function runCurateJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as { scope?: 'pages' | 'subject'; slugs?: string[]; subjectId?: string };
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('curate job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  // 1. 解析 scope + seedSet
  let scopeSlugs: string[];
  let seedSet: Set<string> | null;
  if (params.scope === 'pages' && Array.isArray(params.slugs)) {
    const seed = params.slugs.filter((s) => !PROTECTED_SYSTEM_PAGES.has(s));
    seedSet = new Set(seed);
    const links = pagesRepo.getAllLinks(subject.id);
    scopeSlugs = expandScopeWithNeighbors(seed, links, subject.id, PROTECTED_SYSTEM_PAGES);
  } else {
    seedSet = null;
    scopeSlugs = pagesRepo.getAllPages(subject.id).map((p) => p.slug).filter((s) => !PROTECTED_SYSTEM_PAGES.has(s));
  }

  emit('curate:start', `Curating ${scopeSlugs.length} page(s) in "${subject.slug}"…`, {
    scope: params.scope ?? 'subject',
    count: scopeSlugs.length,
  });

  if (scopeSlugs.length < 2) {
    emit('curate:complete', 'Nothing to curate (need at least 2 pages).', { merge: 0, split: 0, delete: 0, create: 0, writes: 0 });
    return { merge: 0, split: 0, delete: 0, create: 0, writes: 0 };
  }

  // 2. scope 元数据（slug/title/summary/tags/bodyChars，不喂正文——模型用 wiki.read 自取）
  const metas: { slug: string; title: string; summary: string; tags: string[]; bodyChars: number }[] = [];
  for (const slug of scopeSlugs) {
    const doc = readPageInSubject(subject.slug, slug);
    if (!doc) continue;
    metas.push({
      slug,
      title: doc.frontmatter.title,
      summary: doc.frontmatter.summary ?? '',
      tags: doc.frontmatter.tags ?? [],
      bodyChars: doc.body.length,
    });
  }

  // 3. 装配 guard + worker ToolContext + 工具集
  const guard = createCurateGuard({ seedSet, caps: CURATE_CAPS });
  const ctx = buildCurateToolContext(subject, { guard, jobId: job.id, emit });
  const tools = compileToolSet(curateToolDefs, ctx);

  const promptCtx = {
    language: getWikiLanguage(),
    subject: { slug: subject.slug, name: subject.name, description: subject.description },
  };

  // 4. 驱动工具循环
  await generateTextWithTools('curate', {
    system: CURATE_AGENTIC_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildCurateAgenticUserPrompt(metas, promptCtx, { auto: seedSet !== null }) }],
    tools,
    maxSteps: CURATE_MAX_STEPS,
  });

  const totals = guard.totals();
  if (totals.writes > 0) enqueueEmbedIndex(subject.id);

  emit(
    'curate:complete',
    `Curation done: ${totals.merge} merge(s), ${totals.split} split(s), ${totals.delete} delete(s), ${totals.create} create(s).`,
    totals,
  );
  return totals as unknown as Record<string, unknown>;
}

registerHandler('curate', runCurateJob);
```

- [ ] **Step 4: 退休 curate-prompt.ts 的 triage/confirm**

删除 `curate-prompt.ts` 中：`CurateTriageSchema` + `CurateTriage` 类型 + `CURATE_TRIAGE_SYSTEM_PROMPT` + `buildCurateTriageUserPrompt`；`CurateMergeConfirmSchema` + `CurateMergeConfirm` + `CURATE_MERGE_CONFIRM_SYSTEM_PROMPT` + `buildCurateMergeConfirmUserPrompt`；`CurateSplitConfirmSchema` + `CurateSplitConfirm` + `CURATE_SPLIT_CONFIRM_SYSTEM_PROMPT` + `buildCurateSplitConfirmUserPrompt`。保留文件顶部 import（`z`、`renderLanguageDirective`/`PromptContext`）与 Task 4 新增的 agentic 段（仍用 `z`? agentic 不用 z → 若 `z` 变未使用则删 `import { z }`）。

- [ ] **Step 5: 退休 curate-plan.ts 的 applyDecisionCaps/restrictToSeed**

删除 `curate-plan.ts` 中：`import type { CurateTriage } from '../llm/prompts/curate-prompt';`、`CurateLimits` 接口、`restrictToSeed`、`applyDecisionCaps`。保留 `expandScopeWithNeighbors` 与 Task 1 的 guard 代码。

- [ ] **Step 6: 清理退休代码的测试**

- `curate-plan.test.ts`：删除针对 `applyDecisionCaps`/`restrictToSeed` 的 describe/用例（保留 `expandScopeWithNeighbors` + `createCurateGuard`）。
- `curate-prompt.test.ts`：删除针对 triage/confirm 的 describe/用例（保留 Task 4 的 agentic 用例）。

- [ ] **Step 7: 运行确认通过 + 类型检查 + 全量回归**

Run: `npx vitest run src/server/services/__tests__/curate-service.test.ts src/server/wiki/__tests__/curate-plan.test.ts src/server/llm/prompts/__tests__/curate-prompt.test.ts` → 全 PASS
Run: `npx tsc --noEmit` → 无错误（确认无残留引用退休符号）
Run: `npx vitest run` → 全绿（无回归）

- [ ] **Step 8: Commit**

```bash
git add src/server/services/curate-service.ts src/server/services/__tests__/curate-service.test.ts src/server/llm/prompts/curate-prompt.ts src/server/llm/prompts/__tests__/curate-prompt.test.ts src/server/wiki/curate-plan.ts src/server/wiki/__tests__/curate-plan.test.ts
git commit -m "feat(services): curate 重写为 tool-loop 驱动并退休 triage/confirm 流水线"
```

---

### Task 6: UI 接线（use-job-stream 事件 + tool-activity 映射）

**Files:**
- Modify: `src/hooks/use-job-stream.ts`（curate 事件列表加 `curate:delete` / `curate:create`）
- Modify: `src/lib/tool-activity.ts`（`wiki_merge` / `wiki_split` 映射）
- Test: `src/lib/__tests__/tool-activity.test.ts`（追加）

**Interfaces:**
- Produces: `toolActivityIcon`/`toolActivityVerb`/`summarizeToolArgs` 支持 `wiki_merge`（🔗/Merging/`source → target`）与 `wiki_split`（✂️/Splitting/slug）。

- [ ] **Step 1: 写失败测试**（追加到 `tool-activity.test.ts`）

```ts
describe('tool-activity - wiki_merge/wiki_split', () => {
  it('图标', () => {
    expect(toolActivityIcon('wiki_merge')).toBe('🔗');
    expect(toolActivityIcon('wiki_split')).toBe('✂️');
  });
  it('动词', () => {
    expect(toolActivityVerb('wiki_merge')).toBe('Merging');
    expect(toolActivityVerb('wiki_split')).toBe('Splitting');
  });
  it('参数摘要：merge=source→target，split=slug', () => {
    expect(summarizeToolArgs('wiki_merge', { targetSlug: 'a', sourceSlug: 'b' })).toBe('b → a');
    expect(summarizeToolArgs('wiki_split', { slug: 'a' })).toBe('a');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/__tests__/tool-activity.test.ts`
Expected: FAIL（默认 `•`/工具名/空串）

- [ ] **Step 3: 实现 tool-activity 映射**（`src/lib/tool-activity.ts`）

`toolActivityIcon` switch 内 `wiki_delete` 之后：
```ts
    case 'wiki_merge': return '🔗';
    case 'wiki_split': return '✂️';
```
`toolActivityVerb` switch 内 `wiki_delete` 之后：
```ts
    case 'wiki_merge': return 'Merging';
    case 'wiki_split': return 'Splitting';
```
`summarizeToolArgs` 内（`wiki_create` 那行之后）：
```ts
  if (tool === 'wiki_merge') {
    const s = typeof a.sourceSlug === 'string' ? a.sourceSlug : '';
    const t = typeof a.targetSlug === 'string' ? a.targetSlug : '';
    return s && t ? `${s} → ${t}` : s || t;
  }
  if (tool === 'wiki_split') return typeof a.slug === 'string' ? a.slug : '';
```

- [ ] **Step 4: 注册 SSE 事件**（`src/hooks/use-job-stream.ts`，curate 事件块内 `'curate:split',` 之后加）

```ts
        'curate:delete',
        'curate:create',
```

- [ ] **Step 5: 运行确认通过 + 类型检查**

Run: `npx vitest run src/lib/__tests__/tool-activity.test.ts` → PASS
Run: `npx tsc --noEmit` → 无错误

- [ ] **Step 6: Commit**

```bash
git add src/lib/tool-activity.ts src/lib/__tests__/tool-activity.test.ts src/hooks/use-job-stream.ts
git commit -m "feat(ui): curate 工具活动映射(🔗/✂️) + 注册 curate:delete/create 事件"
```

---

### Task 7: 文档同步（CLAUDE.md）

**Files:**
- Modify: `src/server/agents/CLAUDE.md`、`src/server/services/CLAUDE.md`、`src/server/wiki/CLAUDE.md`、`src/server/llm/CLAUDE.md`、`src/lib/CLAUDE.md`、根 `CLAUDE.md`

**Interfaces:** 无代码接口；仅文档同步。

- [ ] **Step 1: 各模块文档补条目**（读各文件现有结构，匹配格式，每个加文件/符号提及 + 2026-06-30 changelog 行）

- `src/server/agents/CLAUDE.md`：`builtin/` 清单加 `wiki-merge.ts`/`wiki-split.ts`；`tool-context.ts` 描述补 `mergePages?`/`splitPage?`；`ToolSideEffect` 提及 `merge`/`split`。
- `src/server/services/CLAUDE.md`：`curate-service.ts` 描述改为「tool-loop 驱动（generateTextWithTools + buildCurateToolContext + CurateGuard）」；文件清单加 `curate-tools.ts`。
- `src/server/wiki/CLAUDE.md`：`curate-plan.ts` 描述改为「`expandScopeWithNeighbors` + `createCurateGuard`（caps/seed/auto禁create/保护页）；退休 applyDecisionCaps/restrictToSeed」。
- `src/server/llm/CLAUDE.md`：`curate-prompt.ts` 描述改为「`CURATE_AGENTIC_SYSTEM_PROMPT` + `buildCurateAgenticUserPrompt`（tool-loop）；退休 triage/confirm 三套」。
- `src/lib/CLAUDE.md`：`tool-activity.ts` 行补 `wiki_merge`(🔗)/`wiki_split`(✂️)。

- [ ] **Step 2: 根 CLAUDE.md changelog 加行**

在第九节变更记录表末尾追加：
```
| 2026-06-30 | Curate 改造为 tool-loop（Agentic Wiki Tools Spec 2）| `curate` 由 triage→confirm→execute 结构化流水线改为自驱 tool-loop：worker `generateTextWithTools('curate')` 驱动，模型读页后调 `wiki.merge`/`wiki.split`/`wiki.delete`/`wiki.create`。新增 `wiki.merge`/`wiki.split` 工具（包装 page-ops 内核）+ `ToolContext.mergePages?/splitPage?`（`ToolDef.sideEffect` 加 `merge`/`split`）；新 `services/curate-tools.ts::buildCurateToolContext`（worker 读侧 + 写能力，经 `createCurateGuard` 硬护栏把守再调内核+emit）；新 `wiki/curate-plan.ts::createCurateGuard`（caps≤5×4 计数器 + auto seed 强制 + auto 禁 create + 保护页，模型物理越不过），退休 `applyDecisionCaps`/`restrictToSeed`；`curate-prompt` 退休 triage/confirm 三套、新增 agentic prompt；`use-job-stream` 注册 `curate:delete/create`、`tool-activity` 加 🔗/✂️。auto 安全靠工具层确定性闸门而非提示。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-30-curate-tool-loop* |
```

- [ ] **Step 3: Commit**

```bash
git add src/server/agents/CLAUDE.md src/server/services/CLAUDE.md src/server/wiki/CLAUDE.md src/server/llm/CLAUDE.md src/lib/CLAUDE.md CLAUDE.md
git commit -m "docs: 同步 Agentic Wiki Tools Spec 2（curate tool-loop）模块文档与 changelog"
```

---

## 收尾验证

- [ ] **全量测试 + 类型检查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿、无类型错误、无残留对退休符号的引用。

- [ ] **手动冒烟（可选，需 dev:all + 配置 LLM）**

Health 页 "Tidy structure"（manual，全库）→ 观察 SSE：curate:start → 模型读页 → curate:merge/split/delete/create（或无操作）→ curate:complete；到 History 确认每次结构操作各一条可回滚记录。ingest 一篇与现有页重复的内容（auto，agentAutoCurate=true）→ 确认 curate 只整理改动相关页、不创建新页、写次数受 cap。
> 冒烟写入真实 vault；清理：History 回滚或 `git revert`。
