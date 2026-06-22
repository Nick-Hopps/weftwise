# Ingest 增量合并进已有页（Incremental Merge）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ingest 更新已有页时，由 orchestrator 确定性注入该页现有正文，writer 把新材料并入现有正文（保留已有知识、不覆盖）；planner 强化「已有主题复用其 slug」。

**Architecture:** 在 fanout 的 `buildFanoutInput` 里，writer 阶段若本页 slug 命中 `existingPages`（=更新），读 `ctx.overlay.readPage` 得现有正文注入 `existingPageContent`；writer skill 据此并入新材料。update 判定确定性（existingPages 成员），不依赖 LLM action 字段。

**Tech Stack:** TypeScript 5、Vitest（node）、multi-agent runtime（orchestrator/skill）。

## Global Constraints

- update 判定 = `existingPages` 成员（确定性），不加 planner `action` 字段。
- 注入机制 = orchestrator 确定性注入（`ctx.overlay.readPage`），不靠 LLM 调 `vault.read`。
- 不改 DB schema / Saga / `seedSkillFiles` / enricher / verifier / indexer / commitPending。
- skill 改动只动 `examples/skills/`（git 源）；`data/vault/.llm-wiki/skills/` 为 gitignore 运行时副本，**不提交、不手动改**。
- writer 仍为结构化输出无写盘工具。
- 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，**非门禁**。
- commit message 中文一句话；**禁止** AI 署名 trailer / 脚注。

---

### Task 1: orchestrator 注入现有正文（`injectExistingPageForUpdate`）

**Files:**
- Modify: `src/server/agents/runtime/orchestrator.ts`（`PipelineStep` 第 8 行；`buildFanoutInput` 第 211 行；调用点第 132 行）
- Modify: `src/server/agents/runtime/__tests__/orchestrator.test.ts`

**Interfaces:**
- Consumes: `ctx.overlay.readPage(subjectSlug, slug): Promise<{ markdown: string } | null>`；`carry.existingPages: Array<{ slug; title; summary }>`；`item.slug`；现有 `isPlainObject`。
- Produces: `PipelineStep` fanout 变体新增可选 `injectExistingPageForUpdate?: boolean`；`buildFanoutInput` 改 `async`，update 页注入 `existingPageContent` 到 writer 输入。

- [ ] **Step 1: 写失败测试**

在 `src/server/agents/runtime/__tests__/orchestrator.test.ts` 的 `describe('orchestrator.runPipeline: fanout', ...)` 块内追加 3 个用例（紧接「可缓存公共前缀」用例之后即可）：

```ts
  it('writer 更新已有页（slug 命中 existingPages + flag）时注入 existingPageContent', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'existing-a', sourceRefs: [] }] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w', output: { action: 'update', path: 'wiki/general/existing-a.md', content: '' }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([]);
    const readPage = vi.fn().mockResolvedValue({ markdown: 'EXISTING BODY' });
    ctx.overlay.readPage = readPage as unknown as AgentContext['overlay']['readPage'];
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages'] },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages', injectExistingPageForUpdate: true },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [{ slug: 'existing-a', title: 'A', summary: 's' }] },
    });
    const writerInput = mockRun.mock.calls[1][0].input as Record<string, unknown>;
    expect(writerInput.existingPageContent).toBe('EXISTING BODY');
    expect(readPage).toHaveBeenCalledWith('general', 'existing-a');
  });

  it('writer 新建页（slug 不在 existingPages）不注入、也不读页', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'brand-new', sourceRefs: [] }] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w', output: { action: 'create', path: 'wiki/general/brand-new.md', content: '' }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([]);
    const readPage = vi.fn().mockResolvedValue({ markdown: 'X' });
    ctx.overlay.readPage = readPage as unknown as AgentContext['overlay']['readPage'];
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages'] },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages', injectExistingPageForUpdate: true },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [{ slug: 'existing-a', title: 'A', summary: 's' }] },
    });
    const writerInput = mockRun.mock.calls[1][0].input as Record<string, unknown>;
    expect(writerInput.existingPageContent).toBeUndefined();
    expect(readPage).not.toHaveBeenCalled();
  });

  it('未设 injectExistingPageForUpdate 时即使 slug 命中也不注入', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'existing-a', sourceRefs: [] }] } }, tokensUsed: 0, stepCount: 1 })
      .mockResolvedValueOnce({ runId: 'w', output: { action: 'update', path: 'wiki/general/existing-a.md', content: '' }, tokensUsed: 0, stepCount: 1 });
    const ctx = ctxStub([]);
    const readPage = vi.fn().mockResolvedValue({ markdown: 'EXISTING BODY' });
    ctx.overlay.readPage = readPage as unknown as AgentContext['overlay']['readPage'];
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages'] },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [{ slug: 'existing-a', title: 'A', summary: 's' }] },
    });
    const writerInput = mockRun.mock.calls[1][0].input as Record<string, unknown>;
    expect(writerInput.existingPageContent).toBeUndefined();
    expect(readPage).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts`
