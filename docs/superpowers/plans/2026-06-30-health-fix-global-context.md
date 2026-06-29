# Health 一键修复注入全局诊断上下文 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `fix-service` 逐页 LLM 修复时额外注入「整个 subject 的可修复 findings 报告」+「本页 findings 涉及的关联页正文」两块只读上下文，让 LLM 看到全局而非孤立单页，减少跨页问题修不掉与反复点击。

**Architecture:** 不改提交粒度（仍每页一个 Saga commit）。新增两个纯函数（`findRelatedPageSlugs` / `buildSubjectReportLines`，放 `fix-deterministic.ts`）+ `buildFixPageUserPrompt` 增第 5 个可选参数 `extra` 渲染两段只读上下文 + `fix-service.ts` 编排（构建报告一次、逐页算关联页并实时读盘）。`FixPageSchema`/路由/UI/DB 零改动。

**Tech Stack:** TypeScript 5、Zod、Vercel AI SDK（`generateStructuredOutput`）、vitest。

## Global Constraints

- 纯函数无 side effect（不触 DB/fs/LLM），集中在 `src/server/services/fix-deterministic.ts`；字符串格式化在 `src/server/llm/prompts/fix-prompt.ts`。
- `extra` 全缺省时 `buildFixPageUserPrompt` 输出必须与改动前**逐字一致**（基线兼容，单测对照）。
- Token 护栏常量：`MAX_RELATED_PAGES = 4`、`REPORT_DESC_MAX = 200`（放 `fix-deterministic.ts`，导出供测试）；`RELATED_BODY_MAX = 8000`（放 `fix-service.ts`，正文截断用）。
- 关联页提取靠描述文本启发式匹配 roster 的 slug/title，**词边界整词匹配、大小写不敏感**；contradiction 兜底纳入"其他带 contradiction finding 的页"。
- LLM 仍只编辑当前待修页、每页一个 commit；不引入 agent runtime；测试只覆盖纯函数与 prompt 渲染（LLM 阶段不做端到端单测，沿用项目惯例）。
- 工作目录为 worktree `../agentic-wiki-feat-health-fix-global-context`（分支 `feat/health-fix-global-context`）；commit message 用中文。

---

## Task 0: worktree 环境准备（运行测试前置）

**Files:** 无代码改动（仅环境）。

git worktree 不含 `node_modules`（gitignored、不随 worktree 复制）。运行 `vitest` / `tsc` 前需让 worktree 能解析依赖。

- [ ] **Step 1: 在 worktree 根目录软链 node_modules 指向主仓库**

Run:
```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context
[ -e node_modules ] || ln -s ../agentic-wiki/node_modules node_modules
```
Expected: 无输出（成功）；`ls -la node_modules` 显示符号链接指向 `../agentic-wiki/node_modules`。

- [ ] **Step 2: 冒烟验证依赖可解析**

Run:
```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context && npx vitest run src/server/services/__tests__/fix-deterministic.test.ts 2>&1 | tail -5
```
Expected: 现有 fix-deterministic 测试全部 PASS（证明 vitest + 依赖在 worktree 内可跑）。

---

## Task 1: 纯函数 `findRelatedPageSlugs` + `buildSubjectReportLines`

**Files:**
- Modify: `src/server/services/fix-deterministic.ts`
- Test: `src/server/services/__tests__/fix-deterministic.test.ts`

**Interfaces:**
- Produces:
  - `export const MAX_RELATED_PAGES = 4`
  - `export const REPORT_DESC_MAX = 200`
  - `findRelatedPageSlugs(pageSlug: string, findingsOnPage: { type: string; description: string; suggestedFix: string | null }[], roster: { slug: string; title: string }[], contradictionPageSlugs?: ReadonlySet<string>): string[]`
  - `buildSubjectReportLines(worklist: LintFinding[]): { slug: string; lines: string[] }[]`

- [ ] **Step 1: 在测试文件顶部 import 新函数**

Modify `src/server/services/__tests__/fix-deterministic.test.ts` 的 import 块：

```ts
import {
  fixMissingFrontmatter,
  partitionFindings,
  buildFixWorklist,
  bodyShrankTooMuch,
  findRelatedPageSlugs,
  buildSubjectReportLines,
} from '../fix-deterministic';
```

- [ ] **Step 2: 追加失败测试到文件末尾**

在 `src/server/services/__tests__/fix-deterministic.test.ts` 末尾追加（复用文件顶部已有的 `f` helper）：

