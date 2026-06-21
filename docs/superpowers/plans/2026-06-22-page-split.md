# 拆分一页为多页（Page Split）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 页发起 Split → 异步 job 用 LLM 把 A 拆成 N 个独立新页（标出一个主承接页）→ 删除 A → 把本 subject 内所有解析到 A 的 `[[…]]` 引用统一重指主页 → 跳到主页。

**Architecture:** 沿用 ④b merge 的「异步 job + 单次结构化 LLM + 确定性多页 Saga」模式。新增纯函数 `planSplitPages`（服务端派生唯一 slug + 兜底恰一主页）、`split-prompt`、`split-service`、`POST /api/split`、split UI。重链**直接复用 ④b `repointLinksToPage`**（fromSlug=A.slug、toTitle=主页 title）。多页改动（create N 新页 + delete A + update 各引用页）一个 `createChangeset` 原子提交。

**Tech Stack:** TypeScript 5、Next.js 15（Route Handler + SSE）、Vitest（node）、Zod、Vercel AI SDK（`generateStructuredOutput`）、TanStack React Query、`useJobStream`。

## Global Constraints

- 复用 `repointLinksToPage`（④b，`@/server/wiki/relink`）、`extractWikiLinks`、`serializeFrontmatter`/`stampSystemFrontmatter`/`serializeWikiDocument`、`buildWikiPath`、`normalizeSlug`、Saga 三件套、`getBacklinks`/`getAllPages`/`getTitleToSlugMap`；**不复刻链接解析**，不改动这些既有符号。
- 写走现有**异步 job + 同步 Saga**：`createChangeset → validateChangeset → applyChangeset`；所有条目同一 subject、同一事务、失败 rollback。
- 解散模型：A 删除；N 个新页用**新派生 slug**（不复用 A.slug）；slug 由服务端 `normalizeSlug(title)` 派生（**不让 LLM 直出 slug**），冲突加后缀。
- 新页 frontmatter：`title`/`body`/`summary` 来自 LLM；`tags`/`sources`/`created` 继承 A；`updated=now`。
- 重指：LLM 标恰一个主页；所有解析到 A 的引用（合并体... 即每个新页正文自身 + 本 subject backlink 源页，排除 A）→ `repointLinksToPage(raw, A.slug, primary.title, subject.slug, resolver)`。跨 subject 不重指。
- `POST /api/split` 顶部 `requireAuth` + `requireCsrf` + `resolveSubjectFromRequest({required:true, body})`；只入队、202。
- LLM 必须 `generateStructuredOutput` + zod schema（`pages` `.min(2)`）；prompt 注入语言指令（`renderLanguageDirective`）。
- meta 系统页（index/log）不可拆。
- 完成后跳主页：前端 `GET /api/jobs/<jobId>` 读 `resultJson.primarySlug`。
- 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，**非门禁**。
- commit message 中文一句话；**禁止** AI 署名 trailer / 脚注。

---

### Task 1: `planSplitPages` 纯函数

**Files:**
- Create: `src/server/wiki/split-plan.ts`
- Test: `src/server/wiki/__tests__/split-plan.test.ts`

**Interfaces:**
- Consumes: `normalizeSlug`（`./page-identity`）。
- Produces: `interface LlmSplitPage { title; body; summary; isPrimary }`、`interface PlannedSplitPage extends LlmSplitPage { slug }`、`planSplitPages(pages: LlmSplitPage[], existingSlugs: Set<string>, sourceSlug: string): PlannedSplitPage[]`。

- [ ] **Step 1: 写失败测试**

