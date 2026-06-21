# 合并两页为一页（Page Merge）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 A 页发起 Merge → 选 B → 异步 job 用 LLM 把 B 正文融合进 A（A 保留 title/slug/URL），删除 B，并把本 subject 内所有解析到 B 的 `[[…]]` 引用重链到 A。

**Architecture:** 沿用 lint/ingest 的「异步 job + 单次结构化 LLM 调用 + 确定性 Saga」模式。新增 `repointLinksToPage`（复用 ④a `replaceTargetInToken`，按解析后 target slug 匹配）、`merge-prompt`、`merge-service`（worker handler）、`POST /api/merge`、merge UI。多页改动（update 合并后 A + delete B + 重写各引用页）一个 `createChangeset` 原子提交。

**Tech Stack:** TypeScript 5、Next.js 15 App Router（Route Handler + SSE）、Vitest（node）、Zod、Vercel AI SDK（`generateStructuredOutput`）、TanStack React Query、`useJobStream`（既有 SSE hook）。

## Global Constraints

- 复用 `extractWikiLinks`（wikilink 唯一真实源）、`replaceTargetInToken`（④a，relink.ts 模块级私有函数，同文件可调）、`serializeWikiDocument` / `serializeFrontmatter` / `stampSystemFrontmatter`；**不复刻链接解析**。
- 写走现有**异步 job + 同步 Saga**：`createChangeset → validateChangeset → applyChangeset`；所有 changeset 条目同一 subject、同一事务、失败 rollback。
- A 保留 title/slug/URL/文件；**只删 B**；标题/slug 不在合并中改（改名走 ④a）。
- LLM 只产 `{ mergedBody, mergedSummary }`；`tags=union(A,B)`、`sources=union(A,B)`、`created=A`、`updated=now`、`title=A`、`summary=LLM`。
- 重链覆盖**所有解析到 B 的链接形式**（title-form + slug-form），范围 = 本 subject 内指向 B 的页 + 合并后正文自身；跨 subject 引用不重链。
- `POST /api/merge` 顶部 `requireAuth` + `requireCsrf` + `resolveSubjectFromRequest({required:true, body})`；长任务只入队、立即返回 `{ jobId }`。
- LLM 必须 `generateStructuredOutput` + zod schema；prompt 注入 PromptContext 语言指令（`renderLanguageDirective`），禁止翻译 slug/wikilink/frontmatter keys。
- 客户端只用 `useApiFetch()`；POST body 显式带 `subjectId`。
- meta 系统页（index/log）不作为 merge 目标或源。
- 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，**非门禁**。
- commit message 中文一句话；**禁止** AI 署名 trailer / 脚注。

---

### Task 1: `repointLinksToPage` 纯函数

**Files:**
- Modify: `src/server/wiki/relink.ts`
- Modify: `src/server/wiki/__tests__/relink.test.ts`

**Interfaces:**
- Consumes: 模块内现有 `extractWikiLinks`、私有 `replaceTargetInToken`（④a）；`TitleResolver = (title: string) => string | undefined`（`@/lib/contracts`）。`ExtractedLink.target` 为解析后 slug（传入 titleResolver 时由其解析，否则 normalizeSlug）。
- Produces: `repointLinksToPage(raw: string, fromSlug: string, toTitle: string, subjectSlug: string, titleResolver: TitleResolver): string`。

- [ ] **Step 1: 写失败测试**

在 `src/server/wiki/__tests__/relink.test.ts` 末尾（最后一个 `describe` 之后）追加：