```ts
describe('findRelatedPageSlugs', () => {
  const roster = [
    { slug: 'react', title: 'React' },
    { slug: 'vue', title: 'Vue' },
    { slug: 'category', title: 'Category Theory' },
  ];

  it('contradiction 描述含对方 slug → 召回对方、排除自身', () => {
    const findings = [f('contradiction', 'react', 'react conflicts with vue on lifecycle')];
    expect(findRelatedPageSlugs('react', findings, roster)).toEqual(['vue']);
  });

  it('描述含 roster title（大小写不敏感整词）→ 召回', () => {
    const findings = [f('missing-crossref', 'react', 'mentions VUE but no link')];
    expect(findRelatedPageSlugs('react', findings, roster)).toContain('vue');
  });

  it('词边界：cat 不命中 category 子串', () => {
    const roster2 = [{ slug: 'cat', title: 'Cat' }];
    const findings = [f('broken-link', 'p', 'see the category page')];
    expect(findRelatedPageSlugs('p', findings, roster2)).toEqual([]);
  });

  it('contradiction 兜底：描述无匹配但有其他 contradiction 页 → 召回（排除自身）', () => {
    const findings = [f('contradiction', 'react', 'states something is true')];
    const out = findRelatedPageSlugs('react', findings, roster, new Set(['vue', 'react']));
    expect(out).toEqual(['vue']);
  });

  it('非 contradiction 不触发兜底', () => {
    const findings = [f('broken-link', 'react', 'no roster names here')];
    expect(findRelatedPageSlugs('react', findings, roster, new Set(['vue']))).toEqual([]);
  });

  it('上限 cap=4 且去重', () => {
    const big = Array.from({ length: 8 }, (_, i) => ({ slug: `p${i}`, title: `P${i}` }));
    const desc = big.map((r) => r.slug).join(' ');
    const findings = [f('contradiction', 'src', desc), f('broken-link', 'src', desc)];
    const out = findRelatedPageSlugs('src', findings, big);
    expect(out).toHaveLength(4);
    expect(new Set(out).size).toBe(4);
  });
});

describe('buildSubjectReportLines', () => {
  it('按 pageSlug 分组、按首次出现保序、行格式 type: desc', () => {
    const wl = [
      f('broken-link', 'a', 'L1'),
      f('contradiction', 'b', 'C1'),
      f('missing-crossref', 'a', 'X1'),
    ];
    const out = buildSubjectReportLines(wl);
    expect(out.map((p) => p.slug)).toEqual(['a', 'b']);
    expect(out[0].lines).toEqual(['broken-link: L1', 'missing-crossref: X1']);
    expect(out[1].lines).toEqual(['contradiction: C1']);
  });

  it('超长描述被截断并加省略号', () => {
    const long = 'x'.repeat(300);
    const out = buildSubjectReportLines([f('broken-link', 'a', long)]);
    expect(out[0].lines[0].endsWith('…')).toBe(true);
    expect(out[0].lines[0].length).toBeLessThan(220);
  });
});
```

- [ ] **Step 3: 运行测试，确认失败**

Run:
```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context && npx vitest run src/server/services/__tests__/fix-deterministic.test.ts 2>&1 | tail -15
```
Expected: FAIL —— `findRelatedPageSlugs is not a function` / `buildSubjectReportLines is not a function`（导入未定义）。

- [ ] **Step 4: 实现两个纯函数**

在 `src/server/services/fix-deterministic.ts` 末尾追加（文件已 `import type { LintFinding, ... } from '@/lib/contracts'`）：

