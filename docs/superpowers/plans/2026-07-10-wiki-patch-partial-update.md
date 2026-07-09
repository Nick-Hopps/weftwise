# wiki.patch 局部更新工具 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `wiki.patch` 工具（old_string/new_string 精确唯一匹配、`edits[]` 批量、全成或全败），让 fix 与 Ask AI 两个 runner 能局部修改页面正文，无需整页重写。

**Architecture:** 内核 `executePagePatch`（page-ops.ts）确定性拼接新正文后委托现有 `executePageUpdate` 走 Saga；服务层 `patchPageInSubject`（page-write.ts）加 META 保护 + embed 回填；工具层新增 `wiki.patch` builtin + `ToolContext.patchPage?`，注入 fix-tools 与 query-tools，系统提示指导优先 patch。**不接忠实度护栏**（确定性拼接无漏抄风险）。

**Tech Stack:** TypeScript / zod / vitest。Spec：`docs/superpowers/specs/2026-07-10-wiki-patch-partial-update-design.md`

## Global Constraints

- 中文注释/commit message，commit 一句话总结，禁止 AI 署名 trailer。
- `npm run lint` 不可用；验证用 `npx tsc --noEmit` + `npx vitest run <files>`。
- IDE 诊断 feed 不可靠（幻影错误），以 tsc/vitest 退出码为准。
- patch 只作用于 body；frontmatter/title/tags/summary 一律走 `wiki.update`。

---

### Task 1: 内核 `executePagePatch`

**Files:**
- Modify: `src/server/wiki/page-ops.ts`（文件末尾追加）
- Test: `src/server/wiki/__tests__/page-ops-patch.test.ts`

**Interfaces:**
- Consumes: 同文件既有 `executePageUpdate(jobId, subject, { slug, body })`、`readPageInSubject`。
- Produces: `executePagePatch(jobId: string, subject: Subject, params: { slug: string; edits: Array<{ oldString: string; newString: string }> }): Promise<{ updatedSlug: string; appliedEdits: number }>`；纯函数 `applyPatchEdits(body: string, edits: Array<{ oldString: string; newString: string }>): string`（导出，供单测直测）。

- [ ] **Step 1: 写失败测试**

先看 `src/server/wiki/__tests__/page-ops-update.test.ts`（若存在）或 `page-ops-create-delete.test.ts` 的测试骨架（临时 vault + SQLite 的搭建方式），照抄其 setup。纯函数部分直接测：

```ts
import { describe, it, expect } from 'vitest';
import { applyPatchEdits } from '../page-ops';

describe('applyPatchEdits', () => {
  const body = '# A\n\nfoo bar baz\n\n## B\n\nqux quux\n';

  it('单处替换', () => {
    expect(applyPatchEdits(body, [{ oldString: 'foo bar baz', newString: 'foo BAR baz' }]))
      .toBe('# A\n\nfoo BAR baz\n\n## B\n\nqux quux\n');
  });

  it('多组顺序替换，后一组可匹配前一组产物', () => {
    const out = applyPatchEdits(body, [
      { oldString: 'qux quux', newString: 'qux NEW quux' },
      { oldString: 'NEW quux', newString: 'NEW2 quux' },
    ]);
    expect(out).toContain('qux NEW2 quux');
  });

  it('0 匹配抛错并带序号', () => {
    expect(() => applyPatchEdits(body, [{ oldString: 'nope', newString: 'x' }]))
      .toThrow(/edit #1: old_string not found/);
  });

  it('多处匹配抛错并带出现次数', () => {
    expect(() => applyPatchEdits(body, [{ oldString: 'qu', newString: 'x' }]))
      .toThrow(/edit #1: old_string matches \d+ locations/);
  });

  it('空 oldString 拒绝', () => {
    expect(() => applyPatchEdits(body, [{ oldString: '', newString: 'x' }]))
      .toThrow(/edit #1: old_string must not be empty/);
  });

  it('old === new 拒绝', () => {
    expect(() => applyPatchEdits(body, [{ oldString: 'foo', newString: 'foo' }]))
      .toThrow(/edit #1: old_string and new_string are identical/);
  });

  it('空 edits 拒绝', () => {
    expect(() => applyPatchEdits(body, [])).toThrow(/at least one edit/);
  });
});
```

