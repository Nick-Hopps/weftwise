# Ask AI 内联引用 + 确定性解析 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ask AI 引用改为「模型内联 `[[slug]]` + 流末确定性解析」，删除流末二次全量 LLM 引用调用；coverage 判定拆成异步小调用。

**Architecture:** 新增纯函数模块 `citation-extract.ts`（wikilink 解析 ∩ accessed.bodies 交集 + 词重叠 excerpt 抽取）；`QUERY_AGENTIC_SYSTEM_PROMPT` 加内联引用纪律；`/api/query` 流式分支与 `runQuery` 改调纯函数并 fire-and-forget coverage 判定；退役 `generateQueryCitations`。

**Tech Stack:** TypeScript / vitest / 现成 `wiki/wikilinks.ts::extractWikiLinks` / Vercel AI SDK `generateObject`（仅 coverage 小调用）。

**Spec:** `docs/superpowers/specs/2026-07-07-inline-citations-design.md`

## Global Constraints

- 中文 comment / commit message（一句话总结变更）；commit 不加 AI 署名 trailer。
- 对外契约 `{ pageSlug, excerpt }[]` 与前端 `Citation` 类型不变；`save-to-wiki`、会话落库零改动。
- 校验用 `npx tsc --noEmit` + `npx vitest run <file>`（`npm run lint` 在本仓库不可用）。
- 答案正文中的 `[[slug]]` 保留不剥离（chat 渲染层已支持 wikilink）。
- 空库短路路径（`NO_QUERY_CONTEXT_ANSWER` + `recordCoverageGap`）行为不变。

---

### Task 1: `citation-extract.ts` 纯函数模块

**Files:**
- Create: `src/server/services/citation-extract.ts`
- Test: `src/server/services/__tests__/citation-extract.test.ts`

**Interfaces:**
- Consumes: `wiki/wikilinks.ts::extractWikiLinks(markdown, { currentSubjectSlug, titleResolver })`（`ExtractedLink { target, targetSubjectSlug, raw, position: { start, end } }`）；`query-tools.ts::AccessedPages`（`{ meta: Map<slug,{title,summary}>, bodies: Map<slug,{title,body}> }`）。
- Produces: `extractCitationsFromAnswer(answer: string, accessed: AccessedPages, subjectSlug: string): { pageSlug: string; excerpt: string }[]`；`pickExcerpt(anchorText: string, pageBody: string): string`（导出供单测）。

- [ ] **Step 1: 写失败测试**