```ts
// ── 全局上下文：关联页提取 + 诊断报告分组（纯函数）────────────────────────────

export const MAX_RELATED_PAGES = 4;
export const REPORT_DESC_MAX = 200;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 词边界整词匹配（大小写不敏感）；连字符视为词内字符，避免 react-hooks 命中 react-hooks-x */
function mentions(haystack: string, needle: string): boolean {
  const n = needle.trim();
  if (n.length === 0) return false;
  const re = new RegExp(`(?:^|[^\\w-])${escapeRegExp(n)}(?:[^\\w-]|$)`, 'i');
  return re.test(haystack);
}

/**
 * 从本页各 finding 的描述文本里启发式提取"关联页"slug（用于注入对方页正文）。
 * 匹配 roster 中任一页的 slug 或 title（词边界、大小写不敏感），排除自身。
 * contradiction 兜底：本页有 contradiction 却没匹到任何关联页时，纳入 contradictionPageSlugs
 * （service 从整个 worklist 预计算的"带 contradiction finding 的全部页"集合，仍排除自身）。
 * 去重、按出现顺序稳定，最多 MAX_RELATED_PAGES 个。
 */
export function findRelatedPageSlugs(
  pageSlug: string,
  findingsOnPage: { type: string; description: string; suggestedFix: string | null }[],
  roster: { slug: string; title: string }[],
  contradictionPageSlugs?: ReadonlySet<string>,
): string[] {
  const related: string[] = [];
  const seen = new Set<string>();
  const add = (slug: string) => {
    if (slug === pageSlug || seen.has(slug)) return;
    seen.add(slug);
    related.push(slug);
  };

  for (const finding of findingsOnPage) {
    const haystack = `${finding.description} ${finding.suggestedFix ?? ''}`;
    for (const r of roster) {
      if (r.slug === pageSlug) continue;
      if (mentions(haystack, r.slug) || mentions(haystack, r.title)) add(r.slug);
    }
  }

  const hasContradiction = findingsOnPage.some((f) => f.type === 'contradiction');
  if (hasContradiction && related.length === 0 && contradictionPageSlugs) {
    for (const slug of contradictionPageSlugs) add(slug);
  }

  return related.slice(0, MAX_RELATED_PAGES);
}

/**
 * 把整个工作清单按 pageSlug 分组成紧凑诊断报告数据（字符串渲染在 fix-prompt 层）。
 * 按首次出现保序；每条行格式 `<type>: <截断描述>`。
 */
export function buildSubjectReportLines(
  worklist: LintFinding[],
): { slug: string; lines: string[] }[] {
  const byPage = new Map<string, string[]>();
  const order: string[] = [];
  for (const finding of worklist) {
    if (!byPage.has(finding.pageSlug)) {
      byPage.set(finding.pageSlug, []);
      order.push(finding.pageSlug);
    }
    const desc =
      finding.description.length > REPORT_DESC_MAX
        ? `${finding.description.slice(0, REPORT_DESC_MAX)}…`
        : finding.description;
    byPage.get(finding.pageSlug)!.push(`${finding.type}: ${desc}`);
  }
  return order.map((slug) => ({ slug, lines: byPage.get(slug)! }));
}
```

- [ ] **Step 5: 运行测试，确认通过**

Run:
```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context && npx vitest run src/server/services/__tests__/fix-deterministic.test.ts 2>&1 | tail -10
```
Expected: 全部 PASS（含原有用例 + 新增 8 例）。

- [ ] **Step 6: 提交**

```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context
git add src/server/services/fix-deterministic.ts src/server/services/__tests__/fix-deterministic.test.ts
git commit -m "feat(health-fix): 新增关联页提取与全局诊断报告分组纯函数"
```

---

## Task 2: `buildFixPageUserPrompt` 注入两段只读上下文 + 系统提示

**Files:**
- Modify: `src/server/llm/prompts/fix-prompt.ts`
- Test: `src/server/llm/prompts/__tests__/fix-prompt.test.ts`

**Interfaces:**
- Consumes: `buildSubjectReportLines` 的返回类型 `{ slug: string; lines: string[] }[]`（作为 `extra.subjectReport`）。
- Produces: `buildFixPageUserPrompt(page, findings, roster, ctx, extra?)`，其中
  `extra?: { subjectReport?: { slug: string; lines: string[] }[]; relatedPages?: { title: string; slug: string; body: string }[] }`。

- [ ] **Step 1: 追加失败测试到文件末尾**

在 `src/server/llm/prompts/__tests__/fix-prompt.test.ts` 末尾追加：