`executePagePatch` 的集成行为（委托 update 走 Saga、坏链拒绝、失败页面不变）用与 `page-ops-update.test.ts` 同款的临时 vault 骨架补 3 个用例：
1. patch 成功 → 读回页面正文含替换产物，frontmatter title 未变；
2. patch 引入 `[[Ghost Page]]` 坏链 → 抛 `unresolved wikilink`，页面正文与 patch 前一致（原子性）；
3. 页不存在 → 抛 `page "x" not found`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/wiki/__tests__/page-ops-patch.test.ts`
Expected: FAIL（`applyPatchEdits` 未导出）。

- [ ] **Step 3: 实现**

在 `src/server/wiki/page-ops.ts` 末尾追加：

```ts
/**
 * 纯函数：按顺序应用 old_string/new_string 精确替换。
 * 每个 oldString 必须在「应用前序 edits 后的当前正文」中恰好出现一次；
 * 任一组失败整批抛错（调用方不落盘）。仿 Claude Code Edit 工具语义。
 */
export function applyPatchEdits(
  body: string,
  edits: Array<{ oldString: string; newString: string }>,
): string {
  if (edits.length === 0) throw new Error('patch requires at least one edit');
  let current = body;
  edits.forEach((edit, i) => {
    const n = i + 1;
    if (!edit.oldString) throw new Error(`edit #${n}: old_string must not be empty`);
    if (edit.oldString === edit.newString) {
      throw new Error(`edit #${n}: old_string and new_string are identical`);
    }
    const first = current.indexOf(edit.oldString);
    if (first === -1) {
      throw new Error(`edit #${n}: old_string not found — quote the page text verbatim`);
    }
    let count = 0;
    for (let at = first; at !== -1; at = current.indexOf(edit.oldString, at + 1)) count++;
    if (count > 1) {
      throw new Error(`edit #${n}: old_string matches ${count} locations — include more surrounding context`);
    }
    current = current.slice(0, first) + edit.newString + current.slice(first + edit.oldString.length);
  });
  return current;
}

/**
 * 局部更新一页正文：edits 逐组精确唯一替换（applyPatchEdits），拼出完整新正文后
 * 委托 executePageUpdate 走 Saga——坏链校验/unresolved-wikilink 拒绝/updated 时间戳
 * /单 git commit 全部继承。只动 body；title/tags/summary 走 executePageUpdate。
 */
export async function executePagePatch(
  jobId: string,
  subject: Subject,
  params: { slug: string; edits: Array<{ oldString: string; newString: string }> },
): Promise<{ updatedSlug: string; appliedEdits: number }> {
  const doc = readPageInSubject(subject.slug, params.slug);
  if (!doc) throw new Error(`page "${params.slug}" not found`);
  const newBody = applyPatchEdits(doc.body, params.edits);
  const { updatedSlug } = await executePageUpdate(jobId, subject, { slug: params.slug, body: newBody });
  return { updatedSlug, appliedEdits: params.edits.length };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/wiki/__tests__/page-ops-patch.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/wiki/page-ops.ts src/server/wiki/__tests__/page-ops-patch.test.ts
git commit -m "feat: page-ops 新增 executePagePatch/applyPatchEdits 局部更新内核"
```

---

### Task 2: 服务层 `patchPageInSubject`

**Files:**
- Modify: `src/server/services/page-write.ts`
- Test: `src/server/services/__tests__/page-write-patch.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `executePagePatch`；同文件既有 `META_PAGE_SLUGS`、`enqueueEmbedIndex`。
- Produces: `patchPageInSubject(subject: Subject, input: { slug: string; edits: Array<{ oldString: string; newString: string }> }): Promise<{ updatedSlug: string; appliedEdits: number }>`。

- [ ] **Step 1: 写失败测试**

参考 `src/server/services/__tests__/` 里现有 page-write / fix-tools 测试的 mock 方式（vi.mock 掉 page-ops 与 embedding-service）：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../wiki/page-ops', () => ({
  executePagePatch: vi.fn(async () => ({ updatedSlug: 'foo', appliedEdits: 1 })),
}));
vi.mock('../embedding-service', () => ({ enqueueEmbedIndex: vi.fn() }));

