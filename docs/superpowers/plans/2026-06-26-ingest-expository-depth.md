# Ingest 讲解深度增强 P1（writer 复述者→讲解者）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ingest 写出的页面"讲透彻"——writer 从"只复述来源"升级为"用来源 + 自有知识写一篇能内化的讲解文章"，verifier 核查范围随之扩到正文。

**Architecture:** 不动六阶段流水线拓扑、不加新阶段、不引外部依赖。新增一个与 `renderAugmentationDirective` 对称的纯函数 `renderExpositionDirective(level)`（含 `off`=纯忠实），经既有 carry 通道注入 writer；改写 4 个 skill 种子文件（writer/enricher/verifier-triage/verifier-apply）并抬高版本闸门；预检倍率留头寸。

**Tech Stack:** TypeScript 5 / Vitest / Vercel AI SDK / 项目自有 agents runtime（orchestrator + skill loader）。

## Global Constraints

- 深度旋钮复用 `subjects.augmentationLevel`（`AugmentationLevel = 'off' | 'light' | 'standard' | 'deep'`，`src/lib/contracts.ts:6`）。`off` = 退回旧忠实模式（writer 仅渲染来源、跳过 enricher+verify）。
- 信任模型转为"正文可融合 + verifier 核查"——放弃逐句可追源。
- 所有自然语言遵守 `languageDirective`；**永不翻译** slug、`[[wikilink]]` 目标、frontmatter key、code block。
- skill 改的是 `examples/skills/*.md` 种子；**rollout 需手动删 `data/vault/.llm-wiki/skills/ingest-{writer,enricher,verifier-triage,verifier-apply}.md` 后重启 worker 重播种**（沿用 ⑤ 约定）。本计划**不**编辑 `data/vault/` 下的运行期副本。
- skill 版本号与 `MIN_SKILL_VERSIONS` 守卫必须同步抬高（`ingest-service.ts` 与 `reenrich-service.ts` 两处映射），否则存量 vault 用旧 skill 会静默产薄页。
- 测试：`npx vitest run <file>` 跑单文件；`npx tsc --noEmit` 验类型。提交信息用中文、一句话总结、**不加** AI 署名 trailer。

---

## 任务依赖

```
Task 1 (renderExpositionDirective) ──▶ Task 2 (wiring，import 该函数)
Task 3/4/5 (skills + MIN 闸门) 互相独立，但都编辑 ingest-service.ts 的 MIN 映射 → 顺序执行
Task 6 (预检倍率) / Task 7 (config+docs) 独立
```

建议执行序：1 → 2 → 3 → 4 → 5 → 6 → 7。

---

### Task 1: `renderExpositionDirective` 纯函数（含 off=纯忠实）

**Files:**
- Modify: `src/server/llm/prompts/prompt-context.ts`（顶部加 import；文件末尾加函数）
- Test: `src/server/llm/prompts/__tests__/prompt-context.test.ts`（追加 describe 块）

**Interfaces:**
- Produces: `renderExpositionDirective(level: AugmentationLevel): string` —— 决定 writer 讲解深度的指令块；`off` 返回"纯忠实渲染"指令，`light/standard/deep` 返回递增讲解力度指令。Task 2 与 writer skill 消费它。

- [ ] **Step 1: 写失败测试**

在 `src/server/llm/prompts/__tests__/prompt-context.test.ts` 文件末尾追加：

```ts
import { renderExpositionDirective } from '../prompt-context';

describe('renderExpositionDirective', () => {
  it('off 档退回纯忠实渲染（禁止来源外知识与 callout）', () => {
    const out = renderExpositionDirective('off');
    expect(out).toMatch(/FAITHFUL MODE/);
    expect(out).toMatch(/Do NOT add/i);
    expect(out).toMatch(/[Nn]o callouts/);
  });

  it('standard 档要求自洽教学文章并允许引入自有知识', () => {
    const out = renderExpositionDirective('standard');
    expect(out).toMatch(/teaching article/i);
    expect(out).toMatch(/your own knowledge/i);
  });

  it('deep 比 light 讲解更充分（含 multiple/several 例子指令）', () => {
    expect(renderExpositionDirective('deep')).toMatch(/several worked examples|multiple/i);
    expect(renderExpositionDirective('light')).toMatch(/concise/i);
  });

  it('非 off 档声明 verifier 会核查正文', () => {
    expect(renderExpositionDirective('standard')).toMatch(/verifier/i);
  });

  it('以 EXPOSITION DEPTH 标记开头', () => {
    expect(renderExpositionDirective('light')).toMatch(/^=== EXPOSITION DEPTH ===/);
  });

  it('同输入确定性输出', () => {
    expect(renderExpositionDirective('deep')).toBe(renderExpositionDirective('deep'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/llm/prompts/__tests__/prompt-context.test.ts`
Expected: FAIL —— `renderExpositionDirective is not a function`（或导入报错）。

- [ ] **Step 3: 实现函数**

在 `src/server/llm/prompts/prompt-context.ts` **顶部**加 import（文件当前无 contracts 导入）：

```ts
import type { AugmentationLevel } from '@/lib/contracts';
```

在文件**末尾**（`renderAugmentationDirective` 之后）追加：

