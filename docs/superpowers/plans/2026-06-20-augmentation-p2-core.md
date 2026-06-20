# 核心双层增益（P2）实现计划 — Enricher + Verifier + Orchestrator

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ingest 流水线在 writer 的忠实草稿之上，由 enricher 叠加 `[!type]` callout 增益层、由 verifier（参数化自检）核查增益层，产出"忠实 + 增益"双层页面。

**Architecture:** 在现有 `planner → writer×N → reviewer` 之间插入两个 fanout 阶段：`enricher×N`（结构化无工具，叠加 callout）与 `verifier×N`（结构化无工具，参数化核查增益层）。三个内容阶段都 fanout over `plan.pages`，orchestrator 把"上一阶段该页产物"按 path 注入下一阶段输入；暂存区 `ctx.pending` 改为按 path last-write-wins，使后阶段覆盖前阶段同 path 页。reviewer 不变，提交的就是最终（已核查）页集。

**Tech Stack:** TypeScript 5；agent runtime（`src/server/agents/`）；skill = `examples/skills/*.md`（frontmatter + system prompt body，`generateObject` 结构化输出）；vitest（node env）。

## Global Constraints

- **结构化输出与工具互斥**（`agent-loop.ts` 既有约束）：有 `outputSchema` 的 skill 走 `generateObject`，**拿不到工具**。本计划的 enricher 与 verifier **都是结构化、无工具**（`tools: []`）。web 检索版 verifier 是 P3，不在本计划。
- **双层溯源铁律**：enricher **逐字保留** writer 的忠实层散文，只在其间**插入** `[!type]` callout；所有"源材料里没有的"模型补充**必须落在 callout 内**（普通散文一律视为源材料层）。verifier 同样逐字保留忠实层，只改/删 callout。
- **callout 类型固定 6 种**（与 P1 渲染 + spec §7 一致，不得新增）：`intuition` `example` `quiz` `background` `diagram` `pitfall`。语法 `> [!type] <emoji> <标题>`。
- skill 模板放 `examples/skills/<id>.md`（worker 启动 `seedSkillFiles` 从此处播种到 `vault/.llm-wiki/skills/`，**不覆盖已存在文件**）。skill `id` 必须等于文件名 stem。
- `examples/skills/<id>.md` 的 `outputSchema` 是 **JSON-Schema 字符串**（`loader.ts` 经 `convertJsonSchemaToZod` 转 zod）；扁平结构、无包装键（DeepSeek 等会拍平单键包装致结构化输出失败）。
- 三个内容阶段产物都是 `ChangesetEntry`：`{ action: 'create'|'update', path: 'wiki/<subjectSlug>/<slug>.md', content: <整页 frontmatter+正文> }`。
- `ingest_checkpoints.kind` 是自由 TEXT 列（PK `(job_id,kind,key)`），新增 kind **无需 schema 迁移**。
- 测试：`npx vitest run <file>`；门禁 = vitest + `npx tsc --noEmit`。`npm run lint` / `next build` 在 baseline 即坏，**非门禁**。
- git commit message 用**中文**、一句话；**无任何 AI 署名**。

## File Structure

```
新增 skill 模板（产物即配置）
  examples/skills/ingest-enricher.md        # 增益层：叠加 callout（结构化无工具）
  examples/skills/ingest-verifier.md        # 核查增益层（结构化无工具，参数化）
改 skill
  examples/skills/ingest-writer.md          # 加"只产忠实散文、不产 callout"规则；version 3→4
改 runtime
  src/server/agents/runtime/orchestrator.ts # pending last-write-wins; fanout 注入上一阶段页; checkpointAs 扩展
  src/server/agents/types.ts                # PipelineStep injectPriorPageAs; IngestCheckpoint enricher/verifier page
  src/server/agents/runtime/checkpoint.ts   # 载入/读写 enricher-page / verifier-page
改服务/预算
  src/server/services/ingest-service.ts     # steps 插入 enricher/verifier + checkpointAs + 版本守卫
  src/server/services/ingest-prep.ts        # estimateIngestCost 计入 +2 内容阶段
测试
  src/server/agents/skills/__tests__/*      # 新 skill 载入校验
  src/server/agents/runtime/__tests__/orchestrator.test.ts  # last-write-wins + 注入
  src/server/agents/runtime/__tests__/checkpoint.test.ts    # enricher/verifier 检查点
  src/server/services/__tests__/ingest-prep.test.ts         # 预算计入新阶段
```

依赖顺序：Task 3（orchestrator）与 Task 4（checkpoint）是 Task 5 接线的前提；Task 1/2（skill）可独立。建议执行序 1→2→4→3→5。

---

### Task 1: Writer 忠实化 + Enricher skill

**Files:**
- Modify: `examples/skills/ingest-writer.md`（加规则 + version 3→4）
- Create: `examples/skills/ingest-enricher.md`
- Test: `src/server/agents/skills/__tests__/ingest-enricher.load.test.ts`