import { patchPageInSubject } from '../page-write';
import { executePagePatch } from '../../wiki/page-ops';
import { enqueueEmbedIndex } from '../embedding-service';

const subject = { id: 'sub1', slug: 'general', name: 'General' } as never;

beforeEach(() => vi.clearAllMocks());

describe('patchPageInSubject', () => {
  it('META 保护页拒绝，不触内核', async () => {
    await expect(patchPageInSubject(subject, { slug: 'index', edits: [{ oldString: 'a', newString: 'b' }] }))
      .rejects.toThrow(/protected system page/);
    expect(executePagePatch).not.toHaveBeenCalled();
  });

  it('成功路径：调内核 + enqueue embed', async () => {
    const res = await patchPageInSubject(subject, { slug: 'foo', edits: [{ oldString: 'a', newString: 'b' }] });
    expect(res).toEqual({ updatedSlug: 'foo', appliedEdits: 1 });
    expect(enqueueEmbedIndex).toHaveBeenCalledWith('sub1', ['foo']);
  });

  it('内核抛错透传', async () => {
    vi.mocked(executePagePatch).mockRejectedValueOnce(new Error('edit #1: old_string not found'));
    await expect(patchPageInSubject(subject, { slug: 'foo', edits: [{ oldString: 'x', newString: 'y' }] }))
      .rejects.toThrow(/not found/);
    expect(enqueueEmbedIndex).not.toHaveBeenCalled();
  });
});
```

注意：先核对 `enqueueEmbedIndex` 实际签名（`updatePageInSubject` 里是 `enqueueEmbedIndex(subject.id)` 单参）——**以现有 `updatePageInSubject` 的调用形式为准**，测试断言跟着改。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/page-write-patch.test.ts`
Expected: FAIL（`patchPageInSubject` 未导出）。

- [ ] **Step 3: 实现**

在 `page-write.ts` 的 `updatePageInSubject` 之后追加（import 行补 `executePagePatch`）：

```ts
/**
 * 局部更新一页正文（对话/fix 工具路径包装）：META 保护页拒绝后委托 executePagePatch
 * （edits 精确唯一替换 + Saga）+ 触发向量回填。
 * 刻意不接忠实度护栏：patch 是确定性拼接，未被 edits 提到的内容不可能变；
 * unresolved-wikilink 校验由内核委托的 executePageUpdate 继承（新增链接必须可解析）。
 */
export async function patchPageInSubject(
  subject: Subject,
  input: { slug: string; edits: Array<{ oldString: string; newString: string }> },
): Promise<{ updatedSlug: string; appliedEdits: number }> {
  if (META_PAGE_SLUGS.has(input.slug)) {
    throw new Error(`Cannot update protected system page "${input.slug}".`);
  }
  const result = await executePagePatch(crypto.randomUUID(), subject, input);
  enqueueEmbedIndex(subject.id);
  return result;
}
```

（若现有 `updatePageInSubject` 的 `enqueueEmbedIndex` 是单参调用，这里保持一致，并同步修 Step 1 测试断言为 `toHaveBeenCalledWith('sub1')`。）