Expected: 第 1 个新用例 FAIL（`existingPageContent` 为 `undefined`，因为注入逻辑还没写）；另两个可能已 PASS（本就不该注入）。关键是看到「注入」用例失败。

- [ ] **Step 3: 实现注入**

(1) `orchestrator.ts` 第 8 行 `PipelineStep` 的 fanout 变体，末尾加可选字段：

```ts
  | { kind: 'fanout'; skillId: string; fromOutput: string; checkpointAs?: 'writer-page' | 'enricher-page' | 'verifier-page'; injectPriorPageAs?: string; injectExistingPageForUpdate?: boolean }
```

(2) `buildFanoutInput`（第 211 行）签名改为 `async` + 返回 `Promise<unknown>`，并扩展 `step` 形参类型；在现有 `injectPriorPageAs` 分支**之后、`return base;` 之前**插入注入逻辑：

把：

```ts
function buildFanoutInput(
  carry: unknown,
  item: unknown,
  ctx: AgentContext,
  step: { injectPriorPageAs?: string },
): unknown {
```

改为：

```ts
async function buildFanoutInput(
  carry: unknown,
  item: unknown,
  ctx: AgentContext,
  step: { injectPriorPageAs?: string; injectExistingPageForUpdate?: boolean },
): Promise<unknown> {
```

在 `return base;` 之前插入：

```ts
  // 增量合并：writer 阶段若本页 slug 命中 existingPages（=更新已有页），注入现有正文供 writer 并入。
  if (step.injectExistingPageForUpdate && typeof item.slug === 'string') {
    const existing = Array.isArray(carry.existingPages) ? carry.existingPages : [];
    const isUpdate = existing.some(
      (p) => isPlainObject(p) && (p as { slug?: unknown }).slug === item.slug,
    );
    if (isUpdate) {
      const page = await ctx.overlay.readPage(String(carry.subjectSlug), item.slug);
      if (page?.markdown) base.existingPageContent = page.markdown;
    }
  }
```

(3) 调用点（第 132 行）加 `await`：

把 `input: buildFanoutInput(carry, item, opts.ctx, step)` 改为 `input: await buildFanoutInput(carry, item, opts.ctx, step)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts`
Expected: 3 个新用例 + 全部既有 orchestrator 用例通过。

- [ ] **Step 5: 门禁 + 提交**

Run: `npx tsc --noEmit`（Expected: exit 0）
Run: `npx vitest run`（Expected: 全绿）

```bash
git add src/server/agents/runtime/orchestrator.ts src/server/agents/runtime/__tests__/orchestrator.test.ts
git commit -m "feat: orchestrator writer 更新已有页时确定性注入现有正文（injectExistingPageForUpdate）"
```

---

### Task 2: 启用注入 + writer 并入 / planner 复用 slug 指令

**Files:**
- Modify: `src/server/services/ingest-service.ts`（writer fanout step，第 165 行）
- Modify: `examples/skills/ingest-writer.md`
- Modify: `examples/skills/ingest-planner.md`

**Interfaces:**
- Consumes: Task 1 的 `injectExistingPageForUpdate` flag。
- Produces: writer step 启用注入；writer skill 在收到 `existingPageContent` 时并入新材料；planner 强化复用 slug。

> 无单测：one-line wiring + skill prompt（LLM 行为）。验收 = `tsc` 干净 + 既有 `vitest` 全绿 + dev 眼测（dev 眼测前置：删 `data/vault/.llm-wiki/skills/ingest-{writer,planner}.md` 后重启 worker 重新播种）。