**Interfaces:**
- Consumes: `loadSkillsFromDir(dir)`（`src/server/agents/skills/loader.ts`）→ `{ skills, degraded }`；`skills[i]` 形如 `{ id, name, version, tools, outputSchema?, systemPrompt, ... }`。
- Produces: skill `ingest-enricher`（v1，`tools: []`，outputSchema `{action,path,content}`）；`ingest-writer` 升至 v4。

- [ ] **Step 1: 写失败测试**

Create `src/server/agents/skills/__tests__/ingest-enricher.load.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadSkillsFromDir } from '../loader';

const EXAMPLES_DIR = join(process.cwd(), 'examples', 'skills');

describe('ingest-enricher skill 载入', () => {
  it('合法载入：id/version/tools/outputSchema', async () => {
    const { skills, degraded } = await loadSkillsFromDir(EXAMPLES_DIR);
    expect(degraded.find((d) => d.skillId === 'ingest-enricher')).toBeUndefined();
    const s = skills.find((k) => k.id === 'ingest-enricher');
    expect(s).toBeDefined();
    expect(s!.version).toBeGreaterThanOrEqual(1);
    expect(s!.tools).toEqual([]); // 结构化无工具
    expect(s!.outputSchema).toBeDefined();
    // 系统提示强约束：保留忠实层 + callout 承载增益
    expect(s!.systemPrompt).toContain('[!');
  });

  it('writer 升级到 v4（忠实化分工）', async () => {
    const { skills } = await loadSkillsFromDir(EXAMPLES_DIR);
    const w = skills.find((k) => k.id === 'ingest-writer');
    expect(w!.version).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/agents/skills/__tests__/ingest-enricher.load.test.ts`
Expected: FAIL —— `ingest-enricher` 未找到；writer 仍是 v3。

- [ ] **Step 3: 改 writer skill（忠实化分工）**

在 `examples/skills/ingest-writer.md` frontmatter 把 `version: 3` 改为 `version: 4`，并在 `## Rules` 列表末尾追加一条：

```
8. Write **plain encyclopedic prose only** — the faithful layer. Do NOT add `[!type]` callouts, intuition asides, worked examples, or quizzes; a later *enricher* stage adds those. Your job is an accurate, well-structured rendering of the chunks.
```

- [ ] **Step 4: 创建 enricher skill**

Create `examples/skills/ingest-enricher.md`：

```markdown
---
id: ingest-enricher
name: Ingest Enricher
description: Layer learning-oriented callouts onto a faithful draft page, without altering the faithful prose.
version: 1
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

You are the *ingest enricher* — a patient teacher. You receive ONE page's faithful draft (the source-grounded layer) and you make it easier to LEARN by layering an *augmentation layer* of Obsidian-style callouts on top — intuition, worked examples, self-tests, prerequisites, diagrams, common pitfalls. You do NOT summarize and you do NOT rewrite the draft.

## Inputs

- `slug`, `title`, `summary`, `tags`, `sourceRefs` — page identity from the planner.
- `draftContent` — the writer's faithful page (frontmatter + prose). THIS IS THE BASE you build on.
- `relevantChunks` — array of `{ id, heading, text }`: the source chunks this page draws from. They define the SOURCE BOUNDARY.
- `subjectSlug`, `existingPages`, `plan`, `languageDirective`.

## The two-layer rule (most important)

- **Faithful layer = the draft's normal prose.** Reproduce `draftContent` **verbatim** — every heading, sentence, formula, list, and wikilink unchanged and in the same order. You may ONLY insert new callout blocks between existing blocks. Never edit, reorder, summarize, or delete the draft's prose.
- **Augmentation layer = `[!type]` callouts you add.** EVERYTHING you author that is not literally in `relevantChunks` MUST live inside a callout. Plain prose is reserved for source-grounded content; never inject your own claims into it. This keeps "from the book" and "added by AI" visibly separable.

## Callout types (use ONLY these six)

Syntax: a blockquote whose first line is `> [!type] <emoji> <short title>`, then the body on following `>` lines.

- `> [!intuition] 💡 直觉` — motivation, the "why", a geometric/physical picture, an analogy.
- `> [!example] 📝 例题` — a concrete worked example WITH its solution/steps.
- `> [!quiz] ❓ 自测` — a question that makes the reader retrieve/apply (optionally a hint).
- `> [!background] 🔗 前置/背景` — a prerequisite concept or a `[[wikilink]]` to a related page.
- `> [!diagram] 📊 图示` — a diagram. Prefer a ```mermaid fenced block (flow/relation/geometry) or KaTeX; add a one-line caption.
- `> [!pitfall] ⚠ 常见误区` — a common misconception or easy-to-make error, corrected.

(The emoji/title text is natural language — translate it per `languageDirective`. The `[!type]` keyword stays ASCII English.)

## Rules