创建 `src/server/wiki/__tests__/split-plan.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { planSplitPages, type LlmSplitPage } from '../split-plan';

function page(title: string, isPrimary = false): LlmSplitPage {
  return { title, body: `body of ${title}`, summary: `sum ${title}`, isPrimary };
}

describe('planSplitPages', () => {
  it('正常：各页得 normalizeSlug(title) 的 slug，透传 body/summary', () => {
    const out = planSplitPages([page('Alpha', true), page('Beta')], new Set(), 'src');
    expect(out.map((p) => p.slug)).toEqual(['alpha', 'beta']);
    expect(out[0].body).toBe('body of Alpha');
    expect(out[1].summary).toBe('sum Beta');
  });

  it('与现有 slug 冲突 → 加后缀 -2', () => {
    const out = planSplitPages([page('Alpha', true), page('Beta')], new Set(['alpha']), 'src');
    expect(out[0].slug).toBe('alpha-2');
    expect(out[1].slug).toBe('beta');
  });

  it('两新页同标题 → 第二个加 -2', () => {
    const out = planSplitPages([page('Dup', true), page('Dup')], new Set(), 'src');
    expect(out.map((p) => p.slug)).toEqual(['dup', 'dup-2']);
  });

  it('派生 slug == sourceSlug → 加后缀（不复用 A 的 slug）', () => {
    const out = planSplitPages([page('Source', true), page('Beta')], new Set(), 'source');
    expect(out[0].slug).toBe('source-2');
  });

  it('空标题 → 兜底 page', () => {
    const out = planSplitPages([page('', true), page('Beta')], new Set(), 'src');
    expect(out[0].slug).toBe('page');
  });

  it('LLM 给 0 个 primary → 第一个置 primary', () => {
    const out = planSplitPages([page('A'), page('B')], new Set(), 'src');
    expect(out[0].isPrimary).toBe(true);
    expect(out[1].isPrimary).toBe(false);
  });

  it('LLM 给多个 primary → 仅第一个保留', () => {
    const out = planSplitPages([page('A', true), page('B', true)], new Set(), 'src');
    expect(out[0].isPrimary).toBe(true);
    expect(out[1].isPrimary).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/wiki/__tests__/split-plan.test.ts`
Expected: FAIL —— 模块 `../split-plan` 解析失败。

- [ ] **Step 3: 写最小实现**

创建 `src/server/wiki/split-plan.ts`：

```ts
/**
 * 把 LLM 产出的拆分页清单整理为可落盘的页：派生唯一 slug、保证恰一个 primary。
 * 纯函数、无副作用。详见 docs/superpowers/specs/2026-06-22-page-split-design.md。
 */
import { normalizeSlug } from './page-identity';

export interface LlmSplitPage {
  title: string;
  body: string;
  summary: string;
  isPrimary: boolean;
}

export interface PlannedSplitPage extends LlmSplitPage {
  slug: string;
}

export function planSplitPages(
  pages: LlmSplitPage[],
  existingSlugs: Set<string>,
  sourceSlug: string,
): PlannedSplitPage[] {
  // 冲突集合：现有页 ∪ A 自己的 slug（要删，但不复用）∪ 已分配的新 slug
  const taken = new Set<string>([...existingSlugs, sourceSlug]);
  const planned: PlannedSplitPage[] = [];

  let primaryAssigned = false;
  for (const p of pages) {
    const base = normalizeSlug(p.title) || 'page';
    let slug = base;
    let n = 2;
    while (taken.has(slug)) {
      slug = `${base}-${n}`;
      n += 1;
    }
    taken.add(slug);

    let isPrimary = false;
    if (p.isPrimary && !primaryAssigned) {
      isPrimary = true;
      primaryAssigned = true;
    }
    planned.push({ ...p, isPrimary, slug });
  }

  // LLM 未标任何 primary → 第一个兜底为 primary
  if (!primaryAssigned && planned.length > 0) {
    planned[0] = { ...planned[0], isPrimary: true };
  }

  return planned;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/wiki/__tests__/split-plan.test.ts`
Expected: PASS —— 7 用例全绿。

- [ ] **Step 5: 门禁 + 提交**

Run: `npx tsc --noEmit`（Expected: exit 0）；`npx vitest run`（Expected: 全绿）

```bash
git add src/server/wiki/split-plan.ts src/server/wiki/__tests__/split-plan.test.ts
git commit -m "feat: 新增 planSplitPages 纯函数（派生唯一 slug + 兜底恰一主页）"
```

---

### Task 2: split LLM prompt + schema + task 枚举

