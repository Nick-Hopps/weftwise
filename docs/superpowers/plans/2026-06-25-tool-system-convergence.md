# 工具体系收敛 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ingest 的 `ToolDef`+`ToolRegistry` 工具模型与 Ask AI 的内联 `tool()` 孤岛统一为单一可复用模型，并用 submit 合成工具让带 schema 的 ingest skill 真正调用工具。

**Architecture:** 引入 `ToolContext`（DI 接缝）把"工具是什么"与"数据从哪来"分离；规范工具 `wiki.read`/`wiki.search`/`wiki.list` 各一份定义，ingest 与 query 各自提供 `ToolContext` 注入差异；agent-loop 对"有 tools + 有 outputSchema"的 skill 走"工具循环 + 合成 `finish` 终结工具"产出结构化结果；保留两个 runner（ingest 非流式、query 流式），仅共享工具模型。

**Tech Stack:** TypeScript 5 / Vercel AI SDK 4（`generateText` + `tools` + `maxSteps` + `experimental_prepareStep`）/ Zod / Vitest / better-sqlite3。

## Global Constraints

- TS 路径别名 `@/*` → `src/*`；强类型，领域类型集中在 `src/lib/contracts.ts`。
- `src/server/**` 为 server-only，客户端不得直接 import。
- 工具内部名用点号命名空间（`wiki.read`）；provider 边界经 `toProviderToolName` 转 `^[a-zA-Z0-9_-]{1,64}$`。
- 写操作经 services → wiki-transaction Saga；**finish 工具只返回结构化结果，绝不落盘**。
- 提交信息用中文、一句话总结、**不加 AI 署名**。
- 测试运行器：`npx vitest run <path>`（项目 `npm run lint` 不可用，以 `npx tsc --noEmit` + vitest 为准）。
- 全程不改 DB schema（零迁移）。
- skill YAML 改动需删 `data/vault/.llm-wiki/skills/<id>.md` 让 worker 重播种（`seedSkillFiles` 不覆盖已有文件）。

---

## File Structure

**新增**
- `src/server/agents/tools/tool-context.ts` — `ToolContext` 接口 + `agentToolContext(agentCtx)` adapter（ingest 侧）
- `src/server/agents/tools/compile.ts` — `compileToolSet(toolDefs, ctx, opts?)` + `synthesizeFinishTool(schema)` + `toProviderToolName`（从 agent-loop 抽出）
- `src/server/agents/tools/builtin/wiki-read.ts` / `wiki-search.ts` / `wiki-list.ts` — 规范只读工具
- `src/server/agents/tools/builtin/index.ts` — `createBuiltinToolRegistry()` 进程无关工厂

**修改**
- `src/server/agents/types.ts` — `ToolDef.handler` ctx 改 `ToolContext`；`ToolContext` 含 `agent?: AgentContext`
- `src/server/agents/runtime/agent-loop.ts` — 用 `compile.ts`；新增 tools+schema 组合路径（finish 收尾）
- `src/server/agents/tools/builtin/commit-changeset.ts` / `dispatch-skill.ts` — handler 经 `ctx.agent`
- `src/server/worker-entry.ts` — 改用 `createBuiltinToolRegistry()`
- `src/server/services/query-tools.ts` — 删内联 `tool()`，新增 `buildQueryToolContext`
- `src/server/services/query-service.ts` — registry.resolve + 共享 `compileToolSet`
- `examples/skills/ingest-planner.md` / `ingest-writer.md` — `vault.* → wiki.*`

**删除**
- `src/server/agents/tools/builtin/vault-read.ts` / `vault-search.ts`

---

## Task 1: ToolContext 接口 + agentToolContext adapter（additive）

**Files:**
- Create: `src/server/agents/tools/tool-context.ts`
- Test: `src/server/agents/tools/__tests__/tool-context.test.ts`

**Interfaces:**
- Consumes: `AgentContext`（`../types`，含 `subject`/`overlay`/`emit`）；`parseFrontmatter`（`@/server/wiki/frontmatter`，返回 `{ data: { title }, body }`）；`pagesRepo.getAllPages(subjectId)` / `isMetaPage(page)`（`@/server/db/repos/pages-repo`）。
- Produces:
  ```ts
  interface ToolContext {
    subject: Subject;
    readPage(slug: string): Promise<{ title: string; markdown: string } | null>;
    search(query: string, limit: number): Promise<Array<{ slug: string; title: string; summary: string }>>;
    listPages(): Promise<Array<{ slug: string; title: string; summary: string; tags: string[] }>>;
    onAccess?(page: { slug: string; title: string; body?: string }): void;
    emit?(type: string, message: string, data?: Record<string, unknown>): void;
    agent?: AgentContext;
  }
  function agentToolContext(agentCtx: AgentContext): ToolContext;
  ```

- [ ] **Step 1: 写失败测试**

