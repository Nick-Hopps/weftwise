# 对话触发 Re-enrich（移除按钮）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除阅读页的 Re-enrich 按钮，改由 Ask AI 对话循环通过一个写动作工具 `wiki.reenrich` 触发重新增益（先确认后执行、fire-and-forget）。

**Architecture:** 给 agentic query 工具循环新增一个写动作工具 `wiki.reenrich`（provider 名 `wiki_reenrich`）。工具经 `ToolContext.reenrich?` 能力（仅 query 注入）调用共享 helper `enqueueReenrich(subjectId, slug)` 入队现有 `re-enrich` job。确认逻辑靠系统提示 + 对话多轮记忆实现。然后删除按钮 / 弹窗 / `/api/re-enrich` 路由。

**Tech Stack:** Next.js 15 App Router、React 19、TypeScript 5、Vercel AI SDK 4（`streamTextWithTools`）、zod、vitest。

## Global Constraints

- Git commit message 用**中文**，一句话总结（来自用户 CLAUDE.md）。
- **禁止** AI 署名（不加 `Co-Authored-By: Claude` / "Generated with Claude Code"）。
- TS 路径别名 `@/*` → `src/*`。
- LLM 输出契约不变：query 仍走 `streamTextWithTools`/`generateTextWithTools`。
- `wiki.*` 工具内部名带点号；经 `compileToolSet::toProviderToolName` 转下划线（`wiki.reenrich`→`wiki_reenrich`）后才是 AI SDK 工具键、SSE `tool-call` 事件的 `toolName`、以及 UI 映射键。
- 测试用 vitest（`npm test`）；类型检查用 `npx tsc --noEmit`（项目无 `tsc` script，`next lint` 不可用）。
- 每个 task 结束时测试必须全绿。

---

### Task 1: re-enrich 入队 helper（`reenrich-enqueue.ts`）

把"校验目标页 + 入队 re-enrich job"抽成共享 helper，供对话工具复用；校验逻辑拆纯函数便于单测。这是原 `/api/re-enrich` route 校验逻辑的迁移落点。

**Files:**
- Create: `src/server/services/reenrich-enqueue.ts`
- Test: `src/server/services/__tests__/reenrich-enqueue.test.ts`

**Interfaces:**
- Consumes: `pagesRepo.getPageBySlug(subjectId, slug)`（`@/server/db/repos/pages-repo`，返回含 `tags: string[]` 的 page 或 `null`）；`queue.enqueue(type, params, subjectId)`（`@/server/jobs/queue`，返回 `{ id: string, ... }`）。
- Produces:
  - `validateReenrichTarget(slug: string, page: { tags: string[] } | null): string | null` — 纯函数，可入队返回 `null`，否则返回面向用户的错误消息。
  - `enqueueReenrich(subjectId: string, slug: string): { jobId: string }` — 校验后入队；校验失败抛 `Error`（消息可直接转述）。

- [ ] **Step 1: 写失败测试**