```ts
describe('buildFixPageUserPrompt — extra 只读上下文', () => {
  const page = { slug: 'react', title: 'React', body: 'React body' };
  const findings = [
    { type: 'contradiction', description: 'conflicts with vue', suggestedFix: null },
  ];
  const roster = [{ slug: 'vue', title: 'Vue' }];

  it('传 subjectReport 渲染全局报告段', () => {
    const out = buildFixPageUserPrompt(page, findings, roster, ctx, {
      subjectReport: [{ slug: 'vue', lines: ['contradiction: conflicts with react'] }],
    });
    expect(out).toContain('Subject-wide health report');
    expect(out).toContain('contradiction: conflicts with react');
  });

  it('传 relatedPages 渲染关联页段且含正文', () => {
    const out = buildFixPageUserPrompt(page, findings, roster, ctx, {
      relatedPages: [{ title: 'Vue', slug: 'vue', body: 'Vue is a framework.' }],
    });
    expect(out).toContain('Related pages');
    expect(out).toContain('Vue is a framework.');
  });

  it('relatedPages 为空数组不渲染该段', () => {
    const out = buildFixPageUserPrompt(page, findings, roster, ctx, { relatedPages: [] });
    expect(out).not.toContain('Related pages');
  });

  it('不传 extra（或空对象）与基线逐字一致', () => {
    const base = buildFixPageUserPrompt(page, findings, roster, ctx);
    const withEmpty = buildFixPageUserPrompt(page, findings, roster, ctx, {});
    expect(withEmpty).toBe(base);
    expect(base).not.toContain('Subject-wide health report');
    expect(base).not.toContain('Related pages');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run:
```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context && npx vitest run src/server/llm/prompts/__tests__/fix-prompt.test.ts 2>&1 | tail -15
```
Expected: FAIL —— 报告段/关联页段缺失（`expect(...).toContain('Subject-wide health report')` 失败），因 `buildFixPageUserPrompt` 尚未接受第 5 参数。

- [ ] **Step 3: 给 `buildFixPageUserPrompt` 加 `extra` 参数并渲染两段**

修改 `src/server/llm/prompts/fix-prompt.ts` 的 `buildFixPageUserPrompt`。新签名与函数体（替换现有同名函数；保持 `languageDirective`/`subjectSection`/`issuesSection`/`rosterSection` 原样，仅加两段并在 return 模板中间插入）：

```ts
export function buildFixPageUserPrompt(
  page: { slug: string; title: string; body: string },
  findings: { type: string; description: string; suggestedFix: string | null }[],
  roster: { slug: string; title: string }[],
  ctx: PromptContext,
  extra?: {
    subjectReport?: { slug: string; lines: string[] }[];
    relatedPages?: { title: string; slug: string; body: string }[];
  },
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

  const reportSection =
    extra?.subjectReport && extra.subjectReport.length > 0
      ? `\n## Subject-wide health report (read-only context)\n` +
        `These are ALL outstanding issues across this subject, grouped by page. Use this only to understand the bigger picture (e.g. another page references this one). You may ONLY edit the page under repair below — do NOT attempt to edit other pages.\n\n` +
        extra.subjectReport
          .map((p) => `### \`${p.slug}\`\n${p.lines.map((l) => `- ${l}`).join('\n')}`)
          .join('\n\n') +
        `\n`
      : '';

  const relatedSection =
    extra?.relatedPages && extra.relatedPages.length > 0
      ? `\n## Related pages (read-only — current content of pages your findings reference)\n` +
        `Provided so you can reconcile cross-page issues (especially contradictions). Treat as reference only; do not copy wholesale and do not edit them.\n\n` +
        extra.relatedPages
          .map((p) => `### [[${p.title}]] (slug: \`${p.slug}\`)\n${p.body}`)
          .join('\n\n') +
        `\n`
      : '';

  return `${languageDirective}${subjectSection}## Page under repair: [[${page.title}]] (slug: \`${page.slug}\`)

### Current body
${page.body}

### Issues to repair on this page
${issuesSection}
${reportSection}${relatedSection}
### Page roster (the ONLY valid wikilink targets in this subject)
${rosterSection}

---

Repair the listed issues faithfully and return the corrected body. If you cannot do so confidently, set proceed=false.`;
}
```

> 说明：`reportSection`/`relatedSection` 缺省时为空串，模板中 `${issuesSection}\n${reportSection}${relatedSection}\n### Page roster` 退化为 `${issuesSection}\n\n### Page roster`，与改动前逐字一致（基线兼容测试覆盖）。

- [ ] **Step 4: 在 `FIX_SYSTEM_PROMPT` 末尾追加"只读上下文"约束**

修改 `src/server/llm/prompts/fix-prompt.ts` 的 `FIX_SYSTEM_PROMPT` 常量，在结尾 `set proceed=false with a clear reason.` 这一行之后、闭合反引号之前追加：