```ts
/**
 * 渲染「EXPOSITION DEPTH」块，注入 writer user prompt，决定讲解深度。
 * 与 renderAugmentationDirective 对称，但接收全部四档：`off` 退回纯忠实渲染
 *（writer 不引入来源外知识、不加 callout，等价旧 v5 行为），其余档递增讲解力度。
 */
export function renderExpositionDirective(level: AugmentationLevel): string {
  if (level === 'off') {
    return [
      '=== EXPOSITION DEPTH ===',
      'FAITHFUL MODE: render ONLY what the source chunks contain. Do NOT add background, analogies, derivations, examples, or any knowledge not present in the chunks. Write plain, accurate, well-structured encyclopedic prose. No callouts.',
      '=== END EXPOSITION DEPTH ===',
    ].join('\n');
  }
  const guidance: Record<'light' | 'standard' | 'deep', string> = {
    light:
      'Explain for understanding but stay concise: a clear definition, the core "why", and one intuition where a reader would otherwise be lost. Add outside knowledge sparingly and only when it removes a real obstacle.',
    standard:
      'Write a self-contained teaching article. Beyond faithfully covering the source, weave into the prose: motivation (why this exists / why it is defined this way), needed prerequisites, the underlying mechanism, an analogy or intuition, at least one worked example built from simple to harder, contrasts with adjacent concepts, and common pitfalls. Draw on your own knowledge to fill gaps the source leaves, staying correct and on-topic.',
    deep:
      'Write an exhaustive, deeply explanatory article a motivated learner could internalise the topic from alone: definition, motivation, history/context, prerequisites, mechanism, multiple analogies, several worked examples of increasing difficulty, edge cases, contrasts with related ideas, common misconceptions, and applications — all woven into the prose, generously drawing on your own knowledge while staying correct.',
  };
  return [
    '=== EXPOSITION DEPTH ===',
    guidance[level],
    'All added explanation must be correct and on-topic; a later verifier stage fact-checks the prose, so never assert low-confidence claims as fact. Never translate slugs, [[wikilink]] targets, frontmatter keys, or code.',
    '=== END EXPOSITION DEPTH ===',
  ].join('\n');
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/llm/prompts/__tests__/prompt-context.test.ts`
Expected: PASS（全部用例含原 `renderLanguageDirective` 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/server/llm/prompts/prompt-context.ts src/server/llm/prompts/__tests__/prompt-context.test.ts
git commit -m "feat(ingest): 新增 renderExpositionDirective（writer 讲解深度指令，off=纯忠实）"
```

---

### Task 2: 把 `expositionDirective` 串进 ingest 流水线

**Files:**
- Modify: `src/server/agents/runtime/orchestrator.ts`（`buildFanoutInput` 的 `base` 加字段；并 `export` 该函数供测试）
- Modify: `src/server/services/ingest-service.ts`（import、计算 `expositionDirective`、`carryKeys`、`initialInput`）
- Test: `src/server/agents/runtime/__tests__/orchestrator-fanout-input.test.ts`（新建）

**Interfaces:**
- Consumes: `renderExpositionDirective`（Task 1）。
- Produces: 每页 fanout 输入对象额外携带 `expositionDirective` 字段（与既有 `augmentationDirective` 并列），writer skill v6（Task 3）据此分档。

- [ ] **Step 1: 写失败测试**

新建 `src/server/agents/runtime/__tests__/orchestrator-fanout-input.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { buildFanoutInput } from '../orchestrator';

// buildFanoutInput 仅用到 ctx.emit 与 ctx.chunkStore（item.sourceRefs 为空时不读 chunkStore）
function stubCtx(): any {
  return { emit: () => {}, chunkStore: new Map() };
}