```ts
import type { TitleResolver } from '@/lib/contracts';
import { repointLinksToPage } from '../relink';

describe('repointLinksToPage', () => {
  // 把 'B Title'（及小写）解析到 slug 'b'；其余按 normalizeSlug 兜底。
  const resolver: TitleResolver = (t) => (t.trim().toLowerCase() === 'b title' ? 'b' : undefined);

  it('title-form [[B Title]] → [[A Title]]', () => {
    expect(repointLinksToPage('see [[B Title]] x', 'b', 'A Title', 'general', resolver))
      .toBe('see [[A Title]] x');
  });

  it('slug-form [[b]] → [[A Title]]', () => {
    expect(repointLinksToPage('[[b]]', 'b', 'A Title', 'general', resolver))
      .toBe('[[A Title]]');
  });

  it('保留别名 [[B Title|看]] → [[A Title|看]]', () => {
    expect(repointLinksToPage('[[B Title|看]]', 'b', 'A Title', 'general', resolver))
      .toBe('[[A Title|看]]');
  });

  it('保留锚点 [[B Title#x]] → [[A Title#x]]', () => {
    expect(repointLinksToPage('[[B Title#x]]', 'b', 'A Title', 'general', resolver))
      .toBe('[[A Title#x]]');
  });

  it('不指向 B 的链接不动（[[Other]] / [[a]]）', () => {
    expect(repointLinksToPage('[[Other]] and [[a]]', 'b', 'A Title', 'general', resolver))
      .toBe('[[Other]] and [[a]]');
  });

  it('跨主题 [[other:B Title]] 不动', () => {
    expect(repointLinksToPage('[[other:B Title]]', 'b', 'A Title', 'general', resolver))
      .toBe('[[other:B Title]]');
  });

  it('同段多处混合、右起替换不串位', () => {
    expect(repointLinksToPage('A [[B Title]] B [[a]] C [[b|x]] D', 'b', 'A Title', 'general', resolver))
      .toBe('A [[A Title]] B [[a]] C [[A Title|x]] D');
  });

  it('code fence 内不动', () => {
    expect(repointLinksToPage('```\n[[b]]\n```\n[[b]]', 'b', 'A Title', 'general', resolver))
      .toBe('```\n[[b]]\n```\n[[A Title]]');
  });

  it('无匹配返回原串', () => {
    expect(repointLinksToPage('nothing [[zzz]]', 'b', 'A Title', 'general', resolver))
      .toBe('nothing [[zzz]]');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/wiki/__tests__/relink.test.ts`
Expected: FAIL —— `repointLinksToPage is not a function` / 导入解析失败。

- [ ] **Step 3: 写最小实现**

在 `src/server/wiki/relink.ts` 顶部 import 区追加（与现有 import 并列）：

```ts
import type { TitleResolver } from '@/lib/contracts';
```

在文件末尾追加新导出函数（`replaceTargetInToken` 已在本文件，直接调用）：

```ts
/**
 * 把整文件 raw 里所有「解析到 fromSlug（本 subject）」的 wikilink 改指向 toTitle。
 * 与 rewriteBacklinkText 的区别：匹配判据是「解析后的 target slug == fromSlug」
 * （用 titleResolver，覆盖 title-form 与 slug-form 两种写法）。用于 merge：源页被删后，
 * 所有指向它的引用（含 [[源-slug]]）都要改指存活页。跨主题链接与代码块内链接不动。
 * 复用 replaceTargetInToken 保前缀/#锚点/|别名；按 position 从右往左替换。无匹配返回原串。
 */
export function repointLinksToPage(
  raw: string,
  fromSlug: string,
  toTitle: string,
  subjectSlug: string,
  titleResolver: TitleResolver,
): string {
  const links = extractWikiLinks(raw, { currentSubjectSlug: subjectSlug, titleResolver });
  const matches = links
    .filter(
      (l) =>
        l.target === fromSlug &&
        (!l.targetSubjectSlug || l.targetSubjectSlug === subjectSlug),
    )
    .sort((a, b) => b.position.start - a.position.start);

  let result = raw;
  for (const link of matches) {
    const newToken = replaceTargetInToken(link.raw, toTitle);
    result =
      result.slice(0, link.position.start) +
      newToken +
      result.slice(link.position.end);
  }
  return result;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/wiki/__tests__/relink.test.ts`
Expected: PASS —— ④a 既有用例 + 9 个 repoint 用例全绿。

- [ ] **Step 5: 门禁 + 提交**

Run: `npx tsc --noEmit`（Expected: exit 0）
Run: `npx vitest run`（Expected: 全绿）

```bash
git add src/server/wiki/relink.ts src/server/wiki/__tests__/relink.test.ts
git commit -m "feat: relink 新增 repointLinksToPage（按解析后 target 匹配，供合并重链）"
```

---

### Task 2: merge LLM prompt + schema + task 枚举

**Files:**
- Create: `src/server/llm/prompts/merge-prompt.ts`
- Create: `src/server/llm/prompts/__tests__/merge-prompt.test.ts`
- Modify: `src/server/llm/config-schema.ts:8`

**Interfaces:**
- Consumes: `renderLanguageDirective` + `PromptContext`（`./prompt-context`）；`zod`。
- Produces: `MergeResultSchema`（zod，`{ mergedBody: string; mergedSummary: string }`）、`MERGE_SYSTEM_PROMPT: string`、`buildMergeUserPrompt(a: {title;body}, b: {title;body}, ctx: PromptContext): string`、`type MergeResult`。

- [ ] **Step 1: 写失败测试**