```
\`\`\`

## Wider context (read-only)
- You may also be shown a **subject-wide health report** (all outstanding issues, grouped by page) and the **current content of related pages**. These are READ-ONLY — they exist only to help you understand cross-page issues. Always return ONLY the corrected body of the page under repair; never edit, or describe edits to, any other page.
- For **contradiction**: when related pages are shown, use them to make THIS page consistent with the rest of the subject and faithful to the source material. If you still cannot tell which side is correct, set proceed=false.\`;
```

> 实操：把原常量结尾
> ```
> - If you cannot fix the issues without risky changes, set proceed=false with a clear reason.`;
> ```
> 替换为
> ```
> - If you cannot fix the issues without risky changes, set proceed=false with a clear reason.
>
> ## Wider context (read-only)
> - You may also be shown a **subject-wide health report** (all outstanding issues, grouped by page) and the **current content of related pages**. These are READ-ONLY — they exist only to help you understand cross-page issues. Always return ONLY the corrected body of the page under repair; never edit, or describe edits to, any other page.
> - For **contradiction**: when related pages are shown, use them to make THIS page consistent with the rest of the subject and faithful to the source material. If you still cannot tell which side is correct, set proceed=false.`;
> ```

- [ ] **Step 5: 运行测试，确认通过**

Run:
```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context && npx vitest run src/server/llm/prompts/__tests__/fix-prompt.test.ts 2>&1 | tail -10
```
Expected: 全部 PASS（含原有 2 例 + 新增 4 例）。

- [ ] **Step 6: 提交**

```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context
git add src/server/llm/prompts/fix-prompt.ts src/server/llm/prompts/__tests__/fix-prompt.test.ts
git commit -m "feat(health-fix): 修复 prompt 注入全局诊断报告与关联页正文两段只读上下文"
```

---

## Task 3: `fix-service` 编排——构建报告、逐页算关联页、实时读盘注入

**Files:**
- Modify: `src/server/services/fix-service.ts`

**Interfaces:**
- Consumes:
  - `findRelatedPageSlugs(pageSlug, findingsOnPage, roster, contradictionPageSlugs?)`、`buildSubjectReportLines(worklist)`（Task 1）
  - `buildFixPageUserPrompt(page, findings, roster, ctx, extra?)`（Task 2）
  - 既有 `readPageInSubject(subjectSlug, slug)` → `WikiDocument | null`（`{ frontmatter:{title,...}, body, links }`）

无单测（编排层触 DB/fs/LLM，沿用项目惯例）；本任务以 `tsc --noEmit` 通过为门控。

- [ ] **Step 1: 扩展 import，加入两个纯函数**

修改 `src/server/services/fix-service.ts` 中对 `./fix-deterministic` 的 import：

```ts
import {
  fixMissingFrontmatter,
  partitionFindings,
  buildFixWorklist,
  bodyShrankTooMuch,
  findRelatedPageSlugs,
  buildSubjectReportLines,
} from './fix-deterministic';
```

- [ ] **Step 2: 在阶段 2 之前构建报告与 contradiction 页集合（各一次）**

在 `fix-service.ts` 中、`roster` 与 `promptCtx` 定义之后（即 `for (const [slug, findingsOnPage] of byPage)` 循环之前）插入：

```ts
  // 全局只读上下文（对每页调用复用，构建一次）
  const RELATED_BODY_MAX = 8000;
  const subjectReport = buildSubjectReportLines(worklist);
  const contradictionPages = new Set(
    worklist.filter((f) => f.type === 'contradiction').map((f) => f.pageSlug),
  );
```

> `worklist` 已在函数上方定义（`const worklist = buildFixWorklist(...)`），此处直接复用。

- [ ] **Step 3: 逐页计算关联页并实时读盘，传入 `buildFixPageUserPrompt` 第 5 参数**

在循环体内，将原有的 `generateStructuredOutput('fix', ...)` 调用块改为先算关联页、再传 `extra`。把原代码：

```ts
    let result: FixPageResult;
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
```

替换为：

```ts
    // 关联页：从本页 findings 描述里启发式提取，实时读盘取最新内容（前面已 commit 的页可拿到修后正文）
    const relatedSlugs = findRelatedPageSlugs(slug, findingsOnPage, roster, contradictionPages);
    const relatedPages = relatedSlugs
      .map((s) => {
        const rdoc = readPageInSubject(subject.slug, s);
        return rdoc
          ? { title: rdoc.frontmatter.title || s, slug: s, body: rdoc.body.slice(0, RELATED_BODY_MAX) }
          : null;
      })
      .filter((x): x is { title: string; slug: string; body: string } => x !== null);

    let result: FixPageResult;
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
          { subjectReport, relatedPages },
        ),
      );
    } catch (err) {
```