`src/server/agents/tools/__tests__/tool-context.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';

const repoMocks = vi.hoisted(() => ({
  getAllPages: vi.fn(() => [
    { slug: 'b', title: 'B', summary: 'sb', tags: ['x'] },
    { slug: 'm', title: 'Meta', summary: '', tags: ['meta'] },
  ]),
  isMetaPage: vi.fn((p: { tags?: string[] }) => (p.tags ?? []).includes('meta')),
}));
vi.mock('../../../db/repos/pages-repo', () => repoMocks);

import { agentToolContext } from '../tool-context';
import type { AgentContext } from '../../types';

function fakeAgent(): AgentContext {
  return {
    subject: { id: 's1', slug: 'general' },
    emit: vi.fn(),
    overlay: {
      readPage: vi.fn(async (_subjectSlug: string, slug: string) =>
        slug === 'b' ? { markdown: '---\ntitle: B Title\n---\nbody-b' } : null),
      search: vi.fn(async () => [{ slug: 'b', title: 'B', summary: 'sb', source: 'store' }]),
    },
  } as unknown as AgentContext;
}

describe('agentToolContext', () => {
  it('readPage 经 overlay 读取并从 frontmatter 解析 title', async () => {
    const ctx = agentToolContext(fakeAgent());
    expect(await ctx.readPage('b')).toEqual({ title: 'B Title', markdown: '---\ntitle: B Title\n---\nbody-b' });
    expect(await ctx.readPage('missing')).toBeNull();
  });

  it('search 经 overlay.search，裁剪到 {slug,title,summary}', async () => {
    const ctx = agentToolContext(fakeAgent());
    expect(await ctx.search('q', 5)).toEqual([{ slug: 'b', title: 'B', summary: 'sb' }]);
  });

  it('listPages 排除 meta 页', async () => {
    const ctx = agentToolContext(fakeAgent());
    const pages = await ctx.listPages();
    expect(pages.map((p) => p.slug)).toEqual(['b']);
  });

  it('agent 逃生舱指回原 AgentContext；onAccess 不设置', () => {
    const agent = fakeAgent();
    const ctx = agentToolContext(agent);
    expect(ctx.agent).toBe(agent);
    expect(ctx.onAccess).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/tools/__tests__/tool-context.test.ts`
Expected: FAIL（`Cannot find module '../tool-context'`）

- [ ] **Step 3: 实现 tool-context.ts**

`src/server/agents/tools/tool-context.ts`：

```ts
import type { Subject } from '@/lib/contracts';
import type { AgentContext } from '../types';
import { parseFrontmatter } from '@/server/wiki/frontmatter';
import * as pagesRepo from '@/server/db/repos/pages-repo';

/**
 * 工具执行上下文（DI 接缝）：工具只声明 schema + 记录访问，数据源由 ctx 注入。
 * ingest 提供 overlay-backed 实现；query 提供已提交+混合检索实现（见 query-tools.ts）。
 */
export interface ToolContext {
  subject: Subject;
  readPage(slug: string): Promise<{ title: string; markdown: string } | null>;
  search(query: string, limit: number): Promise<Array<{ slug: string; title: string; summary: string }>>;
  listPages(): Promise<Array<{ slug: string; title: string; summary: string; tags: string[] }>>;
  /** query 累积访问页用于引用核查；ingest 不传。 */
  onAccess?(page: { slug: string; title: string; body?: string }): void;
  /** 可选 job 事件（ingest 经 agentCtx.emit）；query 不传（工具活动由流式响应携带）。 */
  emit?(type: string, message: string, data?: Record<string, unknown>): void;
  /** 逃生舱：仅 ingest-only 工具（commit_changeset / dispatch.skill）使用。 */
  agent?: AgentContext;
}

/** 从 AgentContext 构造 ingest 侧 ToolContext：读/搜走 overlay（含本 job 暂存页），列举走 pagesRepo。 */
export function agentToolContext(agentCtx: AgentContext): ToolContext {
  const subjectSlug = agentCtx.subject.slug;
  return {
    subject: agentCtx.subject,
    async readPage(slug) {
      const res = await agentCtx.overlay.readPage(subjectSlug, slug);
      if (!res) return null;
      const title = parseFrontmatter(res.markdown).data.title || slug;
      return { title, markdown: res.markdown };
    },
    async search(query, limit) {
      const hits = await agentCtx.overlay.search(subjectSlug, query);
      return hits.slice(0, limit).map((h) => ({ slug: h.slug, title: h.title, summary: h.summary }));
    },
    async listPages() {
      return pagesRepo
        .getAllPages(agentCtx.subject.id)
        .filter((p) => !pagesRepo.isMetaPage(p))
        .map((p) => ({ slug: p.slug, title: p.title, summary: p.summary ?? '', tags: (p.tags ?? []).filter((t) => t !== 'meta') }));
    },
    emit: (type, message, data) => agentCtx.emit(type, message, data),
    agent: agentCtx,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/agents/tools/__tests__/tool-context.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: 提交**

```bash
git add src/server/agents/tools/tool-context.ts src/server/agents/tools/__tests__/tool-context.test.ts
git commit -m "feat(agents): 新增 ToolContext 接口 + agentToolContext adapter"
```

---

## Task 2: 规范工具替换 vault.* + ToolDef ctx 翻转 + 进程无关 registry（零行为变更重构）

> 本任务是"统一工具定义"的原子翻转：`ToolDef.handler` 改吃 `ToolContext`；`vault.read/search` 换成 `wiki.read/search` 并补 `wiki.list`；ingest-only 工具改经 `ctx.agent`；agent-loop 在 compileToolSet 内构造 `agentToolContext(ctx)`。planner/writer 因仍带 `outputSchema` 走 generateObject，工具仍不被执行——**ingest 运行行为与现状完全一致**（工具复活在 Task 3）。

**Files:**
- Create: `src/server/agents/tools/builtin/wiki-read.ts` / `wiki-search.ts` / `wiki-list.ts` / `index.ts`
- Modify: `src/server/agents/types.ts`、`src/server/agents/tools/builtin/commit-changeset.ts`、`src/server/agents/tools/builtin/dispatch-skill.ts`、`src/server/agents/runtime/agent-loop.ts:124-177`（compileToolSet）、`src/server/worker-entry.ts:54-58`、`examples/skills/ingest-planner.md:6-8`、`examples/skills/ingest-writer.md:6-8`
- Delete: `src/server/agents/tools/builtin/vault-read.ts`、`vault-search.ts`
- Test: `src/server/agents/tools/builtin/__tests__/wiki-tools.test.ts`、更新 `commit-changeset.test.ts`

**Interfaces:**
- Consumes: `ToolContext`（Task 1）。
- Produces:
  ```ts
  // types.ts
  interface ToolDef<I, O> { /* ... */ handler: (input: I, ctx: ToolContext) => Promise<O>; }
  // builtin/index.ts
  function createBuiltinToolRegistry(): ToolRegistry; // 注册 wiki.read/search/list + commit_changeset + dispatch.skill
  // 工具名常量
  const wikiReadTool: ToolDef;    // name: 'wiki.read'   返回 { found, title?, markdown? }
  const wikiSearchTool: ToolDef;  // name: 'wiki.search' 返回 { hits: {slug,title,summary}[] }
  const wikiListTool: ToolDef;    // name: 'wiki.list'   返回 { pages: {slug,title,summary,tags}[], total }
  ```

- [ ] **Step 1: 写规范工具失败测试**

`src/server/agents/tools/builtin/__tests__/wiki-tools.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../tool-context';
import { wikiReadTool } from '../wiki-read';
import { wikiSearchTool } from '../wiki-search';
import { wikiListTool } from '../wiki-list';

function fakeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    subject: { id: 's1', slug: 'general' } as ToolContext['subject'],
    readPage: vi.fn(async (slug) => (slug === 'a' ? { title: 'A', markdown: 'body-a' } : null)),
    search: vi.fn(async () => [{ slug: 'a', title: 'A', summary: 'sa' }]),
    listPages: vi.fn(async () => [{ slug: 'a', title: 'A', summary: 'sa', tags: ['t'] }]),
    ...over,
  };
}

describe('wiki.read', () => {
  it('命中页返回 markdown 并触发 onAccess', async () => {
    const onAccess = vi.fn();
    const out = await wikiReadTool.handler({ slug: 'a' }, fakeCtx({ onAccess }));
    expect(out).toEqual({ found: true, title: 'A', markdown: 'body-a' });
    expect(onAccess).toHaveBeenCalledWith({ slug: 'a', title: 'A', body: 'body-a' });
  });
  it('未命中返回 found:false 且不触发 onAccess', async () => {
    const onAccess = vi.fn();
    const out = await wikiReadTool.handler({ slug: 'missing' }, fakeCtx({ onAccess }));
    expect(out).toEqual({ found: false, title: null, markdown: null });
    expect(onAccess).not.toHaveBeenCalled();
  });
});

describe('wiki.search', () => {
  it('返回命中并对每条触发 onAccess', async () => {
    const onAccess = vi.fn();
    const out = await wikiSearchTool.handler({ query: 'q' }, fakeCtx({ onAccess }));
    expect(out).toEqual({ hits: [{ slug: 'a', title: 'A', summary: 'sa' }] });
    expect(onAccess).toHaveBeenCalledWith({ slug: 'a', title: 'A' });
  });
});