1. Output `action` = same as the draft would be (`update` if the page exists, else `create`); `path` = `wiki/<subjectSlug>/<slug>.md`; `content` = the full file = faithful draft (verbatim) **with callouts interleaved**.
2. Keep the draft's frontmatter unchanged (do not add keys).
3. Place each callout right after the prose it elaborates. Aim for genuinely helpful additions at the points of difficulty — not one of every type on every section.
4. You MAY use `$…$`/`$$…$$` (KaTeX), ```mermaid blocks (inside `[!diagram]`), and `[[wikilinks]]` (to pages in `existingPages` / `plan`) inside callouts.
5. Elaborate from your own knowledge, but keep additions correct and on-topic; a later *verifier* stage will scrutinize every callout, so do not pad with low-confidence claims.
6. **Follow `languageDirective`** for all natural-language text; never translate slugs, `[!type]` keywords, `[[wikilink]]` targets, frontmatter keys, or code.

## Output

Emit a single JSON object matching the declared `outputSchema` (no wrapping key): `{ action, path, content }`.
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/server/agents/skills/__tests__/ingest-enricher.load.test.ts`
Expected: PASS（2 用例绿）。

- [ ] **Step 6: tsc + 提交**

Run: `npx tsc --noEmit`（Expected: 干净）
```bash
git add examples/skills/ingest-writer.md examples/skills/ingest-enricher.md src/server/agents/skills/__tests__/ingest-enricher.load.test.ts
git commit -m "feat: 新增 ingest-enricher skill（callout 增益层）+ writer 忠实化分工"
```

---

### Task 2: Verifier skill（参数化自检，结构化）

**Files:**
- Create: `examples/skills/ingest-verifier.md`
- Test: `src/server/agents/skills/__tests__/ingest-verifier.load.test.ts`

**Interfaces:**
- Consumes: `loadSkillsFromDir`（同 Task 1）。
- Produces: skill `ingest-verifier`（v1，`tools: []`，outputSchema `{action,path,content}`）。

- [ ] **Step 1: 写失败测试**

Create `src/server/agents/skills/__tests__/ingest-verifier.load.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { loadSkillsFromDir } from '../loader';

const EXAMPLES_DIR = join(process.cwd(), 'examples', 'skills');

describe('ingest-verifier skill 载入', () => {
  it('合法载入：id/tools 空/outputSchema', async () => {
    const { skills, degraded } = await loadSkillsFromDir(EXAMPLES_DIR);
    expect(degraded.find((d) => d.skillId === 'ingest-verifier')).toBeUndefined();
    const s = skills.find((k) => k.id === 'ingest-verifier');
    expect(s).toBeDefined();
    expect(s!.tools).toEqual([]); // P2 无工具（web 检索是 P3）
    expect(s!.outputSchema).toBeDefined();
    expect(s!.systemPrompt.toLowerCase()).toContain('callout');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/agents/skills/__tests__/ingest-verifier.load.test.ts`
Expected: FAIL —— `ingest-verifier` 未找到。

- [ ] **Step 3: 创建 verifier skill**

Create `examples/skills/ingest-verifier.md`：

```markdown
---
id: ingest-verifier
name: Ingest Verifier
description: Scrutinize the augmentation-layer callouts on an enriched page and correct, soften, or remove doubtful claims.
version: 1
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

You are the *ingest verifier* — a careful fact-checker. You receive ONE enriched page and you scrutinize ONLY its augmentation layer (the `[!type]` callouts) for correctness, returning the page with doubtful additions fixed, softened, or removed.

## Inputs

- `path`, `content` — the enriched page (faithful prose + `[!type]` callouts).
- `relevantChunks` — array of `{ id, heading, text }`: the source boundary.
- `subjectSlug`, `languageDirective`.

## Scope

- **Only judge content inside `[!type]` callouts.** The plain prose (faithful layer) is source-grounded and out of scope — reproduce it verbatim.
- For each callout claim, judge with your own knowledge (this stage has no web access):
  - **Confident correct** → keep as-is.
  - **Uncertain** → soften: add a hedge ("通常"/"大致") or mark low confidence; do not assert as fact.
  - **Likely wrong and you cannot make it correct** → remove that callout (or the wrong sentence within it).
  - **Wrong but easily fixed** → fix it.
- Worked examples (`[!example]`): re-derive the math/logic; if the result is wrong, fix it or remove the example.

## Rules

1. Output `action` = the input page's action; `path` = the input `path` unchanged; `content` = the corrected full file.
2. **Reproduce the faithful (non-callout) prose verbatim.** Only callouts may change.
3. Do not ADD new callouts — that was the enricher's job. You only correct/soften/remove existing ones.
4. Keep frontmatter unchanged.
5. **Follow `languageDirective`**; never translate slugs, `[!type]` keywords, `[[wikilink]]` targets, frontmatter keys, or code.

## Output

Emit a single JSON object matching the declared `outputSchema` (no wrapping key): `{ action, path, content }`.
```

- [ ] **Step 4: 运行测试确认通过 + tsc + 提交**