**Files:**
- Create: `src/server/llm/prompts/split-prompt.ts`
- Create: `src/server/llm/prompts/__tests__/split-prompt.test.ts`
- Modify: `src/server/llm/config-schema.ts:8`

**Interfaces:**
- Consumes: `renderLanguageDirective` + `PromptContext`（`./prompt-context`）；`zod`。
- Produces: `SplitResultSchema`（`{ pages: [{title,body,summary,isPrimary}] }`，`.min(2)`）、`SPLIT_SYSTEM_PROMPT`、`buildSplitUserPrompt(source: {title;body}, hint: string|undefined, ctx: PromptContext): string`、`type SplitResult`。

- [ ] **Step 1: 写失败测试**

创建 `src/server/llm/prompts/__tests__/split-prompt.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { buildSplitUserPrompt, SplitResultSchema, SPLIT_SYSTEM_PROMPT } from '../split-prompt';

const ctx = { language: 'English', subject: { slug: 'general', name: 'General' } };

describe('buildSplitUserPrompt', () => {
  it('注入语言指令 + 原页标题/正文', () => {
    const out = buildSplitUserPrompt({ title: 'Big Page', body: 'big body' }, undefined, ctx);
    expect(out).toContain('=== OUTPUT LANGUAGE ===');
    expect(out).toContain('Big Page');
    expect(out).toContain('big body');
  });

  it('给了 hint 时包含 hint 文本', () => {
    const out = buildSplitUserPrompt({ title: 'X', body: 'y' }, 'split by H2 sections', ctx);
    expect(out).toContain('split by H2 sections');
  });

  it('未给 hint 时不报错且不含 hint 段', () => {
    const out = buildSplitUserPrompt({ title: 'X', body: 'y' }, undefined, ctx);
    expect(typeof out).toBe('string');
  });

  it('包含保留 wikilink 与恰一 primary 的指令', () => {
    const out = buildSplitUserPrompt({ title: 'X', body: 'y' }, undefined, ctx);
    expect(out.toLowerCase()).toContain('wikilink');
    expect(out.toLowerCase()).toContain('primary');
  });
});

describe('SplitResultSchema', () => {
  it('接受 ≥2 页', () => {
    const ok = SplitResultSchema.safeParse({
      pages: [
        { title: 'A', body: 'a', summary: 's', isPrimary: true },
        { title: 'B', body: 'b', summary: 's', isPrimary: false },
      ],
    });
    expect(ok.success).toBe(true);
  });
  it('拒绝 <2 页', () => {
    const bad = SplitResultSchema.safeParse({ pages: [{ title: 'A', body: 'a', summary: 's', isPrimary: true }] });
    expect(bad.success).toBe(false);
  });
});

describe('SPLIT_SYSTEM_PROMPT', () => {
  it('是非空字符串', () => {
    expect(typeof SPLIT_SYSTEM_PROMPT).toBe('string');
    expect(SPLIT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/llm/prompts/__tests__/split-prompt.test.ts`
Expected: FAIL —— 模块 `../split-prompt` 解析失败。

- [ ] **Step 3: 写最小实现**

创建 `src/server/llm/prompts/split-prompt.ts`：

```ts
import { z } from 'zod';
import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Schema ────────────────────────────────────────────────────────────────────

export const SplitResultSchema = z.object({
  pages: z
    .array(
      z.object({
        title: z.string(),
        body: z.string().describe('Self-contained markdown body for this page, WITHOUT frontmatter.'),
        summary: z.string().describe('1-2 sentence summary of this page.'),
        isPrimary: z
          .boolean()
          .describe('Exactly ONE page must be true: the best heir for links that pointed to the original page.'),
      }),
    )
    .min(2),
});

export type SplitResult = z.infer<typeof SplitResultSchema>;

// ── System prompt ─────────────────────────────────────────────────────────────

export const SPLIT_SYSTEM_PROMPT = `You are a senior wiki editor splitting ONE oversized page of a personal knowledge base into MULTIPLE independent pages.

