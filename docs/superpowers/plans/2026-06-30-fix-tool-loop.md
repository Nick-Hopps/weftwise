# Fix → Tool-loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `fix` 任务的 LLM 阶段从「逐页结构化输出」改造为「自驱 update/create 工具循环」，沿用 curate 的「确定性 pre-pass + tool-loop + 工具层硬护栏」范式。

**Architecture:** 新建通用 `executePageUpdate` 内核 + `wiki.update` 工具 + `ToolContext.updatePage?`（Spec 1 当时推迟的 update 一族）。`runFixJob` 保留阶段1 确定性补 frontmatter（1 commit），把阶段2 改为 `generateTextWithTools('fix', …)`，模型自驱 `wiki.read/search/list` 取证 + `wiki.update/create` 修复；写能力经 `createFixGuard`（写 cap + 保护页）+ 忠实度护栏（`bodyShrankTooMuch`）把守，坏链/残链由内核确定性拒绝。

**Tech Stack:** TypeScript 5 / Next.js 15 / better-sqlite3 / Vercel AI SDK 4 / vitest / Zod。

## Global Constraints

- 所有新代码注释、commit message、文档用**中文**；commit message 一句话总结；**禁止**任何 AI 署名 trailer（`Co-Authored-By` / `Generated with`）。
- 每个 commit 用**具体 `git add <path>`**，绝不用 `git add -A`（防 `node_modules` 误提交；`.gitignore` 已含无斜杠 `node_modules`）。
- 保护页常量唯一源 = `@/server/wiki/page-identity::META_PAGE_SLUGS`（禁止再写 `new Set(['index','log'])`）。
- `executePageUpdate` 与 create/delete/merge/split 内核同构：**无 emit、无 enqueue**，仅确定性拼装 + Saga（`createChangeset → validateChangeset → applyChangeset`）。
- 每次写工具调用 = 一个独立 git commit（内核各自 commit）；pre-pass 另算一个 commit。
- 坏链铁律：`executePageUpdate` 在 `!valid`（跨主题坏链 errors）**或**留下同主题 `Unresolved wikilink:` 警告时一律抛错、不落盘。
- TS 路径别名 `@/*` → `src/*`。验证以 `npx tsc --noEmit` + `npx vitest run` 为准（IDE 诊断不可靠）。
- 全部命令在 worktree 根目录 `/Users/nickhopps/Documents/playground/weftwise/.claude/worktrees/feat+fix-tool-loop` 下执行。

---

### Task 1: `executePageUpdate` 内核

**Files:**
- Modify: `src/server/wiki/page-ops.ts`（追加导出函数；现有 import 已含所需符号）
- Test: `src/server/wiki/__tests__/page-ops-update.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `readPageInSubject`（`./wiki-store`）、`serializeFrontmatter`/`stampSystemFrontmatter`（`./frontmatter`）、`buildWikiPath`（`./page-identity`）、`createChangeset`/`validateChangeset`/`applyChangeset`（`./wiki-transaction`）、类型 `ChangesetEntry`/`Subject`/`WikiFrontmatter`（均已在 page-ops.ts 顶部 import）。
- Produces: `executePageUpdate(jobId: string, subject: Subject, params: { slug: string; body: string; summary?: string; tags?: string[] }): Promise<{ updatedSlug: string }>`。

- [ ] **Step 1: 写失败测试** —— 新建 `src/server/wiki/__tests__/page-ops-update.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const txMocks = vi.hoisted(() => ({
  createChangeset: vi.fn((jobId: string, subject: { id: string; slug: string }, entries: unknown[]) => ({
    id: jobId, subjectId: subject.id, subjectSlug: subject.slug, entries,
    preHead: null, postHead: null, status: 'pending',
  })),
  validateChangeset: vi.fn(() => ({ valid: true, errors: [] as string[], warnings: [] as string[] })),
  applyChangeset: vi.fn(async () => undefined),
}));
vi.mock('../wiki-transaction', () => txMocks);

const storeMocks = vi.hoisted(() => ({
  readPageInSubject: vi.fn(() => ({
    frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
    body: 'original body',
  })),
}));
vi.mock('../wiki-store', () => storeMocks);