Create `src/server/services/__tests__/reenrich-enqueue.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetPageBySlug = vi.fn();
const mockEnqueue = vi.fn();
vi.mock('@/server/db/repos/pages-repo', () => ({
  getPageBySlug: (...a: unknown[]) => mockGetPageBySlug(...a),
}));
vi.mock('@/server/jobs/queue', () => ({
  enqueue: (...a: unknown[]) => mockEnqueue(...a),
}));

import { validateReenrichTarget, enqueueReenrich } from '../reenrich-enqueue';

describe('validateReenrichTarget', () => {
  it('meta slug（index/log）→ 错误', () => {
    expect(validateReenrichTarget('index', { tags: [] })).toMatch(/meta/);
    expect(validateReenrichTarget('log', { tags: [] })).toMatch(/meta/);
  });
  it('页不存在 → 错误', () => {
    expect(validateReenrichTarget('ghost', null)).toMatch(/not found/);
  });
  it('meta 标签页 → 错误', () => {
    expect(validateReenrichTarget('eigen', { tags: ['meta', 'math'] })).toMatch(/meta/);
  });
  it('正常页 → null（可入队）', () => {
    expect(validateReenrichTarget('eigen', { tags: ['math'] })).toBeNull();
  });
});

describe('enqueueReenrich', () => {
  beforeEach(() => {
    mockGetPageBySlug.mockReset();
    mockEnqueue.mockReset();
  });
  it('正常页 → enqueue 并返回 jobId', () => {
    mockGetPageBySlug.mockReturnValue({ slug: 'eigen', tags: ['math'] });
    mockEnqueue.mockReturnValue({ id: 'job-9' });
    const out = enqueueReenrich('s1', 'eigen');
    expect(mockEnqueue).toHaveBeenCalledWith('re-enrich', { slug: 'eigen', subjectId: 's1' }, 's1');
    expect(out).toEqual({ jobId: 'job-9' });
  });
  it('缺页 → 抛错，不 enqueue', () => {
    mockGetPageBySlug.mockReturnValue(null);
    expect(() => enqueueReenrich('s1', 'ghost')).toThrow(/not found/);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- reenrich-enqueue`
Expected: FAIL（`Cannot find module '../reenrich-enqueue'`）。

- [ ] **Step 3: 实现 helper**

Create `src/server/services/reenrich-enqueue.ts`:

```ts
/**
 * re-enrich 入队 helper（供对话工具循环触发）：校验目标页后入队 re-enrich 任务。
 * 校验逻辑抽成纯函数 validateReenrichTarget 便于单测；语义沿用原 /api/re-enrich route。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import * as queue from '../jobs/queue';

const META_SLUGS = new Set(['index', 'log']);

/** 纯校验：可入队返回 null，否则返回面向用户的错误消息。page=null 表示该 subject 下未找到。 */
export function validateReenrichTarget(
  slug: string,
  page: { tags: string[] } | null,
): string | null {
  if (META_SLUGS.has(slug)) return 'Cannot re-enrich a meta page (index/log).';
  if (!page) return `Page "${slug}" not found in this subject.`;
  if (page.tags.includes('meta')) return 'Cannot re-enrich a meta page.';
  return null;
}

/** 校验目标页后入队 re-enrich 任务；校验失败抛 Error（消息可直接转述给用户）。 */
export function enqueueReenrich(subjectId: string, slug: string): { jobId: string } {
  const page = pagesRepo.getPageBySlug(subjectId, slug);
  const err = validateReenrichTarget(slug, page);
  if (err) throw new Error(err);
  const job = queue.enqueue('re-enrich', { slug, subjectId }, subjectId);
  return { jobId: job.id };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- reenrich-enqueue`
Expected: PASS（6 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/server/services/reenrich-enqueue.ts src/server/services/__tests__/reenrich-enqueue.test.ts
git commit -m "feat(reenrich): 抽出 enqueueReenrich 入队 helper 与纯校验函数"
```

---

### Task 2: `wiki.reenrich` 写动作工具 + ToolContext 能力

新增工具定义、扩展 `ToolContext` 与 `ToolSideEffect`、注册进 builtin registry。工具仅在 `ctx.reenrich` 能力存在时入队（query 注入；ingest 不注入）。

**Files:**
- Modify: `src/server/agents/types.ts`（`ToolSideEffect` 加 `'enqueue'`）
- Modify: `src/server/agents/tools/tool-context.ts`（`ToolContext` 加 `reenrich?`）
- Create: `src/server/agents/tools/builtin/wiki-reenrich.ts`
- Modify: `src/server/agents/tools/builtin/index.ts`（注册）
- Test: `src/server/agents/tools/builtin/__tests__/wiki-reenrich.test.ts`

**Interfaces:**
- Consumes: `ToolContext.reenrich?(slug: string): Promise<{ jobId: string }>`（本 task 新增的可选能力）；`ToolDef`（`@/server/agents/types`）。
- Produces: `wikiReenrichTool: ToolDef`，内部名 `wiki.reenrich`，input `{ slug: string }`，output `{ ok: boolean; jobId: string | null; message: string }`。

- [ ] **Step 1: 写失败测试**

Create `src/server/agents/tools/builtin/__tests__/wiki-reenrich.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { wikiReenrichTool } from '../wiki-reenrich';
import type { ToolContext } from '../../tool-context';