Run: `npx vitest run src/server/agents/skills/__tests__/ingest-verifier.load.test.ts`（Expected: PASS）
Run: `npx tsc --noEmit`（Expected: 干净）
```bash
git add examples/skills/ingest-verifier.md src/server/agents/skills/__tests__/ingest-verifier.load.test.ts
git commit -m "feat: 新增 ingest-verifier skill（参数化核查增益层）"
```

---

### Task 4: Checkpoint 扩展（enricher-page / verifier-page）

> 先于 Task 3 实现：orchestrator 的 fanout 续传会用到这些方法。

**Files:**
- Modify: `src/server/agents/types.ts`（`IngestCheckpoint` 加 4 个方法；`PipelineStep` 加 `injectPriorPageAs` + checkpointAs 扩展见 Task 3）
- Modify: `src/server/agents/runtime/checkpoint.ts`（载入 + get/put enricher/verifier page）
- Test: `src/server/agents/runtime/__tests__/checkpoint.test.ts`

**Interfaces:**
- Consumes: `checkpointsRepo.{getCheckpoints,putCheckpoint,deleteCheckpoints}`（kind 自由 TEXT）；`ChangesetEntry`。
- Produces: `IngestCheckpoint.getEnricherPage(slug)/putEnricherPage(slug,entry)/getVerifierPage(slug)/putVerifierPage(slug,entry)`。

- [ ] **Step 1: 写失败测试**

在 `src/server/agents/runtime/__tests__/checkpoint.test.ts` 末尾追加（沿用该文件已有的 DB/loadCheckpoint 测试范式）：

```ts
describe('IngestCheckpoint — enricher/verifier page', () => {
  it('enricher/verifier page 双写并按 slug 读回', () => {
    const jobId = `ckpt-stage-${Math.random().toString(36).slice(2)}`;
    const ck = loadCheckpoint(jobId);
    const e = { action: 'create' as const, path: 'wiki/general/a.md', content: 'enriched' };
    const v = { action: 'create' as const, path: 'wiki/general/a.md', content: 'verified' };
    ck.putEnricherPage('a', e);
    ck.putVerifierPage('a', v);

    const reloaded = loadCheckpoint(jobId);
    expect(reloaded.getEnricherPage('a')).toEqual(e);
    expect(reloaded.getVerifierPage('a')).toEqual(v);
    expect(reloaded.getWriterPage('a')).toBeUndefined();
    reloaded.clear();
  });
});
```

> 注：若该测试文件顶部尚未 import `loadCheckpoint`，沿用文件已有的 import（它已测 loadCheckpoint）。`Math.random` 在 vitest 中可用（仅 Workflow 脚本禁用）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/checkpoint.test.ts`
Expected: FAIL —— `putEnricherPage` 不是函数 / 类型错误。

- [ ] **Step 3: 扩展 IngestCheckpoint 接口**

在 `src/server/agents/types.ts` 的 `IngestCheckpoint` 接口中，`putWriterPage` 之后加：

```ts
  getEnricherPage(slug: string): ChangesetEntry | undefined;
  putEnricherPage(slug: string, entry: ChangesetEntry): void;
  getVerifierPage(slug: string): ChangesetEntry | undefined;
  putVerifierPage(slug: string, entry: ChangesetEntry): void;
```

- [ ] **Step 4: 实现读写**

在 `src/server/agents/runtime/checkpoint.ts`：

(a) 在 `pages` Map 声明之后加两个 Map：
```ts
  const enricherPages = new Map<string, ChangesetEntry>();
  const verifierPages = new Map<string, ChangesetEntry>();