```ts
// src/server/services/__tests__/citation-extract.test.ts
import { describe, it, expect } from 'vitest';
import { extractCitationsFromAnswer, pickExcerpt } from '../citation-extract';
import type { AccessedPages } from '../query-tools';

function accessedWith(bodies: Record<string, { title: string; body: string }>): AccessedPages {
  return { meta: new Map(), bodies: new Map(Object.entries(bodies)) };
}

describe('extractCitationsFromAnswer', () => {
  const body = 'SQLite 使用 WAL 模式提升并发读性能。写事务仍然串行。FTS5 提供全文索引。';

  it('解析 [[slug]] 并与 bodies 求交集，excerpt 来自页面原文', () => {
    const accessed = accessedWith({ sqlite: { title: 'SQLite', body } });
    const out = extractCitationsFromAnswer(
      'SQLite 的 WAL 模式提升了并发读性能 [[sqlite]]。',
      accessed,
      'general',
    );
    expect(out).toHaveLength(1);
    expect(out[0].pageSlug).toBe('sqlite');
    expect(body.includes(out[0].excerpt)).toBe(true);
  });

  it('未 read 过的页（幻觉链接 / 仅 search 命中）被丢弃', () => {
    const accessed = accessedWith({ sqlite: { title: 'SQLite', body } });
    accessed.meta.set('postgres', { title: 'Postgres', summary: '' });
    const out = extractCitationsFromAnswer(
      '参见 [[postgres]] 与 [[ghost-page]] 和 [[sqlite]]。',
      accessed,
      'general',
    );
    expect(out.map((c) => c.pageSlug)).toEqual(['sqlite']);
  });

  it('[[Title]] 形式经 accessed 标题兜底解析到 slug', () => {
    const accessed = accessedWith({ 'wal-mode': { title: 'WAL Mode', body } });
    const out = extractCitationsFromAnswer('详见 [[WAL Mode]]。', accessed, 'general');
    expect(out.map((c) => c.pageSlug)).toEqual(['wal-mode']);
  });

  it('同 slug 多次出现只留一条（取首次锚点）；跨主题前缀链接丢弃', () => {
    const accessed = accessedWith({ sqlite: { title: 'SQLite', body } });
    const out = extractCitationsFromAnswer(
      'WAL 提升并发 [[sqlite]]，另见 [[other-subject:sqlite]]，FTS5 相关 [[sqlite]]。',
      accessed,
      'general',
    );
    expect(out).toHaveLength(1);
  });

  it('无任何 wikilink → 空数组', () => {
    const accessed = accessedWith({ sqlite: { title: 'SQLite', body } });
    expect(extractCitationsFromAnswer('没有引用的回答。', accessed, 'general')).toEqual([]);
  });
});

describe('pickExcerpt', () => {
  const body = [
    '# 标题',
    '',
    'SQLite 使用 WAL 模式提升并发读性能。写事务仍然串行执行。',
    '',
    'FTS5 是 SQLite 的全文索引扩展。它支持 BM25 排序。',
  ].join('\n');

  it('选中与锚点词重叠最高的句子', () => {
    const ex = pickExcerpt('FTS5 提供全文索引能力', body);
    expect(ex).toContain('FTS5');
    expect(ex).not.toContain('# 标题');
  });

  it('零重叠时回落正文开头', () => {
    const ex = pickExcerpt('完全无关的锚点文本 zzz', body);
    expect(ex.length).toBeGreaterThan(0);
    expect(body.includes(ex)).toBe(true);
  });

  it('excerpt 长度受上限约束（≤400 字符）', () => {
    const long = 'A'.repeat(1000) + '。' + 'B'.repeat(1000) + '。';
    expect(pickExcerpt('AAAA', long).length).toBeLessThanOrEqual(400);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/citation-extract.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 最小实现**

```ts
// src/server/services/citation-extract.ts
/**
 * Ask AI 内联引用的确定性解析（零 LLM）。
 *
 * 模型在回答正文中内联 [[slug]] 标注依据（prompt 纪律），流结束后：
 *   1. extractWikiLinks 解析答案全文（accessed 标题兜底 titleResolver）；
 *   2. 目标 slug ∩ accessed.bodies（真正 read 过的页）——幻觉链接/未读页丢弃；
 *   3. 按 slug 去重（取首次出现的锚点句），excerpt 从页面原文词重叠抽取。
 */
import { extractWikiLinks } from '../wiki/wikilinks';
import { normalizeSlug } from '../wiki/page-identity';
import type { AccessedPages } from './query-tools';

const EXCERPT_MAX_CHARS = 400;
const EXCERPT_MAX_SENTENCES = 3;

