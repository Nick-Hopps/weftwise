# Health 页「一键修复」findings 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Health 体检页加一个「Fix issues」按钮，异步修复 lint 发现的可安全自动修复问题（`missing-frontmatter` 确定性补齐 + `broken-link`/`missing-crossref`/`contradiction` 逐页 LLM 修复）。

**Architecture:** 新增 `fix` job 类型 + `fix-service`（与 `curate` 同构）。工作清单 = 新鲜重扫确定性 findings ∪ 最近 lint 快照语义 findings。确定性修复合并为一个 Saga commit；LLM 修复按页分组，每页一个 commit、逐条自我门控、过 `validateChangeset` 拦截新坏链。前端单按钮 + SSE 追踪 + 完成后自动重跑 lint 刷新。

**Tech Stack:** Next.js 15 App Router / React 19 / TypeScript 5 / Zod / Vercel AI SDK（`generateStructuredOutput`）/ better-sqlite3 + Drizzle / vitest。

## Global Constraints

- 设计依据：`docs/superpowers/specs/2026-06-24-health-fix-findings-design.md`（范围路由表为准）。
- git commit message 用**中文**、一句话总结；**禁止** `Co-Authored-By: Claude` 等 AI 署名 trailer 与 "Generated with Claude Code" 脚注。
- TS 路径别名 `@/*` → `src/*`。`src/server/**` 不得被客户端组件直接 import。
- `npm run lint` 不可用（next lint 已弃用）；验证一律用 `npx tsc --noEmit` + `npx vitest run`。
- 所有 vault 写入经 Saga：`createChangeset → validateChangeset → applyChangeset`，subject 贯通到底。
- LLM 输出必须 `generateStructuredOutput(task, zodSchema, system, user)`，禁止直出 markdown 文件；user prompt 顶部经 `renderLanguageDirective(ctx.language)` 注入语言指令。
- 写接口顺序：`requireAuth(request)` → `requireCsrf(request)` → `resolveSubjectFromRequest(request, { required: true, body })`；长任务只 `queue.enqueue(...)` 返回 202。
- 修复范围（in scope）：`missing-frontmatter`（确定性）/ `broken-link` / `missing-crossref` / `contradiction`（LLM）。其余三类（`orphan` / `stale-source` / `coverage-gap`）**不修**。

---

### Task 1: 确定性修复纯函数 + 工作清单分桶

**Files:**
- Create: `src/server/services/fix-deterministic.ts`
- Test: `src/server/services/__tests__/fix-deterministic.test.ts`

**Interfaces:**
- Consumes（均已存在）：
  - `parseFrontmatter(content: string): { data: WikiFrontmatter; body: string }`、`serializeFrontmatter(data: WikiFrontmatter, body: string): string`、`stampSystemFrontmatter(content: string, opts: { now: string; existingCreated?: string | null }): string`（`@/server/wiki/frontmatter`）
  - 类型 `WikiDocument { frontmatter: WikiFrontmatter; body: string; links: ExtractedLink[] }`、`WikiFrontmatter`、`LintFinding`（`@/lib/contracts`）
- Produces（后续 Task 3 依赖）：
  - `fixMissingFrontmatter(slug: string, doc: WikiDocument, now: string): string`
  - `partitionFindings(findings: LintFinding[]): { frontmatter: LintFinding[]; llm: LintFinding[]; ignored: LintFinding[] }`
  - `buildFixWorklist(deterministic: LintFinding[], semantic: LintFinding[]): LintFinding[]`
  - 常量 `DETERMINISTIC_FIX_TYPES`、`LLM_FIX_TYPES`（`Set<LintFinding['type']>`）

- [ ] **Step 1: 写失败测试**