- [ ] **Step 1: ingest-service 启用 writer 注入**

`src/server/services/ingest-service.ts` 第 165 行 writer fanout step：

```ts
    { kind: 'fanout', skillId: 'ingest-writer', fromOutput: 'plan.pages', checkpointAs: 'writer-page' },
```

改为：

```ts
    { kind: 'fanout', skillId: 'ingest-writer', fromOutput: 'plan.pages', checkpointAs: 'writer-page', injectExistingPageForUpdate: true },
```

- [ ] **Step 2: writer skill 加并入 Rule（version 5）**

`examples/skills/ingest-writer.md`：

(1) frontmatter `version: 4` 改为 `version: 5`。

(2) Inputs 区，在 `- \`subjectSlug\`, \`existingPages\`, \`plan\` — current vault and plan context.` 之后加一行：

```markdown
- `existingPageContent` — present ONLY when this page already exists (an update): the page's current full markdown (frontmatter + body). When present, you MUST merge into it (see Rule 9).
```

(3) Rules 区，在 Rule 8 之后加 Rule 9：

```markdown
9. **Incremental merge on update.** When the input includes `existingPageContent` (this page already exists), MERGE the new material from `relevantChunks` INTO that existing content: preserve all existing facts, sections, and `[[wikilinks]]`; integrate and de-duplicate the new information; reorganise only as needed for coherence. Do NOT discard existing content or rewrite from scratch. Output the merged full file (frontmatter + body) as `content`.
```

- [ ] **Step 3: planner skill 强化复用 slug（version 3）**

`examples/skills/ingest-planner.md`：

(1) frontmatter `version: 2` 改为 `version: 3`。

(2) Rule 2：

```markdown
2. Prefer updating an existing page over creating a near-duplicate. Use `vault.search` and `vault.read` if you need to inspect the existing page first.
```

改为：

```markdown
2. **Prefer updating an existing page over creating a near-duplicate.** If the incoming material is about a topic that already has a page in `existingPages` (match by title/summary), you MUST reuse that page's exact `slug` so the pipeline updates it in place instead of creating a duplicate. Use `vault.search` / `vault.read` to inspect the existing page first. Only mint a new slug for genuinely new topics.
```

- [ ] **Step 4: 门禁 + 提交**

Run: `npx tsc --noEmit`（Expected: exit 0）
Run: `npx vitest run`（Expected: 全绿，无回归；本任务不新增用例）

```bash
git add src/server/services/ingest-service.ts examples/skills/ingest-writer.md examples/skills/ingest-planner.md
git commit -m "feat: 启用 writer 现有正文注入 + writer 并入/planner 复用 slug 指令（ingest 增量合并）"
```

---

## 验收（全部任务完成后）

- `npx tsc --noEmit` 干净；`npx vitest run` 全绿（含新增 3 个 orchestrator 注入用例）。
- dev 眼测（**前置**：`rm data/vault/.llm-wiki/skills/ingest-writer.md data/vault/.llm-wiki/skills/ingest-planner.md` → `npm run dev:all` 重启使 worker 重新播种更新后的 skill）：
  1. 已有页 X（关于主题 T）。摄入一段关于 T 的**新材料**（补充新事实）。
  2. 期望：planner 复用 X 的 slug → writer 收到 `existingPageContent`（X 现有正文）→ 产出的 X **保留原有内容 + 并入新事实**（而非被新材料整页覆盖）；不新建近似重复页。
  3. 对照：去掉本特性时，同样操作会覆盖 X 或新建重复页。

## 边界与已知取舍（实现时照此处理，勿"自行补强"）

- update 判定靠 `existingPages` 成员（确定性）；planner 是否复用 slug 靠 LLM——漏判仍可能建近似重复页（语义匹配 = ⑧，本期接受）。
- 合并质量是 LLM 行为，靠 prompt + dev 验收，不做强校验。
- skill 改动只提交 `examples/skills/`；`data/vault/.llm-wiki/skills/` 不提交、不手改（gitignore 运行时副本，靠重新播种更新）。
- 不改 `seedSkillFiles`（保留用户自定义安全）；升级内置 skill 需手动重播种（v1 取舍）。
- writer 阶段 overlay 无内容 diff，`readPage` 即真实 vault 当前内容。
