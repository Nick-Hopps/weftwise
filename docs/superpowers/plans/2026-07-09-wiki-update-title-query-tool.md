# wiki_update 支持改标题 + 接入问答工具集 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `wiki_update` 工具支持同时改标题和正文（改标题联动重写全 subject 内引用），并把这个能力接入问答（Ask AI）工具循环——目前只有 fix 能用。

**Architecture:** 在现有 `executePageUpdate` 内核（`src/server/wiki/page-ops.ts`）上加 `title?` 参数 + relink 联动；`ToolContext.updatePage` 签名同步扩展；新增 `page-write.ts::updatePageInSubject`（问答侧写路径包装：忠实度护栏 + 向量回填，对齐 `deletePageInSubject`/`createPageInSubject` 已有模式）；`query-tools.ts` 接入 + `query-service.ts` 工具清单追加；`query-prompt.ts` 补确认纪律。全程复用现有模式，不引入新抽象。

**Tech Stack:** TypeScript, Vitest, Zod（AI SDK 工具 schema）, Drizzle/SQLite（间接，via pagesRepo）。

## Global Constraints

- `body` 保持必填（全量替换语义不变，不支持"只传 diff"）；`title` 为新增可选字段。
- 改标题不做"新标题与本 subject 内其他页标题重名"的唯一性校验——`PUT /api/pages` 现有人工编辑路径本身也没有这个校验，保持一致，不新增更严格约束。
- 问答侧的忠实度护栏复用 `FIDELITY_PROFILES.fix`（正文不得缩水到原文 80% 以下、不得丢失原有 wikilink），不新建更宽松的 query 专属 profile（已与用户确认）。
- 问答侧调用 `wiki_update` 前必须在后续轮次经用户确认才能执行，不能同轮调用（与 `wiki_delete` 纪律一致，已与用户确认）。
- 不涉及 curate/ingest（`curate-tools.ts`、`agents/tools/tool-context.ts::agentToolContext` 均不注入 `updatePage`，本次不改）。
- 不涉及数据库 schema 改动。
- spec: `docs/superpowers/specs/2026-07-09-wiki-update-title-query-tool-design.md`

---

### Task 1: 内核扩展 — `executePageUpdate` 支持改标题 + relink

**Files:**
- Modify: `src/server/wiki/page-ops.ts:12`（import 行）
- Modify: `src/server/wiki/page-ops.ts:237-276`（`executePageUpdate` 函数体）
- Test: `src/server/wiki/__tests__/page-ops-update.test.ts`（整份重写）

**Interfaces:**
- Produces: `executePageUpdate(jobId: string, subject: Subject, params: { slug: string; title?: string; body: string; summary?: string; tags?: string[] }): Promise<{ updatedSlug: string; referencesUpdated: number }>`（`referencesUpdated` 无标题变化时恒为 0）。后续所有任务（Task 2/3）都依赖这个新签名和新返回字段。

- [ ] **Step 1: 改 import 行，补 `rewriteBacklinkText`**

当前 `src/server/wiki/page-ops.ts:12`：
```ts
import { repointLinksToPage } from './relink';
```
改为：
```ts
import { repointLinksToPage, rewriteBacklinkText } from './relink';
```

- [ ] **Step 2: 改写测试文件（先写"应该失败"的新测试）**

用下面内容整份替换 `src/server/wiki/__tests__/page-ops-update.test.ts`：

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
  readPageInSubject: vi.fn((_subjectSlug: string, _slug: string) => ({
    frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
    body: 'original body',
  })),
}));
vi.mock('../wiki-store', () => storeMocks);

const repoMocks = vi.hoisted(() => ({
  getBacklinks: vi.fn(() => [] as Array<{ subjectId: string; slug: string }>),
  getAllPages: vi.fn(() => [] as Array<{ slug: string }>),
  getTitleToSlugMap: vi.fn(() => new Map()),
}));
vi.mock('../../db/repos/pages-repo', () => repoMocks);