`src/server/services/__tests__/fix-deterministic.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../../wiki/frontmatter';
import {
  fixMissingFrontmatter,
  partitionFindings,
  buildFixWorklist,
} from '../fix-deterministic';
import type { LintFinding, WikiDocument } from '@/lib/contracts';

function doc(over: Partial<WikiDocument['frontmatter']> = {}, body = 'Body text'): WikiDocument {
  return {
    frontmatter: { title: '', created: '', updated: '', tags: [], sources: [], ...over },
    body,
    links: [],
  };
}

const f = (type: LintFinding['type'], pageSlug: string, description = 'd'): LintFinding => ({
  type,
  severity: 'warning',
  pageSlug,
  description,
  suggestedFix: null,
});

describe('fixMissingFrontmatter', () => {
  const NOW = '2026-06-24T00:00:00.000Z';

  it('空 title 用 slug 兜底', () => {
    const out = fixMissingFrontmatter('my-page', doc(), NOW);
    const { data } = parseFrontmatter(out);
    expect(data.title).toBe('my-page');
  });

  it('缺失时间戳被 stamp 为 now', () => {
    const out = fixMissingFrontmatter('p', doc(), NOW);
    const { data } = parseFrontmatter(out);
    expect(data.created).toBe(NOW);
    expect(data.updated).toBe(NOW);
  });

  it('已有 created 被保留', () => {
    const out = fixMissingFrontmatter('p', doc({ created: '2025-01-01T00:00:00.000Z' }), NOW);
    const { data } = parseFrontmatter(out);
    expect(data.created).toBe('2025-01-01T00:00:00.000Z');
  });

  it('tags/sources 保证为数组', () => {
    const out = fixMissingFrontmatter('p', doc(), NOW);
    const { data } = parseFrontmatter(out);
    expect(Array.isArray(data.tags)).toBe(true);
    expect(Array.isArray(data.sources)).toBe(true);
  });

  it('正文逐字保留', () => {
    const out = fixMissingFrontmatter('p', doc({}, 'Hello\n\nWorld'), NOW);
    const { body } = parseFrontmatter(out);
    expect(body.trim()).toBe('Hello\n\nWorld');
  });

  it('已有 title 不被覆盖', () => {
    const out = fixMissingFrontmatter('p', doc({ title: 'Real Title' }), NOW);
    const { data } = parseFrontmatter(out);
    expect(data.title).toBe('Real Title');
  });
});

describe('partitionFindings', () => {
  it('按修复机制分三桶', () => {
    const findings = [
      f('missing-frontmatter', 'a'),
      f('broken-link', 'b'),
      f('missing-crossref', 'c'),
      f('contradiction', 'd'),
      f('orphan', 'e'),
      f('stale-source', 'g'),
      f('coverage-gap', 'h'),
    ];
    const { frontmatter, llm, ignored } = partitionFindings(findings);
    expect(frontmatter.map((x) => x.pageSlug)).toEqual(['a']);
    expect(llm.map((x) => x.type).sort()).toEqual(['broken-link', 'contradiction', 'missing-crossref']);
    expect(ignored.map((x) => x.type).sort()).toEqual(['coverage-gap', 'orphan', 'stale-source']);
  });
});

describe('buildFixWorklist', () => {
  it('合并确定性与语义并按 type+slug+description 去重', () => {
    const det = [f('broken-link', 'a', 'L1'), f('broken-link', 'a', 'L1')];
    const sem = [f('missing-crossref', 'a', 'X')];
    const out = buildFixWorklist(det, sem);
    expect(out).toHaveLength(2);
  });

  it('同页不同 description 的 broken-link 各自保留', () => {
    const det = [f('broken-link', 'a', 'L1'), f('broken-link', 'a', 'L2')];
    const out = buildFixWorklist(det, []);
    expect(out).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/fix-deterministic.test.ts`
Expected: FAIL（`Cannot find module '../fix-deterministic'`）

- [ ] **Step 3: 写实现**

`src/server/services/fix-deterministic.ts`：