## Your task
Divide the provided page into 2+ coherent, self-contained pages, each readable on its own.
- Preserve every substantive fact; do not drop information.
- Group related content together; give each new page a clear title and a 1-2 sentence summary.

## Hard rules
- Output ONLY each page's markdown body. Do NOT include YAML frontmatter (no \`---\` block, no title/tags/sources lines).
- Preserve every existing [[wikilink]] BYTE-FOR-BYTE — including \`|alias\`, \`#section\`, and \`subject:\` prefixes. Do NOT invent new wikilinks, do NOT delete existing ones, do NOT translate link targets or slugs.
- Keep code blocks and inline \`code\` verbatim.
- Mark EXACTLY ONE page with isPrimary=true: the page that best inherits the links that previously pointed to the original page.

## Output
Return { pages: [{ title, body, summary, isPrimary }] } with at least 2 pages.`;

// ── User prompt builder ───────────────────────────────────────────────────────

export function buildSplitUserPrompt(
  source: { title: string; body: string },
  hint: string | undefined,
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;

  const subjectSection = ctx.subject
    ? `## Active subject (workspace)
- **Name**: ${ctx.subject.name}
- **Slug**: \`${ctx.subject.slug}\`

`
    : '';

  const hintSection = hint && hint.trim()
    ? `## Split guidance from the user\n${hint.trim()}\n\n`
    : '';

  return `${languageDirective}${subjectSection}${hintSection}Split the page below into multiple self-contained pages. Preserve all facts and all existing [[wikilinks]], and mark exactly one page as primary.

## Original page — "${source.title}"

${source.body}`;
}
```

把 `src/server/llm/config-schema.ts:8`（现为，已含 'merge'）：

```ts
const BUILTIN_LLM_TASKS = ['ingest', 'query', 'lint', 'merge'] as const;
```

改为：

```ts
const BUILTIN_LLM_TASKS = ['ingest', 'query', 'lint', 'merge', 'split'] as const;
```

并把其后 refine 文案里的 `'merge', or 'skill:<id>'` 改为 `'merge', 'split', or 'skill:<id>'`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/llm/prompts/__tests__/split-prompt.test.ts`
Expected: PASS —— 7 用例全绿。

- [ ] **Step 5: 门禁 + 提交**

Run: `npx tsc --noEmit`（exit 0）；`npx vitest run`（全绿）

```bash
git add src/server/llm/prompts/split-prompt.ts src/server/llm/prompts/__tests__/split-prompt.test.ts src/server/llm/config-schema.ts
git commit -m "feat: 新增 split LLM prompt/schema 与 split task 枚举"
```

---

### Task 3: split-service（worker handler）+ Job type + worker import

**Files:**
- Create: `src/server/services/split-service.ts`
- Modify: `src/lib/contracts.ts`（`Job.type` 联合，约第 86 行，现为 `… | 'merge'`）
- Modify: `src/server/worker-entry.ts`（service import 区）

**Interfaces:**
- Consumes: `planSplitPages`（Task 1）；`SplitResultSchema`/`SPLIT_SYSTEM_PROMPT`/`buildSplitUserPrompt`（Task 2）；`repointLinksToPage`（④b）；`generateStructuredOutput`、`getWikiLanguage`、`readPageInSubject`/`serializeWikiDocument`、`serializeFrontmatter`/`stampSystemFrontmatter`、`buildWikiPath`、`getAllPages`/`getTitleToSlugMap`/`getBacklinks`、`createChangeset`/`validateChangeset`/`applyChangeset`、`registerHandler`、`subjectsRepo.getById`。
- Produces: `registerHandler('split', runSplitJob)`；job result `{ sourceSlug, pageSlugs, primarySlug, referencesRepointed }`；SSE `split:start` / `split:complete`。

> 无独立单测：handler 调真实 LLM + Saga（与 lint/ingest/merge 一致）；纯逻辑已被 Task 1 覆盖。验收 = `tsc` 干净 + 既有 `vitest` 全绿 + dev 眼测。

- [ ] **Step 1: 扩 Job.type 联合**