创建 `src/server/llm/prompts/__tests__/merge-prompt.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildMergeUserPrompt, MergeResultSchema, MERGE_SYSTEM_PROMPT } from '../merge-prompt';

const ctx = { language: 'English', subject: { slug: 'general', name: 'General' } };

describe('buildMergeUserPrompt', () => {
  it('注入语言指令 + 两页标题与正文', () => {
    const out = buildMergeUserPrompt(
      { title: 'Alpha', body: 'alpha body' },
      { title: 'Beta', body: 'beta body' },
      ctx,
    );
    expect(out).toContain('=== OUTPUT LANGUAGE ===');
    expect(out).toContain('Alpha');
    expect(out).toContain('alpha body');
    expect(out).toContain('Beta');
    expect(out).toContain('beta body');
  });

  it('包含保留 wikilink 的指令', () => {
    const out = buildMergeUserPrompt({ title: 'A', body: '' }, { title: 'B', body: '' }, ctx);
    expect(out.toLowerCase()).toContain('wikilink');
  });
});

describe('MergeResultSchema', () => {
  it('接受合法对象', () => {
    expect(MergeResultSchema.parse({ mergedBody: 'x', mergedSummary: 'y' }))
      .toEqual({ mergedBody: 'x', mergedSummary: 'y' });
  });
  it('缺字段报错', () => {
    expect(MergeResultSchema.safeParse({ mergedBody: 'x' }).success).toBe(false);
  });
});

describe('MERGE_SYSTEM_PROMPT', () => {
  it('是非空字符串', () => {
    expect(typeof MERGE_SYSTEM_PROMPT).toBe('string');
    expect(MERGE_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/llm/prompts/__tests__/merge-prompt.test.ts`
Expected: FAIL —— 模块 `../merge-prompt` 解析失败。

- [ ] **Step 3: 写最小实现**

创建 `src/server/llm/prompts/merge-prompt.ts`：

```ts
import { z } from 'zod';
import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Schema ────────────────────────────────────────────────────────────────────

export const MergeResultSchema = z.object({
  mergedBody: z
    .string()
    .describe('The merged markdown body, WITHOUT any frontmatter. Combine both pages into one coherent article.'),
  mergedSummary: z
    .string()
    .describe('A 1-2 sentence summary of the merged page.'),
});

export type MergeResult = z.infer<typeof MergeResultSchema>;

// ── System prompt ─────────────────────────────────────────────────────────────

export const MERGE_SYSTEM_PROMPT = `You are a senior wiki editor merging two pages of a personal knowledge base into ONE page.

## Your task
Combine the two provided pages (A = the surviving page, B = the page being absorbed) into a single coherent article.
- Preserve every substantive fact from both pages; do not drop information.
- De-duplicate overlapping content; reconcile and organise into a clear structure with headings.
- Write the result as the body of the surviving page A.