// 中和 import-time 重依赖（page-ops 顶层为 merge/split 引入，update 不调用）
vi.mock('../../db/repos/pages-repo', () => ({ getBacklinks: vi.fn(() => []), getAllPages: vi.fn(() => []), getTitleToSlugMap: vi.fn(() => new Map()) }));
vi.mock('../../llm/provider-registry', () => ({ generateStructuredOutput: vi.fn() }));
vi.mock('../../db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));

import { executePageUpdate } from '../page-ops';

const subject = { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as never;

describe('executePageUpdate', () => {
  beforeEach(() => {
    txMocks.applyChangeset.mockClear();
    txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [], warnings: [] });
    storeMocks.readPageInSubject.mockReturnValue({
      frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
      body: 'original body',
    });
  });

  it('保留 title/created、替换正文、覆盖 tags 并 apply', async () => {
    const out = await executePageUpdate('j1', subject, { slug: 'eigenvalue', body: 'new body', summary: 's', tags: ['linear-algebra'] });
    expect(out.updatedSlug).toBe('eigenvalue');
    expect(txMocks.applyChangeset).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (txMocks.applyChangeset.mock.calls[0] as any)[0] as { entries: Array<{ action: string; path: string; content: string }> };
    expect(cs.entries[0].action).toBe('update');
    expect(cs.entries[0].path).toBe('wiki/general/eigenvalue.md');
    expect(cs.entries[0].content).toContain('title: Eigenvalue'); // 保留原标题
    expect(cs.entries[0].content).toContain('new body');           // 换了正文
    expect(cs.entries[0].content).toContain('linear-algebra');      // 覆盖 tags
  });

  it('页面不存在 → 抛错', async () => {
    storeMocks.readPageInSubject.mockReturnValueOnce(null as never);
    await expect(executePageUpdate('j1', subject, { slug: 'ghost', body: 'x' })).rejects.toThrow(/not found/);
  });

  it('validateChangeset 失败（跨主题坏链）→ 抛错不 apply', async () => {
    txMocks.validateChangeset.mockReturnValueOnce({ valid: false, errors: ['broken'], warnings: [] });
    await expect(executePageUpdate('j1', subject, { slug: 'eigenvalue', body: '[[other:Ghost]]' })).rejects.toThrow(/invalid/);
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });

  it('留下同主题 unresolved-wikilink → 抛错不 apply', async () => {
    txMocks.validateChangeset.mockReturnValueOnce({ valid: true, errors: [], warnings: ['Unresolved wikilink: [[Ghost]]'] });
    await expect(executePageUpdate('j1', subject, { slug: 'eigenvalue', body: '[[Ghost]]' })).rejects.toThrow(/unresolved wikilink/i);
    expect(txMocks.applyChangeset).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/wiki/__tests__/page-ops-update.test.ts`
Expected: FAIL（`executePageUpdate` is not a function / 未导出）。

- [ ] **Step 3: 实现** —— 在 `src/server/wiki/page-ops.ts` 末尾（`executePageCreate` 之后）追加：

```ts
/**
 * 更新一页正文（可选 summary/tags）：保留原 title/created 与系统 frontmatter（stamp updated），
 * 替换正文 → validateChangeset → apply。无 emit / 无 enqueue，与 create/delete 内核同构。
 * 坏链铁律：!valid（跨主题坏链 errors）或留下同主题 unresolved-wikilink 警告一律抛错、不落盘
 * （单页更新里残留 unresolved-wikilink 等同坏链；引导调用方「先建目标页再链接」）。
 * 供 fix tool-loop（与未来对话式 wiki.update）复用。
 */
export async function executePageUpdate(
  jobId: string,
  subject: Subject,
  params: { slug: string; body: string; summary?: string; tags?: string[] },
): Promise<{ updatedSlug: string }> {
  const { slug, body } = params;
  const doc = readPageInSubject(subject.slug, slug);
  if (!doc) throw new Error(`page "${slug}" not found`);

  const now = new Date().toISOString();
  const frontmatter: WikiFrontmatter = {
    ...doc.frontmatter,
    title: doc.frontmatter.title,
    tags: params.tags ?? doc.frontmatter.tags,
    ...(params.summary !== undefined ? { summary: params.summary } : {}),
  };
  const content = stampSystemFrontmatter(serializeFrontmatter(frontmatter, body), {
    now,
    existingCreated: doc.frontmatter.created,
  });

  const entries: ChangesetEntry[] = [
    { action: 'update', path: buildWikiPath(subject.slug, slug), content },
  ];
  const changeset = createChangeset(jobId, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) throw new Error(`update changeset invalid: ${validation.errors.join('; ')}`);
  const unresolved = (validation.warnings ?? []).filter((w) => w.includes('Unresolved wikilink:'));
  if (unresolved.length > 0) throw new Error(`update would leave unresolved wikilink(s): ${unresolved.join('; ')}`);
  await applyChangeset(changeset);

  return { updatedSlug: slug };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/server/wiki/__tests__/page-ops-update.test.ts`
Expected: PASS（4 tests）。

- [ ] **Step 5: tsc + 提交**

Run: `npx tsc --noEmit`（Expected: 无输出，exit 0）

```bash
git add src/server/wiki/page-ops.ts src/server/wiki/__tests__/page-ops-update.test.ts
git commit -m "feat(page-ops): 新增 executePageUpdate 更新内核（保留标题/系统 frontmatter、替换正文、坏链与残链一律拒绝落盘）"
```

---

### Task 2: `wiki.update` 工具 + ToolContext 能力 + 注册

**Files:**
- Create: `src/server/agents/tools/builtin/wiki-update.ts`
- Modify: `src/server/agents/tools/tool-context.ts`（`ToolContext` 加 `updatePage?`）
- Modify: `src/server/agents/types.ts:33`（`ToolSideEffect` 加 `'update'`）
- Modify: `src/server/agents/tools/builtin/index.ts`（import + register `wikiUpdateTool`）
- Test: `src/server/agents/tools/builtin/__tests__/wiki-update.test.ts`（新建）

**Interfaces:**
- Consumes: `ToolDef`（`../../types`）、`ToolContext`（`../../tool-context`）。
- Produces: `wikiUpdateTool: ToolDef`；`ToolContext.updatePage?(input: { slug: string; body: string; summary?: string; tags?: string[] }): Promise<{ updatedSlug: string }>`；`ToolSideEffect` 含 `'update'`。

- [ ] **Step 1: 写失败测试** —— 新建 `src/server/agents/tools/builtin/__tests__/wiki-update.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest';
import { wikiUpdateTool } from '../wiki-update';
import type { ToolContext } from '../../tool-context';

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    subject: { id: 's1', slug: 'general', name: 'G', description: '', createdAt: '', updatedAt: '' },
    readPage: vi.fn(async () => null),
    search: vi.fn(async () => []),
    listPages: vi.fn(async () => []),
    ...over,
  } as ToolContext;
}

describe('wiki.update tool', () => {
  it('注入 updatePage → ok:true 返回 updatedSlug', async () => {
    const updatePage = vi.fn(async () => ({ updatedSlug: 'eigen' }));
    const res = await wikiUpdateTool.handler({ slug: 'eigen', body: 'x' }, ctx({ updatePage }));
    expect(res.ok).toBe(true);
    expect(res.updatedSlug).toBe('eigen');
    expect(updatePage).toHaveBeenCalledWith({ slug: 'eigen', body: 'x' });
  });
  it('ctx 缺 updatePage → ok:false 优雅报错', async () => {
    const res = await wikiUpdateTool.handler({ slug: 'eigen', body: 'x' }, ctx());
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/not available/i);
  });
  it('updatePage 抛错 → ok:false 透传消息', async () => {
    const updatePage = vi.fn(async () => { throw new Error('update would leave unresolved wikilink(s): [[Ghost]]'); });
    const res = await wikiUpdateTool.handler({ slug: 'eigen', body: '[[Ghost]]' }, ctx({ updatePage }));
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/unresolved wikilink/i);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-update.test.ts`
Expected: FAIL（找不到 `../wiki-update` 模块）。

- [ ] **Step 3: 创建工具** —— 新建 `src/server/agents/tools/builtin/wiki-update.ts`：

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  slug: z.string().trim().min(1),
  body: z
    .string()
    .describe('Full corrected markdown body WITHOUT a frontmatter block — the system manages frontmatter (title/timestamps).'),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  updatedSlug: z.string().nullable(),
  message: z.string(),
});

export const wikiUpdateTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.update',
  source: 'builtin',
  description:
    'Replace the body (and optionally summary/tags) of an EXISTING wiki page in the current subject. This CHANGES the wiki. ' +
    'Provide the FULL corrected body, without a frontmatter block. ' +
    'Only use [[Page Title]] wikilinks to pages that already exist; a broken or unresolved link causes the edit to be REJECTED (not applied). ' +
    'Edit faithfully — fix only what the reported issues require; do not drop unrelated content.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'update',
  async handler(input, ctx) {
    if (!ctx.updatePage) {
      return { ok: false, updatedSlug: null, message: 'Updating a page is not available in this context.' };
    }
    try {
      const { updatedSlug } = await ctx.updatePage(input);
      return { ok: true, updatedSlug, message: `Updated "${updatedSlug}".` };
    } catch (err) {
      return { ok: false, updatedSlug: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 4: 扩 ToolContext** —— 在 `src/server/agents/tools/tool-context.ts` 的 `splitPage?` 声明之后（`agent?` 之前）加：

```ts
  /** fix 侧更新一页正文（Saga）；仅 fix runner 注入。 */
  updatePage?(input: { slug: string; body: string; summary?: string; tags?: string[] }):
    Promise<{ updatedSlug: string }>;
```

- [ ] **Step 5: 扩 ToolSideEffect** —— 在 `src/server/agents/types.ts:33` 改：

```ts
export type ToolSideEffect = 'none' | 'commit' | 'enqueue' | 'destructive' | 'create' | 'update' | 'merge' | 'split';
```

- [ ] **Step 6: 注册工具** —— 在 `src/server/agents/tools/builtin/index.ts` 加 import 与 register（与 `wikiCreateTool` 相邻）：

import 段加：
```ts
import { wikiUpdateTool } from './wiki-update';
```
register 段加（`wikiCreateTool` 注册之后）：
```ts
  r.register(wikiUpdateTool as ToolDef);
```

- [ ] **Step 7: 运行确认通过**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-update.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 8: tsc + 提交**

Run: `npx tsc --noEmit`（Expected: exit 0）

```bash
git add src/server/agents/tools/builtin/wiki-update.ts src/server/agents/tools/tool-context.ts src/server/agents/types.ts src/server/agents/tools/builtin/index.ts src/server/agents/tools/builtin/__tests__/wiki-update.test.ts
git commit -m "feat(tools): 新增 wiki.update 工具 + ToolContext.updatePage 能力（sideEffect 'update'，委托 executePageUpdate）"
```

---

### Task 3: `createFixGuard` 护栏（fix-deterministic.ts 追加）

**Files:**
- Modify: `src/server/services/fix-deterministic.ts`（追加 `FixGuard` 接口 + `createFixGuard`；加 `META_PAGE_SLUGS` import）
- Test: `src/server/services/__tests__/fix-deterministic.test.ts`（追加 `describe('createFixGuard')`）

**Interfaces:**
- Consumes: `META_PAGE_SLUGS`（`../wiki/page-identity`）。
- Produces: `interface FixGuard { canWrite(): { ok: boolean; reason?: string }; canEditPage(slug: string): { ok: boolean; reason?: string }; record(op: 'update'|'create'): void; totals(): { update: number; create: number; writes: number } }`；`createFixGuard(opts: { caps: { writes: number } }): FixGuard`。

- [ ] **Step 1: 写失败测试** —— 在 `src/server/services/__tests__/fix-deterministic.test.ts` 顶部 import 行追加 `createFixGuard`，并在文件末尾追加：

```ts
describe('createFixGuard', () => {
  it('canWrite 达到 cap 后拒绝', () => {
    const g = createFixGuard({ caps: { writes: 2 } });
    expect(g.canWrite().ok).toBe(true);
    g.record('update'); g.record('create');
    const d = g.canWrite();
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/limit of 2 edits/);
  });
  it('canEditPage 拒绝保护页 index/log，放行普通页', () => {
    const g = createFixGuard({ caps: { writes: 5 } });
    expect(g.canEditPage('index').ok).toBe(false);
    expect(g.canEditPage('log').ok).toBe(false);
    expect(g.canEditPage('eigen').ok).toBe(true);
  });
  it('totals 累加准确', () => {
    const g = createFixGuard({ caps: { writes: 5 } });
    g.record('update'); g.record('update'); g.record('create');
    expect(g.totals()).toEqual({ update: 2, create: 1, writes: 3 });
  });
});
```

> 注：现有 `fix-deterministic.test.ts` 顶部已 `import { ... } from '../fix-deterministic';`——把 `createFixGuard` 加进该 import 列表即可。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/services/__tests__/fix-deterministic.test.ts`
Expected: FAIL（`createFixGuard` 未导出）。

- [ ] **Step 3: 实现** —— 在 `src/server/services/fix-deterministic.ts`：

顶部 import 段（`import type { LintFinding, ... }` 行之后）加：
```ts
import { META_PAGE_SLUGS } from '../wiki/page-identity';
```

文件末尾追加：
```ts
// ── fix tool-loop 工具层硬护栏 ────────────────────────────────────────────────

export interface FixGuard {
  canWrite(): { ok: boolean; reason?: string };
  canEditPage(slug: string): { ok: boolean; reason?: string };
  record(op: 'update' | 'create'): void;
  totals(): { update: number; create: number; writes: number };
}

/**
 * fix tool-loop 的工具层硬护栏：写次数 cap（runaway backstop）+ 保护页（不可改 index/log）。
 * fix 总是手动触发 → 无 seed 限制。忠实度（bodyShrankTooMuch）在 fix-tools wrapper 把守（需现有正文，guard 不读盘）。
 */
export function createFixGuard(opts: { caps: { writes: number } }): FixGuard {
  const { caps } = opts;
  const counts = { update: 0, create: 0 };
  return {
    canWrite() {
      if (counts.update + counts.create >= caps.writes) return { ok: false, reason: `reached the limit of ${caps.writes} edits` };
      return { ok: true };
    },
    canEditPage(slug) {
      if (META_PAGE_SLUGS.has(slug)) return { ok: false, reason: 'cannot edit a protected page (index/log)' };
      return { ok: true };
    },
    record(op) { counts[op] += 1; },
    totals() { return { ...counts, writes: counts.update + counts.create }; },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/server/services/__tests__/fix-deterministic.test.ts`
Expected: PASS（含原有用例 + 新增 3 个）。

- [ ] **Step 5: tsc + 提交**

Run: `npx tsc --noEmit`（Expected: exit 0）

```bash
git add src/server/services/fix-deterministic.ts src/server/services/__tests__/fix-deterministic.test.ts
git commit -m "feat(fix): 新增 createFixGuard 工具层硬护栏（写次数 cap + 保护页复用 META_PAGE_SLUGS）"
```

---

### Task 4: fix agentic prompt（fix-prompt.ts 追加）

**Files:**
- Modify: `src/server/llm/prompts/fix-prompt.ts`（追加 `FIX_AGENTIC_SYSTEM_PROMPT` + `buildFixAgenticUserPrompt`；旧的逐页三件套本任务**暂不删**，Task 7 清理）
- Test: `src/server/llm/prompts/__tests__/fix-prompt.test.ts`（新建）

**Interfaces:**
- Consumes: `renderLanguageDirective`/`PromptContext`（`./prompt-context`，文件已 import）。
- Produces: `FIX_AGENTIC_SYSTEM_PROMPT: string`；`buildFixAgenticUserPrompt(reportLines: { slug: string; lines: string[] }[], roster: { slug: string; title: string }[], ctx: PromptContext): string`。

- [ ] **Step 1: 写失败测试** —— 新建 `src/server/llm/prompts/__tests__/fix-prompt.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildFixAgenticUserPrompt, FIX_AGENTIC_SYSTEM_PROMPT } from '../fix-prompt';

describe('buildFixAgenticUserPrompt', () => {
  it('嵌入诊断清单、roster 与语言指令', () => {
    const out = buildFixAgenticUserPrompt(
      [{ slug: 'eigen', lines: ['broken-link: [[Ghost]] missing'] }],
      [{ slug: 'matrix', title: 'Matrix' }],
      { language: 'English', subject: { slug: 'general', name: 'General', description: '' } },
    );
    expect(out).toContain('`eigen`');
    expect(out).toContain('broken-link: [[Ghost]] missing');
    expect(out).toContain('[[Matrix]]');
    expect(out).toMatch(/OUTPUT LANGUAGE/);
  });
});

describe('FIX_AGENTIC_SYSTEM_PROMPT', () => {
  it('规定保护页与忠实编辑纪律', () => {
    expect(FIX_AGENTIC_SYSTEM_PROMPT).toMatch(/index/);
    expect(FIX_AGENTIC_SYSTEM_PROMPT).toMatch(/log/);
    expect(FIX_AGENTIC_SYSTEM_PROMPT).toMatch(/[Ff]aithful/);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/llm/prompts/__tests__/fix-prompt.test.ts`
Expected: FAIL（`buildFixAgenticUserPrompt` / `FIX_AGENTIC_SYSTEM_PROMPT` 未导出）。

- [ ] **Step 3: 实现** —— 在 `src/server/llm/prompts/fix-prompt.ts` 末尾追加：

```ts
// ── Agentic（tool-loop 修复）────────────────────────────────────────────────────

export const FIX_AGENTIC_SYSTEM_PROMPT = `You are a conservative wiki repair agent fixing quality issues in a personal knowledge base. You run as a background job: NO human will review or confirm your actions.

## Tools
- \`wiki_list\` / \`wiki_search\` / \`wiki_read\`: inspect pages. ALWAYS \`wiki_read\` a page's full body before editing it; for a contradiction, read the related page(s) too.
- \`wiki_update\`: replace a page's body to fix its issues. Provide the FULL corrected body (no frontmatter). Edit faithfully — fix ONLY what the issue requires, preserve all other prose, headings, callouts and wikilinks.
- \`wiki_create\`: create a missing page ONLY when a broken link clearly should point to a page that ought to exist and you can write a genuine stub. Prefer fixing the link over inventing pages.

## Issue types
- **broken-link**: a [[wikilink]] whose target does not exist. Fix by relinking to the correct existing page (exact title), unwrapping the link to plain text, or — rarely — creating the missing page.
- **missing-crossref**: a concept with its own page is mentioned but not linked. Wrap the FIRST natural mention in [[Exact Title]]; do not duplicate links.
- **contradiction**: a page conflicts with another. Read both; make them consistent and faithful to the material. You MAY update BOTH pages. If you cannot tell which side is correct, leave it and move on — do NOT guess.

## Rules
- Faithful editing: never rewrite, summarise, reorder, or drop content beyond what an issue requires. If an edit is rejected (ok:false), you broke something — read the reason, try a smaller change, or skip.
- Only emit [[wikilinks]] to pages that exist; a broken or unresolved link causes the edit to be rejected. Create the target first if you truly need it.
- Never touch the \`index\` or \`log\` pages. Do not translate slugs, titles, wikilink targets, or code.
- Edits are capped; when a tool returns ok:false (limit reached / protected / would leave a broken link), stop attempting that action.

## When done
Stop calling tools and briefly state what you fixed, or that nothing could be safely fixed.`;

export function buildFixAgenticUserPrompt(
  reportLines: { slug: string; lines: string[] }[],
  roster: { slug: string; title: string }[],
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
  const subjectSection = ctx.subject
    ? `## Active subject (workspace)\n- **Name**: ${ctx.subject.name}\n- **Slug**: \`${ctx.subject.slug}\`\n\n`
    : '';
  const report =
    reportLines.length > 0
      ? reportLines.map((p) => `### \`${p.slug}\`\n${p.lines.map((l) => `- ${l}`).join('\n')}`).join('\n\n')
      : '(no issues)';
  const rosterSection =
    roster.length > 0
      ? roster.map((p) => `- [[${p.title}]] (slug: \`${p.slug}\`)`).join('\n')
      : '(no other pages in this subject)';
  return `${languageDirective}${subjectSection}Below is the wiki's outstanding health report, grouped by page. Inspect each affected page with your tools and repair its issues conservatively (relink/unwrap broken links, add missing cross-references, reconcile contradictions). When you cannot fix something safely, leave it.

## Health report (${reportLines.length} page(s) with issues)
${report}

## Page roster (the ONLY valid wikilink targets in this subject)
${rosterSection}`;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/server/llm/prompts/__tests__/fix-prompt.test.ts`
Expected: PASS（2 tests）。

- [ ] **Step 5: tsc + 提交**

Run: `npx tsc --noEmit`（Expected: exit 0）

```bash
git add src/server/llm/prompts/fix-prompt.ts src/server/llm/prompts/__tests__/fix-prompt.test.ts
git commit -m "feat(fix): 新增 fix agentic prompt（FIX_AGENTIC_SYSTEM_PROMPT + buildFixAgenticUserPrompt 渲染诊断清单/roster）"
```

---

### Task 5: `fix-tools.ts` —— fix 侧 ToolContext 装配

**Files:**
- Create: `src/server/services/fix-tools.ts`
- Test: `src/server/services/__tests__/fix-tools.test.ts`（新建）

**Interfaces:**
- Consumes: `executePageUpdate`/`executePageCreate`（`../wiki/page-ops`，Task 1 + 既有）、`bodyShrankTooMuch`/`FixGuard`（`./fix-deterministic`，Task 3）、`hybridRankSlugs`（`@/server/search/hybrid-retrieval`）、`readPageInSubject`（`../wiki/wiki-store`）、`pagesRepo`、`ToolContext`、`Subject`。
- Produces: `buildFixToolContext(subject: Subject, deps: { guard: FixGuard; jobId: string; emit: (type: string, message: string, data?: Record<string, unknown>) => void }): ToolContext`（含 `updatePage`/`createPage` 写能力）。

- [ ] **Step 1: 写失败测试** —— 新建 `src/server/services/__tests__/fix-tools.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const repoMocks = vi.hoisted(() => ({
  getPageBySlug: vi.fn(() => ({ slug: 'eigen', title: 'Eigen', summary: '', tags: [] })),
  getAllPages: vi.fn(() => [] as Array<{ slug: string; title: string; summary: string; tags: string[] }>),
  isMetaPage: vi.fn(() => false),
}));
vi.mock('@/server/db/repos/pages-repo', () => repoMocks);
const LONG = 'a fairly long original body with more than enough characters to matter here';
const storeMocks = vi.hoisted(() => ({ readPageInSubject: vi.fn(() => ({ frontmatter: { title: 'Eigen' }, body: 'a fairly long original body with more than enough characters to matter here' })) }));
vi.mock('@/server/wiki/wiki-store', () => storeMocks);
vi.mock('@/server/search/hybrid-retrieval', () => ({ hybridRankSlugs: vi.fn(async () => []) }));
const opsMocks = vi.hoisted(() => ({
  executePageUpdate: vi.fn(async (_j: string, _s: unknown, input: { slug: string }) => ({ updatedSlug: input.slug })),
  executePageCreate: vi.fn(async () => ({ createdSlug: 'new-page' })),
}));
vi.mock('@/server/wiki/page-ops', () => opsMocks);

import { buildFixToolContext } from '../fix-tools';
import { createFixGuard } from '../fix-deterministic';

const subject = { id: 's1', slug: 'general', name: 'G', description: '', createdAt: '', updatedAt: '' } as never;

describe('buildFixToolContext', () => {
  beforeEach(() => {
    opsMocks.executePageUpdate.mockClear();
    opsMocks.executePageCreate.mockClear();
    storeMocks.readPageInSubject.mockReturnValue({ frontmatter: { title: 'Eigen' }, body: LONG });
  });

  it('update：成功调内核 + record + emit fix:page', async () => {
    const emit = vi.fn();
    const guard = createFixGuard({ caps: { writes: 5 } });
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit });
    const res = await ctx.updatePage!({ slug: 'eigen', body: `${LONG}, edited` });
    expect(res.updatedSlug).toBe('eigen');
    expect(opsMocks.executePageUpdate).toHaveBeenCalledOnce();
    expect(guard.totals().update).toBe(1);
    expect(emit).toHaveBeenCalledWith('fix:page', expect.any(String), expect.objectContaining({ slug: 'eigen' }));
  });

  it('update：保护页 → fix:skip + 抛错，不调内核', async () => {
    const emit = vi.fn();
    const ctx = buildFixToolContext(subject, { guard: createFixGuard({ caps: { writes: 5 } }), jobId: 'j1', emit });
    await expect(ctx.updatePage!({ slug: 'index', body: 'x' })).rejects.toThrow(/protected/);
    expect(opsMocks.executePageUpdate).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:skip', expect.any(String), expect.objectContaining({ slug: 'index' }));
  });

  it('update：正文塌缩 >50% → fix:warn + 抛错，不调内核', async () => {
    const emit = vi.fn();
    const ctx = buildFixToolContext(subject, { guard: createFixGuard({ caps: { writes: 5 } }), jobId: 'j1', emit });
    await expect(ctx.updatePage!({ slug: 'eigen', body: 'tiny' })).rejects.toThrow(/dropped too much/);
    expect(opsMocks.executePageUpdate).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:warn', expect.any(String), expect.any(Object));
  });

  it('update：写 cap 耗尽 → fix:skip + 抛错', async () => {
    const emit = vi.fn();
    const guard = createFixGuard({ caps: { writes: 1 } });
    guard.record('update');
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit });
    await expect(ctx.updatePage!({ slug: 'eigen', body: `${LONG}, edited` })).rejects.toThrow(/limit of 1 edits/);
    expect(opsMocks.executePageUpdate).not.toHaveBeenCalled();
  });

  it('create：成功调内核 + record + emit fix:create', async () => {
    const emit = vi.fn();
    const guard = createFixGuard({ caps: { writes: 5 } });
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit });
    const res = await ctx.createPage!({ title: 'New Page', body: 'content' });
    expect(res.createdSlug).toBe('new-page');
    expect(guard.totals().create).toBe(1);
    expect(emit).toHaveBeenCalledWith('fix:create', expect.any(String), expect.objectContaining({ slug: 'new-page' }));
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/services/__tests__/fix-tools.test.ts`
Expected: FAIL（找不到 `../fix-tools`）。

- [ ] **Step 3: 实现** —— 新建 `src/server/services/fix-tools.ts`：

```ts
/**
 * fix tool-loop 的 worker 侧 ToolContext。
 * 只读：已提交 vault（readPageInSubject）+ 混合检索（hybridRankSlugs）+ 列举（过滤 meta）——与 curate-tools 读侧同构。
 * 写：update/create 各先过 FixGuard（写 cap + 保护页）；update 再过忠实度（bodyShrankTooMuch）；
 *     allow→调 page-ops 内核（坏链/残链由内核确定性拒绝）→guard.record→emit fix:page/fix:create；
 *     deny→emit fix:skip/fix:warn + 抛错（工具层 catch 成 ok:false，把 reason 透传给模型）。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import { hybridRankSlugs } from '@/server/search/hybrid-retrieval';
import { readPageInSubject } from '../wiki/wiki-store';
import { executePageUpdate, executePageCreate } from '../wiki/page-ops';
import { bodyShrankTooMuch, type FixGuard } from './fix-deterministic';
import type { Subject } from '@/lib/contracts';
import type { ToolContext } from '@/server/agents/tools/tool-context';

const LIST_CAP = 200;
const SEARCH_LIMIT_DEFAULT = 8;

export function buildFixToolContext(
  subject: Subject,
  deps: {
    guard: FixGuard;
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
    async updatePage(input) {
      const cap = guard.canWrite();
      if (!cap.ok) { emit('fix:skip', `Skip update ${input.slug}: ${cap.reason}`, { slug: input.slug, reason: cap.reason }); throw new Error(cap.reason); }
      const prot = guard.canEditPage(input.slug);
      if (!prot.ok) { emit('fix:skip', `Skip update ${input.slug}: ${prot.reason}`, { slug: input.slug, reason: prot.reason }); throw new Error(prot.reason); }
      const doc = readPageInSubject(subject.slug, input.slug);
      if (!doc) { const reason = `page "${input.slug}" not found`; emit('fix:skip', `Skip update ${input.slug}: ${reason}`, { slug: input.slug, reason }); throw new Error(reason); }
      if (bodyShrankTooMuch(doc.body, input.body)) {
        const reason = 'edit dropped too much content';
        emit('fix:warn', `Rejected update ${input.slug}: ${reason}`, { slug: input.slug, reason });
        throw new Error(reason);
      }
      const res = await executePageUpdate(jobId, subject, input);
      guard.record('update');
      emit('fix:page', `Repaired "${res.updatedSlug}".`, { slug: res.updatedSlug });
      return res;
    },
    async createPage(input) {
      const cap = guard.canWrite();
      if (!cap.ok) { emit('fix:skip', `Skip create "${input.title}": ${cap.reason}`, { title: input.title, reason: cap.reason }); throw new Error(cap.reason); }
      const res = await executePageCreate(jobId, subject, input);
      guard.record('create');
      emit('fix:create', `Created "${res.createdSlug}".`, { slug: res.createdSlug });
      return res;
    },
  };
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/server/services/__tests__/fix-tools.test.ts`
Expected: PASS（5 tests）。

- [ ] **Step 5: tsc + 提交**

Run: `npx tsc --noEmit`（Expected: exit 0）

```bash
git add src/server/services/fix-tools.ts src/server/services/__tests__/fix-tools.test.ts
git commit -m "feat(fix): 新增 buildFixToolContext（读侧同构 curate-tools；update/create 经 FixGuard+忠实度护栏后调 page-ops 内核+emit）"
```

---

### Task 6: 重写 `fix-service.ts` 为 tool-loop + 前端事件/活动映射

**Files:**
- Modify: `src/server/services/fix-service.ts`（整体重写 `runFixJob`：保留阶段1，阶段2 改 tool-loop）
- Modify: `src/server/services/__tests__/fix-service.test.ts`（若不存在则新建）
- Modify: `src/hooks/use-job-stream.ts`（fix 事件数组加 `'fix:create'`）
- Modify: `src/lib/tool-activity.ts`（加 `wiki_update` 映射）

**Interfaces:**
- Consumes: Task 3 `createFixGuard`、Task 4 `FIX_AGENTIC_SYSTEM_PROMPT`/`buildFixAgenticUserPrompt`、Task 5 `buildFixToolContext`、Task 2 注册的 `wiki.update`；既有 `buildFixWorklist`/`partitionFindings`/`fixMissingFrontmatter`/`buildSubjectReportLines`、`runDeterministicChecksForSubject`、`selectLatestFindings`、`createBuiltinToolRegistry`、`compileToolSet`、`generateTextWithTools`。
- Produces: 任务类型 `'fix'` 的 handler（行为变更，无新导出）。

- [ ] **Step 1: 重写 fix-service.ts** —— 用以下完整内容替换 `src/server/services/fix-service.ts`：

```ts
/**
 * Fix service — 任务类型 'fix'：一键修复 Health lint findings。
 * 工作清单 = 新鲜重扫确定性（missing-frontmatter / broken-link）∪ 最近 lint 快照语义
 *   （missing-crossref / contradiction）。
 * 阶段1（pre-pass，确定性）：所有 missing-frontmatter 合并为一个 Saga commit。
 * 阶段2（tool-loop）：generateTextWithTools('fix') 驱动，模型自驱读页 + wiki.update/create 修复；
 *   写能力经 FixGuard（写 cap + 保护页）+ 忠实度护栏把守，坏链/残链由内核确定性拒绝。每写一次一个 commit。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('fix', ...)。
 */
import { registerHandler } from '../jobs/worker';
import * as queue from '../jobs/queue';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { enqueueEmbedIndex } from './embedding-service';
import { runDeterministicChecksForSubject } from './lint-deterministic';
import { selectLatestFindings } from './lint-latest';
import { fixMissingFrontmatter, partitionFindings, buildFixWorklist, buildSubjectReportLines, createFixGuard } from './fix-deterministic';
import { buildFixToolContext } from './fix-tools';
import { readPageInSubject } from '../wiki/wiki-store';
import { buildWikiPath } from '../wiki/page-identity';
import { createChangeset, validateChangeset, applyChangeset } from '../wiki/wiki-transaction';
import { createBuiltinToolRegistry } from '@/server/agents/tools/builtin';
import { compileToolSet } from '@/server/agents/tools/compile';
import { generateTextWithTools } from '../llm/provider-registry';
import { FIX_AGENTIC_SYSTEM_PROMPT, buildFixAgenticUserPrompt } from '../llm/prompts/fix-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { ChangesetEntry, Job } from '@/lib/contracts';

/** 工具循环最大步数（bound 读取轮次；写次数由 FixGuard cap 真正兜底）。 */
export const FIX_MAX_STEPS = 60;

const fixToolDefs = createBuiltinToolRegistry().resolve([
  'wiki.read', 'wiki.search', 'wiki.list', 'wiki.update', 'wiki.create',
]);

interface FixParams {
  subjectId?: string;
}

export async function runFixJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as FixParams;
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('fix job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  // 1. 工作清单：确定性新鲜重扫 + 快照语义
  const freshDeterministic = runDeterministicChecksForSubject(subject).filter(
    (f) => f.type === 'missing-frontmatter' || f.type === 'broken-link',
  );
  const snapshotSemantic = selectLatestFindings(
    queue.list({ type: 'lint', status: 'completed', subjectId: subject.id }),
  ).findings.filter((f) => f.type === 'missing-crossref' || f.type === 'contradiction');

  const worklist = buildFixWorklist(freshDeterministic, snapshotSemantic);
  const { frontmatter, llm: loop } = partitionFindings(worklist);

  emit('fix:start', `Fixing ${frontmatter.length + loop.length} issue(s) in "${subject.slug}"…`, {
    deterministic: frontmatter.length,
    semantic: loop.length,
  });

  // 2. pre-pass：确定性补 frontmatter —— 合并为一个 commit
  let deterministicFixed = 0;
  if (frontmatter.length > 0) {
    const now = new Date().toISOString();
    const entries: ChangesetEntry[] = [];
    for (const finding of frontmatter) {
      const doc = readPageInSubject(subject.slug, finding.pageSlug);
      if (!doc) continue;
      entries.push({ action: 'update', path: buildWikiPath(subject.slug, finding.pageSlug), content: fixMissingFrontmatter(finding.pageSlug, doc, now) });
    }
    if (entries.length > 0) {
      const changeset = createChangeset(job.id, subject, entries);
      const validation = validateChangeset(changeset);
      if (validation.valid) {
        await applyChangeset(changeset);
        deterministicFixed = entries.length;
        emit('fix:deterministic', `Fixed ${entries.length} frontmatter issue(s).`, { fixed: entries.length });
      } else {
        emit('fix:warn', `Frontmatter fixes failed validation: ${validation.errors.join('; ')}`, { errors: validation.errors });
      }
    }
  }

  // 3. tool-loop：修 broken-link / missing-crossref / contradiction
  let update = 0;
  let create = 0;
  if (loop.length > 0) {
    const writeCap = Math.max(20, new Set(loop.map((f) => f.pageSlug)).size * 2);
    const guard = createFixGuard({ caps: { writes: writeCap } });
    const ctx = buildFixToolContext(subject, { guard, jobId: job.id, emit });
    const tools = compileToolSet(fixToolDefs, ctx);

    const reportLines = buildSubjectReportLines(loop);
    const roster = pagesRepo
      .getAllPages(subject.id)
      .filter((p) => !pagesRepo.isMetaPage(p))
      .map((p) => ({ slug: p.slug, title: p.title }));
    const promptCtx = {
      language: getWikiLanguage(),
      subject: { slug: subject.slug, name: subject.name, description: subject.description },
    };

    await generateTextWithTools('fix', {
      system: FIX_AGENTIC_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildFixAgenticUserPrompt(reportLines, roster, promptCtx) }],
      tools,
      maxSteps: FIX_MAX_STEPS,
    });

    const totals = guard.totals();
    update = totals.update;
    create = totals.create;
  }

  const writes = deterministicFixed + update + create;
  if (writes > 0) enqueueEmbedIndex(subject.id);

  emit('fix:complete', `Fix complete: ${deterministicFixed} frontmatter, ${update} edited, ${create} created.`, {
    deterministic: deterministicFixed,
    update,
    create,
    writes,
  });
  return { deterministic: deterministicFixed, update, create, writes };
}

registerHandler('fix', runFixJob);
```

- [ ] **Step 2: 写 fix-service 测试** —— 新建/替换 `src/server/services/__tests__/fix-service.test.ts`（mirror `curate-service.test.ts`；Step 1 已 `export runFixJob`，直接 import 测试）：

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));
const genMock = vi.hoisted(() => ({ generateTextWithTools: vi.fn(async () => ({ text: 'done' })) }));
vi.mock('@/server/llm/provider-registry', () => genMock);
vi.mock('@/server/db/repos/subjects-repo', () => ({ getById: vi.fn(() => ({ id: 's1', slug: 'general', name: 'G', description: '' })) }));
const pagesMock = vi.hoisted(() => ({
  getAllPages: vi.fn(() => [{ slug: 'a', title: 'A', summary: '', tags: [] }, { slug: 'b', title: 'B', summary: '', tags: [] }]),
  getPageBySlug: vi.fn(() => ({ slug: 'a', title: 'A', summary: '', tags: [] })),
  isMetaPage: vi.fn(() => false),
}));
vi.mock('@/server/db/repos/pages-repo', () => pagesMock);
vi.mock('@/server/wiki/wiki-store', () => ({
  readPageInSubject: vi.fn(() => ({ frontmatter: { title: 'A', created: '', updated: '', tags: [], sources: [] }, body: 'body' })),
}));
vi.mock('@/server/db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));
vi.mock('@/server/services/embedding-service', () => ({ enqueueEmbedIndex: vi.fn() }));
vi.mock('@/server/search/hybrid-retrieval', () => ({ hybridRankSlugs: vi.fn(async () => []) }));
vi.mock('@/server/wiki/page-ops', () => ({ executePageUpdate: vi.fn(async () => ({ updatedSlug: 'a' })), executePageCreate: vi.fn(async () => ({ createdSlug: 'x' })) }));
const txMock = vi.hoisted(() => ({
  createChangeset: vi.fn((id: string, s: { id: string; slug: string }, entries: unknown[]) => ({ id, subjectId: s.id, subjectSlug: s.slug, entries })),
  validateChangeset: vi.fn(() => ({ valid: true, errors: [] as string[], warnings: [] as string[] })),
  applyChangeset: vi.fn(async () => undefined),
}));
vi.mock('@/server/wiki/wiki-transaction', () => txMock);
const lintMock = vi.hoisted(() => ({ runDeterministicChecksForSubject: vi.fn(() => [] as Array<{ type: string; pageSlug: string; description: string; suggestedFix: string | null }>) }));
vi.mock('@/server/services/lint-deterministic', () => lintMock);
const latestMock = vi.hoisted(() => ({ selectLatestFindings: vi.fn(() => ({ findings: [] as Array<{ type: string; pageSlug: string; description: string; suggestedFix: string | null }> })) }));
vi.mock('@/server/services/lint-latest', () => latestMock);
vi.mock('@/server/jobs/queue', () => ({ list: vi.fn(() => []) }));

import { runFixJob } from '../fix-service';

function job() {
  return { id: 'j1', subjectId: 's1', paramsJson: JSON.stringify({ subjectId: 's1' }) } as never;
}

describe('runFixJob (tool-loop)', () => {
  beforeEach(() => {
    genMock.generateTextWithTools.mockClear();
    txMock.applyChangeset.mockClear();
    lintMock.runDeterministicChecksForSubject.mockReturnValue([]);
    latestMock.selectLatestFindings.mockReturnValue({ findings: [] });
  });

  it('有 loop findings → 驱动 generateTextWithTools(fix) + 工具集含 wiki_update/wiki_create + emit start/complete', async () => {
    lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([{ type: 'broken-link', pageSlug: 'a', description: '[[Ghost]] missing', suggestedFix: null }]);
    const emit = vi.fn();
    const res = await runFixJob(job(), emit);
    expect(genMock.generateTextWithTools).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = (genMock.generateTextWithTools.mock.calls[0] as any[])[1];
    const toolKeys = Object.keys(opts.tools);
    expect(toolKeys).toEqual(expect.arrayContaining(['wiki_read', 'wiki_search', 'wiki_list', 'wiki_update', 'wiki_create']));
    expect(emit).toHaveBeenCalledWith('fix:start', expect.any(String), expect.any(Object));
    expect(emit).toHaveBeenCalledWith('fix:complete', expect.any(String), expect.any(Object));
    expect(res).toHaveProperty('writes');
  });

  it('只有 missing-frontmatter → pre-pass 一个 commit，不调 LLM', async () => {
    lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([{ type: 'missing-frontmatter', pageSlug: 'a', description: 'missing title', suggestedFix: null }]);
    const emit = vi.fn();
    await runFixJob(job(), emit);
    expect(txMock.applyChangeset).toHaveBeenCalledOnce();
    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:deterministic', expect.any(String), expect.any(Object));
    expect(emit).toHaveBeenCalledWith('fix:complete', expect.any(String), expect.any(Object));
  });

  it('worklist 空 → 不调 LLM、不 commit，仍 emit complete', async () => {
    const emit = vi.fn();
    await runFixJob(job(), emit);
    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(txMock.applyChangeset).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:complete', expect.any(String), expect.any(Object));
  });
});
```

> 同时把 Step 1 实现里的 `async function runFixJob` 改成 `export async function runFixJob`（保留末尾 `registerHandler('fix', runFixJob);`）。

- [ ] **Step 3: 前端 SSE 事件** —— 在 `src/hooks/use-job-stream.ts` 的 fix 事件数组（现含 `'fix:start'`…`'fix:complete'`，约 218–223 行）里、`'fix:page'` 之后加一行：

```ts
        'fix:create',
```

- [ ] **Step 4: tool-activity 映射** —— 在 `src/lib/tool-activity.ts` 三处加 `wiki_update`：

`toolActivityIcon` switch 内（`wiki_create` 之后）：
```ts
    case 'wiki_update': return '✏️';
```
`toolActivityVerb` switch 内（`wiki_create` 之后）：
```ts
    case 'wiki_update': return 'Editing';
```
`summarizeToolArgs` 内（`wiki_create` 行之后）：
```ts
  if (tool === 'wiki_update') return typeof a.slug === 'string' ? a.slug : '';
```

- [ ] **Step 5: 运行测试**

Run: `npx vitest run src/server/services/__tests__/fix-service.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 6: tsc + 提交**

Run: `npx tsc --noEmit`（Expected: exit 0）

```bash
git add src/server/services/fix-service.ts src/server/services/__tests__/fix-service.test.ts src/hooks/use-job-stream.ts src/lib/tool-activity.ts
git commit -m "feat(fix): fix-service 阶段2 改为 tool-loop（generateTextWithTools(fix) + buildFixToolContext + FixGuard）；前端注册 fix:create 与 wiki_update 活动映射"
```

---

### Task 7: 退休死代码 + 文档

**Files:**
- Modify: `src/server/llm/prompts/fix-prompt.ts`（删 `FixPageSchema`/`FixPageResult`/`FIX_SYSTEM_PROMPT`/`buildFixPageUserPrompt` + 不再使用的 `import { z }`）
- Modify: `src/server/services/fix-deterministic.ts`（删 `findRelatedPageSlugs`/`mentions`/`escapeRegExp`/`MAX_RELATED_PAGES`）
- Modify: `src/server/services/__tests__/fix-deterministic.test.ts`（删针对上述函数的 describe/it）
- Modify: 模块文档（见下）

**Interfaces:**
- Consumes: 无（纯删除 + 文档）。
- Produces: 无。

- [ ] **Step 1: 删 fix-prompt 死代码** —— 在 `src/server/llm/prompts/fix-prompt.ts`：删除 `// ── Schema ──`、`// ── System prompt ──`、`// ── User prompt builder ──` 三段（即 `FixPageSchema`、`export type FixPageResult`、`FIX_SYSTEM_PROMPT`、`buildFixPageUserPrompt` 整块），仅保留顶部 import 与 Task 4 追加的 `// ── Agentic ──` 段。把首行 `import { z } from 'zod';` 删除（agentic 段不用 z），保留 `import { renderLanguageDirective, type PromptContext } from './prompt-context';`。

- [ ] **Step 2: 删 fix-deterministic 死代码** —— 在 `src/server/services/fix-deterministic.ts` 删除 `// ── 全局上下文：关联页提取 + 诊断报告分组` 注释下属于关联页提取的内容：`MAX_RELATED_PAGES` 常量、`escapeRegExp`、`mentions`、`findRelatedPageSlugs` 四者。**保留** `REPORT_DESC_MAX` 与 `buildSubjectReportLines`（fix agentic prompt 仍用）、`bodyShrankTooMuch`、`fixMissingFrontmatter`、`partitionFindings`、`buildFixWorklist`、`DETERMINISTIC_FIX_TYPES`、`LLM_FIX_TYPES`、Task 3 的 `createFixGuard`/`FixGuard`。

- [ ] **Step 3: 删对应测试** —— 在 `src/server/services/__tests__/fix-deterministic.test.ts` 删除 `describe('findRelatedPageSlugs', …)` 与 `describe('mentions', …)`（若存在）整块；保留其余（`fixMissingFrontmatter`/`partitionFindings`/`buildFixWorklist`/`bodyShrankTooMuch`/`buildSubjectReportLines`/`createFixGuard`）。

- [ ] **Step 4: 全量 tsc + 测试**（确认无残留引用 + 行为绿）

Run: `npx tsc --noEmit`（Expected: exit 0）
Run: `npx vitest run`（Expected: 全部通过；用例数 = 改造前总数 − 删除的关联页用例 + 本 spec 新增用例）

- [ ] **Step 5: 文档** —— 按下表更新模块 `CLAUDE.md`（追加 changelog 行 + 修正描述）：

`src/server/wiki/CLAUDE.md`：
- `page-ops.ts` 行的导出列表 append `/ executePageUpdate(jobId, subject, {slug, body, summary?, tags?})`，说明补「update 内核：保留标题/系统 frontmatter、替换正文、坏链/残链一律拒绝落盘」。
- changelog 追加：`| 2026-06-30 | \`page-ops.ts\` 新增 \`executePageUpdate\`（更新内核：保留 title/created、替换正文、覆盖 tags/summary、坏链与残留 unresolved-wikilink 一律抛错不落盘）；新增 \`page-ops-update\` 单测（Spec 3）|`

`src/server/agents/CLAUDE.md`：
- `tools/` 表与 `builtin/` 文件清单补 `wiki-update.ts`（`wiki.update`，`sideEffect:'update'`，仅 fix runner）；`tool-context.ts` 行补 `updatePage?`；`ToolDef.sideEffect` 描述补 `'update'`。
- changelog 追加：`| 2026-06-30 | Fix tool-loop：新增 \`tools/builtin/wiki-update.ts\`（\`wiki.update\`，\`sideEffect:'update'\`，委托 \`executePageUpdate\`）；\`ToolContext\` 新增 \`updatePage?\`（仅 fix runner 注入）；\`ToolSideEffect\` 扩 \`'update'\`（Spec 3）|`

`src/server/services/CLAUDE.md`：
- 重写 `fix-service.ts` 小节为 tool-loop 流程（pre-pass 确定性补 frontmatter 1 commit → `generateTextWithTools('fix')` 自驱 `wiki.update`/`wiki.create`，`FixGuard`=写 cap+保护页、忠实度 `bodyShrankTooMuch`、坏链/残链内核拒绝、每写一次一 commit）；事件补 `fix:create`；文件清单补 `fix-tools.ts`。
- changelog 追加：`| 2026-06-30 | Fix tool-loop（Spec 3）：\`fix-service\` 阶段2 由逐页 \`generateStructuredOutput('fix')\` 改为 \`generateTextWithTools('fix')\` 自驱 \`wiki.update\`/\`wiki.create\`；新增 \`fix-tools.ts::buildFixToolContext\`（读侧同构 curate-tools + 写经 \`createFixGuard\`+忠实度护栏调 page-ops 内核）；\`fix-deterministic\` 加 \`createFixGuard\`、退休关联页提取（\`findRelatedPageSlugs\`/\`mentions\`/\`MAX_RELATED_PAGES\`）；\`fix-prompt\` 退休逐页 \`FixPageSchema\` 三件套、新增 agentic prompt。每写一次一 commit |`

`src/server/llm/CLAUDE.md`：
- `prompts/` 表 `fix-prompt.ts` 行改为「🆕 agentic tool-loop 修复 prompt：`FIX_AGENTIC_SYSTEM_PROMPT` + `buildFixAgenticUserPrompt(reportLines, roster, ctx)`（逐页 `FixPageSchema` 三件套已退休）」。
- changelog 追加：`| 2026-06-30 | \`fix-prompt.ts\` 重写为 agentic tool-loop 版本：新增 \`FIX_AGENTIC_SYSTEM_PROMPT\` + \`buildFixAgenticUserPrompt\`；退休 \`FixPageSchema\`/\`FIX_SYSTEM_PROMPT\`/\`buildFixPageUserPrompt\`（Spec 3 fix→tool-loop）|`

`src/lib/CLAUDE.md`：
- `tool-activity.ts` 行补 `wiki_update` 映射 ✏️。
- changelog 追加：`| 2026-06-30 | \`tool-activity.ts\` 补 \`wiki_update\`(✏️) 映射，供 fix tool-loop 工具活动展示 |`

根 `CLAUDE.md` changelog 追加一行：`| 2026-06-30 | Fix 改造为 tool-loop（weftwise Tools Spec 3，初始化收官）| \`fix\` 阶段2 由逐页结构化输出改为自驱 tool-loop：新增通用 \`executePageUpdate\` 内核 + \`wiki.update\` 工具 + \`ToolContext.updatePage?\`；\`runFixJob\` 保留确定性 frontmatter pre-pass（1 commit），阶段2 走 \`generateTextWithTools('fix')\`，模型自驱 \`wiki.read/search/list\` + \`wiki.update/create\` 修复；\`createFixGuard\`（写 cap + 保护页 META_PAGE_SLUGS）+ 忠实度护栏（bodyShrankTooMuch）+ 内核坏链/残链拒绝三重把守；可同时改两页和解 contradiction。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-30-fix-tool-loop* |`

- [ ] **Step 6: 提交**

```bash
git add src/server/llm/prompts/fix-prompt.ts src/server/services/fix-deterministic.ts src/server/services/__tests__/fix-deterministic.test.ts src/server/wiki/CLAUDE.md src/server/agents/CLAUDE.md src/server/services/CLAUDE.md src/server/llm/CLAUDE.md src/lib/CLAUDE.md CLAUDE.md
git commit -m "refactor(fix): 退休 fix 逐页结构化输出死代码（FixPageSchema/关联页提取）+ 同步模块文档（Spec 3 收官）"
```

---

## 附：执行注意（worktree 写入纪律）

- 本计划在 worktree `/Users/nickhopps/Documents/playground/weftwise/.claude/worktrees/feat+fix-tool-loop` 内执行；所有 Read/Edit/Write **必须用该 worktree 的绝对路径或在该目录下的相对路径**，切勿用主仓库路径（历史上发生过写入泄漏到主仓库）。每个任务提交后 `git -C <主仓库> status` 复查未被污染、`git ls-files node_modules` 应为空。