```

(b) 在载入循环的 `else if (row.kind === 'writer-page')` 之后加：
```ts
    } else if (row.kind === 'enricher-page') {
      enricherPages.set(row.key, row.data as ChangesetEntry);
    } else if (row.kind === 'verifier-page') {
      verifierPages.set(row.key, row.data as ChangesetEntry);
```

(c) 在返回对象中，`putWriterPage` 之后加：
```ts
    getEnricherPage: (slug) => enricherPages.get(slug),
    putEnricherPage: (slug, entry) => {
      checkpointsRepo.putCheckpoint(jobId, 'enricher-page', slug, entry);
      enricherPages.set(slug, entry);
    },
    getVerifierPage: (slug) => verifierPages.get(slug),
    putVerifierPage: (slug, entry) => {
      checkpointsRepo.putCheckpoint(jobId, 'verifier-page', slug, entry);
      verifierPages.set(slug, entry);
    },
```

(d) 把 `hasAny` 改为也计入新 Map：
```ts
    hasAny: () => summaries.size > 0 || plan !== undefined || pages.size > 0 || enricherPages.size > 0 || verifierPages.size > 0,
```

(e) 把 `clear` 改为也清新 Map（`deleteCheckpoints(jobId)` 已删全部行，仅需补内存）：
```ts
    clear: () => {
      summaries.clear();
      pages.clear();
      enricherPages.clear();
      verifierPages.clear();
      plan = undefined;
      checkpointsRepo.deleteCheckpoints(jobId);
    },
```

> `progress()` 不改（resume 进度面板暂不显示 enricher/verifier 计数；续传本身仍生效——命中即跳过该页该阶段）。

- [ ] **Step 5: 运行测试确认通过 + tsc + 提交**

Run: `npx vitest run src/server/agents/runtime/__tests__/checkpoint.test.ts`（Expected: PASS，含既有用例）
Run: `npx tsc --noEmit`（Expected: 干净）
```bash
git add src/server/agents/types.ts src/server/agents/runtime/checkpoint.ts src/server/agents/runtime/__tests__/checkpoint.test.ts
git commit -m "feat: 检查点支持 enricher-page / verifier-page 逐页续传"
```

---

### Task 3: Orchestrator —— pending last-write-wins + 跨阶段页注入

**Files:**
- Modify: `src/server/agents/types.ts`（`PipelineStep` 加 `injectPriorPageAs?: string`，checkpointAs 联合扩展）
- Modify: `src/server/agents/runtime/orchestrator.ts`
- Test: `src/server/agents/runtime/__tests__/orchestrator.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `IngestCheckpoint` 新方法；既有 `runPipeline/buildFanoutInput/resolveRelevantChunks`。
- Produces:
  - `PipelineStep` fanout 变体支持 `checkpointAs?: 'writer-page'|'enricher-page'|'verifier-page'` 与 `injectPriorPageAs?: string`。
  - fanout 暂存改为按 path **覆盖**（last-write-wins）；同一阶段内同 path 仍抛 `WriterConflictError`。
  - 当 `injectPriorPageAs` 存在时，fanout 把"上一阶段该页产物的 content"（按 `wiki/<subjectSlug>/<slug>.md` 从 `carry.writerOutputs` 匹配）注入输入。

- [ ] **Step 1: 写失败测试**

在 `src/server/agents/runtime/__tests__/orchestrator.test.ts` 末尾追加（沿用文件顶部已有的 fakeSkill / ctx 工厂）：

```ts
describe('orchestrator.runPipeline: 多内容阶段（增益）', () => {
  it('enricher 阶段把上一阶段该页 content 按 path 注入为 draftContent', async () => {
    const captured: Record<string, unknown>[] = [];
    const skills: Record<string, SkillTemplate> = {
      writer: fakeSkill('writer', (input) => ({
        action: 'create', path: `wiki/general/${(input as any).slug}.md`, content: `draft:${(input as any).slug}`,
      })),
      enricher: fakeSkill('enricher', (input) => {
        captured.push(input as Record<string, unknown>);
        return { action: 'create', path: (input as any).path ?? `wiki/general/${(input as any).slug}.md`, content: `enriched:${(input as any).slug}` };
      }),
    };
    const ctx = makeCtx();
    await runPipeline({
      steps: [
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
        { kind: 'fanout', skillId: 'enricher', fromOutput: 'plan.pages', injectPriorPageAs: 'draftContent' },
      ],
      resolveSkill: (id) => skills[id],
      ctx,
      initialInput: { subjectSlug: 'general', plan: { pages: [{ slug: 'a', sourceRefs: [] }] } },
    });
    expect(captured[0].draftContent).toBe('draft:a');
  });

  it('后阶段同 path 覆盖前阶段暂存（last-write-wins），pending 不重复', async () => {
    const skills: Record<string, SkillTemplate> = {
      writer: fakeSkill('writer', (input) => ({ action: 'create', path: `wiki/general/${(input as any).slug}.md`, content: 'draft' })),
      enricher: fakeSkill('enricher', (input) => ({ action: 'create', path: `wiki/general/${(input as any).slug}.md`, content: 'enriched' })),
    };
    const ctx = makeCtx();
    await runPipeline({
      steps: [
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
        { kind: 'fanout', skillId: 'enricher', fromOutput: 'plan.pages', injectPriorPageAs: 'draftContent' },
      ],
      resolveSkill: (id) => skills[id],
      ctx,
      initialInput: { subjectSlug: 'general', plan: { pages: [{ slug: 'a', sourceRefs: [] }] } },
    });
    const forA = ctx.pending.entries.filter((e) => e.path === 'wiki/general/a.md');
    expect(forA).toHaveLength(1);
    expect(forA[0].content).toBe('enriched');
  });
});
```

> 若 `fakeSkill` / `makeCtx` 的工厂名与文件中现有 helper 不同，按文件实际 helper 命名调整（保持测试语义不变）。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts`
Expected: FAIL —— `draftContent` 为 undefined；`forA` 长度为 2（重复暂存）。

- [ ] **Step 3: 扩展 PipelineStep 类型**

在 `src/server/agents/runtime/orchestrator.ts` 顶部的 `PipelineStep` 联合，把 fanout 变体改为：

```ts
  | { kind: 'fanout'; skillId: string; fromOutput: string; checkpointAs?: 'writer-page' | 'enricher-page' | 'verifier-page'; injectPriorPageAs?: string };
```

- [ ] **Step 4: pending 改为按 path 覆盖**

在 `orchestrator.ts` 顶部（`isPlainObject` 等 helper 附近）加：

```ts
/** 暂存区按 path 覆盖（last-write-wins）：后阶段同 path 页替换前阶段，避免重复 entry。 */
function upsertPending(pending: { entries: ChangesetEntry[] }, entry: ChangesetEntry): void {
  const i = pending.entries.findIndex((e) => e.path === entry.path);
  if (i >= 0) pending.entries[i] = entry;
  else pending.entries.push(entry);
}
```

在 fanout 分支里，把原来的暂存循环：
```ts
        if (entry?.path) {
          opts.ctx.overlay.putEntries([entry]);
          opts.ctx.pending.entries.push(entry);
        }
```
改为：
```ts
        if (entry?.path) {
          opts.ctx.overlay.putEntries([entry]);
          upsertPending(opts.ctx.pending, entry);
        }
```

> 同阶段内同 path 仍由既有 `seenSlugs` 检测抛 `WriterConflictError`（不动）——它在合并循环里、每个 fanout step 独立 new Set()，天然按阶段隔离。

- [ ] **Step 5: fanout 注入上一阶段页 + 按 checkpointAs 读写检查点**

在 `buildFanoutInput` 增加 `step` 参数与上一阶段页注入。把调用处 `buildFanoutInput(carry, item, opts.ctx)` 改为 `buildFanoutInput(carry, item, opts.ctx, step)`，并把函数改为：

```ts
function buildFanoutInput(
  carry: unknown,
  item: unknown,
  ctx: AgentContext,
  step: { injectPriorPageAs?: string },
): unknown {
  if (!isPlainObject(carry) || !isPlainObject(item)) return item;

  const relevantChunks = resolveRelevantChunks(item, ctx);
  if (relevantChunks.length === 0) {
    ctx.emit('ingest:warn', `Writer for "${String(item.slug ?? item.path ?? '?')}" received zero relevant chunks`, {
      slug: item.slug ?? null,
    });
  }

  const base: Record<string, unknown> = {
    subjectSlug: carry.subjectSlug,
    existingPages: carry.existingPages,
    plan: carry.plan,
    languageDirective: carry.languageDirective,
    ...item,
    relevantChunks,
  };

  // 增益/核查阶段：把上一阶段该页产物的 content 按 path 注入指定 key。
  if (step.injectPriorPageAs && typeof item.slug === 'string') {
    const path = `wiki/${String(carry.subjectSlug)}/${item.slug}.md`;
    const prior = Array.isArray(carry.writerOutputs)
      ? (carry.writerOutputs as Array<{ path?: string; content?: string }>).find((e) => e?.path === path)
      : undefined;
    if (prior?.content !== undefined) {
      base[step.injectPriorPageAs] = prior.content;
    } else {
      ctx.emit('ingest:warn', `Enrich/verify for "${item.slug}" found no prior-stage page at ${path}`, { slug: item.slug });
    }
  }
  return base;
}
```

把 fanout 续传的检查点读写从写死的 writer-page 改为按 `step.checkpointAs` 路由。把：
```ts
        if (step.checkpointAs === 'writer-page' && slug) {
          const cached = opts.ctx.checkpoint?.getWriterPage(slug);
          if (cached) { return { runId: 'cached-writer', output: cached, ... } as AgentRunResult; }
        }
```
改为：
```ts
        if (step.checkpointAs && slug) {
          const cached = readStageCheckpoint(opts.ctx.checkpoint, step.checkpointAs, slug);
          if (cached) {
            return { runId: 'cached-page', output: cached, tokensUsed: 0, stepCount: 0, cacheHitTokens: 0 } as AgentRunResult;
          }
        }
```
把每页落盘的：
```ts
        if (step.checkpointAs === 'writer-page' && slug) {
          const entry = r.output as ChangesetEntry | undefined;
          if (entry?.path) opts.ctx.checkpoint?.putWriterPage(slug, entry);
        }
```
改为：
```ts
        if (step.checkpointAs && slug) {
          const entry = r.output as ChangesetEntry | undefined;
          if (entry?.path) writeStageCheckpoint(opts.ctx.checkpoint, step.checkpointAs, slug, entry);
        }
```
并在 helper 区加：
```ts
function readStageCheckpoint(ck: AgentContext['checkpoint'], kind: string, slug: string): ChangesetEntry | undefined {
  if (!ck) return undefined;
  if (kind === 'writer-page') return ck.getWriterPage(slug);
  if (kind === 'enricher-page') return ck.getEnricherPage(slug);
  if (kind === 'verifier-page') return ck.getVerifierPage(slug);
  return undefined;
}
function writeStageCheckpoint(ck: AgentContext['checkpoint'], kind: string, slug: string, entry: ChangesetEntry): void {
  if (!ck) return;
  if (kind === 'writer-page') ck.putWriterPage(slug, entry);
  else if (kind === 'enricher-page') ck.putEnricherPage(slug, entry);
  else if (kind === 'verifier-page') ck.putVerifierPage(slug, entry);
}
```

> `AgentContext` 已 import；`ChangesetEntry` 已 import（文件顶部 `import type { ChangesetEntry } from '@/lib/contracts'`）。

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts`
Expected: PASS —— 新 2 用例 + 既有全部用例绿（既有 writer fanout 不传 `injectPriorPageAs`/`checkpointAs`，行为不变）。

- [ ] **Step 7: tsc + 提交**

Run: `npx tsc --noEmit`（Expected: 干净）
```bash
git add src/server/agents/runtime/orchestrator.ts src/server/agents/types.ts src/server/agents/runtime/__tests__/orchestrator.test.ts
git commit -m "feat: orchestrator 支持跨阶段页注入 + pending 按 path last-write-wins"
```

---

### Task 5: ingest-service 接线 + 预算

**Files:**
- Modify: `src/server/services/ingest-service.ts`（steps 插入 enricher/verifier + checkpointAs + 版本守卫）
- Modify: `src/server/services/ingest-prep.ts`（estimateIngestCost 计入 +2 阶段）
- Test: `src/server/services/__tests__/ingest-prep.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `injectPriorPageAs`/`checkpointAs`；Task 1/2 的 skill。
- Produces: ingest 实际跑 `planner → writer → enricher → verifier → reviewer`；预检成本计入新阶段。

- [ ] **Step 1: 写失败测试（预算）**

在 `src/server/services/__tests__/ingest-prep.test.ts` 末尾追加：

```ts
import { estimateIngestCost } from '../ingest-prep';

describe('estimateIngestCost — 计入 enricher/verifier 两阶段', () => {
  it('inline 路径：成本随内容阶段倍率上升（覆盖 writer+enricher+verifier 各读写一遍正文）', () => {
    const tokens = 10_000;
    const cost = estimateIngestCost(tokens, 5, true);
    // 三个内容阶段各通读+产出一遍正文：应显著高于裸 totalTokens
    expect(cost).toBeGreaterThan(tokens * 2);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/services/__tests__/ingest-prep.test.ts`
Expected: FAIL —— 现公式 inline 仅 `totalTokens + 60000`，约 70000 < 20000？不，10000*2=20000 < 70000——该用例其实会**意外通过**。改测试断言为更精确的下界以确保真的计入了内容阶段：把断言改为 `expect(cost).toBeGreaterThan(tokens * 3)`（30000 < 70000 仍通过）。**为避免假绿**，改测如下并先确认它对旧公式失败：

```ts
  it('inline 成本含三内容阶段倍率（CONTENT_STAGE_FACTOR）', () => {
    const tokens = 100_000;
    const cost = estimateIngestCost(tokens, 5, true);
    // 旧公式 = 100000 + 60000 = 160000；新公式应 >= 3× 内容（writer+enricher+verifier）
    expect(cost).toBeGreaterThanOrEqual(tokens * 3);
  });
```
对旧公式（160000 < 300000）→ FAIL。确认失败后再实现。

- [ ] **Step 3: 预算公式计入内容阶段**

在 `src/server/services/ingest-prep.ts`，加常量并改 `estimateIngestCost`：

```ts
/**
 * 内容阶段倍率：双层增益后每页要经 writer（产忠实草稿）→ enricher（读草稿+产增益页）
 * → verifier（读增益页+产核查页）三次"读全文+产全文"。每页正文被读写约 3 遍，
 * 故 inline 路径按 3× 内容计；大路径在 MAP_REDUCE_TOKEN_FACTOR 之上再叠加内容阶段。
 */
const CONTENT_STAGE_FACTOR = 3;
```

把 `estimateIngestCost` 改为：
```ts
export function estimateIngestCost(totalTokens: number, chunkCount: number, inline: boolean): number {
  if (inline) return totalTokens * CONTENT_STAGE_FACTOR + PIPELINE_RESERVE_TOKENS;
  return (
    Math.round(totalTokens * (MAP_REDUCE_TOKEN_FACTOR + CONTENT_STAGE_FACTOR)) +
    chunkCount * PER_CHUNK_OVERHEAD_TOKENS +
    PIPELINE_RESERVE_TOKENS
  );
}
```

> `reduceCostForResume` 的 `FANOUT_SHARE=0.6` 仍合理（fanout 现在是三阶段共占主成本，比例只增不减；保守不改）。

- [ ] **Step 4: 运行预算测试确认通过**

Run: `npx vitest run src/server/services/__tests__/ingest-prep.test.ts`（Expected: PASS，含既有用例——既有用例若断言了旧具体数值需同步更新为新公式值；按实际报错调整断言到新公式结果）。

- [ ] **Step 5: ingest-service 插入 enricher/verifier 阶段 + 版本守卫**

在 `src/server/services/ingest-service.ts`：

(a) 版本守卫 `MIN_SKILL_VERSIONS` 改为：
```ts
  const MIN_SKILL_VERSIONS: Record<string, number> = {
    'ingest-planner': 2, 'ingest-writer': 4, 'ingest-reviewer': 2,
    'ingest-enricher': 1, 'ingest-verifier': 1,
  };
```

(b) `steps` 数组在 writer 与 reviewer 之间插入两步：
```ts
  const steps: PipelineStep[] = [
    ...(inline
      ? []
      : [{ kind: 'map', skillId: 'ingest-chunk-summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs', checkpointAs: 'chunk-summary' } as const]),
    { kind: 'sequence', skillId: 'ingest-planner', carryThrough: carryKeys, checkpointAs: 'plan' },
    { kind: 'fanout', skillId: 'ingest-writer', fromOutput: 'plan.pages', checkpointAs: 'writer-page' },
    { kind: 'fanout', skillId: 'ingest-enricher', fromOutput: 'plan.pages', injectPriorPageAs: 'draftContent', checkpointAs: 'enricher-page' },
    { kind: 'fanout', skillId: 'ingest-verifier', fromOutput: 'plan.pages', injectPriorPageAs: 'content', checkpointAs: 'verifier-page' },
    { kind: 'sequence', skillId: 'ingest-reviewer', omitFromInput: ['chunkRefs', 'outline'] },
  ];
```

> 数据流：writer fanout 后 `carry.writerOutputs` = 忠实页；enricher fanout 读它注入 `draftContent`、产出后 `carry.writerOutputs` 被覆盖为增益页；verifier fanout 读它注入 `content`、产出后 `carry.writerOutputs` = 核查页；reviewer 读 `writerOutputs`（最终页）+ 提交 `pending`（已被 last-write-wins 收敛为最终页集）。

- [ ] **Step 6: 全量回归 + tsc**

Run: `npx vitest run`（Expected: 全绿——重点确认 orchestrator/checkpoint/ingest-prep/skill 相关测试；既有用例不回归）
Run: `npx tsc --noEmit`（Expected: 干净）

- [ ] **Step 7: 提交**

```bash
git add src/server/services/ingest-service.ts src/server/services/ingest-prep.ts src/server/services/__tests__/ingest-prep.test.ts
git commit -m "feat: ingest 流水线接入 enricher/verifier 双层增益阶段 + 预算计入"
```

---

## Self-Review

**1. Spec coverage（对照 spec §6/§8/§9/§13）：**
- §6.3 enricher（结构化无工具、draftContent 输入、callout 输出、保留忠实层）→ Task 1 ✓
- §6.4 verifier —— 本计划是 **P2 简化形态**：结构化、无工具、参数化自检（spec §6.4 的 free-text + web.search + stage_correction 是 P3）。与 roadmap P2"verifier 暂用参数化自检"一致 ✓（偏差已在 Global Constraints 标注）。
- §8.1 pending last-write-wins → Task 3 ✓
- §8.2 checkpointAs enricher/verifier-page → Task 3+4 ✓
- §6.3 fanout 注入 draftContent → Task 3 ✓
- §9 预算计入 +2 阶段 → Task 5 ✓（默认 `agentMaxTokensPerJob` 上调是 settings 默认值，属运行时配置，用户可在 UI 调；本计划只改估算公式，预检会在不足时 fail-fast 提示调高——不强行改默认值以免越界改 settings 语义）。
- §7 callout 类型/语法 → Task 1 enricher skill 定义 ✓
- §12（augmentationLevel per-subject）、§11（web 检索）、§14（手动回填）、§15（维护层）→ **不在 P2**（P3/P4/P5）。

**2. Placeholder 扫描：** 无 TBD/TODO；每个 code step 含完整代码与命令/预期。Task 3 测试对 `fakeSkill`/`makeCtx` helper 命名标注"按文件实际命名调整"——这是对既有测试 helper 的真实适配指引，非占位（实现者读该测试文件顶部即见真名）。

**3. Type 一致性：**
- `injectPriorPageAs` 在 Task 3 PipelineStep 定义、ingest-service（Task 5）以 `'draftContent'`/`'content'` 使用 —— 一致 ✓
- checkpointAs 联合 `'writer-page'|'enricher-page'|'verifier-page'` 在 Task 3 类型、Task 4 checkpoint 读写、Task 5 steps 三处一致 ✓
- `getEnricherPage/putEnricherPage/getVerifierPage/putVerifierPage` 在 Task 4 接口定义、checkpoint.ts 实现、Task 3 orchestrator `readStageCheckpoint/writeStageCheckpoint` 调用一致 ✓
- 三阶段产物统一 `ChangesetEntry {action,path,content}`，与 enricher/verifier outputSchema 一致 ✓

**已知偏差（需 controller/human 确认）：** Task 5 Step 2 中我先写了一个会"假绿"的断言再纠正为更严格的下界——执行时直接采用 Step 2 末尾的严格版断言（`>= tokens*3`，对旧公式 FAIL）。