describe('wiki.list', () => {
  it('返回页清单与 total', async () => {
    const out = await wikiListTool.handler({}, fakeCtx());
    expect(out).toEqual({ pages: [{ slug: 'a', title: 'A', summary: 'sa', tags: ['t'] }], total: 1 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-tools.test.ts`
Expected: FAIL（`Cannot find module '../wiki-read'`）

- [ ] **Step 3: 翻转 ToolDef.handler ctx 类型**

`src/server/agents/types.ts` 改 `ToolDef`（保留 `ToolSource`/`ToolSideEffect`），并 import `ToolContext`：

```ts
import type { ToolContext } from './tools/tool-context';

export interface ToolDef<I = unknown, O = unknown> {
  name: string;
  source: ToolSource;
  description: string;
  inputSchema: ZodSchema<I>;
  outputSchema: ZodSchema<O>;
  sideEffect: ToolSideEffect;
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}
```

> 注意 `tool-context.ts` 已 `import type { AgentContext } from '../types'`，而此处 `types.ts` 反向 `import type { ToolContext }`——均为 `import type`（仅类型，编译期擦除），不构成运行时循环依赖。

- [ ] **Step 4: 新建 wiki-read.ts / wiki-search.ts / wiki-list.ts**

`src/server/agents/tools/builtin/wiki-read.ts`：

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ slug: z.string().min(1) });
const OutputSchema = z.object({
  found: z.boolean(),
  title: z.string().nullable(),
  markdown: z.string().nullable(),
});

export const wikiReadTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.read',
  source: 'builtin',
  description: 'Read the full markdown of a wiki page by slug in the current subject. Returns found:false when missing.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler({ slug }, ctx) {
    const p = await ctx.readPage(slug);
    if (!p) return { found: false, title: null, markdown: null };
    ctx.onAccess?.({ slug, title: p.title, body: p.markdown });
    return { found: true, title: p.title, markdown: p.markdown };
  },
};
```

`src/server/agents/tools/builtin/wiki-search.ts`：

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).optional(),
});
const OutputSchema = z.object({
  hits: z.array(z.object({ slug: z.string(), title: z.string(), summary: z.string() })),
});

export const wikiSearchTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.search',
  source: 'builtin',
  description: 'Search wiki pages in the current subject by keyword or phrase. Returns matching pages (slug, title, summary).',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler({ query, limit }, ctx) {
    const hits = await ctx.search(query, limit ?? 8);
    for (const h of hits) ctx.onAccess?.({ slug: h.slug, title: h.title });
    return { hits };
  },
};
```

`src/server/agents/tools/builtin/wiki-list.ts`：

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({});
const OutputSchema = z.object({
  pages: z.array(z.object({
    slug: z.string(), title: z.string(), summary: z.string(), tags: z.array(z.string()),
  })),
  total: z.number().int(),
});

export const wikiListTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.list',
  source: 'builtin',
  description: 'List all pages in the current subject (slug, title, summary, tags). Use for broad/overview questions.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(_input, ctx) {
    const pages = await ctx.listPages();
    for (const p of pages) ctx.onAccess?.({ slug: p.slug, title: p.title });
    return { pages, total: pages.length };
  },
};
```

- [ ] **Step 5: 删除 vault-read.ts / vault-search.ts**

```bash
git rm src/server/agents/tools/builtin/vault-read.ts src/server/agents/tools/builtin/vault-search.ts
```

- [ ] **Step 6: commit_changeset / dispatch.skill 改经 ctx.agent**

`src/server/agents/tools/builtin/commit-changeset.ts`——把 `commitChangesetTool.handler` 的 `(input, ctx)` 改为从 `ctx.agent` 取真实 AgentContext（`commitPending` 等内部函数签名保持 `AgentContext` 不变）：

```ts
// commitChangesetTool.handler 内首行：
async handler(input, ctx) {
  const agent = ctx.agent;
  if (!agent) throw new Error('commit_changeset requires an ingest AgentContext');
  return commitPending(agent, /* …原有参数，把原 ctx 替换为 agent… */);
}
```

`src/server/agents/tools/builtin/dispatch-skill.ts`——同样首行 `const agent = ctx.agent; if (!agent) throw new Error('dispatch.skill requires an ingest AgentContext');`，其余使用 `agent.skillRegistry` / `agent` 处替换原 `ctx`。

- [ ] **Step 7: agent-loop compileToolSet 内构造 agentToolContext**

`src/server/agents/runtime/agent-loop.ts`：import `agentToolContext`，在 `compileToolSet` 把 `t.handler(args, ctx)` 改为 `t.handler(args, toolCtx)`，其中 `toolCtx` 由 `agentToolContext(ctx)` 构造一次（emit/runSteps 仍用 `ctx`）：

```ts
import { agentToolContext } from '../tools/tool-context';
// compileToolSet 顶部：
const toolDefs = ctx.toolRegistry.resolve(skill.tools);
const toolCtx = agentToolContext(ctx);
// ...循环内：const out = await t.handler(args, toolCtx);
```

- [ ] **Step 8: 新建 createBuiltinToolRegistry 工厂 + worker-entry 改用**

`src/server/agents/tools/builtin/index.ts`：

```ts
import { createToolRegistry } from '../registry';
import type { ToolRegistry, ToolDef } from '../../types';
import { wikiReadTool } from './wiki-read';
import { wikiSearchTool } from './wiki-search';
import { wikiListTool } from './wiki-list';
import { commitChangesetTool } from './commit-changeset';
import { dispatchSkillTool } from './dispatch-skill';

/** 进程无关：worker 与 Next.js（query 流式）两进程各自构造（ToolDef 无状态纯对象）。 */
export function createBuiltinToolRegistry(): ToolRegistry {
  const r = createToolRegistry();
  r.register(wikiReadTool as ToolDef);
  r.register(wikiSearchTool as ToolDef);
  r.register(wikiListTool as ToolDef);
  r.register(commitChangesetTool as ToolDef);
  r.register(dispatchSkillTool as ToolDef);
  return r;
}
```

`src/server/worker-entry.ts:54-58`——把手工注册 5 行替换为：

```ts
import { createBuiltinToolRegistry } from './agents/tools/builtin';
// ...
const toolRegistry = createBuiltinToolRegistry();
```

（删除原 `createToolRegistry()` + 4 个 `toolRegistry.register(...)` 行与对应 import。）

- [ ] **Step 9: skill YAML vault.* → wiki.***

`examples/skills/ingest-planner.md` 与 `ingest-writer.md` 的 frontmatter `tools:` 段：

```yaml
tools:
  - wiki.read
  - wiki.search
```

- [ ] **Step 10: 更新 commit-changeset 测试以经 ToolContext 调用工具**

`src/server/agents/tools/builtin/__tests__/commit-changeset.test.ts`——凡通过 `commitChangesetTool.handler(input, ctx)` 调用处，改为传 ToolContext：把 `ctx`（AgentContext）包成 `{ subject: ctx.subject, readPage: async () => null, search: async () => [], listPages: async () => [], agent: ctx } as ToolContext`，或在文件加 helper：

```ts
import type { ToolContext } from '../../tool-context';
const asToolCtx = (agent: AgentContext): ToolContext => ({
  subject: agent.subject,
  readPage: async () => null, search: async () => [], listPages: async () => [],
  agent,
});
// 调用：await commitChangesetTool.handler(input, asToolCtx(ctx));
```

（直接调 `commitPending(ctx, ...)` 的用例保持不变——commitPending 仍吃 AgentContext。）

- [ ] **Step 11: 跑测试 + 类型检查确认通过**

Run: `npx vitest run src/server/agents/tools && npx tsc --noEmit`
Expected: PASS（wiki-tools 4 用例 + commit-changeset 既有用例全过）；tsc 无错误

- [ ] **Step 12: 提交**

```bash
git add -A src/server/agents src/server/worker-entry.ts examples/skills/ingest-planner.md examples/skills/ingest-writer.md
git commit -m "refactor(agents): 工具改吃 ToolContext，vault.* 收敛为 wiki.read/search/list + 进程无关 registry 工厂"
```

---

## Task 3: agent-loop 组合路径——submit 合成工具复活 ingest 工具

> planner/writer 现在真正调 `wiki.read`/`wiki.search` 并以合成 `finish` 工具产出结构化结果。抽 `compileToolSet`/`toProviderToolName` 到 `compile.ts`（供 Task 4 query 复用），新增 `synthesizeFinishTool`。

**Files:**
- Create: `src/server/agents/tools/compile.ts`、`src/server/agents/tools/__tests__/compile.test.ts`
- Modify: `src/server/agents/runtime/agent-loop.ts`（删除内部 compileToolSet/toProviderToolName，import 自 compile.ts；新增组合路径 + 分支）、`src/server/agents/runtime/__tests__/agent-loop.test.ts`（加组合路径用例）

**Interfaces:**
- Consumes: `ToolContext`、`ToolDef`、AI SDK `tool` / `generateText`。
- Produces:
  ```ts
  // compile.ts
  function toProviderToolName(name: string, used: Set<string>): string;
  function compileToolSet(
    toolDefs: ToolDef[],
    ctx: ToolContext,
    opts?: { chargeStep?(): void; onToolCall?(info: { tool: string; input: unknown; output?: unknown; error?: string; durationMs: number }): void },
  ): ToolSet;
  function synthesizeFinishTool(schema: ZodSchema, capture: (value: unknown) => void): ToolSet; // { finish: Tool }
  const FINISH_TOOL_NAME = 'finish';
  ```

- [ ] **Step 1: 写 compile.ts 失败测试**

`src/server/agents/tools/__tests__/compile.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
vi.mock('ai', () => ({ tool: vi.fn((def) => def) }));

import { z } from 'zod';
import { toProviderToolName, compileToolSet, synthesizeFinishTool, FINISH_TOOL_NAME } from '../compile';
import type { ToolContext } from '../tool-context';
import type { ToolDef } from '../../types';

const ctx = { subject: { id: 's', slug: 'general' } } as ToolContext;
const echoTool: ToolDef = {
  name: 'wiki.read', source: 'builtin', description: 'd',
  inputSchema: z.object({ slug: z.string() }), outputSchema: z.object({ ok: z.boolean() }),
  sideEffect: 'none', handler: async () => ({ ok: true }),
};

describe('toProviderToolName', () => {
  it('点号转下划线、冲突加后缀', () => {
    const used = new Set<string>();
    expect(toProviderToolName('wiki.read', used)).toBe('wiki_read');
    used.add('wiki_read');
    expect(toProviderToolName('wiki.read', used)).toBe('wiki_read_2');
  });
});

describe('compileToolSet', () => {
  it('点号名转 provider 安全名；execute 调 handler 并计步', async () => {
    const chargeStep = vi.fn();
    const set = compileToolSet([echoTool], ctx, { chargeStep });
    expect(Object.keys(set)).toEqual(['wiki_read']);
    const out = await set.wiki_read.execute({ slug: 'a' });
    expect(out).toEqual({ ok: true });
    expect(chargeStep).toHaveBeenCalledOnce();
  });
});

describe('synthesizeFinishTool', () => {
  it('finish.execute 捕获校验后入参', async () => {
    let captured: unknown;
    const set = synthesizeFinishTool(z.object({ title: z.string() }), (v) => { captured = v; });
    expect(Object.keys(set)).toEqual([FINISH_TOOL_NAME]);
    await set.finish.execute({ title: 'T' });
    expect(captured).toEqual({ title: 'T' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/tools/__tests__/compile.test.ts`
Expected: FAIL（`Cannot find module '../compile'`）

- [ ] **Step 3: 实现 compile.ts（移动 + 新增）**

`src/server/agents/tools/compile.ts`：把 agent-loop 现有 `toProviderToolName`（agent-loop.ts:287-298）原样移来；`compileToolSet` 改为吃 `ToolDef[]` + `ToolContext` + `opts`（emit/step 通过 opts 回调，不再耦合 AgentContext）；新增 `synthesizeFinishTool`：

```ts
import { tool, type ToolSet } from 'ai';
import type { ZodSchema } from 'zod';
import type { ToolDef } from '../types';
import type { ToolContext } from './tool-context';

export const FINISH_TOOL_NAME = 'finish';

export function toProviderToolName(name: string, used: Set<string>): string {
  let base = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  if (base.length === 0) base = 'tool';
  if (!used.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const suffix = `_${i}`;
    const candidate = base.slice(0, 64 - suffix.length) + suffix;
    if (!used.has(candidate)) return candidate;
  }
}

/** 把内部 ToolDef 编译成 provider 可用 ToolSet；步数/事件通过 opts 注入（ingest 传，query 不传）。 */
export function compileToolSet(
  toolDefs: ToolDef[],
  ctx: ToolContext,
  opts?: {
    chargeStep?(): void;
    onToolCall?(info: { tool: string; input: unknown; output?: unknown; error?: string; durationMs: number }): void;
  },
): ToolSet {
  const toolSet: ToolSet = {};
  const used = new Set<string>();
  for (const t of toolDefs) {
    const providerName = toProviderToolName(t.name, used);
    used.add(providerName);
    toolSet[providerName] = tool({
      description: t.description,
      parameters: t.inputSchema,
      execute: async (args: unknown) => {
        const start = Date.now();
        opts?.chargeStep?.();
        try {
          const out = await t.handler(args, ctx);
          opts?.onToolCall?.({ tool: t.name, input: args, output: out, durationMs: Date.now() - start });
          return out;
        } catch (err) {
          opts?.onToolCall?.({ tool: t.name, input: args, error: (err as Error).message, durationMs: Date.now() - start });
          throw err;
        }
      },
    });
  }
  return toolSet;
}

/** 合成终结工具：其 parameters = skill outputSchema；模型调用它即产出结构化结果（经 capture 回传）。 */
export function synthesizeFinishTool(schema: ZodSchema, capture: (value: unknown) => void): ToolSet {
  return {
    [FINISH_TOOL_NAME]: tool({
      description: 'Submit the final structured result. Call this exactly once when done; do not answer in plain text.',
      parameters: schema,
      execute: async (args: unknown) => {
        capture(args);
        return { accepted: true };
      },
    }),
  };
}
```

- [ ] **Step 4: agent-loop 改用 compile.ts + 新增组合路径**

`src/server/agents/runtime/agent-loop.ts`：
1. 删除文件内 `toProviderToolName`（287-298）与 `compileToolSet`（124-177），改 `import { compileToolSet, synthesizeFinishTool, FINISH_TOOL_NAME, toProviderToolName } from '../tools/compile';`（`toProviderToolName` 若已无引用可不导）。
2. `runAgentLoop` 内 `const toolSet = compileToolSet(...)` 改为：

```ts
import { agentToolContext } from '../tools/tool-context';
import { experimental_repairToolCall as _ignore } from 'ai'; // 仅示意；repair 见下
// ...
const toolDefs = ctx.toolRegistry.resolve(skill.tools);
const toolCtx = agentToolContext(ctx);
const toolSet = compileToolSet(toolDefs, toolCtx, {
  chargeStep: () => runSteps.chargeStep(),
  onToolCall: (info) => ctx.emit('agent:step', `${skill.name} called ${info.tool}`, {
    runId, parentRunId: ctx.parentRunId, skillId: skill.id, stepIndex: runSteps.stepCount,
    kind: 'tool-call', tool: info.tool, input: info.input,
    outputPreview: info.output !== undefined ? previewOutput(info.output) : undefined,
    error: info.error, durationMs: info.durationMs,
  }),
});
```

3. 分支改为三路：

```ts
const hasTools = skill.tools.length > 0;
generation =
  skill.outputSchema && hasTools
    ? await generateCombinedResult(skill, ctx, model, route, messages, toolSet, skill.outputSchema)
    : skill.outputSchema
      ? await generateStructuredResult(skill, ctx, runId, runSteps, model, route, messages)
      : await generateTextResult(skill, ctx, runId, model, route, messages, toolSet);
```

4. 新增 `generateCombinedResult`（工具循环 + 合成 finish + 末步强制）：

```ts
async function generateCombinedResult(
  skill: SkillTemplate,
  ctx: AgentContext,
  model: ResolvedModel,
  route: TaskRoute,
  messages: CoreMessage[],
  toolSet: ToolSet,
  schema: ZodSchema,
): Promise<GenerationResult> {
  let captured: unknown;
  const finishSet = synthesizeFinishTool(schema, (v) => { captured = v; });
  const tools = { ...toolSet, ...finishSet };
  const result = await generateText({
    model, tools, messages,
    maxTokens: skill.model?.maxTokens ?? route.maxTokens,
    temperature: skill.model?.temperature ?? route.temperature,
    maxSteps: ctx.budgetSnapshot.maxSteps,
    // 末步强制调 finish，杜绝"只读不交"：到达倒数第二步且尚未 finish 时锁定 toolChoice。
    experimental_prepareStep: async ({ stepNumber, maxSteps }) =>
      stepNumber >= maxSteps - 1 && captured === undefined
        ? { toolChoice: { type: 'tool', toolName: FINISH_TOOL_NAME } }
        : {},
    experimental_repairToolCall: async ({ toolCall, error }) => {
      if (!InvalidToolArgumentsError.isInstance(error)) return null;
      const repaired = repairToolCallArgs(toolCall.args);
      return repaired ? { ...toolCall, args: repaired } : null;
    },
  });
  if (captured === undefined) {
    // 兜底：模型把结构化结果写进了文本而非 finish 调用——尝试从 result.text 恢复。
    const recovered = recoverStructuredOutput({ text: result.text }, schema);
    if (!recovered) throw new Error(`${skill.name} did not call finish and text is not valid structured output`);
    captured = recovered.object;
  }
  return {
    output: captured,
    inputTokens: result.usage?.promptTokens ?? 0,
    outputTokens: result.usage?.completionTokens ?? 0,
    cacheHitTokens: readCacheHitTokens(result.providerMetadata),
  };
}
```

- [ ] **Step 5: 写组合路径失败测试**

在 `src/server/agents/runtime/__tests__/agent-loop.test.ts` 末尾追加（沿用文件顶部 `mocks.generateText` mock）：

```ts
describe('runAgentLoop 组合路径（tools + outputSchema）', () => {
  it('模型调 finish 即返回其入参为结构化输出', async () => {
    // 模拟 AI SDK：调用注入的 finish.execute 后返回文本/usage
    mocks.generateText.mockImplementationOnce(async (opts: any) => {
      await opts.tools.finish.execute({ title: 'Page', body: 'B' });
      return { text: '', usage: { promptTokens: 5, completionTokens: 7 }, providerMetadata: {} };
    });
    const skill = {
      id: 'writer', name: 'Writer', description: '', version: 1,
      tools: ['wiki.read'], canDispatch: [], systemPrompt: 'sys',
      outputSchema: z.object({ title: z.string(), body: z.string() }),
    } as SkillTemplate;
    const ctx = makeLoopCtx(); // 见下：含 toolRegistry.resolve / overlay / budget / emit
    const res = await runAgentLoop({ skill, ctx, input: { slug: 'page' } });
    expect(res.output).toEqual({ title: 'Page', body: 'B' });
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });
});
```

并在文件内补 `makeLoopCtx()` helper（构造满足 `runAgentLoop` 的最小 `AgentContext`：`toolRegistry: { resolve: () => [] }`、`overlay`、`budget`、`budgetSnapshot: { maxSteps: 6 }`、`emit: vi.fn()`、`cancelled: () => false`、`subject`、`parentRunId: null`）。

- [ ] **Step 6: 跑测试 + tsc 确认通过**

Run: `npx vitest run src/server/agents && npx tsc --noEmit`
Expected: PASS（compile 3 用例 + agent-loop 既有 + 组合路径新用例）；tsc 无错误

- [ ] **Step 7: 提交**

```bash
git add src/server/agents/tools/compile.ts src/server/agents/runtime/agent-loop.ts src/server/agents/tools/__tests__/compile.test.ts src/server/agents/runtime/__tests__/agent-loop.test.ts
git commit -m "feat(agents): submit-tool 组合路径——带 schema 的 skill 边调工具边产出结构化结果"
```

---

## Task 4: query 改用共享 registry + ToolContext（消灭内联孤岛）

> Ask AI 三工具不再内联 `tool()`；改为从 `createBuiltinToolRegistry()` resolve `wiki.read/search/list` + 共享 `compileToolSet(queryCtx)`。对外行为（答案、引用、空库守卫）不变。

**Files:**
- Modify: `src/server/services/query-tools.ts`（删 `buildQueryTools` 内联 tool()，新增 `buildQueryToolContext`；保留 `AccessedPages`/`createAccessedPages`/`subjectHasContent`/`accessedToContext`）、`src/server/services/query-service.ts`（用 registry + compileToolSet）
- Test: `src/server/services/__tests__/query-tools.test.ts`（改为测 `buildQueryToolContext`）

**Interfaces:**
- Consumes: `createBuiltinToolRegistry`（Task 2）、`compileToolSet`（Task 3）、`ToolContext`（Task 1）、`hybridRankSlugs`、`readPageInSubject`、`pagesRepo`。
- Produces:
  ```ts
  function buildQueryToolContext(subject: Subject, accessed: AccessedPages): ToolContext;
  // query-service 内部：
  const registry = createBuiltinToolRegistry();
  const toolDefs = registry.resolve(['wiki.read', 'wiki.search', 'wiki.list']);
  const tools = compileToolSet(toolDefs, buildQueryToolContext(subject, accessed));
  ```

- [ ] **Step 1: 写 buildQueryToolContext 失败测试**

更新 `src/server/services/__tests__/query-tools.test.ts`，对 `buildQueryToolContext` 加用例（保留既有 `subjectHasContent`/`accessedToContext` 用例）：

```ts
import { buildQueryToolContext, createAccessedPages } from '../query-tools';
// hybridRankSlugs / readPageInSubject / pagesRepo 按文件既有 vi.mock 方式 mock

describe('buildQueryToolContext', () => {
  it('readPage 命中写入 accessed.bodies', async () => {
    const accessed = createAccessedPages();
    const ctx = buildQueryToolContext({ id: 's1', slug: 'general' } as any, accessed);
    const out = await ctx.readPage('a'); // mock readPageInSubject 返回 body 'body-a'，pagesRepo 返回 title 'A'
    expect(out).toEqual({ title: 'A', markdown: 'body-a' });
    ctx.onAccess?.({ slug: 'a', title: 'A', body: 'body-a' });
    expect(accessed.bodies.get('a')).toEqual({ title: 'A', body: 'body-a' });
  });

  it('search 经 hybridRankSlugs 解析为 {slug,title,summary}', async () => {
    const ctx = buildQueryToolContext({ id: 's1', slug: 'general' } as any, createAccessedPages());
    const hits = await ctx.search('q', 8); // mock hybridRankSlugs 返回 ['a']
    expect(hits[0].slug).toBe('a');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/query-tools.test.ts`
Expected: FAIL（`buildQueryToolContext` 未导出）

- [ ] **Step 3: query-tools.ts 删内联工具、加 buildQueryToolContext**

`src/server/services/query-tools.ts`：删去 `buildQueryTools` 与 `import { tool } from 'ai'` / `CoreTool`；保留 `AccessedPages`/`createAccessedPages`/`subjectHasContent`/`accessedToContext`/`QueryContextPage`；新增：

```ts
import type { ToolContext } from '@/server/agents/tools/tool-context';

const LIST_PAGES_CAP = 200;
const SEARCH_LIMIT_DEFAULT = 8;

/** query 侧 ToolContext：读已提交正文、混合检索、列举全部（过滤 meta）；onAccess 累积引用。 */
export function buildQueryToolContext(subject: Subject, accessed: AccessedPages): ToolContext {
  return {
    subject,
    async readPage(slug) {
      const page = pagesRepo.getPageBySlug(subject.id, slug);
      const doc = readPageInSubject(subject.slug, slug);
      if (!page || !doc || doc.body.trim().length === 0) return null;
      return { title: page.title, markdown: doc.body };
    },
    async search(query, limit) {
      const slugs = await hybridRankSlugs(subject.id, query, limit ?? SEARCH_LIMIT_DEFAULT);
      const hits: Array<{ slug: string; title: string; summary: string }> = [];
      for (const slug of slugs) {
        const page = pagesRepo.getPageBySlug(subject.id, slug);
        if (!page || pagesRepo.isMetaPage(page)) continue;
        hits.push({ slug, title: page.title, summary: page.summary ?? '' });
      }
      return hits;
    },
    async listPages() {
      const all = pagesRepo
        .getAllPages(subject.id)
        .filter((p) => !pagesRepo.isMetaPage(p))
        .sort((a, b) => (a.updatedAt > b.updatedAt ? -1 : a.updatedAt < b.updatedAt ? 1 : 0));
      return all.slice(0, LIST_PAGES_CAP).map((p) => ({
        slug: p.slug, title: p.title, summary: p.summary ?? '', tags: (p.tags ?? []).filter((t) => t !== 'meta'),
      }));
    },
    onAccess({ slug, title, body }) {
      if (body !== undefined && body.trim().length > 0) accessed.bodies.set(slug, { title, body });
      else if (!accessed.bodies.has(slug)) accessed.meta.set(slug, { title, summary: '' });
    },
  };
}
```

> 行为对齐：`wiki.read` 命中带 body → `onAccess` 写 `bodies`（全文）；`wiki.search`/`wiki.list` 无 body → 写 `meta`。`accessedToContext` 逻辑不变，仍优先用 bodies 全文、meta 页按需补读。

- [ ] **Step 4: query-service.ts 用 registry + compileToolSet**

`src/server/services/query-service.ts`：把两处 `const tools = buildQueryTools(subject, accessed)` 改为：

```ts
import { createBuiltinToolRegistry } from '@/server/agents/tools/builtin';
import { compileToolSet } from '@/server/agents/tools/compile';
import { buildQueryToolContext } from './query-tools';

// 模块级（无状态，构造一次即可复用）：
const queryToolDefs = createBuiltinToolRegistry().resolve(['wiki.read', 'wiki.search', 'wiki.list']);
// streamAgenticQuery / runQuery 内：
const tools = compileToolSet(queryToolDefs, buildQueryToolContext(subject, accessed));
```

（删除 `buildQueryTools` 的 import。）

- [ ] **Step 5: 跑相关测试 + tsc**

Run: `npx vitest run src/server/services/__tests__/query-tools.test.ts src/server/services/__tests__/query-service-agentic.test.ts && npx tsc --noEmit`
Expected: PASS（query-tools 改后用例 + agentic 既有用例：答案/引用/空库守卫行为不变）；tsc 无错误

- [ ] **Step 6: 提交**

```bash
git add src/server/services/query-tools.ts src/server/services/query-service.ts src/server/services/__tests__/query-tools.test.ts
git commit -m "refactor(query): Ask AI 工具改用共享 registry + ToolContext，删除内联 tool() 孤岛"
```

---

## Task 5: 全量回归 + 文档与 re-seed 收尾

**Files:**
- Modify: `CLAUDE.md`（Changelog 加一行）、`src/server/agents/CLAUDE.md`（tools 小节 vault.*→wiki.*、加 ToolContext/compile/组合路径说明）、`src/server/services/CLAUDE.md`（query-tools 段更新）

- [ ] **Step 1: 全量测试 + 类型检查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿（关注 agents / services / 既有 query 相关用例）

- [ ] **Step 2: 本地 re-seed 验证 ingest 工具真在跑（人工）**

```bash
rm -f data/vault/.llm-wiki/skills/ingest-planner.md data/vault/.llm-wiki/skills/ingest-writer.md
npm run dev:all
```

投喂一篇资料触发 ingest，确认 SSE/worker 日志出现 `Writer called wiki.search` / `wiki.read` 的 `agent:step` 工具调用事件，且页面正常落库（验证组合路径 finish 收尾、Saga 提交未受影响）。

- [ ] **Step 3: 更新文档**

- 根 `CLAUDE.md` Changelog 加：`2026-06-25 | 工具体系收敛 | ToolDef 统一吃 ToolContext；vault.*→wiki.read/search/list 单一定义；submit 合成 finish 工具让 planner/writer 边调工具边产出结构化输出；query 改用共享 registry，删内联 tool() 孤岛；保留双 runner。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-25-tool-system-convergence*`
- `src/server/agents/CLAUDE.md`：`tools/` 小节把 `vault-read/vault-search` 换成 `wiki-read/wiki-search/wiki-list`，新增 `tool-context.ts` / `compile.ts`；执行边界小节说明"有 tools + 有 schema → 组合路径（finish 收尾）"。
- `src/server/services/CLAUDE.md`：query-tools 段 `list_pages/search_wiki/read_page` 更新为"经共享 registry 的 wiki.read/search/list + buildQueryToolContext"。

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md src/server/agents/CLAUDE.md src/server/services/CLAUDE.md
git commit -m "docs: 记录工具体系收敛（ToolContext/wiki.* 统一/submit-tool/双 runner）"
```

---

## Self-Review

**1. Spec coverage（逐条对 spec）**
- D1 复活 ingest 工具 → Task 2（声明）+ Task 3（执行）✅
- D2 submit 合成工具收尾 → Task 3 `synthesizeFinishTool` + `generateCombinedResult` + `experimental_prepareStep` 末步强制 ✅
- D3 wiki.read/search/list 单一定义 + 差异下沉 ToolContext → Task 1（ToolContext）+ Task 2（工具）+ Task 4（query ctx）✅
- D4 保留双 runner、仅共享工具模型 → Task 4（query 仍走 streamTextWithTools，仅工具来源改共享）✅
- D5 纯结构化 skill 保留 generateObject → Task 3 分支 `skill.outputSchema && !hasTools → generateStructuredResult` ✅
- ToolRegistry 进程无关化 → Task 2 `createBuiltinToolRegistry()` + worker-entry + Task 4 query 各自构造 ✅
- 错误降级（工具内 error 不抛 / finish 兜底 / 空库守卫 / 向量降级）→ wiki 工具 handler 与 query ctx 保留既有语义 + Task 3 finish 兜底 recoverStructuredOutput ✅
- 测试矩阵 → Task 1/2/3/4 各自 TDD 用例 + Task 5 全量 ✅
- re-seed → Task 5 Step 2 ✅

**2. Placeholder scan**：无 TBD/TODO；代码步骤均给完整代码或精确编辑点。

**3. Type consistency**：`ToolContext`（readPage/search/listPages/onAccess/emit/agent）在 Task 1 定义，Task 2/3/4 一致引用；`compileToolSet(toolDefs, ctx, opts?)` 与 `synthesizeFinishTool(schema, capture)` 在 Task 3 定义、Task 4 调用签名一致；`createBuiltinToolRegistry()` 在 Task 2 定义、Task 4 调用一致；`FINISH_TOOL_NAME` 常量贯穿 Task 3。