`src/lib/contracts.ts` 的 `Job.type`（现为 `type: 'ingest' | 'lint' | 'save-to-wiki' | 'merge';`）改为：

```ts
  type: 'ingest' | 'lint' | 'save-to-wiki' | 'merge' | 'split';
```

- [ ] **Step 2: 写 split-service**

创建 `src/server/services/split-service.ts`：

```ts
/**
 * Split service — 任务类型 'split'。
 * 把 source 页 LLM 拆成 N 个独立新页（标出主承接页），删除 source，并把本 subject 内
 * 所有解析到 source 的 [[…]] 引用统一重指主页。单次结构化 LLM + 确定性 Saga。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('split', ...)。
 */
import { registerHandler } from '../jobs/worker';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { readPageInSubject } from '../wiki/wiki-store';
import { serializeWikiDocument } from '../wiki/markdown';
import { serializeFrontmatter, stampSystemFrontmatter } from '../wiki/frontmatter';
import { buildWikiPath } from '../wiki/page-identity';
import { repointLinksToPage } from '../wiki/relink';
import { planSplitPages } from '../wiki/split-plan';
import {
  createChangeset,
  validateChangeset,
  applyChangeset,
} from '../wiki/wiki-transaction';
import { generateStructuredOutput } from '../llm/provider-registry';
import {
  SplitResultSchema,
  SPLIT_SYSTEM_PROMPT,
  buildSplitUserPrompt,
} from '../llm/prompts/split-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { Job, ChangesetEntry, TitleResolver, WikiFrontmatter } from '@/lib/contracts';

interface SplitParams {
  sourceSlug?: string;
  hint?: string;
  subjectId?: string;
}

async function runSplitJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as SplitParams;
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('split job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  const { sourceSlug, hint } = params;
  if (!sourceSlug) throw new Error('split job missing sourceSlug');

  const sourceDoc = readPageInSubject(subject.slug, sourceSlug);
  if (!sourceDoc) throw new Error(`source page "${sourceSlug}" not found`);

  emit('split:start', `Splitting "${sourceSlug}"…`, { sourceSlug });

  // 1. LLM 拆分
  const llm = await generateStructuredOutput(
    'split',
    SplitResultSchema,
    SPLIT_SYSTEM_PROMPT,
    buildSplitUserPrompt(
      { title: sourceDoc.frontmatter.title, body: sourceDoc.body },
      hint,
      {
        language: getWikiLanguage(),
        subject: { slug: subject.slug, name: subject.name, description: subject.description },
      },
    ),
  );
  if (llm.pages.length < 2) throw new Error('split must produce at least 2 pages');

  // 2. 派生唯一 slug + 恰一 primary
  const existingSlugs = new Set(pagesRepo.getAllPages(subject.id).map((p) => p.slug));
  const planned = planSplitPages(llm.pages, existingSlugs, sourceSlug);
  const primary = planned.find((p) => p.isPrimary) ?? planned[0];

  // 3. resolver（合并前，A 仍在库，能解析到 sourceSlug）
  const titleMap = pagesRepo.getTitleToSlugMap(subject.id);
  const resolver: TitleResolver = (t) => titleMap.get(t) ?? titleMap.get(t.toLowerCase());
  const now = new Date().toISOString();

  // 4. 新页 create 条目（正文里指向 A 的自引用重指主页）
  const entries: ChangesetEntry[] = [];
  for (const p of planned) {
    const body = repointLinksToPage(p.body, sourceSlug, primary.title, subject.slug, resolver);
    const frontmatter: WikiFrontmatter = {
      title: p.title,
      created: sourceDoc.frontmatter.created,
      updated: now,
      tags: sourceDoc.frontmatter.tags,
      sources: sourceDoc.frontmatter.sources,
      summary: p.summary,
    };
    const content = stampSystemFrontmatter(serializeFrontmatter(frontmatter, body), {
      now,
      existingCreated: sourceDoc.frontmatter.created,
    });
    entries.push({ action: 'create', path: buildWikiPath(subject.slug, p.slug), content });
  }

  // 5. 删 A
  entries.push({ action: 'delete', path: buildWikiPath(subject.slug, sourceSlug), content: null });

  // 6. 本 subject 内指向 A 的引用页统一重指主页
  let referencesRepointed = 0;
  const backlinks = pagesRepo
    .getBacklinks(subject.id, sourceSlug)
    .filter((b) => b.subjectId === subject.id && b.slug !== sourceSlug);
  for (const bl of backlinks) {
    const doc = readPageInSubject(subject.slug, bl.slug);
    if (!doc) continue;
    const raw = serializeWikiDocument(doc);
    const rewritten = repointLinksToPage(raw, sourceSlug, primary.title, subject.slug, resolver);
    if (rewritten !== raw) {
      entries.push({ action: 'update', path: buildWikiPath(subject.slug, bl.slug), content: rewritten });
      referencesRepointed += 1;
    }
  }

  // 7. 单事务 Saga
  const changeset = createChangeset(job.id, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    throw new Error(`split changeset invalid: ${validation.errors.join('; ')}`);
  }
  await applyChangeset(changeset);

  const pageSlugs = planned.map((p) => p.slug);
  emit('split:complete', `Split into ${pageSlugs.length} pages; repointed ${referencesRepointed} reference(s)`, {
    sourceSlug,
    pageSlugs,
    primarySlug: primary.slug,
    referencesRepointed,
  });

  return { sourceSlug, pageSlugs, primarySlug: primary.slug, referencesRepointed };
}

registerHandler('split', runSplitJob);
```