const baseCtx = { subject: { id: 's', slug: 'general' } } as ToolContext;

describe('wiki.reenrich tool', () => {
  it('能力存在 → 入队并返回 ok+jobId', async () => {
    const reenrich = vi.fn().mockResolvedValue({ jobId: 'job-1' });
    const out = await wikiReenrichTool.handler({ slug: 'eigenvalues' }, { ...baseCtx, reenrich });
    expect(reenrich).toHaveBeenCalledWith('eigenvalues');
    expect(out).toEqual(expect.objectContaining({ ok: true, jobId: 'job-1' }));
  });
  it('能力缺失 → ok:false，不抛', async () => {
    const out = await wikiReenrichTool.handler({ slug: 'x' }, baseCtx);
    expect(out.ok).toBe(false);
    expect(out.jobId).toBeNull();
  });
  it('enqueue 抛错 → 捕获为 ok:false + message', async () => {
    const reenrich = vi.fn().mockRejectedValue(new Error('Page "x" not found in this subject.'));
    const out = await wikiReenrichTool.handler({ slug: 'x' }, { ...baseCtx, reenrich });
    expect(out.ok).toBe(false);
    expect(out.message).toContain('not found');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- wiki-reenrich`
Expected: FAIL（`Cannot find module '../wiki-reenrich'`）。

- [ ] **Step 3a: 扩展 `ToolSideEffect`**

In `src/server/agents/types.ts`, change line 33:

```ts
export type ToolSideEffect = 'none' | 'commit' | 'enqueue';
```

（`sideEffect` 仅作元数据，全代码库无 switch 分支消费，扩展安全。）

- [ ] **Step 3b: 给 `ToolContext` 加 `reenrich?` 能力**

In `src/server/agents/tools/tool-context.ts`, 在 `agent?: AgentContext;`（第 20 行）之前插入：

```ts
  /** query 侧触发 re-enrich 任务（入队）；ingest 不传 → 工具在 ingest 中调用会优雅报错。 */
  reenrich?(slug: string): Promise<{ jobId: string }>;
```

- [ ] **Step 3c: 实现工具**

Create `src/server/agents/tools/builtin/wiki-reenrich.ts`:

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ slug: z.string().trim().min(1) });
const OutputSchema = z.object({
  ok: z.boolean(),
  jobId: z.string().nullable(),
  message: z.string(),
});

export const wikiReenrichTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.reenrich',
  source: 'builtin',
  description:
    'Start a background job that re-runs the augmentation pass on ONE wiki page by slug in the current subject ' +
    '(layers fresh learning callouts onto its existing prose, then verifies). This CHANGES the page. ' +
    'Only call after the user has explicitly confirmed which page to re-enrich. Runs asynchronously.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'enqueue',
  async handler({ slug }, ctx) {
    if (!ctx.reenrich) {
      return { ok: false, jobId: null, message: 'Re-enrich is not available in this context.' };
    }
    try {
      const { jobId } = await ctx.reenrich(slug);
      return {
        ok: true,
        jobId,
        message: `Re-enrich started for "${slug}". It runs in the background; refresh the page shortly to see the result.`,
      };
    } catch (err) {
      return { ok: false, jobId: null, message: (err as Error).message };
    }
  },
};
```

- [ ] **Step 3d: 注册工具**

In `src/server/agents/tools/builtin/index.ts`:
- 在第 5 行后加 import：`import { wikiReenrichTool } from './wiki-reenrich';`
- 在 `r.register(wikiListTool as ToolDef);`（第 14 行）后加：`r.register(wikiReenrichTool as ToolDef);`

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- wiki-reenrich`
Expected: PASS（3 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/server/agents/types.ts src/server/agents/tools/tool-context.ts src/server/agents/tools/builtin/wiki-reenrich.ts src/server/agents/tools/builtin/index.ts src/server/agents/tools/builtin/__tests__/wiki-reenrich.test.ts
git commit -m "feat(reenrich): 新增 wiki.reenrich 写动作工具与 ToolContext.reenrich 能力"
```

---

### Task 3: 接入 query 工具循环 + 系统提示（含确认守则）

让对话循环解析到 `wiki.reenrich`，注入 query 侧 `reenrich` 能力，并更新系统提示（工具名修正为真实 provider 名 + 新增 re-enrich 确认守则）。

**Files:**
- Modify: `src/server/services/query-service.ts:49`（resolve 列表加 `'wiki.reenrich'`）
- Modify: `src/server/services/query-tools.ts`（`buildQueryToolContext` 注入 `reenrich`）
- Modify: `src/server/llm/prompts/query-prompt.ts`（`QUERY_AGENTIC_SYSTEM_PROMPT`）
- Modify (test): `src/server/services/__tests__/query-tools.test.ts`（加 queue mock + reenrich 用例）

**Interfaces:**
- Consumes: `enqueueReenrich(subjectId, slug)`（Task 1）；`wiki.reenrich` 工具（Task 2，经共享 registry resolve）。
- Produces: query 侧 `ToolContext.reenrich` 实现（调 `enqueueReenrich`）；对话循环可调 `wiki_reenrich`。

- [ ] **Step 1: 给 query-tools.test.ts 加失败测试**

In `src/server/services/__tests__/query-tools.test.ts`:

在现有 mock 块后（第 18 行 `}));` 之后）追加 queue mock：

```ts
const mockEnqueue = vi.fn();
vi.mock('@/server/jobs/queue', () => ({
  enqueue: (...a: unknown[]) => mockEnqueue(...a),
}));
```

在 `beforeEach`（第 52-57 行）的 reset 列表里追加一行：

```ts
  mockEnqueue.mockReset();
```

在文件末尾追加新 describe：

```ts
describe('buildQueryToolContext - reenrich', () => {
  it('校验通过 → enqueue re-enrich 并返回 jobId', async () => {
    mockGetPageBySlug.mockReturnValue(page('eigen'));
    mockEnqueue.mockReturnValue({ id: 'job-7' });
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    const out = await ctx.reenrich!('eigen');
    expect(out).toEqual({ jobId: 'job-7' });
    expect(mockEnqueue).toHaveBeenCalledWith('re-enrich', { slug: 'eigen', subjectId: 's1' }, 's1');
  });
  it('meta 页 → 抛错（不 enqueue）', async () => {
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    await expect(ctx.reenrich!('index')).rejects.toThrow(/meta/);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- query-tools`
Expected: FAIL（`ctx.reenrich` 为 undefined → `Cannot read properties of undefined`）。

- [ ] **Step 3a: query-tools 注入 `reenrich`**

In `src/server/services/query-tools.ts`:
- 在 import 区（第 12 行 `import type { ToolContext } ...` 之后）加：

```ts
import { enqueueReenrich } from './reenrich-enqueue';
```

- 在 `buildQueryToolContext` 返回对象里，`onAccess(...)` 方法之后（第 86 行 `},` 之后、第 87 行 `};` 之前）加：

```ts
    async reenrich(slug) {
      return enqueueReenrich(subject.id, slug);
    },
```

- [ ] **Step 3b: query-service resolve 列表加工具**

In `src/server/services/query-service.ts:49`, 改为：

```ts
const queryToolDefs = createBuiltinToolRegistry().resolve(['wiki.read', 'wiki.search', 'wiki.list', 'wiki.reenrich']);
```

- [ ] **Step 3c: 更新系统提示**

In `src/server/llm/prompts/query-prompt.ts`, 把 `QUERY_AGENTIC_SYSTEM_PROMPT`（第 128-149 行）整体替换为：

```ts
export const QUERY_AGENTIC_SYSTEM_PROMPT = `You are a knowledgeable assistant with access to a personal wiki, scoped to a single subject (workspace).

## Tools
The wiki content is NOT in this prompt — you MUST use the tools to read it before answering.
- \`wiki_list\`: list every page in the subject (slug, title, summary). Use FIRST for broad/overview/summary questions ("what does this cover", "summarise X", "how do A and B relate").
- \`wiki_search\`: hybrid full-text + semantic search. Use for specific questions. Issue SEVERAL focused searches with different keywords to maximise recall.
- \`wiki_read\`: read a page's full body by slug. Use to get details and the exact wording before citing.
- \`wiki_reenrich\`: start a background job that re-runs the augmentation pass on ONE page (layers fresh learning callouts onto its existing prose, then verifies). This CHANGES the page — only use it under the rules in "Re-enriching a page" below.

## Strategy
- Overview/summary questions: call \`wiki_list\`, then \`wiki_read\` on the most relevant pages.
- Specific questions: \`wiki_search\` (often several times), then \`wiki_read\` on the top hits.
- Before stating a fact, make sure you have \`wiki_read\`'d the page that supports it, so you can cite an exact excerpt.
- If, after searching and listing, the subject genuinely has nothing relevant, say so clearly. Never invent information.

## Answer format
- Clear, well-structured markdown.
- Base every claim ONLY on content returned by your tools. Do not use outside knowledge.
- If pages conflict, acknowledge the contradiction explicitly.

## Subject scoping
- Your tools only see the current subject. Do NOT reference or invent pages from another subject.
- If the question can only be answered from another subject, say so plainly and ask the user to switch subjects.

## Re-enriching a page
Use \`wiki_reenrich\` ONLY when the user explicitly asks to re-enrich, re-run augmentation, or refresh a page's learning aids. Never trigger it on your own initiative.
1. Identify the target page. If the user refers to "this page", "here", or "the current page" and a current page is given in the context, use that page's slug. If the user names a page, use \`wiki_list\`/\`wiki_search\` to resolve its exact slug.
2. If the target is ambiguous — no current page is given, or several pages could match — ASK the user which page; do not guess.
3. ALWAYS confirm before triggering: restate which page you will re-enrich (by title and slug) and ask the user to confirm. Do NOT call \`wiki_reenrich\` in the same turn you ask — only call it in a LATER turn, after the user has clearly agreed (e.g. "yes", "go ahead").
4. After calling it, tell the user the re-enrichment has started in the background and they can refresh the page shortly to see the result. The job runs asynchronously — you will not see its outcome in this conversation, so do not claim it has finished.`;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- query-tools`
Expected: PASS（含新增 2 用例，旧用例不回归）。

- [ ] **Step 5: 提交**

```bash
git add src/server/services/query-service.ts src/server/services/query-tools.ts src/server/llm/prompts/query-prompt.ts src/server/services/__tests__/query-tools.test.ts
git commit -m "feat(reenrich): 对话工具循环接入 wiki.reenrich 并加确认守则系统提示"
```

---

### Task 4: 聊天工具活动展示（修复陈旧工具名 + 新增 reenrich）

抽出共享纯模块 `lib/tool-activity.ts` 统一"provider 工具名 → 图标/动词/参数摘要"。顺手修复既有 bug：`message-list.tsx` 与 route 的 `summarizeToolArgs` 用的是陈旧名 `search_wiki/read_page/list_pages`，与真实 provider 名 `wiki_search/wiki_read/wiki_list` 不匹配（当前活动渲染成 "• wiki_search"）。

**Files:**
- Create: `src/lib/tool-activity.ts`
- Test: `src/lib/__tests__/tool-activity.test.ts`
- Modify: `src/components/chat/message-list.tsx`（删本地 helper，改 import）
- Modify: `src/app/api/query/route.ts`（删本地 `summarizeToolArgs`，改 import）

**Interfaces:**
- Consumes: SSE `tool-call` 事件的 `toolName`（= provider 名，如 `wiki_reenrich`）与工具 `args`。
- Produces:
  - `toolActivityIcon(tool: string): string`
  - `toolActivityVerb(tool: string): string`
  - `summarizeToolArgs(tool: string, args: unknown): string`

- [ ] **Step 1: 写失败测试**

Create `src/lib/__tests__/tool-activity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { toolActivityIcon, toolActivityVerb, summarizeToolArgs } from '../tool-activity';

describe('tool-activity', () => {
  it('已知工具映射 icon/verb（含 wiki_reenrich）', () => {
    expect(toolActivityIcon('wiki_reenrich')).toBe('✨');
    expect(toolActivityVerb('wiki_reenrich')).toBe('Re-enriching');
    expect(toolActivityIcon('wiki_search')).toBe('🔍');
    expect(toolActivityVerb('wiki_read')).toBe('Reading');
    expect(toolActivityIcon('wiki_list')).toBe('🗂');
  });
  it('未知工具回落', () => {
    expect(toolActivityIcon('mystery')).toBe('•');
    expect(toolActivityVerb('mystery')).toBe('mystery');
  });
  it('summarizeToolArgs：search→query，read/reenrich→slug，其它空', () => {
    expect(summarizeToolArgs('wiki_search', { query: 'foo' })).toBe('foo');
    expect(summarizeToolArgs('wiki_read', { slug: 'bar' })).toBe('bar');
    expect(summarizeToolArgs('wiki_reenrich', { slug: 'baz' })).toBe('baz');
    expect(summarizeToolArgs('wiki_list', {})).toBe('');
    expect(summarizeToolArgs('wiki_search', null)).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- tool-activity`
Expected: FAIL（`Cannot find module '../tool-activity'`）。

- [ ] **Step 3a: 实现共享模块**

Create `src/lib/tool-activity.ts`:

```ts
/**
 * 聊天工具活动展示：把 SSE tool-call 的 provider 工具名（点号已转下划线）
 * 映射为图标 / 动词 / 参数摘要。client 与 server（query route）共用单一源。
 */
export function toolActivityIcon(tool: string): string {
  switch (tool) {
    case 'wiki_search': return '🔍';
    case 'wiki_read': return '📄';
    case 'wiki_list': return '🗂';
    case 'wiki_reenrich': return '✨';
    default: return '•';
  }
}

export function toolActivityVerb(tool: string): string {
  switch (tool) {
    case 'wiki_search': return 'Searching';
    case 'wiki_read': return 'Reading';
    case 'wiki_list': return 'Listing pages';
    case 'wiki_reenrich': return 'Re-enriching';
    default: return tool;
  }
}

/** 把工具调用入参压成一行给前端展示（不外发完整 result，避免泄漏正文）。 */
export function summarizeToolArgs(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (tool === 'wiki_search') return typeof a.query === 'string' ? a.query : '';
  if (tool === 'wiki_read' || tool === 'wiki_reenrich') return typeof a.slug === 'string' ? a.slug : '';
  return '';
}
```

- [ ] **Step 3b: 接线 message-list.tsx**

In `src/components/chat/message-list.tsx`:
- 删除本地 `toolActivityIcon`（第 20-26 行）与 `toolActivityVerb`（第 28-34 行）两个函数及其注释。
- 在 import 区（`import { cn } from '@/lib/cn';` 第 6 行之后）加：

```ts
import { toolActivityIcon, toolActivityVerb } from '@/lib/tool-activity';
```

（第 151/153 行对 `toolActivityIcon(act.tool)` / `toolActivityVerb(act.tool)` 的调用保持不变。）

- [ ] **Step 3c: 接线 query route**

In `src/app/api/query/route.ts`:
- 删除文件末尾本地 `summarizeToolArgs` 函数（第 250-256 行，含其注释）。
- 在 import 区（第 15 行 `import { deriveConversationTitle } ...` 之后）加：

```ts
import { summarizeToolArgs } from '@/lib/tool-activity';
```

（第 201 行 `summarizeToolArgs(part.toolName, part.args)` 调用保持不变。）

- [ ] **Step 4: 跑测试 + 类型检查确认通过**

Run: `npm test -- tool-activity`
Expected: PASS（3 用例）。

Run: `npx tsc --noEmit`
Expected: 无错误（确认 route / message-list 改 import 后类型正确）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/tool-activity.ts src/lib/__tests__/tool-activity.test.ts src/components/chat/message-list.tsx src/app/api/query/route.ts
git commit -m "feat(reenrich): 抽出 tool-activity 展示模块、修正陈旧工具名并支持 reenrich"
```

---

### Task 5: 移除 Re-enrich 按钮 / 弹窗 / 死路由

删按钮 UI、弹窗、`/api/re-enrich` 路由及其旧 schema 测试（校验已在 Task 1 迁移到 `reenrich-enqueue.test.ts`），并清理 `frontmatter-display` / `page-renderer` 中现已无用的 `slug` 直连。

**Files:**
- Delete: `src/components/wiki/reenrich-button.tsx`
- Delete: `src/components/wiki/reenrich-dialog.tsx`
- Delete: `src/app/api/re-enrich/route.ts`
- Delete: `src/app/api/re-enrich/__tests__/validate.test.ts`
- Modify: `src/components/wiki/frontmatter-display.tsx`（移除 import / `slug` prop / 按钮）
- Modify: `src/components/wiki/page-renderer.tsx:83`（移除 `slug={slug}` 传值）

**Interfaces:**
- Consumes: 无新增。
- Produces: 阅读页不再渲染 Re-enrich 按钮；`/api/re-enrich` 不再存在；`FrontmatterDisplay` 不再接收 `slug` prop。

- [ ] **Step 1: 删除文件**

```bash
git rm src/components/wiki/reenrich-button.tsx \
       src/components/wiki/reenrich-dialog.tsx \
       src/app/api/re-enrich/route.ts \
       src/app/api/re-enrich/__tests__/validate.test.ts
```

- [ ] **Step 2: 编辑 `frontmatter-display.tsx`**

In `src/components/wiki/frontmatter-display.tsx`:
- 删除 import（第 7 行）：`import { ReenrichButton } from './reenrich-button';`
- 在 `FrontmatterDisplayProps` 接口里删除 `slug?: string;`（第 17 行）。
- 在函数参数解构里删除 `slug,`（第 47 行）。
- 删除按钮渲染行（第 58 行）：`{slug && <ReenrichButton slug={slug} title={title} />}`

  改后该 `<div className="flex items-center gap-2 shrink-0">` 仅剩 `editHref` 按钮（保留）。

- [ ] **Step 3: 编辑 `page-renderer.tsx`**

In `src/components/wiki/page-renderer.tsx`, 删除传给 `FrontmatterDisplay` 的 `slug={slug}`（第 83 行）。
（`PageRenderer` 自身的 `slug` prop 保留——它是组件公共入参；删除该连线后此入参在组件内变为未使用，项目 tsconfig 未开 `noUnusedLocals`，不报错。）

- [ ] **Step 4: 跑全量测试 + 类型检查 + 残留引用检查**

Run: `npx tsc --noEmit`
Expected: 无错误（无对已删 `ReenrichButton` / `/api/re-enrich` / `slug` prop 的悬挂引用）。

Run: `grep -rn "Reenrich\|reenrich-button\|reenrich-dialog\|api/re-enrich" src`
Expected: 仅剩 `src/hooks/use-job-stream.ts` 的 `'reenrich:start'` 事件注册（**保留**：全局 job tracker 仍叙述 re-enrich 进度）与 `src/server/services/reenrich-service.ts` / `reenrich-enqueue.ts`（后端逻辑，保留）。无 UI 按钮 / dialog / 路由引用残留。

Run: `npm test`
Expected: 全绿（用例数 = 基线 615 − 2（删 validate.test）+ 本计划新增）。

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(reenrich): 移除阅读页 Re-enrich 按钮/弹窗与 /api/re-enrich 死路由"
```

---

### Task 6: 端到端验证（手动冒烟）

UI 无自动化测试，按下述清单手动确认对话触发链路 + 按钮已消失。

**Files:** 无（验证）。

- [ ] **Step 1: 全量测试 + 类型检查**

Run: `npm test`
Expected: 全绿。

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 2: 启动应用**

Run: `npm run dev:all`（同时起 Next.js + worker；需 `llm-config.json` 已配置）。

- [ ] **Step 3: 冒烟清单**

- [ ] 打开任一非 meta wiki 阅读页：标题行右侧**不再有** Re-enrich 按钮，Edit 按钮仍在。
- [ ] 打开右侧 Chat tab（当前页上下文），输入"重新增益这一页" → AI **先复述**将增益的页（标题/slug）并请求确认，**未**立即触发。
- [ ] 回复"确认/yes" → 聊天活动出现 **✨ Re-enriching: `<slug>`**，AI 答复"已在后台启动，稍后刷新"。
- [ ] 全局 job tracker 出现一条 `re-enrich` 任务并最终 completed；刷新页面可见新增 callout。
- [ ] 反例：聊天里说"重新增益 不存在的页面xyz" → AI 反问或转述"page not found"，不静默失败。
- [ ] 反例：未明确请求时（如只问"这页讲什么"）AI **不**触发 re-enrich。

- [ ] **Step 4: 更新文档（CLAUDE.md changelog + 模块 changelog）**

按实际改动追加 changelog 行（根 `CLAUDE.md` 变更记录表 + 受影响模块的 `CLAUDE.md`）：根、`src/components/CLAUDE.md`（删 reenrich-button/dialog）、`src/app/CLAUDE.md`（删 /api/re-enrich）、`src/server/services/CLAUDE.md`（新增 reenrich-enqueue）、`src/server/agents/CLAUDE.md`（新增 wiki.reenrich 工具 + ToolContext.reenrich）。

提交：

```bash
git add -A
git commit -m "docs(reenrich): 更新对话触发 re-enrich 的架构文档与 changelog"
```

---

## Self-Review

**Spec coverage:**
- ① 移除按钮 UI → Task 5。
- ② 抽共享入队 helper + 删死路由 → Task 1（helper）+ Task 5（删路由 + 迁移测试）。
- ③ 新工具 `wiki.reenrich`（写）→ Task 2。
- ④ 扩展 ToolContext（仅 query 注入）→ Task 2（接口）+ Task 3（query 注入）。
- ⑤ query 接线 + 系统提示 → Task 3。
- ⑥ 聊天活动渲染（+ 修正陈旧工具名）→ Task 4。
- 错误/边界（缺页/meta/模糊目标/鉴权复用）→ Task 1 校验 + Task 2 handler 兜底 + Task 3 提示守则；鉴权沿用 `/api/query` 现链路（无新路由）。
- 测试策略（enqueue helper / 工具 handler / ctx 注入）→ Task 1 / 2 / 3 测试。
- 已知限制（确认靠提示）→ Task 3 提示 + Task 6 冒烟核对。

**Placeholder scan:** 无 TBD/TODO；每个改码步骤均给出完整代码或精确行号编辑。

**Type consistency:**
- `wiki.reenrich`（内部名）始终经 `toProviderToolName` → `wiki_reenrich`（provider 名）；UI/route/提示均用 `wiki_reenrich`，工具定义/registry resolve 用 `wiki.reenrich`。一致。
- `ToolContext.reenrich?(slug): Promise<{ jobId: string }>` 在 Task 2 定义、Task 3 实现（`enqueueReenrich` 同步返回 `{ jobId }` 由 `async` 包装为 Promise）、Task 2 handler `await ctx.reenrich(slug)` 消费。一致。
- `enqueueReenrich(subjectId, slug)` / `validateReenrichTarget(slug, page)` 签名在 Task 1 定义、Task 3 调用一致。
- `toolActivityIcon/Verb/summarizeToolArgs` 在 Task 4 定义并被 message-list/route 复用，键名全为 provider 名。一致。