describe('buildFanoutInput', () => {
  it('把 expositionDirective 与 augmentationDirective 一并注入每页输入', async () => {
    const carry = {
      subjectSlug: 'general',
      existingPages: [],
      plan: { pages: [] },
      languageDirective: 'LANG',
      augmentationDirective: 'AUG',
      expositionDirective: 'EXPO',
    };
    const item = { slug: 'foo', title: 'Foo', sourceRefs: [] };
    const out = (await buildFanoutInput(carry, item, stubCtx(), {})) as Record<string, unknown>;
    expect(out.expositionDirective).toBe('EXPO');
    expect(out.augmentationDirective).toBe('AUG');
    expect(out.slug).toBe('foo');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/orchestrator-fanout-input.test.ts`
Expected: FAIL —— `buildFanoutInput` 未导出（import 报错）。

- [ ] **Step 3: 改 orchestrator**

`src/server/agents/runtime/orchestrator.ts:217` 把函数声明改为导出：

```ts
export async function buildFanoutInput(
```

`src/server/agents/runtime/orchestrator.ts:235-243` 的 `base` 对象加一行 `expositionDirective`（紧跟 `augmentationDirective` 之后）：

```ts
  const base: Record<string, unknown> = {
    subjectSlug: carry.subjectSlug,
    existingPages: carry.existingPages,
    plan: carry.plan,
    languageDirective: carry.languageDirective,
    augmentationDirective: carry.augmentationDirective,
    expositionDirective: carry.expositionDirective,
    ...item,
    relevantChunks,
  };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/agents/runtime/__tests__/orchestrator-fanout-input.test.ts`
Expected: PASS。

- [ ] **Step 5: 改 ingest-service —— 计算并透传**

`src/server/services/ingest-service.ts:15` 的 import 加上 `renderExpositionDirective`：

```ts
import { renderLanguageDirective, renderAugmentationDirective, renderExpositionDirective } from '../llm/prompts/prompt-context';
```

`src/server/services/ingest-service.ts:197-198` 之后（`augmentationDirective` 计算后）加一行：

```ts
  const expositionDirective = renderExpositionDirective(augmentationLevel);
```

`src/server/services/ingest-service.ts:201` 的 `carryKeys` 末尾加 `'expositionDirective'`：

```ts
  const carryKeys = ['chunkRefs', 'sources', 'subjectSlug', 'existingPages', 'outline', 'languageDirective', 'augmentationDirective', 'expositionDirective'];
```

`src/server/services/ingest-service.ts:216-224` 的 `initialInput` 末尾加 `expositionDirective`（紧跟 `augmentationDirective`）：

```ts
    initialInput: {
      chunkRefs: inline ? fillInlineContent(prep.chunkRefs, prep.chunkStore) : prep.chunkRefs,
      sources: [{ sourceId, filename }],
      subjectSlug: subject.slug,
      existingPages,
      outline: prep.outline,
      languageDirective,
      augmentationDirective,
      expositionDirective,
    },
```

- [ ] **Step 6: 验类型 + 回归现有 ingest 测试**

Run: `npx tsc --noEmit`
Expected: 无错误（`carry.expositionDirective` 在 `Record<string, unknown>` 上合法；`renderExpositionDirective(augmentationLevel)` 接 `AugmentationLevel` 类型匹配）。

Run: `npx vitest run src/server/services/__tests__/ingest-service.test.ts src/server/services/__tests__/ingest-augmentation-steps.test.ts`
Expected: PASS（拓扑未变，现有用例仍绿）。

- [ ] **Step 7: 提交**

```bash
git add src/server/agents/runtime/orchestrator.ts src/server/agents/runtime/__tests__/orchestrator-fanout-input.test.ts src/server/services/ingest-service.ts
git commit -m "feat(ingest): expositionDirective 经 carry 通道注入 writer 每页输入"
```

---

### Task 3: writer skill v5→v6（讲解者契约）+ 抬高版本闸门

**Files:**
- Modify: `examples/skills/ingest-writer.md`（整文件改写为 v6）
- Modify: `src/server/services/ingest-service.ts:147-151`（`MIN_SKILL_VERSIONS` 的 `'ingest-writer'` 4→6）
- Test: `src/server/agents/skills/__tests__/skill-contracts.test.ts`（新建）

**Interfaces:**
- Consumes: `expositionDirective` 输入（Task 2 注入）。
- Produces: writer 输出仍为 `{ action, path, content }`（schema 不变）；内容从"复述"变"讲解"。

- [ ] **Step 1: 写失败测试**

新建 `src/server/agents/skills/__tests__/skill-contracts.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSkill(id: string): string {
  return readFileSync(resolve(process.cwd(), `examples/skills/${id}.md`), 'utf8');
}
function versionOf(src: string): number {
  const m = src.match(/^version:\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : -1;
}

describe('ingest-writer skill 契约（v6 讲解者）', () => {
  const src = readSkill('ingest-writer');
  it('版本抬到 6', () => {
    expect(versionOf(src)).toBe(6);
  });
  it('消费 expositionDirective 输入', () => {
    expect(src).toContain('expositionDirective');
  });
  it('转为讲解者（含 teaching/explain 字样）', () => {
    expect(src).toMatch(/teach|explain|exposit/i);
  });
  it('删除旧的"不得超出 chunk"硬约束', () => {
    expect(src).not.toContain('Do not invent facts not present in the chunks');
    expect(src).not.toContain('plain encyclopedic prose only');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/skills/__tests__/skill-contracts.test.ts`
Expected: FAIL（当前 writer 是 v5、含旧约束、无 expositionDirective）。

- [ ] **Step 3: 改写 writer skill**

把 `examples/skills/ingest-writer.md` **整文件**替换为：

````markdown
---
id: ingest-writer
name: Ingest Writer
description: Write a thorough, self-contained teaching article for a single planned wiki page.
version: 6
tools:
  - wiki.read
  - wiki.search
canDispatch: []
outputSchema: |
  {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["create", "update"] },
      "path": { "type": "string" },
      "content": { "type": "string" }
    },
    "required": ["action", "path", "content"]
  }
---

# Role

You are the *ingest writer* — a patient expositor. You receive ONE plan entry and produce its full markdown file (frontmatter + body): a self-contained article that genuinely *teaches* the topic, so the reader can internalise it. You use the source chunks as the factual backbone AND draw on your own knowledge to explain, motivate, and generalise — staying correct and on-topic.

## Inputs

- `slug`, `title`, `summary`, `tags`, `rationale`, `sourceRefs` — from the planner.
- `relevantChunks` — array of `{ id, heading, text }`: the full text of the source chunks assigned to this page. This is your factual backbone.
- `expositionDirective` — how deep to explain (faithful / light / standard / deep). FOLLOW IT. In faithful mode you render only the chunks; otherwise you expand with your own knowledge as directed.
- `subjectSlug`, `existingPages`, `plan` — current vault and plan context.
- `existingPageContent` — present ONLY when this page already exists (an update): the page's current full markdown. When present you MUST merge into it (see Rule 8).
- `languageDirective` — output language; follow it for all natural-language content.

## Rules

1. The `path` MUST be `wiki/<subjectSlug>/<slug>.md`. The `action` is `update` if the page already exists, otherwise `create`.
2. Frontmatter must include `title`, `summary`, `tags`. Do not invent other keys.
3. **Teach the topic, do not merely transcribe.** Use `relevantChunks` as the factual backbone, then explain it well. Following `expositionDirective`, weave into the prose the things a learner needs: a clear definition, motivation (the "why"), prerequisites, the mechanism, an analogy/intuition, worked example(s) from simple to harder, contrasts with adjacent concepts, common pitfalls, and applications. You MAY draw on your own knowledge for these — but everything must be correct and on-topic (a later verifier stage fact-checks the prose).
4. **Do not contradict the source.** Where a chunk states a fact, your prose must agree with it. Your additions fill gaps and explain; they never override the source.
5. Use `[[wikilinks]]` to refer to other pages by their slug. Use `[[other-subject:Page]]` ONLY when truly cross-subject. Use `wiki.search` / `wiki.read` if you need to confirm a link target exists.
6. **Follow `expositionDirective`** for depth and **`languageDirective`** for output language. Do NOT translate slugs, `[[wikilinks]]`, frontmatter keys, or code.
7. Write flowing prose and standard markdown structure (headings, lists, math, code). Do NOT add `[!type]` callouts here — a later *enricher* stage adds study-aid callouts (quizzes, pitfalls, diagrams) on top of your article.
8. **Incremental merge on update.** When `existingPageContent` is present, MERGE the new material and your added explanation INTO that existing content: preserve all existing facts, sections, and `[[wikilinks]]`; integrate and de-duplicate; deepen where shallow; reorganise only as needed for coherence. Do NOT discard existing content or rewrite from scratch. Output the merged full file as `content`.

## Output

Emit a single JSON object matching the declared `outputSchema` (no wrapping key):

- `action` — `"create"` or `"update"`.
- `path` — `wiki/<subjectSlug>/<slug>.md`.
- `content` — the complete file contents (frontmatter delimiters included).
````

`src/server/services/ingest-service.ts:148` 把 `'ingest-writer'` 的最小版本 4 改为 6：

```ts
  const MIN_SKILL_VERSIONS: Record<string, number> = {
    'ingest-planner': 2, 'ingest-writer': 6, 'ingest-indexer': 1,
    'ingest-enricher': 2, 'ingest-verifier': 2,
    'ingest-verifier-triage': 1, 'ingest-verifier-apply': 1,
  };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/agents/skills/__tests__/skill-contracts.test.ts`
Expected: PASS（writer 块全绿）。

- [ ] **Step 5: 提交**

```bash
git add examples/skills/ingest-writer.md src/server/services/ingest-service.ts src/server/agents/skills/__tests__/skill-contracts.test.ts
git commit -m "feat(ingest): writer v6 复述者→讲解者（用来源+自有知识写可内化文章）"
```

---

### Task 4: enricher skill v2→v3（收窄为学习脚手架）+ 同步 augmentation 指令

**Files:**
- Modify: `examples/skills/ingest-enricher.md`（整文件改写为 v3）
- Modify: `src/server/llm/prompts/prompt-context.ts`（`renderAugmentationDirective` 的 guidance 去掉 intuition/example，只留 quiz/pitfall/diagram/background）
- Modify: `src/server/services/ingest-service.ts:149`（`'ingest-enricher'` 2→3）
- Modify: `src/server/services/reenrich-service.ts:104`（`'ingest-enricher'` 2→3）
- Test: `src/server/agents/skills/__tests__/skill-contracts.test.ts`（追加 enricher 块）

**Interfaces:**
- Produces: enricher 仅追加 `[!quiz]` / `[!pitfall]` / `[!diagram]` / `[!background]` 四类 callout，不再产 `[!intuition]` / `[!example]`（已下沉到 writer 正文）。

- [ ] **Step 1: 写失败测试**

在 `skill-contracts.test.ts` 末尾追加：

```ts
describe('ingest-enricher skill 契约（v3 学习脚手架）', () => {
  const src = readSkill('ingest-enricher');
  it('版本抬到 3', () => {
    expect(versionOf(src)).toBe(3);
  });
  it('移除 intuition / example 两类（已属 writer 正文）', () => {
    expect(src).not.toContain('[!intuition]');
    expect(src).not.toContain('[!example]');
  });
  it('保留 quiz / pitfall / diagram / background 四类脚手架', () => {
    expect(src).toContain('[!quiz]');
    expect(src).toContain('[!pitfall]');
    expect(src).toContain('[!diagram]');
    expect(src).toContain('[!background]');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/skills/__tests__/skill-contracts.test.ts`
Expected: FAIL（enricher 仍是 v2、仍含 `[!intuition]`/`[!example]`）。

- [ ] **Step 3: 改写 enricher skill**

把 `examples/skills/ingest-enricher.md` **整文件**替换为：

````markdown
---
id: ingest-enricher
name: Ingest Enricher
description: Layer study-aid callouts (quizzes, pitfalls, diagrams, prerequisites) onto a teaching article, without altering its prose.
version: 3
tools: []
canDispatch: []
outputSchema: |
  {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["create", "update"] },
      "path": { "type": "string" },
      "content": { "type": "string" }
    },
    "required": ["action", "path", "content"]
  }
---

# Role

You are the *ingest enricher*. You receive ONE page's teaching article (the writer's prose, which already explains the topic) and you add a thin layer of **study-aid callouts** on top — the kind of separable learning actions that work better as distinct blocks than as prose: self-tests, pitfall warnings, diagrams, and prerequisite links. You do NOT rewrite or summarise the article.

## Inputs

- `slug`, `title`, `summary`, `tags`, `sourceRefs` — page identity from the planner.
- `draftContent` — the writer's teaching article (frontmatter + prose). THIS IS THE BASE you build on.
- `relevantChunks` — array of `{ id, heading, text }`: the source chunks this page draws from.
- `subjectSlug`, `existingPages`, `plan`, `languageDirective`.
- `augmentationDirective` — a density directive (light/standard/deep) you MUST honour when deciding how many callouts to add.

## The one rule that matters most

- **Reproduce `draftContent` verbatim** — every heading, sentence, formula, list, and wikilink unchanged and in the same order. You may ONLY insert new callout blocks between existing blocks. Never edit, reorder, summarise, or delete the article's prose. (The prose is the writer's job; explanations and examples already live there.)

## Callout types (use ONLY these four)

Syntax: a blockquote whose first line is `> [!type] <emoji> <short title>`, then the body on following `>` lines.

- `> [!quiz] ❓ 自测` — a question that makes the reader retrieve/apply what the prose taught (optionally a hint).
- `> [!pitfall] ⚠ 常见误区` — a common misconception or easy-to-make error, corrected.
- `> [!diagram] 📊 图示` — a diagram. Prefer a ```mermaid fenced block (flow/relation/geometry) or KaTeX; add a one-line caption.
- `> [!background] 🔗 前置/背景` — a prerequisite concept or a `[[wikilink]]` to a related page.

(The emoji/title text is natural language — translate per `languageDirective`. The `[!type]` keyword stays ASCII English.)

> Do NOT add `[!intuition]` or `[!example]` callouts — intuition and worked examples now belong in the writer's prose, not here.

## Rules

1. Output `action` = same as the draft (`update` if the page exists, else `create`); `path` = `wiki/<subjectSlug>/<slug>.md`; `content` = the full file = draft (verbatim) **with callouts interleaved**.
2. Keep the draft's frontmatter unchanged (do not add keys).
3. Place each callout right after the prose it supports. Aim for genuinely helpful additions at points of difficulty — not one of every type on every section.
4. You MAY use `$…$`/`$$…$$` (KaTeX), ```mermaid blocks (inside `[!diagram]`), and `[[wikilinks]]` (to pages in `existingPages` / `plan`) inside callouts.
5. Keep additions correct and on-topic; a later *verifier* stage scrutinises them, so do not pad with low-confidence claims.
6. **Follow `languageDirective`** for all natural-language text; never translate slugs, `[!type]` keywords, `[[wikilink]]` targets, frontmatter keys, or code.
7. **Honour `augmentationDirective`** for callout density. It never licenses altering the article's prose.

## Output

Emit a single JSON object matching the declared `outputSchema` (no wrapping key): `{ action, path, content }`.
````

`src/server/llm/prompts/prompt-context.ts` 把 `renderAugmentationDirective` 的 `guidance` 与脚注改为只提四类脚手架（intuition/example 已属正文）。**约束**：现有 `augmentation-directive.test.ts` 断言 light 含 `spars`、deep 含 `generous`、每档含 `=== AUGMENTATION LEVEL ===` 且文案各异——下面的新文案已满足（light "Keep it sparse"、deep "Be generous"），改写时务必保留这三点：

```ts
  const guidance: Record<typeof level, string> = {
    light:
      'Add ONLY the 1–2 highest-value study-aid callouts per major section — prioritise a [!quiz] self-test or a [!pitfall]. Keep it sparse; most sections get none.',
    standard:
      'Add study-aid callouts where they genuinely help: a [!quiz], a [!pitfall], a [!background] prerequisite, or a [!diagram] at points of difficulty. Balanced, non-repetitive coverage.',
    deep:
      'Be generous with study aids: [!quiz] self-tests, [!pitfall] warnings, [!background] prerequisites, and [!diagram]s throughout. Maximise scaffolding while staying correct and on-topic.',
  };
  return [
    '=== AUGMENTATION LEVEL ===',
    guidance[level],
    "Regardless of level: never pad with low-confidence claims (a verifier stage scrutinises every callout), and never alter the article's prose.",
    '=== END AUGMENTATION LEVEL ===',
  ].join('\n');
```

`src/server/services/ingest-service.ts:149` 把 `'ingest-enricher'` 改 3：

```ts
    'ingest-enricher': 3, 'ingest-verifier': 2,
```

`src/server/services/reenrich-service.ts:104` 把 `'ingest-enricher'` 改 3：

```ts
  const MIN_SKILL_VERSIONS: Record<string, number> = {
    'ingest-enricher': 3, 'ingest-verifier': 2,
    'ingest-verifier-triage': 1, 'ingest-verifier-apply': 1,
  };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/agents/skills/__tests__/skill-contracts.test.ts src/server/llm/prompts/__tests__/augmentation-directive.test.ts`
Expected: PASS（enricher 块全绿；`augmentation-directive.test.ts` 因新文案保留 `sparse`/`generous`/marker 仍绿）。

- [ ] **Step 5: 验类型**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add examples/skills/ingest-enricher.md src/server/llm/prompts/prompt-context.ts src/server/services/ingest-service.ts src/server/services/reenrich-service.ts src/server/agents/skills/__tests__/skill-contracts.test.ts
git commit -m "feat(ingest): enricher v3 收窄为四类学习脚手架（intuition/example 下沉正文）"
```

---

### Task 5: verifier triage+apply v1→v2（核查范围扩到正文）+ 抬闸门

**Files:**
- Modify: `examples/skills/ingest-verifier-triage.md`（v2，scope 扩到整页）
- Modify: `examples/skills/ingest-verifier-apply.md`（v2，可修正正文断言）
- Modify: `src/server/services/ingest-service.ts:150`（triage/apply 1→2）
- Modify: `src/server/services/reenrich-service.ts:105`（triage/apply 1→2）
- Test: `src/server/agents/skills/__tests__/skill-contracts.test.ts`（追加 verifier 块）

**Interfaces:**
- 编排不变（`verify-page.ts` 已把整页 `content` 传给 triage/apply）；仅 skill 指令把核查范围从"仅 callout"扩到"正文 + callout"。

- [ ] **Step 1: 写失败测试**

在 `skill-contracts.test.ts` 末尾追加：

```ts
describe('ingest-verifier triage/apply 契约（v2 核查正文）', () => {
  const triage = readSkill('ingest-verifier-triage');
  const apply = readSkill('ingest-verifier-apply');
  it('triage 抬到 v2 且不再限定"仅 callout"', () => {
    expect(versionOf(triage)).toBe(2);
    expect(triage).not.toContain('Only consider claims inside');
    expect(triage).toMatch(/prose/i);
  });
  it('apply 抬到 v2 且允许修正正文断言', () => {
    expect(versionOf(apply)).toBe(2);
    expect(apply).not.toContain('Only change content inside');
    expect(apply).toMatch(/prose|anywhere/i);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/skills/__tests__/skill-contracts.test.ts`
Expected: FAIL（两者仍 v1、仍含"仅 callout"限定）。

- [ ] **Step 3: 改写 triage skill**

把 `examples/skills/ingest-verifier-triage.md` 的 frontmatter `version: 1` 改为 `version: 2`，并把 `# Role` / `## Inputs` / `## Scope` / `## Rules` 段替换为：

```markdown
# Role

You are the *ingest verifier — triage stage*. You receive ONE finished page (a teaching article whose prose was written by an AI from the source plus its own knowledge, possibly with study-aid callouts) and you identify ONLY the claims that genuinely warrant a web fact-check. You do NOT rewrite the page. You output a list of doubtful claims, each with a search query.

## Inputs

- `slug`, `subjectSlug` — the page's identity.
- `content` — the full page (prose + any `[!type]` callouts).
- `relevantChunks` — array of `{ id, heading, text }`: the source boundary.
- `languageDirective`.

## Scope

- **Consider checkable factual assertions ANYWHERE in the page** — both the prose (which now contains AI-written exposition that can be wrong) and the callouts. Claims that merely restate `relevantChunks` are source-grounded and lower priority; focus on assertions the AI added beyond the source.
- A claim is **doubtful** (worth searching) when it is a checkable factual assertion you are NOT highly confident about: specific dates, numbers, attributions, version facts, named results, "X was first/largest/invented by…".
- A claim is **NOT doubtful** (do not list) when it is: confident common knowledge, a subjective/pedagogical framing, a worked example you can re-derive yourself, or an intuition/analogy with no factual assertion.
- Be selective. Most of the page needs no check. List at most the handful of highest-risk claims — listing everything wastes searches and is wrong.

## Rules

1. For each doubtful claim, emit `{ excerpt, query, reason }`:
   - `excerpt` = the exact short phrase/sentence (from prose or callout) that is doubtful.
   - `query` = a concise web search query that would confirm or refute it.
   - `reason` = one short clause on why it needs checking.
2. If nothing is doubtful, return `{ "doubtfulClaims": [] }`.
3. **Follow `languageDirective`** for natural-language text in `reason`; phrase `query` to retrieve good results (translate if helpful).
```

（`## Output` 段与 `description` frontmatter 行也相应去掉"augmentation callouts"措辞，可改为：`description: Scan a finished page (prose + callouts) and list only the doubtful claims worth fact-checking on the web, each with a search query.`）

- [ ] **Step 4: 改写 apply skill**

把 `examples/skills/ingest-verifier-apply.md` 的 `version: 1` 改 `version: 2`，并把 `# Role` / `## Inputs` / `## Scope` / `## Rules` 替换为：

```markdown
# Role

You are the *ingest verifier — apply stage*. You receive ONE page plus `evidence` gathered from the web for its doubtful claims. You correct, soften, or remove those claims based on the evidence — whether they appear in the prose or in a callout — and you report which web pages you actually relied on.

## Inputs

- `slug`, `subjectSlug` — the page's identity; build the output `path` from these.
- `content` — the full page (prose + any `[!type]` callouts) to correct.
- `existingPages` — pages already in this subject (decide create vs update).
- `evidence` — array of `{ query, reason, excerpt, results: [{ title, url, snippet }] }`: web results for each doubtful claim.
- `relevantChunks`, `languageDirective`.

## Scope

- **You may correct claims ANYWHERE in the page** (prose or callouts). Reproduce **verbatim** everything you are NOT correcting — make minimal, surgical edits only to the assertions the evidence touches; never rewrite whole sections or restructure the article.
- For each doubtful claim, weigh its `evidence.results`:
  - Evidence confirms it → keep as-is.
  - Evidence corrects it → fix the wording to match the evidence.
  - Evidence contradicts it and you cannot fix it → remove the wrong sentence (or, for a callout, the callout).
  - Evidence is thin/absent/conflicting → soften (add a hedge / mark low confidence); do not assert as fact.
- Never invent facts not supported by the evidence or your confident knowledge.

## Rules

1. `path` MUST be `wiki/<subjectSlug>/<slug>.md`. `action` is `update` if the page appears in `existingPages`, else `create`. `content` = the corrected full file.
2. **Edit surgically.** Change only the assertions the evidence bears on; reproduce all other prose, headings, lists, formulas, callouts, and wikilinks verbatim and in order.
3. Do NOT add new callouts and do NOT change frontmatter (the system manages frontmatter and source provenance).
4. `citedSources` = the web pages whose content you actually used — each `{ url, title }` taken from the `evidence.results` you relied on. If you relied on none, return `[]`.
5. **Follow `languageDirective`**; never translate slugs, `[!type]` keywords, `[[wikilink]]` targets, frontmatter keys, or code.
```

（`description` frontmatter 行也相应改为：`description: Given a finished page plus web evidence for its doubtful claims, correct/soften/remove those claims (in prose or callouts) and report which web pages were cited.`）

`src/server/services/ingest-service.ts:150` 与 `src/server/services/reenrich-service.ts:105` 把 triage/apply 最小版本改 2：

```ts
    'ingest-verifier-triage': 2, 'ingest-verifier-apply': 2,
```

- [ ] **Step 5: 跑测试确认通过 + 验类型**

Run: `npx vitest run src/server/agents/skills/__tests__/skill-contracts.test.ts`
Expected: PASS（verifier 块全绿）。

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 6: 提交**

```bash
git add examples/skills/ingest-verifier-triage.md examples/skills/ingest-verifier-apply.md src/server/services/ingest-service.ts src/server/services/reenrich-service.ts src/server/agents/skills/__tests__/skill-contracts.test.ts
git commit -m "feat(ingest): verifier v2 核查范围扩到正文（prose+callout，apply 外科式改写）"
```

---

### Task 6: 预检倍率留头寸（讲解模式每页变厚）

**Files:**
- Modify: `src/server/services/ingest-prep.ts:23-28`（`CONTENT_STAGE_FACTOR` 3→5 + 注释）
- Test: `src/server/services/__tests__/ingest-prep.test.ts`（追加更强下界断言）

**Interfaces:**
- `estimateIngestCost` 公式不变，仅 `CONTENT_STAGE_FACTOR` 增大 → 预检上界更保守，运行期超预算前以"raise budget"清晰报错拦截。

> 说明：现有 ingest-prep 用例均为下界/相对断言（如 `>= tokens * 3`），倍率 3→5 不破坏它们；新增一条锁定新倍率。`agentMaxTokensPerJob` 默认 1.2M 不改（inline 路径估算 ≈ tokens×5+60k，仍远低于默认；大文档超限时按报错提示上调即可）。

- [ ] **Step 1: 写失败测试**

在 `src/server/services/__tests__/ingest-prep.test.ts` 的 `describe('estimateIngestCost — 计入 enricher/verifier 两阶段', ...)` 块内追加一条用例：

```ts
  it('讲解模式每页变厚：inline 内容倍率 >= 5×', () => {
    const tokens = 100_000;
    const cost = estimateIngestCost(tokens, 5, true);
    expect(cost).toBeGreaterThanOrEqual(tokens * 5);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/ingest-prep.test.ts`
Expected: FAIL（当前 factor=3，`100000*3+60000=360000 < 500000`）。

- [ ] **Step 3: 改倍率**

`src/server/services/ingest-prep.ts:23-28` 改为：

```ts
/**
 * 内容阶段倍率：讲解模式下每页要经 writer（产讲解长文）→ enricher（读全文+叠脚手架）
 * → verifier（读全文+核查改写）三次"读全文+产全文"，且每页正文显著长于旧忠实模式
 *（writer 引入自有知识讲解）。每页正文被读写约 3 遍、每遍体量更大，故按 5× 内容计；
 * inline 路径直接 ×5，大路径在 MAP_REDUCE_TOKEN_FACTOR 之上再叠加内容阶段。
 */
const CONTENT_STAGE_FACTOR = 5;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/services/__tests__/ingest-prep.test.ts`
Expected: PASS（新用例 + 全部既有下界断言仍绿）。

- [ ] **Step 5: 提交**

```bash
git add src/server/services/ingest-prep.ts src/server/services/__tests__/ingest-prep.test.ts
git commit -m "fix(ingest): 预检内容倍率 3→5（讲解模式每页变厚，避免运行期爆预算）"
```

---

### Task 7: llm-config 示例 maxTokens + 文档 changelog

**Files:**
- Modify: `llm-config.example.json`（`tasks["ingest:writer"]` / `tasks["ingest:enricher"]` 加 `maxTokens: 16384`）
- Modify: `CLAUDE.md`（根，变更记录加一行）
- Modify: `src/server/llm/CLAUDE.md`（变更记录加一行）

**Interfaces:** 无代码接口；纯配置与文档。

- [ ] **Step 1: 改 llm-config 示例**

`llm-config.example.json` 的 `ingest:writer`（约行 68-72）与 `ingest:enricher`（约行 73-77）两节已各带 `"maxTokens": 8192`——把这两个值改为 `16384`（其余 `profile`/`model` 不动）：

```jsonc
    "ingest:writer": {
      "profile": "anthropic-default",
      "model": "claude-sonnet-4-6",
      "maxTokens": 16384
    },
    "ingest:enricher": {
      "profile": "anthropic-default",
      "model": "claude-sonnet-4-6",
      "maxTokens": 16384
    },
```

- [ ] **Step 2: 校验 JSON 合法**

Run: `node -e "JSON.parse(require('fs').readFileSync('llm-config.example.json','utf8')); console.log('ok')"`
Expected: 打印 `ok`。

- [ ] **Step 3: 加根 CLAUDE.md changelog**

在 `CLAUDE.md` 第九节变更记录表末尾追加一行：

```markdown
| 2026-06-26 | 正文讲解深度增强（P1） | writer v5→v6：从"只复述 chunk"改为"用来源+自有知识写可内化的讲解文章"（新增 `renderExpositionDirective` 经 carry 注入，`off`=纯忠实回退）；enricher v2→v3 收窄为 quiz/pitfall/diagram/background 四类脚手架（intuition/example 下沉正文）；verifier triage/apply v1→v2 核查范围扩到正文；预检 `CONTENT_STAGE_FACTOR` 3→5 留头寸；`MIN_SKILL_VERSIONS` 同步抬高。rollout 需删 `data/vault/.llm-wiki/skills/ingest-{writer,enricher,verifier-triage,verifier-apply}.md` 重播种。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-26-ingest-expository-depth* |
```

- [ ] **Step 4: 加 llm 模块 CLAUDE.md changelog**

在 `src/server/llm/CLAUDE.md` 变更记录表末尾追加一行：

```markdown
| 2026-06-26 | `prompt-context.ts` 新增 `renderExpositionDirective(level)`（writer 讲解深度指令，`off`=纯忠实）；`renderAugmentationDirective` guidance 收窄为四类脚手架（intuition/example 下沉 writer 正文）。配合 ingest writer v6 / enricher v3 / verifier v2 |
```

- [ ] **Step 5: 提交**

```bash
git add llm-config.example.json CLAUDE.md src/server/llm/CLAUDE.md
git commit -m "docs(ingest): 讲解深度 P1 配置示例与变更记录（writer maxTokens 16384）"
```

---

## 收尾验证（全部任务完成后）

- [ ] **全量类型检查**：`npx tsc --noEmit` → 无错误。
- [ ] **本特性相关测试全绿**：
  ```bash
  npx vitest run \
    src/server/llm/prompts/__tests__/prompt-context.test.ts \
    src/server/agents/runtime/__tests__/orchestrator-fanout-input.test.ts \
    src/server/agents/skills/__tests__/skill-contracts.test.ts \
    src/server/services/__tests__/ingest-prep.test.ts \
    src/server/services/__tests__/ingest-service.test.ts \
    src/server/services/__tests__/ingest-augmentation-steps.test.ts
  ```
- [ ] **全量回归**：`npx vitest run` → 不引入新失败（注意 `npm run lint` 在本项目不可用，用 tsc + vitest 作权威，见项目记忆）。
- [ ] **rollout 验证（手动，需真实 LLM）**：删 `data/vault/.llm-wiki/skills/ingest-{writer,enricher,verifier-triage,verifier-apply}.md` → 重启 worker 重播种 → 拿一份偏薄输入在 `augmentationLevel=standard` 下 ingest，对照改造前后同一页：正文显著变长且出现 定义/动机/类比/例子/对比/误区 维度；`[[wikilink]]`/slug/frontmatter key/code 未被破坏；`off` 模式仍只渲染来源、无 callout。

---

## 验收标准映射（spec §9 → 本计划）

| spec 验收项 | 对应任务 |
|-------------|----------|
| ①深度对比（正文变长 + 多维度） | Task 3（writer v6）+ 收尾手动验证 |
| ②核查不破坏正文 | Task 5（verifier v2 外科式改写）+ 收尾手动验证 |
| ③off 回归（行为忠实：仅渲染来源、无 callout） | Task 1（`renderExpositionDirective('off')` 纯函数断言）+ 既有 `buildIngestSteps('off')` 测试 |
| ④预算不爆 | Task 6（倍率 3→5）|
| ⑤单测 | Task 1/2/3/4/5/6 各自的 vitest 用例 |

> **对 spec §9.3 的细化**：spec 写"off 输出与旧 v5 逐字一致"，但 LLM 输出无法保证逐字。本计划把它落为**可测的行为契约**：`renderExpositionDirective('off')` 确定性返回"仅渲染来源、不加知识、无 callout"指令（纯函数可断言），且 `off` 仍跳过 enricher/verify（既有测试），即"忠实逃生口"成立。

## 已知限制（P1 范围外，留记录）

- **存量薄页不会自动变厚**：re-enrich 跳过 writer（现有正文当 draft），故对老的忠实薄页只补四类脚手架、不重写正文加深。让老页"讲透彻"需 P2/P3 或一次重新 ingest。
- 深度自适应（按主题难度迭代加深）= P2 完整性批判循环；联网把来源喂厚 = P3。