- [ ] **Step 3: 注册 service import**

`src/server/worker-entry.ts` 的 service import 区追加：

```ts
import './services/split-service';
```

- [ ] **Step 4: 门禁**

Run: `npx tsc --noEmit`（Expected: exit 0）
Run: `npx vitest run`（Expected: 全绿，无回归）

- [ ] **Step 5: 提交**

```bash
git add src/server/services/split-service.ts src/lib/contracts.ts src/server/worker-entry.ts
git commit -m "feat: split-service 拆分一页（LLM 拆 N 页 + 删源页 + 同事务重指主页）"
```

---

### Task 4: `POST /api/split` 路由

**Files:**
- Create: `src/app/api/split/route.ts`
- Create: `src/app/api/split/__tests__/route.test.ts`

**Interfaces:**
- Consumes: `requireAuth`/`requireCsrf`、`resolveSubjectFromRequest`、`pagesRepo.getPageBySlug`、`queue.enqueue`；`Job['type']` 含 `'split'`（Task 3）。
- Produces: `POST` → 202 `{ jobId, subjectId }`；校验失败 400/404。

- [ ] **Step 1: 写失败测试**

创建 `src/app/api/split/__tests__/route.test.ts`：

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
  const req = new NextRequest('http://localhost/api/split', {
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

describe('POST /api/split', () => {
  it('合法请求入队 split 并返回 202 + jobId', async () => {
    const res = await call({ sourceSlug: 'big', hint: 'by topic', subjectId: 's1' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.jobId).toBe('job-1');
    expect(mockEnqueue).toHaveBeenCalledWith('split', { sourceSlug: 'big', hint: 'by topic', subjectId: 's1' }, 's1');
  });

  it('source 不存在 → 404，不入队', async () => {
    const res = await call({ sourceSlug: 'missing', subjectId: 's1' });
    expect(res.status).toBe(404);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('meta 系统页（index）→ 400，不入队', async () => {
    const res = await call({ sourceSlug: 'index', subjectId: 's1' });
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('body 缺 sourceSlug → 400，不入队', async () => {
    const res = await call({ subjectId: 's1' });
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/app/api/split/__tests__/route.test.ts`
Expected: FAIL —— 模块 `../route` 解析失败。

- [ ] **Step 3: 写最小实现**

创建 `src/app/api/split/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as queue from '@/server/jobs/queue';

export const runtime = 'nodejs';

const SplitRequestSchema = z.object({
  sourceSlug: z.string().min(1),
  hint: z.string().optional(),
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

  const parsed = SplitRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { sourceSlug, hint } = parsed.data;

  if (PROTECTED_SYSTEM_PAGES.has(sourceSlug)) {
    return NextResponse.json(
      { error: 'Cannot split protected system pages (index/log)' },
      { status: 400 },
    );
  }
  if (!pagesRepo.getPageBySlug(subject.id, sourceSlug)) {
    return NextResponse.json({ error: `Page "${sourceSlug}" not found` }, { status: 404 });
  }

  const job = queue.enqueue(
    'split',
    { sourceSlug, hint, subjectId: subject.id },
    subject.id,
  );
  return NextResponse.json({ jobId: job.id, subjectId: subject.id }, { status: 202 });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/app/api/split/__tests__/route.test.ts`
Expected: PASS —— 4 用例全绿。

- [ ] **Step 5: 门禁 + 提交**

Run: `npx tsc --noEmit`（exit 0）；`npx vitest run`（全绿）

```bash
git add src/app/api/split/route.ts src/app/api/split/__tests__/route.test.ts
git commit -m "feat: POST /api/split 校验后入队 split 任务"
```

---

### Task 5: 拆分 UI（入口 + 弹窗 + SSE 事件）

**Files:**
- Create: `src/components/wiki/split-dialog.tsx`
- Create: `src/components/wiki/split-button.tsx`
- Modify: `src/components/wiki/frontmatter-display.tsx`
- Modify: `src/hooks/use-job-stream.ts`（`namedEventTypes`）

**Interfaces:**
- Consumes: `POST /api/split` → `{ jobId }`（Task 4）；`GET /api/jobs/<id>` → `{ resultJson: string, ... }`（resultJson 是 JSON 字符串，含 `primarySlug`）；`useJobStream`、`useApiFetch`、`useCurrentSubject`。
- Produces: A 阅读页标题行「Split」入口 → 弹窗（可选 hint）→ 触发 → 完成跳主页。

> 无单测：React 组件，tsc + dev 验收。不引第三方库；`z-command` 类（与 merge-dialog/settings-dialog 同款）。

- [ ] **Step 1: use-job-stream 注册 split 事件**

`src/hooks/use-job-stream.ts` 的 `namedEventTypes` 数组里，在 `'merge:complete',` 之后追加：

```ts
        // Split events
        'split:start',
        'split:complete',
```

- [ ] **Step 2: 写 split-dialog**

创建 `src/components/wiki/split-dialog.tsx`：

```tsx
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useJobStream } from '@/hooks/use-job-stream';
import { Button } from '@/components/ui/button';

const INVALIDATE_KEYS = ['pages', 'page-detail', 'graph', 'search', 'jobs', 'backlinks', 'context', 'frontmatter'];

export function SplitDialog({
  sourceSlug,
  sourceTitle,
  onClose,
}: {
  sourceSlug: string;
  sourceTitle: string;
  onClose: () => void;
}) {
  const apiFetch = useApiFetch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();

  const [hint, setHint] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { status, latestMessage } = useJobStream(jobId);

  useEffect(() => {
    if (status === 'completed') {
      void (async () => {
        let primarySlug = '';
        try {
          const res = await apiFetch(`/api/jobs/${jobId}`);
          if (res.ok) {
            const job = (await res.json()) as { resultJson?: string };
            const result = JSON.parse(job.resultJson ?? '{}') as { primarySlug?: string };
            primarySlug = result.primarySlug ?? '';
          }
        } catch {
          // fall through to home
        }
        await Promise.all(INVALIDATE_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
        router.push(
          primarySlug ? `/wiki/${primarySlug}?s=${encodeURIComponent(subjectSlug)}` : '/',
        );
        router.refresh();
        onClose();
      })();
    } else if (status === 'failed') {
      setError('Split failed — see the job tracker for details.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function startSplit() {
    setError(null);
    const res = await apiFetch('/api/split', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceSlug, hint: hint.trim() || undefined, subjectId }),
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
      className="fixed inset-0 z-command flex items-center justify-center bg-black/40 p-4"
      onClick={running ? undefined : onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-border bg-surface shadow-lg p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h2 className="text-sm font-semibold text-foreground">Split “{sourceTitle}” into multiple pages</h2>
          <p className="mt-1 text-xs text-foreground-secondary">
            AI proposes the split; this page is deleted and references are repointed to the primary new page. Committed to git (revertable).
          </p>
        </div>

        {running ? (
          <div className="py-6 text-center text-sm text-foreground-secondary">{latestMessage || 'Splitting…'}</div>
        ) : (
          <>
            <textarea
              autoFocus
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              rows={3}
              placeholder="Optional: how to split / how many pages — leave blank to let AI decide"
              className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus-ring resize-none"
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex items-center justify-end gap-2">
              <Button intent="ghost" onClick={onClose}>Cancel</Button>
              <Button intent="primary" onClick={startSplit}>Split</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: 写 split-button**

创建 `src/components/wiki/split-button.tsx`：

```tsx
'use client';

import { useState } from 'react';
import { Scissors } from 'lucide-react';
import { SplitDialog } from './split-dialog';

export function SplitButton({ slug, title }: { slug: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Split this page into multiple pages"
        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-sm font-medium text-foreground-secondary border border-border hover:bg-subtle hover:text-foreground transition-colors focus-ring"
      >
        <Scissors className="h-3.5 w-3.5" />
        Split
      </button>
      {open && <SplitDialog sourceSlug={slug} sourceTitle={title} onClose={() => setOpen(false)} />}
    </>
  );
}
```

- [ ] **Step 4: frontmatter-display 接入 Split 入口**

`src/components/wiki/frontmatter-display.tsx`：

(1) import 区追加：

```ts
import { SplitButton } from '@/components/wiki/split-button';
```

(2) actions 容器里、`MergeButton` 之后、`editHref` 之前，加一行（与 MergeButton 同 `slug` 守卫）：

```tsx
          {slug && <SplitButton slug={slug} title={title} />}
```

即该容器变为：

```tsx
        <div className="flex items-center gap-2 shrink-0">
          {slug && <MergeButton slug={slug} title={title} />}
          {slug && <SplitButton slug={slug} title={title} />}
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

- [ ] **Step 5: 门禁**

Run: `npx tsc --noEmit`（Expected: exit 0）
Run: `npx vitest run`（Expected: 全绿，无新增用例）

- [ ] **Step 6: 提交**

```bash
git add src/components/wiki/split-dialog.tsx src/components/wiki/split-button.tsx src/components/wiki/frontmatter-display.tsx src/hooks/use-job-stream.ts
git commit -m "feat: A 页 Split 入口 + 拆分弹窗（可选 hint、SSE 追踪、完成跳主页）"
```

---

## 验收（全部任务完成后）

- `npx tsc --noEmit` 干净；`npx vitest run` 全绿（含新增 split-plan 7 + split-prompt 7 + split 路由 4 用例）。
- dev 眼测：建一页 A（含多个 H2 章节、正文里有 `[[X]]` 链接）+ 一页 C 含 `[[A 标题]]`/`[[a-slug]]`。A 页点「Split」→ 可留空 hint → 进度结束后跳到主页：A 已 404、生成 ≥2 个新页（继承 A 的 tags/sources）、C 里两种指向 A 的链接都改指主页且可跳；`git log` 顶部一条拆分 commit 可 `git revert`。

## 边界与已知取舍（实现时照此处理，勿"自行补强"）

- 跨 subject 指向 A 的引用不重指 → 悬挂链接由 lint/health 暴露，本期不处理。
- LLM 返回 <2 页 → `SplitResultSchema.min(2)` 拒绝 + service 二次校验 → job fail。
- 新页 slug 不复用 A 的 slug（`planSplitPages` 把 sourceSlug 计入冲突集合）。
- LLM 违规改动 wikilink → 质量问题，事后审阅/编辑，不强校验。
- A 的 page_sources 随级联删除丢失；其 source 已继承到每个新页 frontmatter `sources`。
- 拆分是破坏性操作，安全网 = 单条 git commit，可 `git revert`。