## Hard rules
- Output ONLY the merged markdown body. Do NOT include YAML frontmatter (no \`---\` block, no title/tags/sources lines).
- Preserve every existing [[wikilink]] BYTE-FOR-BYTE — including \`|alias\`, \`#section\`, and \`subject:\` prefixes. Do NOT invent new wikilinks, do NOT delete existing ones, do NOT translate link targets or slugs.
- Keep code blocks and inline \`code\` verbatim.

## Output
Return { mergedBody, mergedSummary }. mergedSummary is a 1-2 sentence overview of the merged page.`;

// ── User prompt builder ───────────────────────────────────────────────────────

export function buildMergeUserPrompt(
  a: { title: string; body: string },
  b: { title: string; body: string },
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;

  const subjectSection = ctx.subject
    ? `## Active subject (workspace)
- **Name**: ${ctx.subject.name}
- **Slug**: \`${ctx.subject.slug}\`
Both pages belong to this subject.

`
    : '';

  return `${languageDirective}${subjectSection}Merge the two pages below into one coherent article. Page A is the surviving page; fold Page B into it.

## Page A (surviving) — "${a.title}"

${a.body}

---

## Page B (absorbed) — "${b.title}"

${b.body}

---

Combine them, de-duplicate, preserve all facts and all existing [[wikilinks]], and return the merged body plus a short summary.`;
}
```

把 `src/server/llm/config-schema.ts:8`（现为）：

```ts
const BUILTIN_LLM_TASKS = ['ingest', 'query', 'lint'] as const;
```

改为：

```ts
const BUILTIN_LLM_TASKS = ['ingest', 'query', 'lint', 'merge'] as const;
```

并把紧随其后的 refine 报错文案（第 11 行）：

```ts
    { message: "Task must be 'ingest', 'query', 'lint', or 'skill:<id>'" },
```

改为：

```ts
    { message: "Task must be 'ingest', 'query', 'lint', 'merge', or 'skill:<id>'" },
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/llm/prompts/__tests__/merge-prompt.test.ts`
Expected: PASS —— 5 个用例全绿。

- [ ] **Step 5: 门禁 + 提交**

Run: `npx tsc --noEmit`（Expected: exit 0）
Run: `npx vitest run`（Expected: 全绿）

```bash
git add src/server/llm/prompts/merge-prompt.ts src/server/llm/prompts/__tests__/merge-prompt.test.ts src/server/llm/config-schema.ts
git commit -m "feat: 新增 merge LLM prompt/schema 与 merge task 枚举"
```

---

### Task 3: merge-service（worker handler）+ Job type + worker import

**Files:**
- Create: `src/server/services/merge-service.ts`
- Modify: `src/lib/contracts.ts`（`Job.type` 联合，约第 86 行）
- Modify: `src/server/worker-entry.ts`（service import 区，约第 35-37 行）

**Interfaces:**
- Consumes: `repointLinksToPage`（Task 1）；`MergeResultSchema` / `MERGE_SYSTEM_PROMPT` / `buildMergeUserPrompt`（Task 2）；`generateStructuredOutput(task, schema, system, user, overrides?)`（`@/server/llm/provider-registry`）；`getWikiLanguage()`（`@/server/db/repos/settings-repo`）；`readPageInSubject(subjectSlug, slug)` / `serializeWikiDocument`；`serializeFrontmatter(data, body)` / `stampSystemFrontmatter(content, {now, existingCreated})`；`buildWikiPath(subjectSlug, slug)`；`getTitleToSlugMap(subjectId): Map<string,string>` / `getBacklinks(subjectId, slug): WikiPage[]` / `getPageBySlug`；`createChangeset / validateChangeset / applyChangeset`；`registerHandler`；`subjectsRepo.getById`。
- Produces: `registerHandler('merge', runMergeJob)`；job result `{ mergedSlug, deletedSlug, referencesRepointed }`；SSE 事件 `merge:start` / `merge:complete`。

> 无独立单测：handler 调真实 LLM + Saga（与 lint/ingest 一致，mock 不划算；重链核心已被 Task 1 覆盖）。验收 = `tsc` 干净 + 既有 `vitest` 全绿 + dev 眼测。

- [ ] **Step 1: 扩 Job.type 联合**

`src/lib/contracts.ts` 中 `Job` 接口的 `type` 字段（现为 `type: 'ingest' | 'lint' | 'save-to-wiki';`）改为：

```ts
  type: 'ingest' | 'lint' | 'save-to-wiki' | 'merge';
```

- [ ] **Step 2: 写 merge-service**

创建 `src/server/services/merge-service.ts`：

```ts
/**
 * Merge service — 任务类型 'merge'。
 * 把 source 页融合进 target 页（LLM 产正文+摘要），删除 source，并把本 subject 内
 * 所有解析到 source 的 [[…]] 引用重链到 target。单次结构化 LLM + 确定性 Saga。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('merge', ...)。
 */
import { registerHandler } from '../jobs/worker';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { readPageInSubject } from '../wiki/wiki-store';
import { serializeWikiDocument } from '../wiki/markdown';
import { serializeFrontmatter, stampSystemFrontmatter } from '../wiki/frontmatter';
import { buildWikiPath } from '../wiki/page-identity';
import { repointLinksToPage } from '../wiki/relink';
import {
  createChangeset,
  validateChangeset,
  applyChangeset,
} from '../wiki/wiki-transaction';
import { generateStructuredOutput } from '../llm/provider-registry';
import {
  MergeResultSchema,
  MERGE_SYSTEM_PROMPT,
  buildMergeUserPrompt,
} from '../llm/prompts/merge-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { Job, ChangesetEntry, TitleResolver, WikiFrontmatter } from '@/lib/contracts';

interface MergeParams {
  targetSlug?: string;
  sourceSlug?: string;
  subjectId?: string;
}

function unionArr(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

async function runMergeJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as MergeParams;
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('merge job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  const { targetSlug, sourceSlug } = params;
  if (!targetSlug || !sourceSlug) throw new Error('merge job missing targetSlug/sourceSlug');
  if (targetSlug === sourceSlug) throw new Error('cannot merge a page into itself');

  const targetDoc = readPageInSubject(subject.slug, targetSlug);
  const sourceDoc = readPageInSubject(subject.slug, sourceSlug);
  if (!targetDoc) throw new Error(`target page "${targetSlug}" not found`);
  if (!sourceDoc) throw new Error(`source page "${sourceSlug}" not found`);

  emit('merge:start', `Merging "${sourceSlug}" into "${targetSlug}"…`, { targetSlug, sourceSlug });

  // 1. LLM 融合正文 + 摘要
  const llm = await generateStructuredOutput(
    'merge',
    MergeResultSchema,
    MERGE_SYSTEM_PROMPT,
    buildMergeUserPrompt(
      { title: targetDoc.frontmatter.title, body: targetDoc.body },
      { title: sourceDoc.frontmatter.title, body: sourceDoc.body },
      {
        language: getWikiLanguage(),
        subject: { slug: subject.slug, name: subject.name, description: subject.description },
      },
    ),
  );

  // 2. 确定性拼装 A 的新 frontmatter（title/created 保 A，tags/sources 取并集，summary 用 LLM）
  const mergedFrontmatter: WikiFrontmatter = {
    ...targetDoc.frontmatter,
    title: targetDoc.frontmatter.title,
    tags: unionArr(targetDoc.frontmatter.tags, sourceDoc.frontmatter.tags),
    sources: unionArr(targetDoc.frontmatter.sources, sourceDoc.frontmatter.sources),
    summary: llm.mergedSummary,
  };
  const now = new Date().toISOString();
  let mergedContent = stampSystemFrontmatter(
    serializeFrontmatter(mergedFrontmatter, llm.mergedBody),
    { now, existingCreated: targetDoc.frontmatter.created },
  );

  // 3. 重链：把所有解析到 source 的引用改指 target（合并体自身 + 本 subject backlink 源页）
  const titleMap = pagesRepo.getTitleToSlugMap(subject.id);
  const resolver: TitleResolver = (t) => titleMap.get(t) ?? titleMap.get(t.toLowerCase());
  const targetTitle = targetDoc.frontmatter.title;

  mergedContent = repointLinksToPage(mergedContent, sourceSlug, targetTitle, subject.slug, resolver);

  const entries: ChangesetEntry[] = [
    { action: 'update', path: buildWikiPath(subject.slug, targetSlug), content: mergedContent },
    { action: 'delete', path: buildWikiPath(subject.slug, sourceSlug), content: null },
  ];

  let referencesRepointed = 0;
  const backlinks = pagesRepo
    .getBacklinks(subject.id, sourceSlug)
    .filter((b) => b.subjectId === subject.id && b.slug !== targetSlug && b.slug !== sourceSlug);
  for (const bl of backlinks) {
    const doc = readPageInSubject(subject.slug, bl.slug);
    if (!doc) continue;
    const raw = serializeWikiDocument(doc);
    const rewritten = repointLinksToPage(raw, sourceSlug, targetTitle, subject.slug, resolver);
    if (rewritten !== raw) {
      entries.push({ action: 'update', path: buildWikiPath(subject.slug, bl.slug), content: rewritten });
      referencesRepointed += 1;
    }
  }

  // 4. 单事务 Saga
  const changeset = createChangeset(job.id, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    throw new Error(`merge changeset invalid: ${validation.errors.join('; ')}`);
  }
  await applyChangeset(changeset);

  emit(
    'merge:complete',
    `Merged into "${targetSlug}"; repointed ${referencesRepointed} reference(s)`,
    { mergedSlug: targetSlug, deletedSlug: sourceSlug, referencesRepointed },
  );

  return { mergedSlug: targetSlug, deletedSlug: sourceSlug, referencesRepointed };
}

registerHandler('merge', runMergeJob);
```

- [ ] **Step 3: 注册 service import**

`src/server/worker-entry.ts` 中 service import 区（现有 `import './services/ingest-service';` 等）追加一行：

```ts
import './services/merge-service';
```

- [ ] **Step 4: 门禁**

Run: `npx tsc --noEmit`
Expected: exit 0（确认 `WikiFrontmatter` / `ChangesetEntry` / `TitleResolver` 类型、`generateStructuredOutput` 泛型、各 repo 签名匹配）。

Run: `npx vitest run`
Expected: 全绿（不新增用例，确认无回归）。

- [ ] **Step 5: 提交**

```bash
git add src/server/services/merge-service.ts src/lib/contracts.ts src/server/worker-entry.ts
git commit -m "feat: merge-service 合并两页（LLM 融合正文 + 删源页 + 同事务重链）"
```

---

### Task 4: `POST /api/merge` 路由

**Files:**
- Create: `src/app/api/merge/route.ts`
- Create: `src/app/api/merge/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `requireAuth` / `requireCsrf`（`@/server/middleware/auth`）；`resolveSubjectFromRequest`（`@/server/middleware/subject`，返回 `{ subject, error }`）；`pagesRepo.getPageBySlug(subjectId, slug)`；`queue.enqueue(type, params?, subjectId?)`（`@/server/jobs/queue`）；`Job['type']` 含 `'merge'`（Task 3）。
- Produces: `POST` → 202 `{ jobId, subjectId }`；校验失败 400/404。

- [ ] **Step 1: 写失败测试**

创建 `src/app/api/merge/__tests__/route.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGetPage = vi.fn();
const mockResolve = vi.fn();
const mockEnqueue = vi.fn();

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/subject', () => ({
  resolveSubjectFromRequest: (request: unknown, options?: unknown) => mockResolve(request, options),
}));
vi.mock('@/server/db/repos/pages-repo', () => ({
  getPageBySlug: (subjectId: unknown, slug: unknown) => mockGetPage(subjectId, slug),
}));
vi.mock('@/server/jobs/queue', () => ({
  enqueue: (type: unknown, params: unknown, subjectId: unknown) => mockEnqueue(type, params, subjectId),
}));

import { POST } from '../route';

function call(body: unknown) {
  const req = new NextRequest('http://localhost/api/merge', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return POST(req);
}

beforeEach(() => {
  mockGetPage.mockReset();
  mockGetPage.mockImplementation((_s: unknown, slug: unknown) => (slug === 'missing' ? null : { slug }));
  mockResolve.mockReset();
  mockResolve.mockReturnValue({ subject: { id: 's1', slug: 'general' }, error: null });
  mockEnqueue.mockReset();
  mockEnqueue.mockReturnValue({ id: 'job-1' });
});

describe('POST /api/merge', () => {
  it('合法请求入队 merge 并返回 202 + jobId', async () => {
    const res = await call({ targetSlug: 'a', sourceSlug: 'b', subjectId: 's1' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.jobId).toBe('job-1');
    expect(mockEnqueue).toHaveBeenCalledWith('merge', { targetSlug: 'a', sourceSlug: 'b', subjectId: 's1' }, 's1');
  });

  it('target==source → 400，不入队', async () => {
    const res = await call({ targetSlug: 'a', sourceSlug: 'a', subjectId: 's1' });
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('source 不存在 → 404', async () => {
    const res = await call({ targetSlug: 'a', sourceSlug: 'missing', subjectId: 's1' });
    expect(res.status).toBe(404);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('meta 系统页（index）→ 400', async () => {
    const res = await call({ targetSlug: 'index', sourceSlug: 'b', subjectId: 's1' });
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/app/api/merge/__tests__/route.test.ts`
Expected: FAIL —— 模块 `../route` 解析失败。

- [ ] **Step 3: 写最小实现**

创建 `src/app/api/merge/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as queue from '@/server/jobs/queue';

export const runtime = 'nodejs';

const MergeRequestSchema = z.object({
  targetSlug: z.string().min(1),
  sourceSlug: z.string().min(1),
});

const PROTECTED_SYSTEM_PAGES = new Set(['index', 'log']);

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const body = await request.json().catch(() => null);

  const resolution = resolveSubjectFromRequest(request, { required: true, body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const parsed = MergeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { targetSlug, sourceSlug } = parsed.data;

  if (targetSlug === sourceSlug) {
    return NextResponse.json({ error: 'Cannot merge a page into itself' }, { status: 400 });
  }
  if (PROTECTED_SYSTEM_PAGES.has(targetSlug) || PROTECTED_SYSTEM_PAGES.has(sourceSlug)) {
    return NextResponse.json(
      { error: 'Cannot merge protected system pages (index/log)' },
      { status: 400 },
    );
  }
  if (!pagesRepo.getPageBySlug(subject.id, targetSlug)) {
    return NextResponse.json({ error: `Target page "${targetSlug}" not found` }, { status: 404 });
  }
  if (!pagesRepo.getPageBySlug(subject.id, sourceSlug)) {
    return NextResponse.json({ error: `Source page "${sourceSlug}" not found` }, { status: 404 });
  }

  const job = queue.enqueue(
    'merge',
    { targetSlug, sourceSlug, subjectId: subject.id },
    subject.id,
  );
  return NextResponse.json({ jobId: job.id, subjectId: subject.id }, { status: 202 });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/app/api/merge/__tests__/route.test.ts`
Expected: PASS —— 4 个用例全绿。

- [ ] **Step 5: 门禁 + 提交**

Run: `npx tsc --noEmit`（Expected: exit 0）
Run: `npx vitest run`（Expected: 全绿）

```bash
git add src/app/api/merge/route.ts src/app/api/merge/__tests__/route.test.ts
git commit -m "feat: POST /api/merge 校验后入队 merge 任务"
```

---

### Task 5: 合并 UI（弹窗 + 入口 + 透传 + SSE 事件）

**Files:**
- Create: `src/components/wiki/merge-dialog.tsx`
- Create: `src/components/wiki/merge-button.tsx`
- Modify: `src/components/wiki/frontmatter-display.tsx`
- Modify: `src/components/wiki/page-renderer.tsx`
- Modify: `src/hooks/use-job-stream.ts`（`namedEventTypes` 数组）

**Interfaces:**
- Consumes: `POST /api/merge` → `{ jobId }`（Task 4）；`useJobStream(jobId): { status, latestMessage, ... }`；`useApiFetch()`；`useCurrentSubject(): { id, slug }`；`GET /api/pages` → `{ slug; title; tags? }[]`。
- Produces: A 阅读页标题行的「Merge」入口 → 弹窗选 B → 触发合并 → 完成后失效缓存 + `router.refresh` + 关闭。

> 无单测：React 组件，项目无 DOM 测试环境。验收 = `tsc` 干净 + dev 眼测。不引第三方 modal/toast 库。

- [ ] **Step 1: use-job-stream 注册 merge 事件**

`src/hooks/use-job-stream.ts` 的 `namedEventTypes` 数组里，在 `'save:complete',` 之后追加：

```ts
        // Merge events
        'merge:start',
        'merge:complete',
```

- [ ] **Step 2: 写 merge-dialog**

创建 `src/components/wiki/merge-dialog.tsx`：

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useJobStream } from '@/hooks/use-job-stream';
import { Button } from '@/components/ui/button';

interface PageItem {
  slug: string;
  title: string;
  tags?: string[];
}

const INVALIDATE_KEYS = ['pages', 'page-detail', 'graph', 'search', 'jobs', 'backlinks', 'context', 'frontmatter'];

export function MergeDialog({
  targetSlug,
  targetTitle,
  onClose,
}: {
  targetSlug: string;
  targetTitle: string;
  onClose: () => void;
}) {
  const apiFetch = useApiFetch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: subjectId } = useCurrentSubject();

  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<PageItem | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { status, latestMessage } = useJobStream(jobId);

  const { data: pages = [] } = useQuery({
    queryKey: ['pages', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/pages');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as PageItem[];
    },
    enabled: !!subjectId,
  });

  const candidates = pages
    .filter((p) => p.slug !== targetSlug && !(p.tags ?? []).includes('meta'))
    .filter((p) => {
      const q = query.trim().toLowerCase();
      return q === '' || p.title.toLowerCase().includes(q) || p.slug.toLowerCase().includes(q);
    });

  useEffect(() => {
    if (status === 'completed') {
      void (async () => {
        await Promise.all(INVALIDATE_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
        router.refresh();
        onClose();
      })();
    } else if (status === 'failed') {
      setError('Merge failed — see the job tracker for details.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function startMerge() {
    if (!selected) return;
    setError(null);
    const res = await apiFetch('/api/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetSlug, sourceSlug: selected.slug, subjectId }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      setError(b.error ?? `HTTP ${res.status}`);
      return;
    }
    const b = (await res.json()) as { jobId: string };
    setJobId(b.jobId);
  }

  const running = jobId !== null && status !== 'failed';

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/40 p-4"
      onClick={running ? undefined : onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-surface shadow-lg p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-sm font-semibold text-foreground">Merge another page into “{targetTitle}”</h2>
          <p className="mt-1 text-xs text-foreground-secondary">
            The selected page is absorbed into this one and then deleted; references are repointed here. Committed to git (revertable).
          </p>
        </div>

        {running ? (
          <div className="py-6 text-center text-sm text-foreground-secondary">
            {latestMessage || 'Merging…'}
          </div>
        ) : (
          <>
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search pages to merge in…"
              className="w-full h-9 px-3 rounded-md border border-border bg-background text-sm focus-ring"
            />
            <ul className="max-h-64 overflow-y-auto rounded-md border border-border divide-y divide-border">
              {candidates.length === 0 ? (
                <li className="px-3 py-2 text-sm text-foreground-tertiary">No other pages.</li>
              ) : (
                candidates.map((p) => (
                  <li key={p.slug}>
                    <button
                      onClick={() => setSelected(p)}
                      className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                        selected?.slug === p.slug ? 'bg-accent-subtle text-accent-strong' : 'hover:bg-subtle'
                      }`}
                    >
                      {p.title}
                      <span className="ml-2 font-mono text-xs text-foreground-tertiary">{p.slug}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>

            {error && <p className="text-sm text-danger">{error}</p>}

            <div className="flex items-center justify-end gap-2">
              <Button intent="ghost" onClick={onClose}>Cancel</Button>
              <Button intent="primary" disabled={!selected} onClick={startMerge}>
                Merge {selected ? `“${selected.title}”` : ''}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 写 merge-button**

创建 `src/components/wiki/merge-button.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { GitMerge } from 'lucide-react';
import { MergeDialog } from './merge-dialog';

export function MergeButton({ slug, title }: { slug: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Merge another page into this one"
        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-sm font-medium text-foreground-secondary border border-border hover:bg-subtle hover:text-foreground transition-colors focus-ring"
      >
        <GitMerge className="h-3.5 w-3.5" />
        Merge
      </button>
      {open && <MergeDialog targetSlug={slug} targetTitle={title} onClose={() => setOpen(false)} />}
    </>
  );
}
```

- [ ] **Step 4: frontmatter-display 接入 Merge 入口**

`src/components/wiki/frontmatter-display.tsx`：

(1) import 区追加：

```ts
import { MergeButton } from '@/components/wiki/merge-button';
```

(2) `FrontmatterDisplayProps` 接口加 `slug?: string;`（放在 `subjectSlug?` 旁）：

```ts
  editHref?: string;
  subjectSlug?: string;
  slug?: string;
```

(3) 函数签名解构加 `slug`：

```ts
export default function FrontmatterDisplay({
  title,
  tags,
  sources,
  created,
  updated,
  editHref,
  subjectSlug,
  slug,
}: FrontmatterDisplayProps) {
```

(4) 把标题行里仅含 Edit 链接的部分（现为 `{editHref && (<Link …>Edit</Link>)}`）替换为：把 Edit 与 Merge 包进一个 actions 容器：

```tsx
        <div className="flex items-center gap-2 shrink-0">
          {slug && <MergeButton slug={slug} title={title} />}
          {editHref && (
            <Link
              href={editHref}
              title="Edit this page"
              className="shrink-0 inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-sm font-medium text-foreground-secondary border border-border hover:bg-subtle hover:text-foreground transition-colors focus-ring"
            >
              <Pencil className="h-3.5 w-3.5" />
              Edit
            </Link>
          )}
        </div>
```

- [ ] **Step 5: page-renderer 透传 slug**

`src/components/wiki/page-renderer.tsx`：`<FrontmatterDisplay … />` 调用处（现已传 `editHref` / `subjectSlug`）追加一行：

```tsx
          slug={slug}
```

（`slug` 已是 `PageRenderer` 的入参，无需额外声明。）

- [ ] **Step 6: 门禁**

Run: `npx tsc --noEmit`
Expected: exit 0（确认 `z-modal` 类、`useCurrentSubject`/`useJobStream`/`Button` 类型均匹配；若 `z-modal` 未定义则改用项目既有 z-index 类如 `z-tooltip` 之上的值——先以 tsc 不报为准，tailwind 任意 class 不影响 tsc）。

Run: `npx vitest run`
Expected: 全绿（本任务不新增用例）。

- [ ] **Step 7: 提交**

```bash
git add src/components/wiki/merge-dialog.tsx src/components/wiki/merge-button.tsx src/components/wiki/frontmatter-display.tsx src/components/wiki/page-renderer.tsx src/hooks/use-job-stream.ts
git commit -m "feat: A 页 Merge 入口 + 合并弹窗（选 B、触发、SSE 追踪、完成刷新）"
```

---

## 验收（全部任务完成后）

- `npx tsc --noEmit` 干净；`npx vitest run` 全绿（含新增 repoint 9 用例 + merge-prompt 5 用例 + merge route 4 用例）。
- dev 眼测：建两页 A、B（B 关于同主题），另建页 C 正文含 `[[B 标题]]` 与 `[[b-slug]]`。在 A 阅读页点「Merge」→ 搜选 B → 确认 → 进度结束后留在 A：A 正文已是融合内容、tags 为并集；B 页 404；C 正文里两种指向 B 的链接都已改指 A 且可跳；`git log` 顶部是一条合并 commit，可 `git revert`。

## 边界与已知取舍（实现时照此处理，勿"自行补强"）

- 跨 subject 指向 B 的引用不重链（单事务约束）→ 悬挂链接由 lint/health 暴露，本期不处理。
- LLM 若违规改动 wikilink → 属质量问题，事后审阅/编辑修正，不做强校验。
- B 的 page_sources 溯源随级联删除丢失；其 source 已并入 A 的 frontmatter `sources`。
- merge 是破坏性操作，安全网 = 单条 git commit，可 `git revert`。
- `z-modal` 若非项目既有 z-index 工具类，用现有最高层级类（如比 `z-tooltip` 更高的值）替代；以 dev 实测弹窗在最上层为准。