- [ ] **Step 4: 类型检查通过**

Run:
```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context && npx tsc --noEmit 2>&1 | tail -20
```
Expected: 无错误输出（exit 0）。若报 `readPageInSubject` 的返回类型缺 `frontmatter.title`，核对 `WikiDocument` 契约——`title` 为 `string`，`|| s` 兜底空串。

- [ ] **Step 5: 提交**

```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context
git add src/server/services/fix-service.ts
git commit -m "feat(health-fix): fix-service 逐页注入全局诊断报告与关联页正文上下文"
```

---

## Task 4: 全量验证 + 回合主分支

**Files:** 无代码改动。

- [ ] **Step 1: 跑全量类型检查**

Run:
```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context && npx tsc --noEmit 2>&1 | tail -20
```
Expected: exit 0，无错误。

- [ ] **Step 2: 跑相关单测（两个改动文件 + 全量回归）**

Run:
```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context && npx vitest run 2>&1 | tail -15
```
Expected: 全部 PASS（无回归）。如全量太慢，至少跑 `npx vitest run src/server/services/__tests__/fix-deterministic.test.ts src/server/llm/prompts/__tests__/fix-prompt.test.ts`。

- [ ] **Step 3: 确认主仓库工作树未被污染（防 worktree 写入泄漏）**

Run:
```bash
git -C /Users/nickhopps/Documents/playground/agentic-wiki status --short
```
Expected: 仅 `?? IDEAS.md`（改动应全在 worktree 内）。若出现本特性相关文件，说明写入泄漏，需 `git -C .../agentic-wiki restore` 复位。

- [ ] **Step 4: 回合主分支并清理 worktree**

```bash
cd /Users/nickhopps/Documents/playground/agentic-wiki
git merge --ff-only feat/health-fix-global-context
# 删除 node_modules 软链后移除 worktree
rm -f /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context/node_modules
git worktree remove /Users/nickhopps/Documents/playground/agentic-wiki-feat-health-fix-global-context
git branch -d feat/health-fix-global-context
git log --oneline -5
```
Expected: main 快进合并；worktree 与分支清理完毕；`git log` 顶部为本次 4 个 commit（spec + 3 实现）。

---

## Self-Review（计划对照 spec）

- **spec §三 改动文件表**：`fix-deterministic.ts`（Task 1）、`fix-prompt.ts`（Task 2）、`fix-service.ts`（Task 3）、两个测试文件（Task 1/2）——全覆盖。`contracts.ts`/`config-schema.ts`/路由/`health-view.tsx`/SSE 均无改动 ✓（计划无对应任务，符合 spec"零改动"声明）。
- **spec §四 关联页规则**：`findRelatedPageSlugs` 实现含 slug/title 词边界匹配、排除自身、contradiction 兜底、cap=4——Task 1 Step 4 + 测试 Step 2 全覆盖 ✓。
- **spec §五 Prompt 渲染**：两段标题与文案、插入位置（issues 与 roster 之间）、空数据不渲染——Task 2 ✓。
- **spec §六 边界**：`extra` 全缺省基线一致（Task 2 测试）、关联页读盘失败 filter 掉（Task 3 Step 3 `.filter`）、token cap（`RELATED_BODY_MAX`/`REPORT_DESC_MAX`/`MAX_RELATED_PAGES`）✓。
- **spec §七 测试策略**：`findRelatedPageSlugs`/`buildSubjectReportLines`/`buildFixPageUserPrompt` 三组单测——Task 1/2 ✓。
- **类型一致性**：`subjectReport` 类型 `{slug,lines}[]` 在 Task 1（produces）、Task 2（consumes extra.subjectReport）、Task 3（传入）三处一致 ✓；`findRelatedPageSlugs` 第 4 参数 `ReadonlySet<string>` 与 Task 3 传入的 `new Set(...)` 兼容 ✓。
- **偏离 spec 说明**：spec §三示例把 `extra.subjectReport` 标注为 `string`（"已格式化段正文"），计划改为结构化 `{slug,lines}[]` 由 prompt 层渲染——更可测、分层更干净（数据提取在 fix-deterministic、字符串在 fix-prompt），与 spec "字符串格式化放 fix-prompt.ts" 的意图一致。