```ts
/**
 * Fix service — 确定性修复纯函数 + findings 分桶。
 * 无 side effect（不触 DB / fs / LLM），便于单测。
 *   - missing-frontmatter → 确定性补齐必填字段。
 *   - broken-link / missing-crossref / contradiction → 交给 LLM 逐页修复（本文件只做分桶）。
 *   - orphan / stale-source / coverage-gap → 不修（ignored）。
 */
import { parseFrontmatter, serializeFrontmatter, stampSystemFrontmatter } from '../wiki/frontmatter';
import type { LintFinding, WikiDocument, WikiFrontmatter } from '@/lib/contracts';

export const DETERMINISTIC_FIX_TYPES: ReadonlySet<LintFinding['type']> = new Set(['missing-frontmatter']);
export const LLM_FIX_TYPES: ReadonlySet<LintFinding['type']> = new Set([
  'broken-link',
  'missing-crossref',
  'contradiction',
]);

/**
 * 补齐一页缺失/非法的必填 frontmatter 字段。纯函数：now 由调用方传入。
 * title 为空 → 用 slug 兜底；时间戳/数组字段由 stampSystemFrontmatter 主理；正文逐字保留。
 */
export function fixMissingFrontmatter(slug: string, doc: WikiDocument, now: string): string {
  const fm = doc.frontmatter;
  const data: WikiFrontmatter = {
    ...fm,
    title: fm.title.trim() === '' ? slug : fm.title,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    sources: Array.isArray(fm.sources) ? fm.sources : [],
  };
  return stampSystemFrontmatter(serializeFrontmatter(data, doc.body), {
    now,
    existingCreated: fm.created?.trim() ? fm.created : null,
  });
}

/** 按修复机制把 findings 分入三桶。 */
export function partitionFindings(findings: LintFinding[]): {
  frontmatter: LintFinding[];
  llm: LintFinding[];
  ignored: LintFinding[];
} {
  const frontmatter: LintFinding[] = [];
  const llm: LintFinding[] = [];
  const ignored: LintFinding[] = [];
  for (const finding of findings) {
    if (DETERMINISTIC_FIX_TYPES.has(finding.type)) frontmatter.push(finding);
    else if (LLM_FIX_TYPES.has(finding.type)) llm.push(finding);
    else ignored.push(finding);
  }
  return { frontmatter, llm, ignored };
}

/**
 * 合并工作清单：确定性新鲜重扫结果（missing-frontmatter / broken-link）∪ 快照语义结果
 * （missing-crossref / contradiction）。按 type+pageSlug+description 去重（保留同页多条不同 broken-link）。
 */
export function buildFixWorklist(deterministic: LintFinding[], semantic: LintFinding[]): LintFinding[] {
  const seen = new Set<string>();
  const out: LintFinding[] = [];
  for (const finding of [...deterministic, ...semantic]) {
    const key = `${finding.type}::${finding.pageSlug}::${finding.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/services/__tests__/fix-deterministic.test.ts`
Expected: PASS（12 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/server/services/fix-deterministic.ts src/server/services/__tests__/fix-deterministic.test.ts
git commit -m "feat(fix): 新增确定性修复纯函数与 findings 分桶"
```

---

### Task 2: `fix` LLM task + 修复 prompt/schema

**Files:**
- Modify: `src/server/llm/config-schema.ts:8`（`BUILTIN_LLM_TASKS` 加 `'fix'`）
- Create: `src/server/llm/prompts/fix-prompt.ts`
- Test: `src/server/llm/prompts/__tests__/fix-prompt.test.ts`

**Interfaces:**
- Consumes：`renderLanguageDirective(language: string): string`、类型 `PromptContext`（`@/server/llm/prompts/prompt-context`）
- Produces（Task 3 依赖）：
  - `FixPageSchema`（Zod）、类型 `FixPageResult = { proceed: boolean; reason: string; body: string; summary?: string }`
  - `FIX_SYSTEM_PROMPT: string`
  - `buildFixPageUserPrompt(page: { slug: string; title: string; body: string }, findings: { type: string; description: string; suggestedFix: string | null }[], roster: { slug: string; title: string }[], ctx: PromptContext): string`

- [ ] **Step 1: 注册 builtin task**

`src/server/llm/config-schema.ts` 第 8 行，把 `'fix'` 加进数组：

```ts
const BUILTIN_LLM_TASKS = ['ingest', 'query', 'lint', 'merge', 'split', 'embedding', 'curate', 'fix'] as const;
```

- [ ] **Step 2: 写失败测试**

`src/server/llm/prompts/__tests__/fix-prompt.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { FixPageSchema, buildFixPageUserPrompt } from '../fix-prompt';

const ctx = { language: 'English', subject: { slug: 'general', name: 'General', description: '' } };

describe('FixPageSchema', () => {
  it('接受合法对象', () => {
    const parsed = FixPageSchema.parse({ proceed: true, reason: 'fixed link', body: '# Hi' });
    expect(parsed.proceed).toBe(true);
  });

  it('proceed 必填', () => {
    expect(() => FixPageSchema.parse({ reason: 'x', body: 'y' })).toThrow();
  });
});

describe('buildFixPageUserPrompt', () => {
  const page = { slug: 'react', title: 'React', body: 'React is a UI library. See Hooks.' };
  const findings = [
    { type: 'broken-link', description: '[[Hookz]] does not exist', suggestedFix: 'fix the link' },
  ];
  const roster = [{ slug: 'hooks', title: 'Hooks' }];

  it('包含语言指令、findings、页名册', () => {
    const out = buildFixPageUserPrompt(page, findings, roster, ctx);
    expect(out).toContain('English');
    expect(out).toContain('[[Hookz]] does not exist');
    expect(out).toContain('Hooks');
    expect(out).toContain('react');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/server/llm/prompts/__tests__/fix-prompt.test.ts`
Expected: FAIL（`Cannot find module '../fix-prompt'`）

- [ ] **Step 4: 写实现**

`src/server/llm/prompts/fix-prompt.ts`：

```ts
import { z } from 'zod';
import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Schema ────────────────────────────────────────────────────────────────────

export const FixPageSchema = z.object({
  proceed: z
    .boolean()
    .describe('true if you can confidently repair the listed issues on this page; false to leave it untouched'),
  reason: z
    .string()
    .describe('If proceed=false, explain why you declined. If proceed=true, a one-line summary of what you changed.'),
  body: z
    .string()
    .describe(
      'The full corrected page body in markdown (NO frontmatter). Faithful repair: change ONLY what the findings require; preserve all other prose, headings, callouts and wikilinks verbatim.',
    ),
  summary: z
    .string()
    .optional()
    .describe('Optional updated one-line page summary — include only if your edits materially change the page focus.'),
});

export type FixPageResult = z.infer<typeof FixPageSchema>;

// ── System prompt ─────────────────────────────────────────────────────────────

export const FIX_SYSTEM_PROMPT = `You are a meticulous wiki editor repairing quality issues on a single page of a personal knowledge base.

## Your job
You are given ONE page and a list of issues detected on it. Repair ONLY those issues and return the corrected page body.

## Issue types you may see
- **broken-link**: the page contains a [[wikilink]] whose target page does not exist.
  - If a roster page is an obvious match (typo / casing / pluralisation), relink to it using the roster page's exact title: [[Exact Title]].
  - If there is no good target, UNWRAP the link: remove the [[ ]] but keep the visible text as plain prose.
  - Never invent a target that is not in the roster.
- **missing-crossref**: the page mentions a concept that has its own roster page but is not linked.
  - Wrap the FIRST natural mention in a wikilink using the roster page's exact title: [[Exact Title]]. Do not duplicate links.
- **contradiction**: the page states something that conflicts with another page.
  - Only edit if you can confidently make the page internally consistent and faithful to the source material.
  - If resolving requires knowing which side is correct and you cannot tell, set proceed=false and explain. Do NOT guess.

## Hard rules
- Faithful editing: do not rewrite, summarise, reorder, or "improve" prose beyond what the issues require.
- Only emit [[wikilinks]] whose target appears in the page roster below. Do not translate slugs, titles, wikilink targets, or code blocks.
- Do not touch frontmatter — return body only. The system owns title/timestamps.
- If you cannot fix the issues without risky changes, set proceed=false with a clear reason.`;

// ── User prompt builder ───────────────────────────────────────────────────────

export function buildFixPageUserPrompt(
  page: { slug: string; title: string; body: string },
  findings: { type: string; description: string; suggestedFix: string | null }[],
  roster: { slug: string; title: string }[],
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;

  const subjectSection = ctx.subject
    ? `## Active subject (workspace)
- **Name**: ${ctx.subject.name}
- **Slug**: \`${ctx.subject.slug}\`
${ctx.subject.description?.trim() ? `- **Description**: ${ctx.subject.description.trim()}\n` : ''}
`
    : '';

  const issuesSection = findings
    .map(
      (finding, i) =>
        `${i + 1}. **${finding.type}** — ${finding.description}${
          finding.suggestedFix ? `\n   Suggested fix: ${finding.suggestedFix}` : ''
        }`,
    )
    .join('\n');

  const rosterSection =
    roster.length > 0
      ? roster.map((p) => `- [[${p.title}]] (slug: \`${p.slug}\`)`).join('\n')
      : '(no other pages in this subject)';

  return `${languageDirective}${subjectSection}## Page under repair: [[${page.title}]] (slug: \`${page.slug}\`)

### Current body
${page.body}

### Issues to repair on this page
${issuesSection}

### Page roster (the ONLY valid wikilink targets in this subject)
${rosterSection}

---

Repair the listed issues faithfully and return the corrected body. If you cannot do so confidently, set proceed=false.`;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/server/llm/prompts/__tests__/fix-prompt.test.ts`
Expected: PASS

- [ ] **Step 6: typecheck + 提交**

Run: `npx tsc --noEmit`
Expected: 退出码 0（无新增错误）

```bash
git add src/server/llm/config-schema.ts src/server/llm/prompts/fix-prompt.ts src/server/llm/prompts/__tests__/fix-prompt.test.ts
git commit -m "feat(fix): 新增 fix LLM task 与逐页修复 prompt/schema"
```

---

### Task 3: `fix` job 类型 + fix-service 编排

**Files:**
- Modify: `src/lib/contracts.ts:92`（`Job.type` 加 `'fix'`）
- Create: `src/server/services/fix-service.ts`
- Modify: `src/server/worker-entry.ts`（import 新 service 触发注册）

**Interfaces:**
- Consumes：
  - Task 1：`fixMissingFrontmatter` / `partitionFindings` / `buildFixWorklist`
  - Task 2：`FixPageSchema` / `FIX_SYSTEM_PROMPT` / `buildFixPageUserPrompt` / `FixPageResult`
  - 既有：`registerHandler(type, handler)`（`@/server/jobs/worker`）、`queue.list(filter)`（`@/server/jobs/queue`）、`subjectsRepo.getById(id)`、`pagesRepo.getAllPages(subjectId)` / `getTitleToSlugMap(subjectId)`、`runDeterministicChecksForSubject(subject)`（`@/server/services/lint-deterministic`）、`selectLatestFindings(jobs)`（`@/server/services/lint-latest`）、`readPageInSubject(subjectSlug, slug)`、`createChangeset/validateChangeset/applyChangeset`、`buildWikiPath(subjectSlug, slug)`、`serializeFrontmatter/stampSystemFrontmatter`、`generateStructuredOutput`、`getWikiLanguage()`、`enqueueEmbedIndex(subjectId)`
- Produces：`registerHandler('fix', runFixJob)`（side-effect）；job `resultJson = { fixed, skipped, failed, byType }`

- [ ] **Step 1: 给 Job.type 加 'fix'**

`src/lib/contracts.ts` 第 92 行：

```ts
  type: 'ingest' | 'lint' | 'save-to-wiki' | 'embed-index' | 'curate' | 're-enrich' | 'fix';
```

- [ ] **Step 2: 写 fix-service**

`src/server/services/fix-service.ts`：

```ts
/**
 * Fix service — 任务类型 'fix'：一键修复 Health lint findings。
 * 工作清单 = 新鲜重扫确定性（missing-frontmatter / broken-link）∪ 最近 lint 快照语义
 *   （missing-crossref / contradiction）。
 * 阶段1 确定性：所有 frontmatter 修复合并为一个 Saga commit。
 * 阶段2 LLM：按 pageSlug 分组，逐页 generateStructuredOutput('fix')，自我门控 + validateChangeset
 *   拦截新坏链，每页一个 commit。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('fix', ...)。
 */
import { registerHandler } from '../jobs/worker';
import * as queue from '../jobs/queue';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { enqueueEmbedIndex } from './embedding-service';
import { runDeterministicChecksForSubject } from './lint-deterministic';
import { selectLatestFindings } from './lint-latest';
import { fixMissingFrontmatter, partitionFindings, buildFixWorklist } from './fix-deterministic';
import { readPageInSubject } from '../wiki/wiki-store';
import { buildWikiPath } from '../wiki/page-identity';
import { serializeFrontmatter, stampSystemFrontmatter } from '../wiki/frontmatter';
import { createChangeset, validateChangeset, applyChangeset } from '../wiki/wiki-transaction';
import { generateStructuredOutput } from '../llm/provider-registry';
import { FixPageSchema, FIX_SYSTEM_PROMPT, buildFixPageUserPrompt } from '../llm/prompts/fix-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { ChangesetEntry, Job, LintFinding } from '@/lib/contracts';

interface FixParams {
  subjectId?: string;
}

async function runFixJob(
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
  const { frontmatter, llm } = partitionFindings(worklist);

  emit('fix:start', `Fixing ${frontmatter.length + llm.length} issue(s) in "${subject.slug}"…`, {
    deterministic: frontmatter.length,
    semantic: llm.length,
  });

  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  const byType: Record<string, number> = {};
  const bump = (type: string, n = 1) => {
    byType[type] = (byType[type] ?? 0) + n;
  };

  // 2. 阶段1 确定性 frontmatter 修复 — 合并为一个 commit
  if (frontmatter.length > 0) {
    const now = new Date().toISOString();
    const entries: ChangesetEntry[] = [];
    for (const finding of frontmatter) {
      try {
        const doc = readPageInSubject(subject.slug, finding.pageSlug);
        if (!doc) {
          skipped += 1;
          continue;
        }
        const content = fixMissingFrontmatter(finding.pageSlug, doc, now);
        entries.push({ action: 'update', path: buildWikiPath(subject.slug, finding.pageSlug), content });
      } catch {
        skipped += 1;
      }
    }
    if (entries.length > 0) {
      const changeset = createChangeset(job.id, subject, entries);
      const validation = validateChangeset(changeset);
      if (validation.valid) {
        await applyChangeset(changeset);
        fixed += entries.length;
        bump('missing-frontmatter', entries.length);
        emit('fix:deterministic', `Fixed ${entries.length} frontmatter issue(s).`, { fixed: entries.length });
      } else {
        failed += entries.length;
        emit('fix:warn', `Frontmatter fixes failed validation: ${validation.errors.join('; ')}`, {
          errors: validation.errors,
        });
      }
    }
  }

  // 3. 阶段2 LLM 逐页修复 — 按 pageSlug 分组，每页一个 commit
  const byPage = new Map<string, LintFinding[]>();
  for (const finding of llm) {
    const arr = byPage.get(finding.pageSlug) ?? [];
    arr.push(finding);
    byPage.set(finding.pageSlug, arr);
  }

  const roster = pagesRepo.getAllPages(subject.id).map((p) => ({ slug: p.slug, title: p.title }));
  const promptCtx = {
    language: getWikiLanguage(),
    subject: { slug: subject.slug, name: subject.name, description: subject.description },
  };

  for (const [slug, findingsOnPage] of byPage) {
    const doc = readPageInSubject(subject.slug, slug);
    if (!doc) {
      skipped += findingsOnPage.length;
      emit('fix:skip', `Skip "${slug}": page not found.`, { slug });
      continue;
    }

    let result;
    try {
      result = await generateStructuredOutput(
        'fix',
        FixPageSchema,
        FIX_SYSTEM_PROMPT,
        buildFixPageUserPrompt(
          { slug, title: doc.frontmatter.title, body: doc.body },
          findingsOnPage.map((f) => ({ type: f.type, description: f.description, suggestedFix: f.suggestedFix })),
          roster,
          promptCtx,
        ),
      );
    } catch (err) {
      skipped += findingsOnPage.length;
      emit('fix:skip', `Skip "${slug}": LLM error — ${(err as Error).message}`, { slug });
      continue;
    }

    if (!result.proceed) {
      skipped += findingsOnPage.length;
      emit('fix:skip', `Skip "${slug}": ${result.reason}`, { slug, reason: result.reason });
      continue;
    }

    const now = new Date().toISOString();
    const frontmatterData = {
      ...doc.frontmatter,
      ...(result.summary ? { summary: result.summary } : {}),
    };
    const content = stampSystemFrontmatter(serializeFrontmatter(frontmatterData, result.body), {
      now,
      existingCreated: doc.frontmatter.created,
    });

    const changeset = createChangeset(job.id, subject, [
      { action: 'update', path: buildWikiPath(subject.slug, slug), content },
    ]);
    const validation = validateChangeset(changeset);
    if (!validation.valid) {
      failed += findingsOnPage.length;
      emit('fix:warn', `Skip "${slug}": fix introduced invalid links — ${validation.errors.join('; ')}`, {
        slug,
        errors: validation.errors,
      });
      continue;
    }

    await applyChangeset(changeset);
    fixed += findingsOnPage.length;
    for (const f of findingsOnPage) bump(f.type);
    emit('fix:page', `Repaired "${slug}" (${findingsOnPage.map((f) => f.type).join(', ')}).`, {
      slug,
      types: findingsOnPage.map((f) => f.type),
    });
  }

  if (fixed > 0) enqueueEmbedIndex(subject.id);

  emit('fix:complete', `Fix complete: ${fixed} fixed, ${skipped} skipped, ${failed} failed.`, {
    fixed,
    skipped,
    failed,
    byType,
  });
  return { fixed, skipped, failed, byType };
}

registerHandler('fix', runFixJob);
```

- [ ] **Step 3: 在 worker-entry 注册 service**

`src/server/worker-entry.ts`：在其它 `import './services/*-service';` 行旁边加一行（紧跟 `curate-service` 之后）：

```ts
import './services/fix-service';
```

- [ ] **Step 4: typecheck**

Run: `npx tsc --noEmit`
Expected: 退出码 0（无新增错误）

- [ ] **Step 5: 回归既有测试**

Run: `npx vitest run`
Expected: 全绿（无回归）

- [ ] **Step 6: 提交**

```bash
git add src/lib/contracts.ts src/server/services/fix-service.ts src/server/worker-entry.ts
git commit -m "feat(fix): 新增 fix job 类型与 fix-service 两阶段编排"
```

---

### Task 4: `POST /api/fix` Route Handler

**Files:**
- Create: `src/app/api/fix/route.ts`

**Interfaces:**
- Consumes：`requireAuth(request)` / `requireCsrf(request)`（`@/server/middleware/auth`）、`resolveSubjectFromRequest(request, opts)`（`@/server/middleware/subject`）、`queue.enqueue(type, params, subjectId)`、Task 3 的 `'fix'` job 类型
- Produces：`POST /api/fix` → 202 `{ jobId, subjectId, subjectSlug }`

- [ ] **Step 1: 写 route（仿 `src/app/api/curate/route.ts`）**

`src/app/api/fix/route.ts`：

```ts
import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';

export const runtime = 'nodejs';

/**
 * POST /api/fix — 修复当前 subject lint 发现的可自动修复问题。
 * 异步：入队 'fix' job，立即返回 202 + jobId。
 */
export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }

  const resolution = resolveSubjectFromRequest(request, { required: true, body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const job = queue.enqueue('fix', { subjectId: subject.id }, subject.id);
  return NextResponse.json(
    { jobId: job.id, subjectId: subject.id, subjectSlug: subject.slug },
    { status: 202 },
  );
}
```

- [ ] **Step 2: typecheck**

Run: `npx tsc --noEmit`
Expected: 退出码 0

- [ ] **Step 3: 手动冒烟（需 `npm run dev:all` 在跑）**

Run: `curl -i -X POST http://localhost:3000/api/fix -H 'Content-Type: application/json' -d '{"subjectId":"<某个真实 subjectId>"}'`
Expected: `HTTP/1.1 202` + JSON body 含 `jobId`（无 dev server 则跳过此步，靠 Task 5 的 UI 联调验证）

- [ ] **Step 4: 提交**

```bash
git add src/app/api/fix/route.ts
git commit -m "feat(fix): 新增 POST /api/fix 入队接口"
```

---

### Task 5: Health 页「Fix issues」按钮 + SSE 事件注册

**Files:**
- Modify: `src/components/health/health-view.tsx`
- Modify: `src/hooks/use-job-stream.ts:130-176`（`namedEventTypes` 加 `fix:*`）

**Interfaces:**
- Consumes：Task 4 的 `POST /api/fix`、既有 `useApiFetch()` / `useJobStream(jobId)` / `useLintSummary(allSubjects)`、`runLint()`（同文件已有）
- Produces：Health header 新增 "Fix issues" 按钮 + 完成摘要 banner

- [ ] **Step 1: 注册 fix SSE 事件**

`src/hooks/use-job-stream.ts`，在 `namedEventTypes` 数组里 `// Curate events` 区块之后加：

```ts
        // Fix events
        'fix:start',
        'fix:deterministic',
        'fix:page',
        'fix:skip',
        'fix:warn',
        'fix:complete',
```

- [ ] **Step 2: 接入 fix job 流（health-view.tsx）**

`src/components/health/health-view.tsx`：

1. 顶部 import 加 `Wrench` 图标：

```ts
import { Activity, RefreshCw, Wand2, Wrench } from 'lucide-react';
```

2. 在 `runCurate` 的 state 块之后（`const curating = ...` 那行下面）加 fix 的 state + 摘要类型：

```ts
  const [fixJobId, setFixJobId] = useState<string | null>(null);
  const [fixStarting, setFixStarting] = useState(false);
  const [fixSummary, setFixSummary] = useState<{ fixed: number; skipped: number; failed: number } | null>(null);
  const { status: fixStatus, events: fixEvents, latestMessage: fixMessage } = useJobStream(fixJobId);
  const fixing = fixStarting || (fixJobId !== null && fixStatus !== 'completed' && fixStatus !== 'failed');
```

3. 在 `runCurate` 的 `useEffect` 之后加 fix 完成处理（完成后取摘要 + 失效缓存 + 自动重跑 lint）：

```ts
  useEffect(() => {
    if (fixStatus === 'completed') {
      const done = [...fixEvents].reverse().find((e) => e.type === 'fix:complete');
      const d = done?.data as { fixed?: number; skipped?: number; failed?: number } | undefined;
      setFixSummary({ fixed: d?.fixed ?? 0, skipped: d?.skipped ?? 0, failed: d?.failed ?? 0 });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      setFixJobId(null);
      // 闭环：修复后自动重跑体检刷新 findings
      void runLint();
    } else if (fixStatus === 'failed') {
      setFixJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixStatus, fixEvents]);
```

4. 加 `runFix` 函数（放在 `runCurate` 之后）：

```ts
  async function runFix() {
    setFixStarting(true);
    setFixSummary(null);
    try {
      const res = await apiFetch('/api/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
      if (res.ok) {
        const json = (await res.json()) as { jobId: string };
        setFixJobId(json.jobId);
      }
    } finally {
      setFixStarting(false);
    }
  }
```

5. 在 `switchScope` 里重置 fix 状态（与现有 `setCurateJobId(null)` 同处）：

```ts
    setFixJobId(null);
    setFixSummary(null);
```

- [ ] **Step 3: 加按钮与进度/摘要 UI**

`src/components/health/health-view.tsx`：

1. 在 header 操作区，"Tidy structure" 按钮之后加 "Fix issues" 按钮（在 `<Button ...>Tidy structure</Button>` 下面）：

```tsx
          <Button
            intent="secondary"
            onClick={runFix}
            loading={fixing}
            disabled={allSubjects || neverRun || total === 0 || running || curating}
          >
            <Wrench className="h-3.5 w-3.5" />
            Fix issues
          </Button>
```

2. 在 `{curating && (...)}` 进度提示之后加 fix 进度提示：

```tsx
      {fixing && (
        <p className="text-sm text-foreground-secondary">{fixMessage || 'Fixing issues…'}</p>
      )}
```

3. 在 `{semanticErrored && (...)}` 之后加修复结果摘要 banner：

```tsx
      {fixSummary && (
        <div className="rounded-md border border-accent/40 bg-accent-subtle px-3 py-2 text-sm text-accent-strong">
          Fixed {fixSummary.fixed} · skipped {fixSummary.skipped} (needs manual review)
          {fixSummary.failed > 0 ? ` · failed ${fixSummary.failed}` : ''}. Re-running health check…
        </div>
      )}
```

- [ ] **Step 4: typecheck**

Run: `npx tsc --noEmit`
Expected: 退出码 0

- [ ] **Step 5: 手动联调（`npm run dev:all`）**

1. 打开 `/health`，先点 "Run health check"（或 Re-run）跑出 findings。
2. 确认 "Fix issues" 按钮在「有 findings + 单 subject」时可点；切到 "All subjects" 时禁用。
3. 点 "Fix issues" → 看到进度文案 `fix:*` → 完成后出现摘要 banner → 自动重跑 lint → findings 列表刷新（frontmatter/broken-link/crossref 类减少）。
4. 抽查一两个被修页面：frontmatter 补齐、坏链被重链或拆掉、无新坏链。

Expected: 上述行为全部符合。

- [ ] **Step 6: 提交**

```bash
git add src/components/health/health-view.tsx src/hooks/use-job-stream.ts
git commit -m "feat(fix): Health 页新增一键修复按钮与 SSE 事件接入"
```

---

### Task 6: 文档与 CHANGELOG 收尾

**Files:**
- Modify: `CLAUDE.md`（根，第九节 Changelog 加一行）
- Modify: `src/app/CLAUDE.md`（`/api/fix` 路由 + health 页描述去掉"只读"措辞）
- Modify: `src/server/services/CLAUDE.md`（新增 `fix-service` 段）
- Modify: `src/components/CLAUDE.md`（`health/health-view.tsx` 描述补 "Fix issues"）
- Modify: `src/server/llm/CLAUDE.md`（BUILTIN task 加 `fix` + `fix-prompt.ts`）

**Interfaces:** 无（纯文档）

- [ ] **Step 1: 更新根 CLAUDE.md Changelog**

在第九节表格末尾加一行：

```markdown
| 2026-06-24 | Health 一键修复 findings | Health 页加 "Fix issues" 按钮 → 异步 `fix` job（`fix-service`）：工作清单=新鲜重扫确定性(missing-frontmatter/broken-link)∪最近 lint 快照语义(missing-crossref/contradiction)；阶段1 确定性补 frontmatter(1 commit)，阶段2 按页 `generateStructuredOutput('fix')` 逐页修复(自我门控+validateChangeset 拦新坏链，每页 1 commit)；orphan/stale-source/coverage-gap 不修。新增 `fix-deterministic.ts`(纯函数)+`fix-prompt.ts`+`POST /api/fix`+`use-job-stream` 注册 `fix:*`；完成后自动重跑 lint 闭环。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-24-health-fix-findings* |
```

- [ ] **Step 2: 更新各模块 CLAUDE.md**

- `src/app/CLAUDE.md`：health 页行去掉"（只读，自动修复见后续特性）"，改为"（含 'Fix issues' 一键修复入口）"；路由表加 `/api/fix` POST 行：`入队 'fix' 任务修复当前 subject lint findings（确定性+LLM 两阶段）；返回 202 + jobId`。
- `src/server/services/CLAUDE.md`：在 curate-service 段后加 `fix-service.ts` 段（任务类型 `'fix'`，两阶段流程，复用 `fix-deterministic` 纯函数 + `page-ops` 不复用——直接 Saga）；文件清单加 `fix-service.ts` / `fix-deterministic.ts`。
- `src/components/CLAUDE.md`：`health/health-view.tsx` 行补 "Fix issues 按钮（POST /api/fix + useJobStream 追踪 fix:*，完成后自动重跑 lint）"。
- `src/server/llm/CLAUDE.md`：扩展指南/清单加 `fix` builtin task 与 `prompts/fix-prompt.ts`。

- [ ] **Step 3: 提交**

```bash
git add CLAUDE.md src/app/CLAUDE.md src/server/services/CLAUDE.md src/components/CLAUDE.md src/server/llm/CLAUDE.md
git commit -m "docs(fix): 记录 Health 一键修复特性与模块文档"
```

---

## Self-Review

**Spec coverage（逐节核对）：**
- 范围路由表（spec §二决策1）→ Task 1 `partitionFindings`/`DETERMINISTIC_FIX_TYPES`/`LLM_FIX_TYPES` + Task 3 工作清单 filter。✓
- 新 `fix` job + subject-scoped 异步（§决策2）→ Task 3（job 类型 + service）+ Task 4（route）。✓
- 工作清单=新鲜确定性∪快照语义（§决策3）→ Task 3 Step 2（`runDeterministicChecksForSubject` + `selectLatestFindings`）+ Task 1 `buildFixWorklist`。✓
- LLM 逐条自我门控 + validateChangeset 拦坏链（§决策4）→ Task 2 schema `proceed` + Task 3 `!result.proceed` 分支 + `validateChangeset` 分支。✓
- 提交粒度：确定性 1 commit + LLM 每页 1 commit（§决策5）→ Task 3 阶段1/阶段2。✓
- UI 单按钮 + 禁用条件 + 摘要 + 自动重跑 lint（§四）→ Task 5。✓
- SSE 事件（§五）→ Task 3 emit + Task 5 Step 1 注册。✓
- 测试策略（§七）→ Task 1（纯函数）+ Task 2（prompt builder）。✓

**Placeholder scan：** 无 TBD/TODO；每个代码步骤含完整可粘贴代码。✓

**Type consistency：** `fixMissingFrontmatter(slug, doc, now)` / `partitionFindings`→`{frontmatter,llm,ignored}` / `buildFixWorklist(det, sem)` / `FixPageSchema`→`{proceed,reason,body,summary?}` / `buildFixPageUserPrompt(page, findings, roster, ctx)` 在 Task 1/2 定义、Task 3 按同名同签名消费。`queue.enqueue('fix', { subjectId }, subject.id)` 与 `enqueue(type, params?, subjectId?)` 一致。✓

**注记：** services 层在本仓库无单测（见 `src/server/services/CLAUDE.md`），故 Task 3/4 以 `tsc --noEmit` + `vitest run` 回归 + Task 5 UI 联调为验证门，与既有 curate/lint service 的验证方式一致。