**实现期确认点（spec §2）**：跑 Task 1 的集成用例确认「patch 删掉一个已断链的 wikilink」不会被 `executePageUpdate` 的 unresolved 检查误拦——该检查只扫**新正文**里残留的坏链，删除坏链天然通过，无需注入 `collectBrokenLinkTargets` 豁免。若实测被拦（说明理解有误），则给 `executePagePatch` 增加与 `updatePageInSubject` 同款豁免注入并补用例。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/services/__tests__/page-write-patch.test.ts src/server/wiki/__tests__/page-ops-patch.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/services/page-write.ts src/server/services/__tests__/page-write-patch.test.ts
git commit -m "feat: page-write 新增 patchPageInSubject 局部更新包装（META 保护 + embed 回填）"
```

---

### Task 3: `wiki.patch` builtin 工具 + ToolContext 能力

**Files:**
- Create: `src/server/agents/tools/builtin/wiki-patch.ts`
- Modify: `src/server/agents/tools/tool-context.ts`（`ToolContext` 加 `patchPage?`）
- Modify: `src/server/agents/tools/builtin/index.ts`（注册）
- Test: `src/server/agents/tools/builtin/__tests__/wiki-patch.test.ts`

**Interfaces:**
- Consumes: `ToolDef`（`../../types`）、`ToolContext`。
- Produces: `wikiPatchTool: ToolDef`（`name: 'wiki.patch'`, `sideEffect: 'update'`）；`ToolContext.patchPage?(input: { slug: string; edits: Array<{ oldString: string; newString: string }> }): Promise<{ updatedSlug: string; appliedEdits: number }>`。

- [ ] **Step 1: 写失败测试**（仿 `__tests__/wiki-update.test.ts` 的 ctx 构造 helper）

```ts
import { describe, it, expect, vi } from 'vitest';
import { wikiPatchTool } from '../wiki-patch';
import type { ToolContext } from '../../tool-context';

const ctx = (extra: Partial<ToolContext> = {}): ToolContext =>
  ({ subject: { id: 's', slug: 'general', name: 'G' }, readPage: vi.fn(), search: vi.fn(), listPages: vi.fn(), ...extra }) as never;