// 中和 import-time 重依赖（page-ops 顶层为 merge/split 引入，update 不调用）
vi.mock('../../llm/provider-registry', () => ({ generateStructuredOutput: vi.fn() }));
vi.mock('../../db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));

import { executePageUpdate } from '../page-ops';

const subject = { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as never;

describe('executePageUpdate', () => {
  beforeEach(() => {
    txMocks.applyChangeset.mockClear();
    txMocks.validateChangeset.mockReturnValue({ valid: true, errors: [], warnings: [] });
    repoMocks.getBacklinks.mockReset();
    repoMocks.getBacklinks.mockReturnValue([]);
    storeMocks.readPageInSubject.mockReset();
    storeMocks.readPageInSubject.mockImplementation(() => ({
      frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
      body: 'original body',
    }));
  });

  it('保留 title/created、替换正文、覆盖 tags 并 apply（不传 title = 行为不变）', async () => {
    const out = await executePageUpdate('j1', subject, { slug: 'eigenvalue', body: 'new body', summary: 's', tags: ['linear-algebra'] });
    expect(out.updatedSlug).toBe('eigenvalue');
    expect(out.referencesUpdated).toBe(0);
    expect(repoMocks.getBacklinks).not.toHaveBeenCalled(); // 标题未变，不查 backlinks
    expect(txMocks.applyChangeset).toHaveBeenCalledOnce();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (txMocks.applyChangeset.mock.calls[0] as any)[0] as { entries: Array<{ action: string; path: string; content: string }> };
    expect(cs.entries).toHaveLength(1);
    expect(cs.entries[0].action).toBe('update');
    expect(cs.entries[0].path).toBe('wiki/general/eigenvalue.md');
    expect(cs.entries[0].content).toContain('title: Eigenvalue'); // 保留原标题
    expect(cs.entries[0].content).toContain('new body');           // 换了正文
    expect(cs.entries[0].content).toContain('linear-algebra');      // 覆盖 tags
    expect(cs.entries[0].content).toContain('2020-01-01'); // 保留原 created 时间戳
  });

  it('传同名 title（未变化）→ referencesUpdated=0，不查 backlinks', async () => {
    const out = await executePageUpdate('j1', subject, { slug: 'eigenvalue', title: 'Eigenvalue', body: 'new body' });
    expect(out.referencesUpdated).toBe(0);
    expect(repoMocks.getBacklinks).not.toHaveBeenCalled();
  });

  it('改标题：联动重写本 subject 内引用旧标题的其他页，计入 referencesUpdated', async () => {
    storeMocks.readPageInSubject.mockImplementation((_subjectSlug: string, slug: string) => {
      if (slug === 'eigenvalue') {
        return {
          frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
          body: 'original body',
        };
      }
      if (slug === 'linear-algebra-notes') {
        return {
          frontmatter: { title: 'Linear Algebra Notes', created: '2021-01-01T00:00:00.000Z', updated: '2021-01-01T00:00:00.000Z', tags: [], sources: [] },
          body: 'See [[Eigenvalue]] for details.',
        };
      }
      return null;
    });
    repoMocks.getBacklinks.mockReturnValue([{ subjectId: 's1', slug: 'linear-algebra-notes' }]);

    const out = await executePageUpdate('j1', subject, { slug: 'eigenvalue', title: 'Eigen Value', body: 'new body' });

    expect(out.updatedSlug).toBe('eigenvalue');
    expect(out.referencesUpdated).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (txMocks.applyChangeset.mock.calls[0] as any)[0] as { entries: Array<{ action: string; path: string; content: string }> };
    expect(cs.entries).toHaveLength(2);
    const selfEntry = cs.entries.find((e) => e.path === 'wiki/general/eigenvalue.md');
    expect(selfEntry?.content).toContain('title: Eigen Value');
    const backlinkEntry = cs.entries.find((e) => e.path === 'wiki/general/linear-algebra-notes.md');
    expect(backlinkEntry?.content).toContain('[[Eigen Value]]');
    expect(backlinkEntry?.content).not.toContain('[[Eigenvalue]]');
  });

  it('改标题：自引用（backlinks 含自身 slug）不被重复处理', async () => {
    storeMocks.readPageInSubject.mockImplementation((_subjectSlug: string, slug: string) => {
      if (slug === 'eigenvalue') {
        return {
          frontmatter: { title: 'Eigenvalue', created: '2020-01-01T00:00:00.000Z', updated: '2020-01-01T00:00:00.000Z', tags: ['math'], sources: [] },
          body: 'See also [[Eigenvalue]] intro section.',
        };
      }
      return null;
    });
    repoMocks.getBacklinks.mockReturnValue([{ subjectId: 's1', slug: 'eigenvalue' }]); // 自引用

    const out = await executePageUpdate('j1', subject, { slug: 'eigenvalue', title: 'Eigen Value', body: 'new body' });
    expect(out.referencesUpdated).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cs = (txMocks.applyChangeset.mock.calls[0] as any)[0] as { entries: Array<{ action: string; path: string }> };
    expect(cs.entries).toHaveLength(1); // 只有自身这一条 update，没有额外的 backlink 条目
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

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run src/server/wiki/__tests__/page-ops-update.test.ts`
Expected: 新增的 4 个用例（同名 title / 联动重写 / 自引用 / referencesUpdated 断言）FAIL——因为内核还没实现 `title`/relink 逻辑，`out.referencesUpdated` 是 `undefined`。

- [ ] **Step 4: 实现内核改动**

用下面内容整份替换 `src/server/wiki/page-ops.ts:237-276` 的 `executePageUpdate` 函数（含它上面的文档注释）：

```ts
/**
 * 更新一页（可选改标题）：替换正文、覆盖 tags/summary；改标题时联动重写本 subject 内
 * 引用该页旧标题的文本（relink.ts::rewriteBacklinkText），与原页更新同一个 Saga 事务提交。
 * 坏链铁律：!valid（跨主题坏链 errors）或留下同主题 unresolved-wikilink 警告一律抛错、不落盘
 * （单页更新里残留 unresolved-wikilink 等同坏链；引导调用方「先建目标页再链接」）。
 * 供 fix tool-loop 与对话式 wiki.update（fix + query 两个 runner）复用。
 */
export async function executePageUpdate(
  jobId: string,
  subject: Subject,
  params: { slug: string; title?: string; body: string; summary?: string; tags?: string[] },
): Promise<{ updatedSlug: string; referencesUpdated: number }> {
  const { slug, body } = params;
  const doc = readPageInSubject(subject.slug, slug);
  if (!doc) throw new Error(`page "${slug}" not found`);

  const oldTitle = doc.frontmatter.title;
  const newTitle = params.title?.trim() || oldTitle;

  const now = new Date().toISOString();
  const frontmatter: WikiFrontmatter = {
    ...doc.frontmatter,
    title: newTitle,
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

  let referencesUpdated = 0;
  if (newTitle !== oldTitle) {
    const backlinks = pagesRepo
      .getBacklinks(subject.id, slug)
      .filter((b) => b.subjectId === subject.id && b.slug !== slug);
    for (const bl of backlinks) {
      const backDoc = readPageInSubject(subject.slug, bl.slug);
      if (!backDoc) continue;
      const raw = serializeWikiDocument(backDoc);
      const rewritten = rewriteBacklinkText(raw, oldTitle, newTitle, subject.slug);
      if (rewritten !== raw) {
        entries.push({ action: 'update', path: buildWikiPath(subject.slug, bl.slug), content: rewritten });
        referencesUpdated += 1;
      }
    }
  }

  const changeset = createChangeset(jobId, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) throw new Error(`update changeset invalid: ${validation.errors.join('; ')}`);
  const unresolved = (validation.warnings ?? []).filter((w) => w.includes('Unresolved wikilink:'));
  if (unresolved.length > 0) throw new Error(`update would leave unresolved wikilink(s): ${unresolved.join('; ')}`);
  await applyChangeset(changeset);

  return { updatedSlug: slug, referencesUpdated };
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run src/server/wiki/__tests__/page-ops-update.test.ts`
Expected: 全部 9 个用例 PASS。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增类型错误（`executePageUpdate` 调用方——`fix-tools.ts`——此时还传旧签名的子集，结构兼容不应报错；若报错见 Task 2）。

- [ ] **Step 7: Commit**

```bash
git add src/server/wiki/page-ops.ts src/server/wiki/__tests__/page-ops-update.test.ts
git commit -m "$(cat <<'EOF'
feat(wiki): executePageUpdate 支持改标题并联动重写引用

改标题时用 relink.ts::rewriteBacklinkText 重写本 subject 内引用旧标题的文本，
与原页更新同一个 Saga 事务提交；返回值新增 referencesUpdated。
EOF
)"
```

---

### Task 2: `wiki.update` 工具 schema + `ToolContext.updatePage` 签名扩展

**Files:**
- Modify: `src/server/agents/tools/tool-context.ts:32-34`
- Modify: `src/server/agents/tools/builtin/wiki-update.ts`（整份重写）
- Test: `src/server/agents/tools/builtin/__tests__/wiki-update.test.ts`（新增用例）
- Test: `src/server/services/__tests__/fix-tools.test.ts`（新增一个 title 透传回归用例）

**Interfaces:**
- Consumes: Task 1 的 `executePageUpdate` 新签名/返回值。
- Produces: `ToolContext.updatePage?(input: { slug: string; title?: string; body: string; summary?: string; tags?: string[] }): Promise<{ updatedSlug: string; referencesUpdated: number }>`。Task 3/4 的 `page-write.ts`/`query-tools.ts` 都实现这个接口。

- [ ] **Step 1: 改 `ToolContext.updatePage` 签名**

当前 `src/server/agents/tools/tool-context.ts:32-34`：
```ts
  /** fix 侧更新一页正文（Saga）；仅 fix runner 注入。 */
  updatePage?(input: { slug: string; body: string; summary?: string; tags?: string[] }):
    Promise<{ updatedSlug: string }>;
```
改为：
```ts
  /** 更新一页（可选改标题+正文，Saga）；fix runner 与 query runner 均注入。 */
  updatePage?(input: { slug: string; title?: string; body: string; summary?: string; tags?: string[] }):
    Promise<{ updatedSlug: string; referencesUpdated: number }>;
```

- [ ] **Step 2: 补 wiki-update 工具的新测试用例（先写失败的）**

在 `src/server/agents/tools/builtin/__tests__/wiki-update.test.ts` 的 `describe('wiki.update tool', ...)` 块内，`it('注入 updatePage → ok:true 返回 updatedSlug', ...)` 这个用例之后插入两个新用例：

```ts
  it('传 title → 透传给 updatePage，返回 referencesUpdated', async () => {
    const updatePage = vi.fn(async () => ({ updatedSlug: 'eigenvalue', referencesUpdated: 2 }));
    const res = await wikiUpdateTool.handler(
      { slug: 'eigenvalue', title: 'Eigen Value', body: 'x' },
      ctx({ updatePage }),
    );
    expect(res.ok).toBe(true);
    expect(res.referencesUpdated).toBe(2);
    expect(res.message).toContain('2 references updated');
    expect(updatePage).toHaveBeenCalledWith({ slug: 'eigenvalue', title: 'Eigen Value', body: 'x' });
  });

  it('referencesUpdated=0 时 message 不提 references', async () => {
    const updatePage = vi.fn(async () => ({ updatedSlug: 'eigenvalue', referencesUpdated: 0 }));
    const res = await wikiUpdateTool.handler({ slug: 'eigenvalue', body: 'x' }, ctx({ updatePage }));
    expect(res.message).not.toContain('references updated');
  });
```

也把已有的第一个用例（`'注入 updatePage → ok:true 返回 updatedSlug'`）里的 mock 与断言改成匹配新返回形状：
```ts
  it('注入 updatePage → ok:true 返回 updatedSlug', async () => {
    const updatePage = vi.fn(async () => ({ updatedSlug: 'eigen', referencesUpdated: 0 }));
    const res = await wikiUpdateTool.handler({ slug: 'eigen', body: 'x', summary: 's', tags: ['math'] }, ctx({ updatePage }));
    expect(res.ok).toBe(true);
    expect(res.updatedSlug).toBe('eigen');
    expect(updatePage).toHaveBeenCalledWith({ slug: 'eigen', body: 'x', summary: 's', tags: ['math'] });
  });
```

- [ ] **Step 3: 运行测试，确认新用例失败**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-update.test.ts`
Expected: 新增两个用例 FAIL（`res.referencesUpdated` 是 `undefined`，schema 里还没有这个字段；且 `title` 字段不在 schema 里会被 zod 校验拒绝——如果 handler 前置了 schema 校验；至少 message 断言会失败，因为工具还没实现"引用更新"文案）。

- [ ] **Step 4: 重写 `wiki-update.ts`**

整份替换 `src/server/agents/tools/builtin/wiki-update.ts`：

```ts
import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  slug: z.string().trim().min(1),
  title: z.string().trim().min(1).optional().describe('New title for the page. Omit to keep the current title.'),
  body: z
    .string()
    .describe('Full corrected markdown body WITHOUT a frontmatter block — the system manages frontmatter (title/timestamps).'),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  updatedSlug: z.string().nullable(),
  referencesUpdated: z.number().nullable(),
  message: z.string(),
});

export const wikiUpdateTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.update',
  source: 'builtin',
  description:
    'Replace the title and/or body (and optionally summary/tags) of an EXISTING wiki page in the current subject. This CHANGES the wiki. ' +
    'Provide the FULL corrected body, without a frontmatter block — not a diff or excerpt. ' +
    'Preserve information you have not been asked to remove; do not drop unrelated content. ' +
    'Only use [[Page Title]] wikilinks to pages that already exist; a broken or unresolved link causes the edit to be REJECTED (not applied). ' +
    'If you change the title, every wikilink elsewhere in this subject that references the OLD title is automatically rewritten to the new title.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'update',
  async handler(input, ctx) {
    if (!ctx.updatePage) {
      return { ok: false, updatedSlug: null, referencesUpdated: null, message: 'Updating a page is not available in this context.' };
    }
    try {
      const { updatedSlug, referencesUpdated } = await ctx.updatePage(input);
      const refNote = referencesUpdated > 0
        ? ` (${referencesUpdated} reference${referencesUpdated === 1 ? '' : 's'} updated)`
        : '';
      return { ok: true, updatedSlug, referencesUpdated, message: `Updated "${updatedSlug}".${refNote}` };
    } catch (err) {
      return { ok: false, updatedSlug: null, referencesUpdated: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
```

- [ ] **Step 5: 运行测试，确认通过**

Run: `npx vitest run src/server/agents/tools/builtin/__tests__/wiki-update.test.ts`
Expected: 全部用例 PASS。

- [ ] **Step 6: 补 fix-tools.ts 的 title 透传回归测试**

在 `src/server/services/__tests__/fix-tools.test.ts` 里，`it('update：成功调内核 + record + emit fix:page', ...)` 这个用例之后插入：

```ts
  it('update：title 原样透传给内核（fix 侧无需改代码，接口扩展自动生效）', async () => {
    const emit = vi.fn();
    opsMocks.executePageUpdate.mockResolvedValueOnce({ updatedSlug: 'eigen', referencesUpdated: 3 });
    const guard = createFixGuard({ caps: { writes: 5 } });
    const ctx = buildFixToolContext(subject, { guard, jobId: 'j1', emit });
    const res = await ctx.updatePage!({ slug: 'eigen', title: 'Eigen Value', body: `${LONG}, edited` });
    expect(res.referencesUpdated).toBe(3);
    expect(opsMocks.executePageUpdate).toHaveBeenCalledWith('j1', subject, { slug: 'eigen', title: 'Eigen Value', body: `${LONG}, edited` });
  });
```

这一步不需要改 `src/server/services/fix-tools.ts` 的任何代码——`updatePage(input)` 直接把整个 `input` 对象转发给 `executePageUpdate(jobId, subject, input)`，`title` 字段随对象结构自动透传。

- [ ] **Step 7: 运行测试，确认通过**

Run: `npx vitest run src/server/services/__tests__/fix-tools.test.ts`
Expected: 全部用例（含新增的）PASS，且 `git diff src/server/services/fix-tools.ts` 应为空。

- [ ] **Step 8: 类型检查 + 全量相关测试**

Run: `npx tsc --noEmit && npx vitest run src/server/agents src/server/wiki src/server/services/__tests__/fix-tools.test.ts`
Expected: 无错误，全部 PASS。

- [ ] **Step 9: Commit**

```bash
git add src/server/agents/tools/tool-context.ts src/server/agents/tools/builtin/wiki-update.ts \
  src/server/agents/tools/builtin/__tests__/wiki-update.test.ts \
  src/server/services/__tests__/fix-tools.test.ts
git commit -m "$(cat <<'EOF'
feat(agents): wiki.update 工具支持改标题，返回引用更新计数

ToolContext.updatePage 签名扩展 title? 入参与 referencesUpdated 返回值，
fix runner 零代码改动自动获得改标题能力（结构化透传）。
EOF
)"
```

---

### Task 3: 问答侧写路径包装 — `page-write.ts::updatePageInSubject`

**Files:**
- Modify: `src/server/services/page-write.ts`
- Test: `src/server/services/__tests__/page-write.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `executePageUpdate`；`checkRewriteFidelity`/`FIDELITY_PROFILES`（`@/server/wiki/rewrite-fidelity`，已存在，签名 `checkRewriteFidelity(original: string, revised: string, profile: FidelityProfile): { ok: boolean; violations: string[] }`）；`readPageInSubject`（`@/server/wiki/wiki-store`，已存在）；`enqueueEmbedIndex`（已存在）。
- Produces: `updatePageInSubject(subject: Subject, input: { slug: string; title?: string; body: string; summary?: string; tags?: string[] }): Promise<{ updatedSlug: string; referencesUpdated: number }>`。Task 4 的 `query-tools.ts` 直接调用它。

- [ ] **Step 1: 写失败的测试**

在 `src/server/services/__tests__/page-write.test.ts` 顶部的 mock 区补充（`opsMocks` 加 `executePageUpdate`，新增 `readPageInSubject`/`rewrite-fidelity` 的 mock 引用点——本任务不 mock `checkRewriteFidelity`，用真实实现 + 精心构造的 body 长度触发通过/拦截，与 `fix-tools.test.ts` 的做法一致）：

把文件顶部的 mock 区改成：
```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

const repoMocks = vi.hoisted(() => ({ getPageBySlug: vi.fn() }));
vi.mock('@/server/db/repos/pages-repo', () => repoMocks);

const opsMocks = vi.hoisted(() => ({
  executePageDelete: vi.fn(async () => ({ deletedSlug: 'eigen', brokenBacklinks: 2 })),
  executePageCreate: vi.fn(async () => ({ createdSlug: 'foo' })),
  executePageUpdate: vi.fn(async () => ({ updatedSlug: 'eigen', referencesUpdated: 0 })),
}));
vi.mock('@/server/wiki/page-ops', () => opsMocks);

const storeMocks = vi.hoisted(() => ({
  readPageInSubject: vi.fn(() => ({ frontmatter: { title: 'Eigen' }, body: 'a fairly long original body with more than enough characters to matter here' })),
}));
vi.mock('@/server/wiki/wiki-store', () => storeMocks);

const embedMocks = vi.hoisted(() => ({ enqueueEmbedIndex: vi.fn() }));
vi.mock('../embedding-service', () => embedMocks);

import { validateDeleteTarget, deletePageInSubject, createPageInSubject, updatePageInSubject } from '../page-write';

const subject = { id: 's1', slug: 'general', name: 'General', description: '', createdAt: '', updatedAt: '' } as never;
const LONG = 'a fairly long original body with more than enough characters to matter here';
```

（`validateDeleteTarget`/`deletePageInSubject`/`createPageInSubject` 三个既有 `describe` 块保持原样不动，只是顶部 import 多了 `updatePageInSubject` 和 `LONG` 常量、mock 区多了 `storeMocks`/`opsMocks.executePageUpdate`。）

在文件末尾追加新的 `describe` 块：
```ts
describe('updatePageInSubject', () => {
  beforeEach(() => {
    opsMocks.executePageUpdate.mockClear();
    embedMocks.enqueueEmbedIndex.mockClear();
    storeMocks.readPageInSubject.mockReturnValue({ frontmatter: { title: 'Eigen' }, body: LONG });
  });

  it('正常改标题+正文 → 执行更新 + enqueue embed', async () => {
    opsMocks.executePageUpdate.mockResolvedValue({ updatedSlug: 'eigen', referencesUpdated: 3 });
    const out = await updatePageInSubject(subject, { slug: 'eigen', title: 'Eigen Value', body: `${LONG}, edited` });
    expect(opsMocks.executePageUpdate).toHaveBeenCalledOnce();
    expect(embedMocks.enqueueEmbedIndex).toHaveBeenCalledWith('s1');
    expect(out).toEqual({ updatedSlug: 'eigen', referencesUpdated: 3 });
  });

  it('目标页不存在 → 抛错，不执行、不 enqueue', async () => {
    storeMocks.readPageInSubject.mockReturnValueOnce(null as never);
    await expect(updatePageInSubject(subject, { slug: 'ghost', body: 'x' })).rejects.toThrow(/not found/);
    expect(opsMocks.executePageUpdate).not.toHaveBeenCalled();
    expect(embedMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it('正文塌缩超出保真度护栏 → 抛错，不执行', async () => {
    await expect(updatePageInSubject(subject, { slug: 'eigen', body: 'tiny' })).rejects.toThrow(/dropped too much/);
    expect(opsMocks.executePageUpdate).not.toHaveBeenCalled();
    expect(embedMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/services/__tests__/page-write.test.ts`
Expected: `updatePageInSubject` 相关用例 FAIL（`updatePageInSubject is not a function` / 找不到导出）。

- [ ] **Step 3: 实现 `updatePageInSubject`**

在 `src/server/services/page-write.ts` 顶部，把：
```ts
import { executePageDelete, executePageCreate } from '../wiki/page-ops';
```
改为：
```ts
import { executePageDelete, executePageCreate, executePageUpdate } from '../wiki/page-ops';
import { readPageInSubject } from '../wiki/wiki-store';
import { checkRewriteFidelity, FIDELITY_PROFILES } from '../wiki/rewrite-fidelity';
```

在文件末尾（`createPageInSubject` 函数之后）追加：
```ts
/**
 * 校验目标页存在 + 忠实度护栏（FIDELITY_PROFILES.fix：正文不得缩水到原文 80% 以下、
 * 不得丢失原有 wikilink）后同步更新（Saga，可选改标题联动 relink）+ 触发向量回填。
 * 校验/护栏失败抛 Error（消息可直接转述）。
 */
export async function updatePageInSubject(
  subject: Subject,
  input: { slug: string; title?: string; body: string; summary?: string; tags?: string[] },
): Promise<{ updatedSlug: string; referencesUpdated: number }> {
  const doc = readPageInSubject(subject.slug, input.slug);
  if (!doc) throw new Error(`Page "${input.slug}" not found in this subject.`);
  const fidelity = checkRewriteFidelity(doc.body, input.body, FIDELITY_PROFILES.fix);
  if (!fidelity.ok) {
    throw new Error(`Edit dropped too much content: ${fidelity.violations.join('; ')}`);
  }
  const result = await executePageUpdate(crypto.randomUUID(), subject, input);
  enqueueEmbedIndex(subject.id);
  return result;
}
```

同时把文件头部注释里的"delete / createPageInSubject"补一句提到 update（可选，非阻塞）：文件顶部注释第 1-4 行改为：
```ts
/**
 * 页面写操作的对话路径包装（供 query 工具循环调用）。
 * 删除规则纯函数化（validateDeleteTarget，路由与对话单一来源），执行复用
 * wiki/page-ops 内核，写后触发向量回填。update 额外过忠实度护栏（复用 fix 同档）。
 * 语义沿用 DELETE /api/pages 路由 + executePageCreate/executePageUpdate。
 */
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/server/services/__tests__/page-write.test.ts`
Expected: 全部用例 PASS。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/server/services/page-write.ts src/server/services/__tests__/page-write.test.ts
git commit -m "$(cat <<'EOF'
feat(services): 新增 page-write.ts::updatePageInSubject

对话路径写更新包装：目标页存在性 + 忠实度护栏(FIDELITY_PROFILES.fix) +
executePageUpdate + enqueueEmbedIndex，对齐 deletePageInSubject/createPageInSubject。
EOF
)"
```

---

### Task 4: 接入问答工具集 — `query-tools.ts` + `query-service.ts`

**Files:**
- Modify: `src/server/services/query-tools.ts`
- Modify: `src/server/services/query-service.ts:50`
- Test: `src/server/services/__tests__/query-tools.test.ts`
- Test: `src/server/services/__tests__/resolve-query-tools.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `updatePageInSubject(subject, input)`。
- Produces: `buildQueryToolContext(...).updatePage` 委托 `updatePageInSubject`；`resolveQueryTools()` 返回集合含 `'wiki.update'`。Task 5（prompt）依赖这个工具已经在工具集里。

- [ ] **Step 1: 写失败的测试 — `query-tools.test.ts`**

在 `src/server/services/__tests__/query-tools.test.ts` 顶部，把：
```ts
const mockDeletePage = vi.fn();
const mockCreatePage = vi.fn();
vi.mock('../page-write', () => ({
  deletePageInSubject: (...a: unknown[]) => mockDeletePage(...a),
  createPageInSubject: (...a: unknown[]) => mockCreatePage(...a),
}));
```
改为：
```ts
const mockDeletePage = vi.fn();
const mockCreatePage = vi.fn();
const mockUpdatePage = vi.fn();
vi.mock('../page-write', () => ({
  deletePageInSubject: (...a: unknown[]) => mockDeletePage(...a),
  createPageInSubject: (...a: unknown[]) => mockCreatePage(...a),
  updatePageInSubject: (...a: unknown[]) => mockUpdatePage(...a),
}));
```

在 `describe('buildQueryToolContext - delete/create', ...)` 块的 `beforeEach` 里加一行 `mockUpdatePage.mockReset();`，并在该 `describe` 块末尾（`createPage` 用例之后）追加：
```ts
  it('updatePage 委托 updatePageInSubject(subject, input)', async () => {
    mockUpdatePage.mockResolvedValue({ updatedSlug: 'eigen', referencesUpdated: 1 });
    const ctx = buildQueryToolContext(SUBJECT, createAccessedPages());
    const input = { slug: 'eigen', title: 'Eigen Value', body: 'x' };
    const out = await ctx.updatePage!(input);
    expect(mockUpdatePage).toHaveBeenCalledWith(SUBJECT, input);
    expect(out).toEqual({ updatedSlug: 'eigen', referencesUpdated: 1 });
  });
```

- [ ] **Step 2: 写失败的测试 — `resolve-query-tools.test.ts`**

在 `src/server/services/__tests__/resolve-query-tools.test.ts` 的两个 `it` 块里各加一行断言（紧跟在 `expect(names).toContain('wiki.read');` / 现有断言之后）：

```ts
  it('excludes web.search when web search is not configured', async () => {
    mockGetWebSearchConfig.mockReturnValue({ provider: 'tavily', apiKey: '', maxResults: 5 });
    const { resolveQueryTools } = await import('../query-service');
    const names = resolveQueryTools().map((t) => t.name);
    expect(names).not.toContain('web.search');
    expect(names).toContain('wiki.read');
    expect(names).toContain('wiki.update');
  });

  it('includes web.search when web search is configured', async () => {
    mockGetWebSearchConfig.mockReturnValue({ provider: 'tavily', apiKey: 'sk-123', maxResults: 5 });
    const { resolveQueryTools } = await import('../query-service');
    const names = resolveQueryTools().map((t) => t.name);
    expect(names).toContain('web.search');
    expect(names).toContain('wiki.update');
  });
```

- [ ] **Step 3: 运行测试，确认失败**

Run: `npx vitest run src/server/services/__tests__/query-tools.test.ts src/server/services/__tests__/resolve-query-tools.test.ts`
Expected: 新增断言 FAIL（`ctx.updatePage` 不存在 / `names` 不含 `'wiki.update'`）。

- [ ] **Step 4: 实现 `query-tools.ts` 改动**

把 `src/server/services/query-tools.ts` 里：
```ts
import { deletePageInSubject, createPageInSubject } from './page-write';
```
改为：
```ts
import { deletePageInSubject, createPageInSubject, updatePageInSubject } from './page-write';
```

在 `buildQueryToolContext` 返回对象里，`async createPage(input) { return createPageInSubject(subject, input); },` 这一段之后（`async webSearch(query) {` 之前）插入：
```ts
    async updatePage(input) {
      return updatePageInSubject(subject, input);
    },
```

- [ ] **Step 5: 实现 `query-service.ts` 改动**

把 `src/server/services/query-service.ts:50`：
```ts
const BASE_QUERY_TOOL_NAMES = ['wiki.read', 'wiki.search', 'wiki.list', 'wiki.reenrich', 'wiki.create', 'wiki.delete'];
```
改为：
```ts
const BASE_QUERY_TOOL_NAMES = ['wiki.read', 'wiki.search', 'wiki.list', 'wiki.reenrich', 'wiki.create', 'wiki.update', 'wiki.delete'];
```

- [ ] **Step 6: 运行测试，确认通过**

Run: `npx vitest run src/server/services/__tests__/query-tools.test.ts src/server/services/__tests__/resolve-query-tools.test.ts`
Expected: 全部 PASS。

- [ ] **Step 7: 类型检查 + 相关测试全量**

Run: `npx tsc --noEmit && npx vitest run src/server/services`
Expected: 无错误，全部 PASS。

- [ ] **Step 8: Commit**

```bash
git add src/server/services/query-tools.ts src/server/services/query-service.ts \
  src/server/services/__tests__/query-tools.test.ts src/server/services/__tests__/resolve-query-tools.test.ts
git commit -m "$(cat <<'EOF'
feat(query): 问答工具集接入 wiki_update

buildQueryToolContext 新增 updatePage（委托 page-write::updatePageInSubject），
BASE_QUERY_TOOL_NAMES 追加 'wiki.update'。
EOF
)"
```

---

### Task 5: 确认纪律 Prompt — `query-prompt.ts`

**Files:**
- Modify: `src/server/llm/prompts/query-prompt.ts:146-199`（`QUERY_AGENTIC_SYSTEM_PROMPT`）
- Test: `src/server/llm/prompts/__tests__/query-prompt.test.ts`

**Interfaces:**
- Consumes: Task 4 已完成，`wiki.update` 已在问答工具集里（此任务不依赖代码接口，只是文案，但逻辑上应在工具真正可用之后落地）。

- [ ] **Step 1: 写失败的测试**

在 `src/server/llm/prompts/__tests__/query-prompt.test.ts` 的 `describe('QUERY_AGENTIC_SYSTEM_PROMPT - 写工具纪律', ...)` 块末尾（`'创建段存在'` 用例之后）追加：

```ts
  it('工具清单含 wiki_update', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toContain('wiki_update');
  });
  it('更新段存在，要求后续轮确认、禁止同轮更新', () => {
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/Updating a page/i);
    expect(QUERY_AGENTIC_SYSTEM_PROMPT).toMatch(/ALWAYS confirm before updat/i);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/llm/prompts/__tests__/query-prompt.test.ts`
Expected: 新增两个用例 FAIL（字符串里还没有 `wiki_update`/`Updating a page`）。

- [ ] **Step 3: 编辑 Prompt**

在 `src/server/llm/prompts/query-prompt.ts` 的 `## Tools` 清单里，把：
```
- \`wiki_create\`: create a NEW page from a title + markdown body (slug auto-derived). This CHANGES the wiki — only under the rules in "Creating a page" below.
- \`wiki_delete\`: permanently delete ONE page by slug. This CHANGES the wiki — only under the rules in "Deleting a page" below.
```
改为：
```
- \`wiki_create\`: create a NEW page from a title + markdown body (slug auto-derived). This CHANGES the wiki — only under the rules in "Creating a page" below.
- \`wiki_update\`: replace an EXISTING page's title and/or body (slug stays the same). This CHANGES the wiki — only under the rules in "Updating a page" below.
- \`wiki_delete\`: permanently delete ONE page by slug. This CHANGES the wiki — only under the rules in "Deleting a page" below.
```

把 `## Creating a page` 段落（结尾是 `... broken links are rejected and the create fails.`）和 `## Deleting a page` 段落之间插入新段落：
```
## Updating a page
Use \`wiki_update\` ONLY when the user explicitly asks to edit, rewrite, or retitle an EXISTING page. Never on your own initiative.
1. Identify the target page. If the user refers to "this page"/"here" and a current page is given, use that slug. If they name a page, resolve its exact slug via \`wiki_list\`/\`wiki_search\`.
2. If the target is ambiguous — no current page, or several could match — ASK which page; do not guess.
3. ALWAYS confirm before updating: restate the intended change (the new title, if any, and a one-line summary of the body change) and ask the user to confirm. Do NOT call \`wiki_update\` in the same turn you ask — only call it in a LATER turn, after the user clearly agrees (e.g. "yes", "go ahead").
4. Provide the FULL corrected body (markdown, without a frontmatter block) — not a diff or excerpt. Preserve information the user has not asked you to remove. Only use [[wikilinks]] to pages that already exist — broken links are rejected and the update fails.
5. After updating, tell the user it is done. If you changed the title, mention that references to the old title elsewhere in the subject were automatically updated (report the count if greater than zero). Note the change is recorded in History and can be reverted.

```
（注意：段落顺序是 Creating → Updating → Deleting，紧跟在 `## Deleting a page` 前面插入即可；`## Deleting a page` 原文不动。）

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/server/llm/prompts/__tests__/query-prompt.test.ts`
Expected: 全部用例 PASS。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: Commit**

```bash
git add src/server/llm/prompts/query-prompt.ts src/server/llm/prompts/__tests__/query-prompt.test.ts
git commit -m "$(cat <<'EOF'
feat(prompt): QUERY_AGENTIC_SYSTEM_PROMPT 补 wiki_update 确认纪律

新增 "Updating a page" 段落，规则对齐 "Deleting a page"：须在后续轮次
经用户确认才能调用，不能同轮执行。
EOF
)"
```

---

### Task 6: 文档同步 + 全量验证

**Files:**
- Modify: `CLAUDE.md`（根，变更记录表）
- Modify: `src/server/agents/CLAUDE.md`（模块表格行 + 文件清单 + 变更记录）
- Modify: `src/server/wiki/CLAUDE.md`（模块表格行 + 变更记录）
- Modify: `src/server/services/CLAUDE.md`（文件清单行 + 变更记录）

**Interfaces:** 无代码接口，纯文档 + 验证。

- [ ] **Step 1: 更新 `src/server/agents/CLAUDE.md`**

在"### `tools/`"小节的表格里，把：
```
| `builtin/wiki-update.ts` | `wiki.update` — 通过 `ToolContext.updatePage` 更新页面正文（`sideEffect:'update'`，仅 fix runner） |
```
改为：
```
| `builtin/wiki-update.ts` | `wiki.update` — 通过 `ToolContext.updatePage` 更新页面标题/正文，改标题联动 relink（`sideEffect:'update'`，fix + query runner） |
```

把 `tool-context.ts` 那一行里的 `` `updatePage?`（fix runner） `` 改成 `` `updatePage?`（fix + query runner） ``（其余文字不变）。

在"相关文件清单"的 `builtin/` 目录树里，`├── wiki-list.ts            # wiki.list` 之后补一行：
```
        ├── wiki-update.ts          # wiki.update（写动作工具，sideEffect:'update'，改标题联动 relink，fix + query runner）
```

在变更记录表最后一行（`2026-07-06 | T2.2 fanout existingPages...`）之后追加：
```
| 2026-07-09 | `wiki.update` 支持改标题：`executePageUpdate` 新增 `title?` 参数，改标题时联动 `relink.ts::rewriteBacklinkText` 重写本 subject 内引用旧标题的文本（新增返回字段 `referencesUpdated`）；`ToolContext.updatePage` 注入范围从"仅 fix runner"扩展为"fix + query runner"——问答（Ask AI）首次获得 `wiki_update` 能力（经 `services/page-write.ts::updatePageInSubject` 包装：忠实度护栏复用 `FIDELITY_PROFILES.fix` + `enqueueEmbedIndex`）；`QUERY_AGENTIC_SYSTEM_PROMPT` 补 "Updating a page" 确认纪律（与 `wiki_delete` 一致，须后续轮确认）。spec 见 `docs/superpowers/specs/2026-07-09-wiki-update-title-query-tool-design.md` |
```

- [ ] **Step 2: 更新 `src/server/wiki/CLAUDE.md`**

在"对外接口"表格里，把：
```
| `page-ops.ts` | `executePageMerge(jobId, subject, {targetSlug, sourceSlug})` / `executePageSplit(jobId, subject, {sourceSlug, hint?})` / `executePageDelete(jobId, subject, slug)` / `executePageCreate(jobId, subject, {title, body?, tags?})` / `executePageUpdate(jobId, subject, {slug, body, summary?, tags?})` | merge/split/delete/create/update 执行内核（LLM 调用 + Saga 事务）；无 emit / 无 embed enqueue —— 调用方自持；供 `curate-service` 与 query 工具复用。update 保留标题/系统 frontmatter、替换正文、坏链与残留 unresolved-wikilink 一律拒绝落盘 |
```
改为：
```
| `page-ops.ts` | `executePageMerge(jobId, subject, {targetSlug, sourceSlug})` / `executePageSplit(jobId, subject, {sourceSlug, hint?})` / `executePageDelete(jobId, subject, slug)` / `executePageCreate(jobId, subject, {title, body?, tags?})` / `executePageUpdate(jobId, subject, {slug, title?, body, summary?, tags?})` | merge/split/delete/create/update 执行内核（LLM 调用 + Saga 事务）；无 emit / 无 embed enqueue —— 调用方自持；供 `curate-service` 与 query 工具复用。update 支持改标题（联动 `relink.ts::rewriteBacklinkText` 重写本 subject 内引用旧标题的文本，返回 `referencesUpdated`），坏链与残留 unresolved-wikilink 一律拒绝落盘 |
```

在变更记录表最后一行（`2026-07-06 | T1.4 统一保真护栏...`）之后追加：
```
| 2026-07-09 | `page-ops.ts::executePageUpdate` 支持改标题：新增 `title?` 参数，标题变化时取本 subject 内 backlinks 逐个用 `relink.ts::rewriteBacklinkText` 重写引用文本（排除自引用），随原页更新一并进同一个 Saga 事务；返回值新增 `referencesUpdated`（无标题变化恒为 0）。供 fix 与新接入的问答（Ask AI）`wiki_update` 工具复用 |
```

- [ ] **Step 3: 更新 `src/server/services/CLAUDE.md`**

在"相关文件清单"里，把：
```
├── page-write.ts        # 🆕 共享写工具内核：validateDeleteTarget（删除守卫单一真实源）+ deletePageInSubject / createPageInSubject（Saga + embed 回填，供 DELETE 路由与 wiki.delete/wiki.create 对话工具复用）
```
改为：
```
├── page-write.ts        # 共享写工具内核：validateDeleteTarget（删除守卫单一真实源）+ deletePageInSubject / createPageInSubject / updatePageInSubject（Saga + embed 回填 + 忠实度护栏，供 DELETE 路由与 wiki.delete/wiki.create/wiki.update 对话工具复用）
```

在变更记录表最后追加一行：
```
| 2026-07-09 | 新增 `page-write.ts::updatePageInSubject`（校验目标页存在 + 忠实度护栏 `FIDELITY_PROFILES.fix` + 调 `executePageUpdate`（支持改标题）+ `enqueueEmbedIndex`）；`query-tools.ts::buildQueryToolContext` 接入 `updatePage`（委托上述函数）；`query-service.ts::BASE_QUERY_TOOL_NAMES` 追加 `'wiki.update'`——问答（Ask AI）首次获得改写页面标题+正文的能力；`QUERY_AGENTIC_SYSTEM_PROMPT` 补 "Updating a page" 确认纪律（与 `wiki_delete` 一致，须后续轮确认）|
```

- [ ] **Step 4: 更新根 `CLAUDE.md`**

在"九、变更记录 (Changelog)"表格最后一行（`2026-07-09 | Ask AI 表格渲染 + 引用列表折叠...`）之后追加：
```
| 2026-07-09 | wiki_update 支持改标题 + 接入问答工具集 | `executePageUpdate`（`wiki/page-ops.ts`）新增 `title?` 参数，改标题时联动 `relink.ts::rewriteBacklinkText` 重写本 subject 内引用旧标题的文本，返回值增加 `referencesUpdated`；`wiki.update` 工具 schema/`ToolContext.updatePage` 签名同步扩展；新增 `services/page-write.ts::updatePageInSubject`（忠实度护栏复用 `FIDELITY_PROFILES.fix` + `enqueueEmbedIndex`），`query-tools.ts`/`query-service.ts` 接入，`wiki_update` 首次对问答（Ask AI）开放；`QUERY_AGENTIC_SYSTEM_PROMPT` 补 "Updating a page" 确认纪律（与 `wiki_delete` 一致，须后续轮确认）。spec 见 `docs/superpowers/specs/2026-07-09-wiki-update-title-query-tool-design.md` |
```

- [ ] **Step 5: 全量测试 + 类型检查**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 类型检查无错误；全部测试套件 PASS（含本次改动新增/修改的用例）。

- [ ] **Step 6: 手动验证（需要已配置可用的 LLM provider）**

启动 `npm run dev:all`，打开一个有内容的 subject，在 Ask AI 里发一条明确要求改写某页标题/正文的消息（例如"帮我把 XX 页的标题改成 YY，正文加一句 ZZ"）。预期：

1. 模型先复述将要做的改动并等待确认，不在同一轮调用 `wiki_update`；
2. 用户回复"好的"/"go ahead" 后，模型在下一轮调用 `wiki_update`，聊天 UI 出现 ✏️ Editing 工具活动气泡；
3. 页面刷新后标题/正文确实改变；若改了标题，跳到本 subject 内任意一个原本用 `[[旧标题]]` 引用该页的其他页面确认引用文本已同步变成新标题。

若当前环境没有配置可用的 LLM provider（无法触发真实工具调用），明确说明"手动验证未执行——LLM 未配置"，不要在没有实际验证的情况下声称通过。

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md src/server/agents/CLAUDE.md src/server/wiki/CLAUDE.md src/server/services/CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: 同步 wiki_update 支持改标题+接入问答工具集的模块文档

更新根/agents/wiki/services 四份 CLAUDE.md 的模块说明与变更记录。
EOF
)"
```