/** 中英通用分词：latin 词 + CJK 相邻双字（bigram）。 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]+/g)) tokens.add(m[0]);
  const cjk = text.match(/[一-鿿]/g) ?? [];
  for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk[i] + cjk[i + 1]);
  return tokens;
}

/** 按句界切分正文（跳过标题/空行/代码围栏行）。 */
function splitSentences(body: string): string[] {
  const prose = body
    .split('\n')
    .filter((line) => !/^\s*(#|```|\||>)/.test(line))
    .join(' ');
  return prose
    .split(/(?<=[.!?。！？；;])\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 从页面正文中抽取与锚点文本词重叠最高的连续 1-3 句作 excerpt。 */
export function pickExcerpt(anchorText: string, pageBody: string): string {
  const sentences = splitSentences(pageBody);
  if (sentences.length === 0) return pageBody.trim().slice(0, EXCERPT_MAX_CHARS);

  const anchorTokens = tokenize(anchorText);
  let bestIdx = 0;
  let bestScore = 0;
  sentences.forEach((s, i) => {
    let score = 0;
    for (const t of tokenize(s)) if (anchorTokens.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });
  // 零重叠回落正文开头
  if (bestScore === 0) bestIdx = 0;

  let excerpt = sentences[bestIdx];
  for (
    let i = bestIdx + 1;
    i < Math.min(bestIdx + EXCERPT_MAX_SENTENCES, sentences.length) &&
    excerpt.length + sentences[i].length + 1 <= EXCERPT_MAX_CHARS;
    i++
  ) {
    excerpt += ` ${sentences[i]}`;
  }
  return excerpt.slice(0, EXCERPT_MAX_CHARS);
}

/** 取答案中 wikilink 所在句作锚点（向两侧扩到句界）。 */
function anchorSentenceAt(answer: string, start: number, end: number): string {
  const boundary = /[.!?。！？\n]/;
  let s = start;
  while (s > 0 && !boundary.test(answer[s - 1])) s--;
  let e = end;
  while (e < answer.length && !boundary.test(answer[e])) e++;
  return answer.slice(s, Math.min(e + 1, answer.length));
}

export function extractCitationsFromAnswer(
  answer: string,
  accessed: AccessedPages,
  subjectSlug: string,
): { pageSlug: string; excerpt: string }[] {
  // 标题→slug 兜底解析：模型写 [[Title]] 也能落到 read 过的页
  const titleToSlug = new Map<string, string>();
  for (const [slug, { title }] of accessed.bodies) titleToSlug.set(normalizeSlug(title), slug);
  for (const [slug, { title }] of accessed.meta) {
    if (!titleToSlug.has(normalizeSlug(title))) titleToSlug.set(normalizeSlug(title), slug);
  }

  const links = extractWikiLinks(answer, {
    currentSubjectSlug: subjectSlug,
    titleResolver: (title) => titleToSlug.get(normalizeSlug(title)),
  });

  const out: { pageSlug: string; excerpt: string }[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (link.targetSubjectSlug !== subjectSlug) continue; // 跨主题链接不算本 subject 引用
    const page = accessed.bodies.get(link.target);
    if (!page || seen.has(link.target)) continue;
    seen.add(link.target);
    const anchor = anchorSentenceAt(answer, link.position.start, link.position.end);
    out.push({ pageSlug: link.target, excerpt: pickExcerpt(anchor, page.body) });
  }
  return out;
}
```

注意：若 `extractWikiLinks` 的 titleResolver 解析行为与假设不符（例如 `target` 已是 normalize 后的结果、无需再包 `normalizeSlug`），以现有 `wikilinks.ts` 实测行为为准调整，测试是行为契约。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/services/__tests__/citation-extract.test.ts`
Expected: PASS（8 用例）

- [ ] **Step 5: Commit**

```bash
git add src/server/services/citation-extract.ts src/server/services/__tests__/citation-extract.test.ts
git commit -m "新增 citation-extract 纯函数：答案内联 wikilink 确定性解析引用 + 词重叠 excerpt 抽取"
```

---

### Task 2: Prompt 层——内联引用纪律 + CoverageSchema

**Files:**
- Modify: `src/server/llm/prompts/query-prompt.ts`
- Test: `src/server/llm/prompts/__tests__/`（若已有 query-prompt 测试则就地补，否则本 task 不新增测试文件——纯常量/builder，由 Task 3 集成测试覆盖）

**Interfaces:**
- Produces: `CoverageSchema`（zod：`{ coverageSufficient: boolean; suggestedResearchQuestion?: string }`）、`buildCoverageUserPrompt(question: string, answer: string, ctx: PromptContext): string`、修订后的 `QUERY_AGENTIC_SYSTEM_PROMPT`。
- 保留：`QueryResponseSchema`（`save-to-wiki` 等仍消费 citations 契约类型）。

- [ ] **Step 1: 修改 `QUERY_AGENTIC_SYSTEM_PROMPT` 的 Answer format 一节**

将现有：

```
## Answer format
- Clear, well-structured markdown.
- Base every claim ONLY on content returned by your tools. Do not use outside knowledge.
- If pages conflict, acknowledge the contradiction explicitly.
```

替换为：

```
## Answer format
- Clear, well-structured markdown.
- Base every claim ONLY on content returned by your tools. Do not use outside knowledge.
- CITE INLINE: immediately after each statement based on wiki content, append a wikilink to the supporting page using its EXACT slug, e.g. "WAL mode improves concurrent reads [[sqlite-wal]]." Only cite pages you have actually read with \`wiki_read\` in this conversation. These inline wikilinks are how citations are collected — an uncited claim will show no source.
- Do NOT invent slugs. Do NOT cite pages you only saw in search results without reading them.
- If pages conflict, acknowledge the contradiction explicitly.
```

（web 结果禁用 `[[page]]` 格式的既有 Web search 一节纪律不动。）

- [ ] **Step 2: 新增 CoverageSchema 与 builder（同文件）**

```ts
// ── Coverage 判定（异步 best-effort，独立于引用）────────────────────────────

export const CoverageSchema = QueryResponseSchema.pick({
  coverageSufficient: true,
  suggestedResearchQuestion: true,
});

export type CoverageResult = z.infer<typeof CoverageSchema>;

export const COVERAGE_SYSTEM_PROMPT = `You judge whether an assistant's answer was sufficiently supported by a personal wiki.
Given the user question and the final answer, decide coverageSufficient:
- false if the answer mostly says the wiki lacks the information, is incomplete, or is speculative;
- true if the answer substantively addresses the question from wiki content.
When false, also provide suggestedResearchQuestion — a concise, well-formed question worth researching to fill the gap. Follow the output language directive.`;

export function buildCoverageUserPrompt(
  question: string,
  answer: string,
  ctx: PromptContext,
): string {
  return `${renderLanguageDirective(ctx.language)}

## User question
<user_input>
${question}
</user_input>

## Final answer given
<answer>
${answer}
</answer>

Judge coverage for the answer above.`;
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 错误

- [ ] **Step 4: Commit**

```bash
git add src/server/llm/prompts/query-prompt.ts
git commit -m "query prompt 加内联引用纪律 + 独立 CoverageSchema/builder（引用与 coverage 判定解耦）"
```

---

### Task 3: query-service 改造——确定性引用 + 异步 coverage，退役 generateQueryCitations

**Files:**
- Modify: `src/server/services/query-service.ts`
- Test: `src/server/services/__tests__/query-service-agentic.test.ts`（改造既有用例）

**Interfaces:**
- Consumes: Task 1 `extractCitationsFromAnswer`；Task 2 `CoverageSchema` / `COVERAGE_SYSTEM_PROMPT` / `buildCoverageUserPrompt`。
- Produces:
  - `assessCoverageInBackground(subject: Subject, question: string, answer: string): void` — fire-and-forget，内部 `generateStructuredOutput('query', CoverageSchema, …)`，`coverageSufficient===false` 时调 `recordCoverageGap`，任何异常只 `console.error`；导出供 route 复用。
  - `runQuery` 签名不变（`Promise<QueryResult>`）。
- 删除: `generateQueryCitations` / `QueryCitationsSchema` / `QueryCitationsResult`（先 `grep -rn "generateQueryCitations\|QueryCitationsResult"` 确认仅 route.ts 与本文件引用，route 在 Task 4 改）。注意 Task 3/4 之间 route.ts 会短暂编译失败——Task 3 内先把 route.ts 的 import 与调用一并最小改掉（见 Step 3），保证每个 commit 可编译。

- [ ] **Step 1: 改造既有测试**

`query-service-agentic.test.ts` 中所有 mock `generateQueryCitations` / 二次结构化输出返回 citations 的用例，按新行为改写：

```ts
// 关键断言变化（示意，按现有测试文件的 mock 设施落地）：
// 1) runQuery：mock generateTextWithTools 返回含 [[slug]] 的答案文本，
//    并通过 buildQueryToolContext 的 onAccess 预填 accessed.bodies（或 mock 工具执行）；
//    断言 citations 直接来自确定性解析（pageSlug 命中、excerpt ⊂ 页面正文），
//    不再有第二次 generateStructuredOutput 调用产出 citations。
it('runQuery：citations 来自答案内联 wikilink 的确定性解析', async () => {
  // mock generateTextWithTools → { text: '答案 [[sqlite]]。' }
  // mock 工具上下文使 accessed.bodies 含 sqlite
  const result = await runQuery('WAL 是什么', subject);
  expect(result.citations.map((c) => c.pageSlug)).toEqual(['sqlite']);
});

// 2) coverage 用例：mock generateStructuredOutput（CoverageSchema 调用）
//    coverageSufficient=false → recordCoverageGap 被调（backlog create 恰一次）；
//    因 fire-and-forget，测试里 await flushPromises（await new Promise(r => setTimeout(r, 0)) 数次）后断言。
// 3) coverage 调用抛错 → 不影响 runQuery 返回值，仅 console.error。
// 4) 空库短路：行为不变（现有用例保留）。
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/query-service-agentic.test.ts`
Expected: 新改用例 FAIL（旧实现仍走二次调用）

- [ ] **Step 3: 实现**

`query-service.ts`：

```ts
import { extractCitationsFromAnswer } from './citation-extract';
import {
  QUERY_AGENTIC_SYSTEM_PROMPT,
  buildAgenticUserContent,
  CoverageSchema,
  COVERAGE_SYSTEM_PROMPT,
  buildCoverageUserPrompt,
  // QueryResponseSchema 的既有 import 若仅为 QueryCitationsSchema 服务则移除
} from '../llm/prompts/query-prompt';

/**
 * 异步 coverage 判定（fire-and-forget）：只喂问题+最终答案，
 * 不足时 best-effort 写 research backlog；任何失败只记日志。
 */
export function assessCoverageInBackground(
  subject: Subject,
  question: string,
  answer: string,
): void {
  const promptCtx: PromptContext = {
    language: getWikiLanguage(),
    subject: subjectCtxFrom(subject),
  };
  void generateStructuredOutput(
    'query',
    CoverageSchema,
    COVERAGE_SYSTEM_PROMPT,
    buildCoverageUserPrompt(question, answer, promptCtx),
  )
    .then((r) => {
      if (!r.coverageSufficient) {
        recordCoverageGap(subject, question, r.suggestedResearchQuestion);
      }
    })
    .catch((err) => {
      console.error('[query] coverage assessment failed', err);
    });
}
```

`runQuery` 尾段替换为：

```ts
  const answer = text.trim().length > 0 ? text : NO_QUERY_CONTEXT_ANSWER;
  const citations = extractCitationsFromAnswer(answer, accessed, subject.slug);
  assessCoverageInBackground(subject, question, answer);
  return { answer, citations, savedAsPage: null };
```

删除 `generateQueryCitations` / `QueryCitationsSchema` / `QueryCitationsResult` 及不再使用的 import（`buildQueryUserPrompt`、`QUERY_SYSTEM_PROMPT` 若仅被其消费则一并清理；`accessedToContext` 若再无生产调用方，从本文件 re-export 保留、由其 own 模块继续导出，不动 `query-tools.ts`）。

同一 commit 内最小改动 `src/app/api/query/route.ts` 保持编译：import 改为 `assessCoverageInBackground` + `extractCitationsFromAnswer`，流末逻辑替换（完整改造在 Task 4 细化验证，此处即为目标形态）：

```ts
        const citations = extractCitationsFromAnswer(fullAnswer, accessed, subject.slug);
        emit('citations', { citations });
        persistTurn(fullAnswer, citations);
        emit('done', { subjectId: subject.id, conversationId: activeConversationId });
        assessCoverageInBackground(subject, trimmedQuestion, fullAnswer);
```

（`done` 事件不再携带 `coverageSufficient` —— 判定已异步化，检查前端 `chat-interface.tsx` 对该字段的消费并同步移除。）

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run src/server/services/__tests__/query-service-agentic.test.ts && npx tsc --noEmit`
Expected: PASS / 0 错误

- [ ] **Step 5: Commit**

```bash
git add src/server/services/query-service.ts src/server/services/__tests__/query-service-agentic.test.ts src/app/api/query/route.ts
git commit -m "Ask AI 引用改确定性解析：runQuery/流式路由去二次 LLM 调用，coverage 判定异步化，退役 generateQueryCitations"
```

---

### Task 4: 流式路由收尾 + 前端 done 事件字段清理

**Files:**
- Modify: `src/app/api/query/route.ts`（核对 Task 3 已落的改动：无残留 `generateQueryCitations`/`accessedToContext` import）
- Modify: `src/components/chat/chat-interface.tsx`（若消费 `done.coverageSufficient` 则移除）

**Interfaces:**
- Consumes: Task 3 的 `extractCitationsFromAnswer` / `assessCoverageInBackground`。

- [ ] **Step 1: 全局残留检查**

Run: `grep -rn "generateQueryCitations\|QueryCitationsSchema\|coverageSufficient" src --include="*.ts" --include="*.tsx" | grep -v __tests__ | grep -v "prompts/query-prompt"`
Expected: 仅剩 `research-backlog` 无关命中或空；`chat-interface.tsx` 若命中 `coverageSufficient` 则删除该消费逻辑（含关联 UI 状态）。

- [ ] **Step 2: 空库短路路径核对**

`route.ts` 空库分支保持：`emit('citations', {citations: []})` + `recordCoverageGap(subject, trimmedQuestion)`；`done` payload 与正常路径一致（无 `coverageSufficient`）。

- [ ] **Step 3: 类型检查 + 全量相关测试**

Run: `npx tsc --noEmit && npx vitest run src/server/services/ src/server/llm/`
Expected: 0 错误 / 全 PASS

- [ ] **Step 4: 端到端验证（verify）**

启动 `npm run dev:all`，在有内容的 subject 里 Ask AI 提问：
- 答案流完后 citations **立即**出现（无二次等待）；
- 正文里 `[[slug]]` 渲染为可点 wikilink；
- Sources 区 excerpt 来自页面原文；
- 提一个 wiki 外问题，稍后 `/health` 的 Research backlog 出现条目（coverage 异步生效）。

- [ ] **Step 5: Commit**

```bash
git add -A src/app/api/query src/components/chat
git commit -m "流式路由与 chat 前端收尾：done 事件去 coverageSufficient，残留清理"
```

---

### Task 5: 文档更新

**Files:**
- Modify: `CLAUDE.md`（根，变更记录加一行）
- Modify: `src/server/services/CLAUDE.md`（query-service 一节：generateQueryCitations 退役、citation-extract/assessCoverageInBackground 新增；Changelog 加一行）
- Modify: `src/server/llm/CLAUDE.md`（query-prompt 描述同步：内联引用纪律 + CoverageSchema）

- [ ] **Step 1: 三处 CLAUDE.md 按实际落地内容更新**（描述：引用=内联 wikilink 确定性解析；coverage=流后异步小调用；`[unverified]` 机制退役）

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md src/server/services/CLAUDE.md src/server/llm/CLAUDE.md
git commit -m "文档同步：Ask AI 内联引用+确定性解析、coverage 异步化"
```

---

## Self-Review 记录

- Spec 覆盖：Prompt 纪律（Task 2）、纯函数解析（Task 1）、调用点改造（Task 3/4）、coverage 异步化（Task 3）、测试（Task 1/3/4）、文档（Task 5）——齐。
- 契约一致性：`extractCitationsFromAnswer(answer, accessed, subjectSlug)` 与 `assessCoverageInBackground(subject, question, answer)` 在 Task 1/2/3/4 中签名一致。
- 已知取舍：模型漏标内联引用 → citations 变少（spec 已接受）；coverage 只看问题+答案（spec 已接受）。