describe('wiki.patch tool', () => {
  const edits = [{ oldString: 'a', newString: 'b' }];

  it('注入 patchPage → ok:true 返回 updatedSlug/appliedEdits', async () => {
    const patchPage = vi.fn(async () => ({ updatedSlug: 'eigen', appliedEdits: 2 }));
    const res = await wikiPatchTool.handler({ slug: 'eigen', edits }, ctx({ patchPage }));
    expect(res).toMatchObject({ ok: true, updatedSlug: 'eigen', appliedEdits: 2 });
    expect(patchPage).toHaveBeenCalledWith({ slug: 'eigen', edits });
  });

  it('ctx 缺 patchPage → ok:false 优雅报错', async () => {
    const res = await wikiPatchTool.handler({ slug: 'eigen', edits }, ctx());
    expect(res.ok).toBe(false);
  });

  it('patchPage 抛错 → ok:false 透传消息', async () => {
    const patchPage = vi.fn(async () => { throw new Error('edit #1: old_string not found'); });
    const res = await wikiPatchTool.handler({ slug: 'eigen', edits }, ctx({ patchPage }));
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not found');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-patch.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

`src/server/agents/tools/builtin/wiki-patch.ts`（结构仿 `wiki-update.ts`）：

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const EditSchema = z.object({
  oldString: z.string().min(1).describe('Exact text that currently exists in the page body, verbatim — not a paraphrase. Must match exactly one location; include surrounding context to disambiguate.'),
  newString: z.string().describe('Replacement text. Empty string deletes the matched text.'),
});
const InputSchema = z.object({
  slug: z.string().trim().min(1),
  edits: z.array(EditSchema).min(1).describe('Applied in order; ALL must match or NOTHING is applied (one git commit).'),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  updatedSlug: z.string().nullable(),
  appliedEdits: z.number().nullable(),
  message: z.string(),
});

export const wikiPatchTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.patch',
  source: 'builtin',
  description:
    'Make targeted partial edits to the BODY of an EXISTING wiki page in the current subject. This CHANGES the wiki. ' +
    'Prefer this over wiki.update for small corrections — you only provide the fragments to change, so untouched content cannot be altered. ' +
    'Each oldString must be quoted verbatim from the page (read it first) and match exactly once. ' +
    'Cannot change the title, tags or summary — use wiki.update for those, or for full rewrites. ' +
    'Only use [[Page Title]] wikilinks to pages that already exist; a broken link causes the WHOLE batch to be REJECTED (nothing applied).',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'update',
  async handler(input, ctx) {
    if (!ctx.patchPage) {
      return { ok: false, updatedSlug: null, appliedEdits: null, message: 'Patching a page is not available in this context.' };
    }
    try {
      const { updatedSlug, appliedEdits } = await ctx.patchPage(input);
      return { ok: true, updatedSlug, appliedEdits, message: `Patched "${updatedSlug}" (${appliedEdits} edit${appliedEdits === 1 ? '' : 's'}).` };
    } catch (err) {
      return { ok: false, updatedSlug: null, appliedEdits: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

`tool-context.ts` 在 `updatePage?` 之后加：

```ts
  /** 局部更新一页正文（edits 精确唯一替换，Saga）；fix runner 与 query runner 均注入。 */
  patchPage?(input: { slug: string; edits: Array<{ oldString: string; newString: string }> }):
    Promise<{ updatedSlug: string; appliedEdits: number }>;
```

`builtin/index.ts` 加 `import { wikiPatchTool } from './wiki-patch';` 与 `r.register(wikiPatchTool as ToolDef);`（放在 `wikiUpdateTool` 注册行之后）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-patch.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/agents/tools/builtin/wiki-patch.ts src/server/agents/tools/builtin/index.ts src/server/agents/tools/tool-context.ts src/server/agents/tools/builtin/__tests__/wiki-patch.test.ts
git commit -m "feat: 新增 wiki.patch builtin 工具与 ToolContext.patchPage 能力"
```

---

### Task 4: 注入 fix + query 两个 runner + 系统提示 + 活动映射

**Files:**
- Modify: `src/server/services/fix-tools.ts`（注入 `patchPage`，经 guard）
- Modify: `src/server/services/fix-service.ts`（`fixToolDefs` resolve 列表加 `'wiki.patch'`）
- Modify: `src/server/services/query-tools.ts`（注入 `patchPage` → `patchPageInSubject`）
- Modify: `src/server/services/query-service.ts:50`（`BASE_QUERY_TOOL_NAMES` 加 `'wiki.patch'`）
- Modify: `src/server/llm/prompts/fix-prompt.ts`（工具说明加 `wiki_patch`，指导优先用）
- Modify: `src/server/llm/prompts/query-prompt.ts`（同上 + "Updating a page" 纪律覆盖 patch）
- Modify: `src/lib/tool-activity.ts`（`wiki_patch` 映射）
- Test: 复用/扩展 `src/server/services/__tests__/fix-tools.test.ts`

**Interfaces:**
- Consumes: Task 2 `patchPageInSubject`、Task 1 `executePagePatch`、Task 3 `wiki.patch` 工具与 `ToolContext.patchPage`。
- Produces: 无新导出；两个 runner 的工具集各多一个 `wiki_patch`。

- [ ] **Step 1: 写失败测试**（`fix-tools.test.ts` 追加用例；mock 方式沿用该文件现状）

```ts
it('patchPage：guard 写 cap 拒绝时不触内核', async () => {
  // 构造 canWrite() 返回 {ok:false, reason:'write cap reached'} 的 guard（沿用文件里现有 guard stub 写法）
  const toolCtx = buildFixToolContext(subject, { guard: deniedGuard, jobId: 'j', emit });
  await expect(toolCtx.patchPage!({ slug: 'foo', edits: [{ oldString: 'a', newString: 'b' }] }))
    .rejects.toThrow(/cap/);
});

it('patchPage：允许时调 executePagePatch 并 record/emit', async () => {
  const toolCtx = buildFixToolContext(subject, { guard: allowGuard, jobId: 'j', emit });
  const res = await toolCtx.patchPage!({ slug: 'foo', edits: [{ oldString: 'a', newString: 'b' }] });
  expect(res.updatedSlug).toBe('foo');
  expect(allowGuard.record).toHaveBeenCalledWith('update');
});
```

（`executePagePatch` 用 `vi.mock('../../wiki/page-ops', ...)` 打桩，与该文件现有 `executePageUpdate` mock 并列。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/fix-tools.test.ts`
Expected: 新用例 FAIL（`patchPage` undefined）。

- [ ] **Step 3: 实现四处注入**

`fix-tools.ts` 的返回对象加（import 补 `executePagePatch`）——guard/保护页与 `updatePage` 同款，**不做忠实度检查**（确定性拼接；坏链由内核拒绝）：

```ts
    async patchPage(input) {
      const cap = guard.canWrite();
      if (!cap.ok) { emit('fix:skip', `Skip patch ${input.slug}: ${cap.reason}`, { slug: input.slug, reason: cap.reason }); throw new Error(cap.reason); }
      const prot = guard.canEditPage(input.slug);
      if (!prot.ok) { emit('fix:skip', `Skip patch ${input.slug}: ${prot.reason}`, { slug: input.slug, reason: prot.reason }); throw new Error(prot.reason); }
      const res = await executePagePatch(jobId, subject, input);
      guard.record('update');
      emit('fix:page', `Patched "${res.updatedSlug}" (${res.appliedEdits} edits).`, { slug: res.updatedSlug });
      return res;
    },
```

`fix-service.ts:34` 的 `createBuiltinToolRegistry().resolve([...])` 列表加 `'wiki.patch'`。

`query-tools.ts` 在 `updatePage` 旁加（import 补 `patchPageInSubject`）：

```ts
    async patchPage(input) {
      return patchPageInSubject(subject, input);
    },
```

`query-service.ts:50`：`BASE_QUERY_TOOL_NAMES` 数组加 `'wiki.patch'`（放 `'wiki.update'` 之后）。

`fix-prompt.ts` 工具说明段在 `wiki_update` 行后加：

```
- \`wiki_patch\`: make targeted partial edits to a page body via exact old/new string replacement. PREFER this over \`wiki_update\` when fixing a specific broken link, sentence or paragraph — quote the old text verbatim from the page you just read.
```

`query-prompt.ts`：工具清单（约 155 行 `wiki_update` 之后）加同风格一行；"Updating a page" 一节改为同时覆盖 `wiki_update` / `wiki_patch`（确认纪律相同：须后续轮确认，禁同轮），并注明「正文局部小改优先 `wiki_patch`；改标题/整页重写/改 tags 用 `wiki_update`」。

`lib/tool-activity.ts` 三处 switch/if 各加 `wiki_patch`：icon `'✏️'`、动词 `'Patching'`、subject 提取 `if (tool === 'wiki_patch') return typeof a.slug === 'string' ? a.slug : '';`。

- [ ] **Step 4: 验证**

Run: `npx vitest run src/server/services/__tests__/fix-tools.test.ts && npx tsc --noEmit`
Expected: PASS + tsc 退出码 0。

- [ ] **Step 5: Commit**

```bash
git add src/server/services/fix-tools.ts src/server/services/fix-service.ts src/server/services/query-tools.ts src/server/services/query-service.ts src/server/llm/prompts/fix-prompt.ts src/server/llm/prompts/query-prompt.ts src/lib/tool-activity.ts src/server/services/__tests__/fix-tools.test.ts
git commit -m "feat: wiki.patch 接入 fix 与 Ask AI 两个 runner（提示指导局部小改优先 patch）"
```

---

### Task 5: 全量验证 + 文档同步

**Files:**
- Modify: `CLAUDE.md`（根，Changelog 加一行）
- Modify: `src/server/agents/CLAUDE.md`（builtin 清单 + ToolContext 描述 + Changelog）
- Modify: `src/server/wiki/CLAUDE.md`（page-ops 导出行 + Changelog）
- Modify: `src/server/services/CLAUDE.md`（page-write/fix-tools 描述 + Changelog）

- [ ] **Step 1: 全量测试 + 类型检查**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全部 PASS、tsc 退出码 0。任何失败先修再继续。

- [ ] **Step 2: 文档同步**

四个 CLAUDE.md 各加一行（格式仿既有条目，日期 2026-07-10）：核心事实 = 新增 `wiki.patch`（old_string/new_string 精确唯一匹配、edits[] 全成或全败、委托 `executePageUpdate` 继承 Saga/坏链拒绝、**不接忠实度护栏**）+ `executePagePatch`/`applyPatchEdits`/`patchPageInSubject`/`ToolContext.patchPage` + 注入 fix/query 两 runner + prompt 指导优先 patch。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md src/server/agents/CLAUDE.md src/server/wiki/CLAUDE.md src/server/services/CLAUDE.md
git commit -m "docs: wiki.patch 局部更新工具落地，同步四份模块文档"
```
