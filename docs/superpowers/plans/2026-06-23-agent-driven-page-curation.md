# Agent 驱动页面策展（merge/split 内化）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉逐页 Merge/Split 按钮（只留 Edit），把合并/拆分升级为 agent 自动决策的「页面策展」能力——ingest 收尾自动触发 + Health 页手动触发，共用一个 `curate` 任务与确定性执行层。

**Architecture:** 新增 service-level curator（直接 `generateStructuredOutput`，无 tools，规避 packyapi 工具死循环）。triage（只读元数据收窄候选）→ confirm（候选取正文确认）→ 逐条执行。执行层把 merge/split 核心抽到纯函数 `wiki/page-ops.ts` 复用；merge/split 的 LLM prompt/schema 原样保留。

**Tech Stack:** Next.js 15 App Router + TypeScript + better-sqlite3/Drizzle + Vercel AI SDK（`generateObject`）+ vitest。

## Global Constraints

- 测试命令：`npm test`（= `vitest run`）；类型检查：`npx tsc --noEmit`。`npm run lint` 不可用（next lint 已弃用），不要依赖它。
- vitest `globals: false` —— 测试文件必须 `import { describe, expect, it } from 'vitest'`；测试匹配 glob `src/**/__tests__/**/*.test.ts`。
- 写操作经 services → `wiki-transaction` Saga（`createChangeset → validateChangeset → applyChangeset`），不得绕过。
- 所有 service 强校验 `subjectId`（`params.subjectId ?? job.subjectId`，缺失抛错）。
- 写接口 Route Handler 顺序：`requireAuth(request)` → `requireCsrf(request)` → `resolveSubjectFromRequest(request, { required: true, body })` → `queue.enqueue(...)` → 202 + jobId。
- 保护页常量：`new Set(['index', 'log'])`，策展永不触碰。
- 提交信息用中文、一句话总结；**禁止** AI 署名 trailer / "Generated with" 脚注。
- TS 路径别名 `@/*` → `src/*`。
- commit/git 提交只在用户要求时做；本计划在分支 `feat/agent-page-curation` 上推进。

---

## 文件结构总览

**新建：**
- `src/server/wiki/page-ops.ts` —— `executePageMerge` / `executePageSplit`（执行层纯函数，从 merge/split service 抽取）。
- `src/server/wiki/curate-plan.ts` —— 策展纯逻辑：`expandScopeWithNeighbors` / `applyDecisionCaps`。
- `src/server/wiki/__tests__/curate-plan.test.ts` —— curate-plan 单测。
- `src/server/llm/prompts/curate-prompt.ts` —— triage + merge-confirm + split-confirm 的 schema/system/builder。
- `src/server/llm/prompts/__tests__/curate-prompt.test.ts` —— prompt 单测。
- `src/server/services/curate-service.ts` —— `curate` 任务编排（triage→confirm→execute）。
- `src/app/api/curate/route.ts` —— 手动触发的 `POST /api/curate`。

**修改：**
- `src/lib/contracts.ts` —— 加 `agentAutoCurate` 设置；`Job.type` 加 `'curate'`（T4）、移除 `'merge'|'split'`（T7）；更新 operation type 注释（T7）。
- `src/server/db/repos/settings-repo.ts` —— `getAgentAutoCurate` / `setAgentAutoCurate`。
- `src/app/api/settings/route.ts` —— 透传 `agentAutoCurate`。
- `src/components/layout/settings-content.tsx` —— Agents 面板加自动策展开关。
- `src/server/services/merge-service.ts` / `split-service.ts` —— 改为调用 page-ops 的薄包装（T2）→ 删除（T7）。
- `src/server/services/ingest-service.ts` —— 成功后按开关入队 `curate`（T6）。
- `src/server/worker-entry.ts` —— import `curate-service`（T4）；移除 merge/split import（T7）。
- `src/hooks/use-job-stream.ts` —— 加 `curate:*` 事件（T4）；移除 `merge:*`/`split:*`（T7）。
- `src/components/health/health-view.tsx` —— 加「整理结构」按钮（T5）。
- `src/components/wiki/frontmatter-display.tsx` —— 移除 Merge/Split 按钮（T7）。
- `src/components/history/operation-list.tsx` —— `TYPE_LABELS` 加 `curate`（T7）。

**删除（T7）：**
- `src/components/wiki/{merge,split}-button.tsx`、`src/components/wiki/{merge,split}-dialog.tsx`
- `src/app/api/merge/route.ts`、`src/app/api/split/route.ts`
- `src/server/services/merge-service.ts`、`src/server/services/split-service.ts`

每个 Task 结束时 build/类型/测试均绿，merge/split 功能在 T7 前保持可用，T7 一次性下线其全部 UI/路由/handler。

---

## Task 1: 新增 `agentAutoCurate` 全局设置（端到端）

**Files:**
- Modify: `src/lib/contracts.ts:248-297`
- Modify: `src/server/db/repos/settings-repo.ts`
- Modify: `src/app/api/settings/route.ts`
- Modify: `src/components/layout/settings-content.tsx:220-280`

**Interfaces:**
- Produces: `DEFAULT_AGENT_AUTO_CURATE: boolean`、`AgentAutoCurateSchema: z.ZodBoolean`（contracts）；`getAgentAutoCurate(): boolean` / `setAgentAutoCurate(value: boolean): boolean`（settings-repo）；`AppSettings.agentAutoCurate: boolean`。

- [ ] **Step 1: contracts 加默认值、schema、AppSettings 字段**

在 `src/lib/contracts.ts` 第 252 行（`DEFAULT_AGENT_TASK_ROUTER_MODE` 那行）之后插入：

```ts
export const DEFAULT_AGENT_AUTO_CURATE = true;
```

在第 259 行（`AgentMaxParallelSubAgentsSchema` 那行）之后插入：

```ts
export const AgentAutoCurateSchema = z.boolean();
```

在 `AppSettings` interface（约 275-285 行）的 `agentTaskRouterMode` 字段后加一行：

```ts
  agentAutoCurate: boolean;
```

在 `AppSettingsSchema`（约 287-297 行）的 `agentTaskRouterMode` 字段后加一行：

```ts
  agentAutoCurate: AgentAutoCurateSchema,
```

- [ ] **Step 2: settings-repo 加 getter/setter**

在 `src/server/db/repos/settings-repo.ts` 的 import 块（第 4-26 行 from `@/lib/contracts`）中加入 `AgentAutoCurateSchema,` 和 `DEFAULT_AGENT_AUTO_CURATE,`。

在第 33 行（`const KEY_AGENT_TASK_ROUTER_MODE = ...`）后加：

```ts
const KEY_AGENT_AUTO_CURATE = 'agentAutoCurate';
```

在第 188 行（`setAgentTaskRouterMode` 函数结束的 `}`）之后插入：

```ts
/**
 * Returns whether ingest auto-triggers a curation pass on success. Falls back to
 * DEFAULT_AGENT_AUTO_CURATE (true). Stored as 'true'/'false' string in app_settings.
 * Reads DB on every call so the toggle takes effect without a worker restart.
 */
export function getAgentAutoCurate(): boolean {
  const raw = readKey(KEY_AGENT_AUTO_CURATE);
  if (raw === undefined) return DEFAULT_AGENT_AUTO_CURATE;
  return raw === 'true';
}

/**
 * Persists the auto-curate toggle. Validates via AgentAutoCurateSchema.
 * Returns the validated value.
 */
export function setAgentAutoCurate(value: boolean): boolean {
  const v = AgentAutoCurateSchema.parse(value);
  writeKey(KEY_AGENT_AUTO_CURATE, String(v));
  return v;
}
```

- [ ] **Step 3: /api/settings 透传 agentAutoCurate**

在 `src/app/api/settings/route.ts` 的 settings-repo import 块加 `getAgentAutoCurate,` 和 `setAgentAutoCurate,`；contracts import 块加 `AgentAutoCurateSchema,`。

`readSettings()` 的返回对象（在 `agentTaskRouterMode: getAgentTaskRouterMode(),` 后）加：

```ts
    agentAutoCurate: getAgentAutoCurate(),
```

`PutBodySchema`（在 `agentTaskRouterMode: AgentTaskRouterModeSchema.optional(),` 后）加：

```ts
  agentAutoCurate: AgentAutoCurateSchema.optional(),
```

PUT apply 段（在 `if (d.agentTaskRouterMode !== undefined) setAgentTaskRouterMode(d.agentTaskRouterMode);` 后）加：

```ts
  if (d.agentAutoCurate !== undefined) setAgentAutoCurate(d.agentAutoCurate);
```

- [ ] **Step 4: 设置面板 Agents 区加开关**

在 `src/components/layout/settings-content.tsx` 的 `AgentsPanel`（约第 220 行起）内，`agentTaskRouterMode` 的 `SelectSettingRow`（约 266-279 行）之后插入（用 SelectSettingRow 的 on/off 映射布尔，避免新增原语）：

```tsx
      <SelectSettingRow
        label="Auto-curate after ingest（摄入后自动整理结构）"
        value={(settings?.agentAutoCurate ?? true) ? 'on' : 'off'}
        options={[
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
        onChange={(v) => savePartial.mutate({ agentAutoCurate: v === 'on' })}
        pending={savePartial.isPending}
      />
```

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无报错（`agentAutoCurate` 在 AppSettings / PutBody / panel 三处类型一致）。

- [ ] **Step 6: 提交**

```bash
git add src/lib/contracts.ts src/server/db/repos/settings-repo.ts src/app/api/settings/route.ts src/components/layout/settings-content.tsx
git commit -m "feat(settings): 新增 agentAutoCurate 全局开关（默认开）"
```

---

## Task 2: 抽取执行层 `wiki/page-ops.ts`，merge/split service 改薄包装

**Files:**
- Create: `src/server/wiki/page-ops.ts`
- Modify: `src/server/services/merge-service.ts`（全文替换为薄包装）
- Modify: `src/server/services/split-service.ts`（全文替换为薄包装）

**Interfaces:**
- Produces:
  - `executePageMerge(jobId: string, subject: Subject, params: { targetSlug: string; sourceSlug: string }): Promise<{ mergedSlug: string; deletedSlug: string; referencesRepointed: number }>`
  - `executePageSplit(jobId: string, subject: Subject, params: { sourceSlug: string; hint?: string }): Promise<{ sourceSlug: string; pageSlugs: string[]; primarySlug: string; referencesRepointed: number }>`
  - 两者均自行执行 Saga（validate+apply）；**不** emit、**不** `enqueueEmbedIndex`（由调用方负责）；目标/源页缺失时抛错。
- Consumes（curate-service / 包装层稍后用）：上述两个函数。

- [ ] **Step 1: 创建 page-ops.ts（合并 merge + split 核心逻辑）**

Create `src/server/wiki/page-ops.ts`:

```ts
/**
 * 页面结构操作执行层（merge / split）。
 * 把「LLM 生成内容 → 确定性拼装 frontmatter → relink 重链 → 单事务 Saga」抽成纯函数，
 * 供 merge/split 任务包装层与 curate（页面策展）service 复用。
 * 本层不 emit 事件、不触发向量回填——由调用方按各自语义处理。
 */
import * as pagesRepo from '../db/repos/pages-repo';
import { readPageInSubject } from './wiki-store';
import { serializeWikiDocument } from './markdown';
import { serializeFrontmatter, stampSystemFrontmatter } from './frontmatter';
import { buildWikiPath } from './page-identity';
import { repointLinksToPage } from './relink';
import { planSplitPages } from './split-plan';
import { createChangeset, validateChangeset, applyChangeset } from './wiki-transaction';
import { generateStructuredOutput } from '../llm/provider-registry';
import { MergeResultSchema, MERGE_SYSTEM_PROMPT, buildMergeUserPrompt } from '../llm/prompts/merge-prompt';
import { SplitResultSchema, SPLIT_SYSTEM_PROMPT, buildSplitUserPrompt } from '../llm/prompts/split-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { ChangesetEntry, Subject, TitleResolver, WikiFrontmatter } from '@/lib/contracts';

function unionArr(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/** 把 source 融合进 target（target 存活），删除 source，本 subject 内指向 source 的引用全部重链到 target。 */
export async function executePageMerge(
  jobId: string,
  subject: Subject,
  params: { targetSlug: string; sourceSlug: string },
): Promise<{ mergedSlug: string; deletedSlug: string; referencesRepointed: number }> {
  const { targetSlug, sourceSlug } = params;
  if (targetSlug === sourceSlug) throw new Error('cannot merge a page into itself');

  const targetDoc = readPageInSubject(subject.slug, targetSlug);
  const sourceDoc = readPageInSubject(subject.slug, sourceSlug);
  if (!targetDoc) throw new Error(`target page "${targetSlug}" not found`);
  if (!sourceDoc) throw new Error(`source page "${sourceSlug}" not found`);

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

  const changeset = createChangeset(jobId, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) throw new Error(`merge changeset invalid: ${validation.errors.join('; ')}`);
  await applyChangeset(changeset);

  return { mergedSlug: targetSlug, deletedSlug: sourceSlug, referencesRepointed };
}

/** 把 source 页 LLM 拆成 N 个独立新页（标恰一主承接页），删除 source，本 subject 内指向 source 的引用统一重指主页。 */
export async function executePageSplit(
  jobId: string,
  subject: Subject,
  params: { sourceSlug: string; hint?: string },
): Promise<{ sourceSlug: string; pageSlugs: string[]; primarySlug: string; referencesRepointed: number }> {
  const { sourceSlug, hint } = params;
  const sourceDoc = readPageInSubject(subject.slug, sourceSlug);
  if (!sourceDoc) throw new Error(`source page "${sourceSlug}" not found`);

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

  const existingSlugs = new Set(pagesRepo.getAllPages(subject.id).map((p) => p.slug));
  const planned = planSplitPages(llm.pages, existingSlugs, sourceSlug);
  const primary = planned.find((p) => p.isPrimary) ?? planned[0];

  const titleMap = pagesRepo.getTitleToSlugMap(subject.id);
  const resolver: TitleResolver = (t) => titleMap.get(t) ?? titleMap.get(t.toLowerCase());
  const now = new Date().toISOString();

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

  entries.push({ action: 'delete', path: buildWikiPath(subject.slug, sourceSlug), content: null });

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

  const changeset = createChangeset(jobId, subject, entries);
  const validation = validateChangeset(changeset);
  if (!validation.valid) throw new Error(`split changeset invalid: ${validation.errors.join('; ')}`);
  await applyChangeset(changeset);

  return { sourceSlug, pageSlugs: planned.map((p) => p.slug), primarySlug: primary.slug, referencesRepointed };
}
```

- [ ] **Step 2: merge-service 改薄包装（全文替换）**

Replace 全文 of `src/server/services/merge-service.ts`:

```ts
/**
 * Merge service — 任务类型 'merge'。逻辑已抽到 wiki/page-ops.ts::executePageMerge。
 * 本文件只做参数解析、subject 解析、事件发射与向量回填。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('merge', ...)。
 */
import { registerHandler } from '../jobs/worker';
import { enqueueEmbedIndex } from './embedding-service';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { executePageMerge } from '../wiki/page-ops';
import type { Job } from '@/lib/contracts';

interface MergeParams {
  targetSlug?: string;
  sourceSlug?: string;
  subjectId?: string;
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

  emit('merge:start', `Merging "${sourceSlug}" into "${targetSlug}"…`, { targetSlug, sourceSlug });
  const res = await executePageMerge(job.id, subject, { targetSlug, sourceSlug });
  emit('merge:complete', `Merged into "${targetSlug}"; repointed ${res.referencesRepointed} reference(s)`, res);

  enqueueEmbedIndex(subject.id);
  return res;
}

registerHandler('merge', runMergeJob);
```

- [ ] **Step 3: split-service 改薄包装（全文替换）**

Replace 全文 of `src/server/services/split-service.ts`:

```ts
/**
 * Split service — 任务类型 'split'。逻辑已抽到 wiki/page-ops.ts::executePageSplit。
 * 本文件只做参数解析、subject 解析、事件发射与向量回填。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('split', ...)。
 */
import { registerHandler } from '../jobs/worker';
import { enqueueEmbedIndex } from './embedding-service';
import * as subjectsRepo from '../db/repos/subjects-repo';
import { executePageSplit } from '../wiki/page-ops';
import type { Job } from '@/lib/contracts';

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

  emit('split:start', `Splitting "${sourceSlug}"…`, { sourceSlug });
  const res = await executePageSplit(job.id, subject, { sourceSlug, hint });
  emit('split:complete', `Split into ${res.pageSlugs.length} pages; repointed ${res.referencesRepointed} reference(s)`, res);

  enqueueEmbedIndex(subject.id);
  return res;
}

registerHandler('split', runSplitJob);
```

- [ ] **Step 4: 类型检查 + 全量测试（确认无回归）**

Run: `npx tsc --noEmit && npm test`
Expected: tsc 无报错；既有测试（含 `relink.test.ts` / `split-plan.test.ts` / `merge-prompt.test.ts` / `split-prompt.test.ts`）全绿——证明执行层抽取无行为漂移。

- [ ] **Step 5: 提交**

```bash
git add src/server/wiki/page-ops.ts src/server/services/merge-service.ts src/server/services/split-service.ts
git commit -m "refactor(wiki): 抽取 page-ops 执行层，merge/split service 改薄包装"
```

---

## Task 3: curate LLM task + prompt（triage / merge-confirm / split-confirm）

**Files:**
- Create: `src/server/llm/prompts/curate-prompt.ts`
- Create: `src/server/llm/prompts/__tests__/curate-prompt.test.ts`
- Modify: `src/server/llm/config-schema.ts:8`

**Interfaces:**
- Produces:
  - `CurateTriageSchema`（`{ merges: {aSlug,bSlug,reason}[]; splits: {slug,reason}[] }`，两数组 `.default([])`）+ `CURATE_TRIAGE_SYSTEM_PROMPT` + `buildCurateTriageUserPrompt(pages: {slug,title,summary,tags,bodyChars}[], ctx)`
  - `CurateMergeConfirmSchema`（`{ proceed: boolean; targetSlug?: string; reason: string }`）+ `CURATE_MERGE_CONFIRM_SYSTEM_PROMPT` + `buildCurateMergeConfirmUserPrompt(a, b, ctx)`，a/b 形如 `{slug,title,body}`
  - `CurateSplitConfirmSchema`（`{ proceed: boolean; hint?: string; reason: string }`）+ `CURATE_SPLIT_CONFIRM_SYSTEM_PROMPT` + `buildCurateSplitConfirmUserPrompt(page, ctx)`，page 形如 `{slug,title,body}`
  - `ctx` 类型为 `PromptContext`（`{ language, subject? }`）。
- Consumes: `prompt-context.ts::{ renderLanguageDirective, PromptContext }`。

- [ ] **Step 1: 写失败测试**

Create `src/server/llm/prompts/__tests__/curate-prompt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildCurateTriageUserPrompt,
  CurateTriageSchema,
  CURATE_TRIAGE_SYSTEM_PROMPT,
  buildCurateMergeConfirmUserPrompt,
  CurateMergeConfirmSchema,
  buildCurateSplitConfirmUserPrompt,
  CurateSplitConfirmSchema,
} from '../curate-prompt';

const ctx = { language: 'English', subject: { slug: 'general', name: 'General' } };

describe('buildCurateTriageUserPrompt', () => {
  it('注入语言指令 + 每页 slug/title/字数', () => {
    const out = buildCurateTriageUserPrompt(
      [{ slug: 'alpha', title: 'Alpha', summary: 's1', tags: ['t'], bodyChars: 1200 }],
      ctx,
    );
    expect(out).toContain('=== OUTPUT LANGUAGE ===');
    expect(out).toContain('alpha');
    expect(out).toContain('Alpha');
    expect(out).toContain('1200');
  });
});

describe('CurateTriageSchema', () => {
  it('缺数组时默认空', () => {
    expect(CurateTriageSchema.parse({})).toEqual({ merges: [], splits: [] });
  });
  it('接受合法候选', () => {
    const v = CurateTriageSchema.parse({
      merges: [{ aSlug: 'a', bSlug: 'b', reason: 'dup' }],
      splits: [{ slug: 'c', reason: 'too big' }],
    });
    expect(v.merges[0].aSlug).toBe('a');
    expect(v.splits[0].slug).toBe('c');
  });
});

describe('curate confirm schemas', () => {
  it('merge confirm 需要 proceed + reason', () => {
    expect(CurateMergeConfirmSchema.parse({ proceed: true, targetSlug: 'a', reason: 'r' }).proceed).toBe(true);
    expect(CurateMergeConfirmSchema.safeParse({ targetSlug: 'a' }).success).toBe(false);
  });
  it('split confirm 接受可选 hint', () => {
    expect(CurateSplitConfirmSchema.parse({ proceed: false, reason: 'r' }).hint).toBeUndefined();
  });
});

describe('confirm prompt builders', () => {
  it('merge-confirm 含两页正文', () => {
    const out = buildCurateMergeConfirmUserPrompt(
      { slug: 'a', title: 'A', body: 'body-a' },
      { slug: 'b', title: 'B', body: 'body-b' },
      ctx,
    );
    expect(out).toContain('body-a');
    expect(out).toContain('body-b');
  });
  it('split-confirm 含页面正文', () => {
    const out = buildCurateSplitConfirmUserPrompt({ slug: 'c', title: 'C', body: 'body-c' }, ctx);
    expect(out).toContain('body-c');
  });
});

describe('CURATE_TRIAGE_SYSTEM_PROMPT', () => {
  it('是非空字符串且强调保守', () => {
    expect(typeof CURATE_TRIAGE_SYSTEM_PROMPT).toBe('string');
    expect(CURATE_TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain('conservative');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- curate-prompt`
Expected: FAIL（`Cannot find module '../curate-prompt'`）。

- [ ] **Step 3: 创建 curate-prompt.ts**

Create `src/server/llm/prompts/curate-prompt.ts`:

```ts
import { z } from 'zod';
import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Triage（只读元数据，收窄候选） ──────────────────────────────────────────────

export const CurateTriageSchema = z.object({
  merges: z
    .array(
      z.object({
        aSlug: z.string().describe('Slug of one page in the candidate pair.'),
        bSlug: z.string().describe('Slug of the other page in the candidate pair.'),
        reason: z.string().describe('Why these two pages are redundant / heavily overlapping.'),
      }),
    )
    .default([]),
  splits: z
    .array(
      z.object({
        slug: z.string().describe('Slug of a page that is too large AND covers multiple distinct topics.'),
        reason: z.string().describe('Why this page should be split.'),
      }),
    )
    .default([]),
});

export type CurateTriage = z.infer<typeof CurateTriageSchema>;

export const CURATE_TRIAGE_SYSTEM_PROMPT = `You are a conservative wiki curator triaging a personal knowledge base for structural maintenance.

You are given ONLY page metadata (slug, title, summary, tags, body size). Propose candidate structural operations:
- merges: two pages that are clearly REDUNDANT or HEAVILY OVERLAPPING (same topic written twice, a stub duplicating a fuller page).
- splits: a single page that is clearly TOO LARGE *and* covers MULTIPLE DISTINCT TOPICS that deserve their own pages.

## Be conservative — this is the most important rule
- When in doubt, propose NOTHING. A clean wiki with a few large pages is far better than an over-fragmented or wrongly-merged one.
- Do NOT propose a merge just because two pages are related or cross-link — only when they substantially duplicate each other.
- Do NOT propose a split just because a page is long — only when it bundles unrelated topics.
- Never reference slugs that are not in the provided list. Never propose merging a page with itself.

## Output
Return { merges, splits }. Either array may be empty. Each item carries a short reason.`;

export function buildCurateTriageUserPrompt(
  pages: { slug: string; title: string; summary: string; tags: string[]; bodyChars: number }[],
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
  const subjectSection = ctx.subject
    ? `## Active subject (workspace)\n- **Name**: ${ctx.subject.name}\n- **Slug**: \`${ctx.subject.slug}\`\n\n`
    : '';

  const list = pages
    .map(
      (p) =>
        `- slug: \`${p.slug}\` | title: "${p.title}" | size: ${p.bodyChars} chars | tags: ${p.tags.join(', ') || '(none)'}\n  summary: ${p.summary || '(none)'}`,
    )
    .join('\n');

  return `${languageDirective}${subjectSection}Below is the metadata of every page in scope. Identify conservative merge / split candidates.

## Pages (${pages.length})
${list}

Return candidate merges and splits. When unsure, return empty arrays.`;
}

// ── Merge confirm（载入两页正文，确认 go/no-go + 选存活页） ─────────────────────

export const CurateMergeConfirmSchema = z.object({
  proceed: z.boolean().describe('True only if the two pages should genuinely be merged.'),
  targetSlug: z
    .string()
    .optional()
    .describe('When proceeding, the slug of the page that should SURVIVE (the more complete / canonical one). Must be one of the two input slugs.'),
  reason: z.string().describe('Short justification of the decision.'),
});

export const CURATE_MERGE_CONFIRM_SYSTEM_PROMPT = `You are a conservative wiki curator deciding whether two specific pages should be merged into one.

You now see the FULL body of both pages. Confirm a merge ONLY if they substantially cover the same topic and one coherent page would serve the reader better.
- If they are merely related, complementary, or cross-referenced, do NOT merge (proceed=false).
- When proceeding, choose targetSlug = the page that should survive (usually the more complete / canonical one); the other is absorbed and deleted.
- Default to proceed=false when uncertain.`;

export function buildCurateMergeConfirmUserPrompt(
  a: { slug: string; title: string; body: string },
  b: { slug: string; title: string; body: string },
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
  return `${languageDirective}Decide whether to merge these two pages. If yes, pick which one survives (targetSlug must be "${a.slug}" or "${b.slug}").

## Page 1 — slug \`${a.slug}\` — "${a.title}"

${a.body}

---

## Page 2 — slug \`${b.slug}\` — "${b.title}"

${b.body}

---

Return { proceed, targetSlug, reason }.`;
}

// ── Split confirm（载入页面正文，确认 go/no-go + 可选 hint） ────────────────────

export const CurateSplitConfirmSchema = z.object({
  proceed: z.boolean().describe('True only if the page should genuinely be split.'),
  hint: z
    .string()
    .optional()
    .describe('When proceeding, an optional hint describing how to divide the page (which topics become which pages).'),
  reason: z.string().describe('Short justification of the decision.'),
});

export const CURATE_SPLIT_CONFIRM_SYSTEM_PROMPT = `You are a conservative wiki curator deciding whether one specific page should be split into multiple pages.

You now see the FULL body of the page. Confirm a split ONLY if it clearly bundles MULTIPLE DISTINCT TOPICS that each deserve their own page.
- A long but cohesive page about a single topic should NOT be split (proceed=false).
- When proceeding, you may give a short hint describing the intended division.
- Default to proceed=false when uncertain.`;

export function buildCurateSplitConfirmUserPrompt(
  page: { slug: string; title: string; body: string },
  ctx: PromptContext,
): string {
  const languageDirective = `${renderLanguageDirective(ctx.language)}\n\n`;
  return `${languageDirective}Decide whether to split this page into multiple independent pages.

## Page — slug \`${page.slug}\` — "${page.title}"

${page.body}

---

Return { proceed, hint, reason }.`;
}
```

- [ ] **Step 4: 把 'curate' 加入内置任务**

在 `src/server/llm/config-schema.ts` 第 8 行：

```ts
const BUILTIN_LLM_TASKS = ['ingest', 'query', 'lint', 'merge', 'split', 'embedding'] as const;
```

改为：

```ts
const BUILTIN_LLM_TASKS = ['ingest', 'query', 'lint', 'merge', 'split', 'embedding', 'curate'] as const;
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -- curate-prompt`
Expected: PASS（全部用例）。

- [ ] **Step 6: 类型检查 + 提交**

Run: `npx tsc --noEmit`
Expected: 无报错。

```bash
git add src/server/llm/prompts/curate-prompt.ts src/server/llm/prompts/__tests__/curate-prompt.test.ts src/server/llm/config-schema.ts
git commit -m "feat(llm): 新增 curate 任务的 triage/confirm prompt 与 schema"
```

---

## Task 4: curate 纯逻辑 + curate-service + 注册 + SSE 事件

**Files:**
- Create: `src/server/wiki/curate-plan.ts`
- Create: `src/server/wiki/__tests__/curate-plan.test.ts`
- Create: `src/server/services/curate-service.ts`
- Modify: `src/lib/contracts.ts:86`（Job.type 加 `'curate'`）
- Modify: `src/server/worker-entry.ts:40`（import curate-service）
- Modify: `src/hooks/use-job-stream.ts:171`（加 curate 事件）

**Interfaces:**
- Produces（curate-plan）：
  - `expandScopeWithNeighbors(seedSlugs: string[], links: { sourceSlug: string; targetSlug: string; targetSubjectId: string }[], subjectId: string, metaSlugs: Set<string>): string[]`
  - `interface CurateLimits { maxMerges: number; maxSplits: number }`
  - `applyDecisionCaps(triage: CurateTriage, limits: CurateLimits): { kept: CurateTriage; droppedMerges: number; droppedSplits: number }`
- Consumes：`page-ops.ts::{executePageMerge, executePageSplit}`、`curate-prompt.ts` 全部导出、`pagesRepo.{getAllPages,getAllLinks,getPageBySlug}`、`readPageInSubject`、`generateStructuredOutput`、`subjectsRepo.getById`、`getWikiLanguage`、`enqueueEmbedIndex`。
- `curate` job params 形状：`{ scope: 'pages' | 'subject'; slugs?: string[]; subjectId: string }`。

- [ ] **Step 1: 写 curate-plan 失败测试**

Create `src/server/wiki/__tests__/curate-plan.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { expandScopeWithNeighbors, applyDecisionCaps } from '../curate-plan';

const meta = new Set(['index', 'log']);

describe('expandScopeWithNeighbors', () => {
  const links = [
    { sourceSlug: 'x', targetSlug: 'seed', targetSubjectId: 's1' }, // x -> seed (backlink)
    { sourceSlug: 'seed', targetSlug: 'y', targetSubjectId: 's1' }, // seed -> y (outlink)
    { sourceSlug: 'seed', targetSlug: 'log', targetSubjectId: 's1' }, // meta excluded
    { sourceSlug: 'q', targetSlug: 'seed', targetSubjectId: 's2' },  // other subject excluded
  ];

  it('加入本-subject 的反链源与正链目标，排除 meta 与跨主题', () => {
    const out = expandScopeWithNeighbors(['seed'], links, 's1', meta).sort();
    expect(out).toEqual(['seed', 'x', 'y']);
  });

  it('seed 去重且不含 meta', () => {
    const out = expandScopeWithNeighbors(['seed', 'index'], links, 's1', meta);
    expect(out).not.toContain('index');
    expect(new Set(out).size).toBe(out.length);
  });
});

describe('applyDecisionCaps', () => {
  it('超过上限时截断并报告丢弃数', () => {
    const triage = {
      merges: [
        { aSlug: 'a', bSlug: 'b', reason: 'r' },
        { aSlug: 'c', bSlug: 'd', reason: 'r' },
      ],
      splits: [
        { slug: 'e', reason: 'r' },
        { slug: 'f', reason: 'r' },
        { slug: 'g', reason: 'r' },
      ],
    };
    const { kept, droppedMerges, droppedSplits } = applyDecisionCaps(triage, { maxMerges: 1, maxSplits: 2 });
    expect(kept.merges).toHaveLength(1);
    expect(kept.splits).toHaveLength(2);
    expect(droppedMerges).toBe(1);
    expect(droppedSplits).toBe(1);
  });

  it('未超限时不丢弃', () => {
    const triage = { merges: [], splits: [{ slug: 'e', reason: 'r' }] };
    const { droppedMerges, droppedSplits } = applyDecisionCaps(triage, { maxMerges: 5, maxSplits: 5 });
    expect(droppedMerges).toBe(0);
    expect(droppedSplits).toBe(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- curate-plan`
Expected: FAIL（`Cannot find module '../curate-plan'`）。

- [ ] **Step 3: 创建 curate-plan.ts**

Create `src/server/wiki/curate-plan.ts`:

```ts
/**
 * 页面策展纯逻辑：scope 邻居扩展 + 决策上限截断。无 I/O，便于单测。
 */
import type { CurateTriage } from '../llm/prompts/curate-prompt';

export interface CurateLimits {
  maxMerges: number;
  maxSplits: number;
}

/**
 * 把受影响页 slug 集合扩展到其「本-subject 邻居」：
 *  - 反链源：指向 seed 的页（link.targetSlug ∈ seed）→ 加 link.sourceSlug
 *  - 正链目标：seed 指向的页（link.sourceSlug ∈ seed）→ 加 link.targetSlug
 * 仅计本-subject 链接（targetSubjectId === subjectId），排除 meta，去重。
 */
export function expandScopeWithNeighbors(
  seedSlugs: string[],
  links: { sourceSlug: string; targetSlug: string; targetSubjectId: string }[],
  subjectId: string,
  metaSlugs: Set<string>,
): string[] {
  const seed = new Set(seedSlugs);
  const out = new Set(seedSlugs);
  for (const l of links) {
    if (l.targetSubjectId !== subjectId) continue;
    if (seed.has(l.targetSlug)) out.add(l.sourceSlug);
    if (seed.has(l.sourceSlug)) out.add(l.targetSlug);
  }
  return [...out].filter((s) => !metaSlugs.has(s));
}

/** 截断 triage 候选到上限内，返回保留集合与各自丢弃数。 */
export function applyDecisionCaps(
  triage: CurateTriage,
  limits: CurateLimits,
): { kept: CurateTriage; droppedMerges: number; droppedSplits: number } {
  const merges = triage.merges.slice(0, limits.maxMerges);
  const splits = triage.splits.slice(0, limits.maxSplits);
  return {
    kept: { merges, splits },
    droppedMerges: triage.merges.length - merges.length,
    droppedSplits: triage.splits.length - splits.length,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- curate-plan`
Expected: PASS。

- [ ] **Step 5: 创建 curate-service.ts**

Create `src/server/services/curate-service.ts`:

```ts
/**
 * Curate service — 任务类型 'curate'：agent 驱动的页面策展。
 * 两段式：triage（只读元数据收窄候选）→ confirm（逐候选取正文确认）→ 执行（复用 page-ops）。
 * 每条 merge/split 各自一个 Saga commit（⑥ 历史可逐条 revert）。
 * params: { scope: 'pages' | 'subject'; slugs?: string[]; subjectId }
 *  - 'pages'：scope = slugs（本次 ingest 受影响页）+ 本-subject 邻居（自动路径）。
 *  - 'subject'：scope = 全 subject 非 meta 页（手动路径）。
 * side-effect import：worker-entry import 本文件即完成 registerHandler('curate', ...)。
 */
import { registerHandler } from '../jobs/worker';
import { enqueueEmbedIndex } from './embedding-service';
import * as subjectsRepo from '../db/repos/subjects-repo';
import * as pagesRepo from '../db/repos/pages-repo';
import { readPageInSubject } from '../wiki/wiki-store';
import { executePageMerge, executePageSplit } from '../wiki/page-ops';
import { expandScopeWithNeighbors, applyDecisionCaps, type CurateLimits } from '../wiki/curate-plan';
import { generateStructuredOutput } from '../llm/provider-registry';
import {
  CurateTriageSchema,
  CURATE_TRIAGE_SYSTEM_PROMPT,
  buildCurateTriageUserPrompt,
  CurateMergeConfirmSchema,
  CURATE_MERGE_CONFIRM_SYSTEM_PROMPT,
  buildCurateMergeConfirmUserPrompt,
  CurateSplitConfirmSchema,
  CURATE_SPLIT_CONFIRM_SYSTEM_PROMPT,
  buildCurateSplitConfirmUserPrompt,
} from '../llm/prompts/curate-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { Job } from '@/lib/contracts';

const PROTECTED_SYSTEM_PAGES = new Set(['index', 'log']);
const LIMITS: CurateLimits = { maxMerges: 5, maxSplits: 5 };

interface CurateParams {
  scope?: 'pages' | 'subject';
  slugs?: string[];
  subjectId?: string;
}

async function runCurateJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as CurateParams;
  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) throw new Error('curate job missing subjectId');
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) throw new Error(`Subject ${subjectId} not found`);

  const promptCtx = {
    language: getWikiLanguage(),
    subject: { slug: subject.slug, name: subject.name, description: subject.description },
  };

  // 1. 解析 scope
  let scopeSlugs: string[];
  if (params.scope === 'pages' && Array.isArray(params.slugs)) {
    const seed = params.slugs.filter((s) => !PROTECTED_SYSTEM_PAGES.has(s));
    const links = pagesRepo.getAllLinks(subject.id);
    scopeSlugs = expandScopeWithNeighbors(seed, links, subject.id, PROTECTED_SYSTEM_PAGES);
  } else {
    scopeSlugs = pagesRepo
      .getAllPages(subject.id)
      .map((p) => p.slug)
      .filter((s) => !PROTECTED_SYSTEM_PAGES.has(s));
  }

  emit('curate:start', `Curating ${scopeSlugs.length} page(s) in "${subject.slug}"…`, {
    scope: params.scope ?? 'subject',
    count: scopeSlugs.length,
  });

  if (scopeSlugs.length < 2) {
    emit('curate:complete', 'Nothing to curate (need at least 2 pages).', { merges: 0, splits: 0 });
    return { merges: 0, splits: 0, referencesRepointed: 0, skipped: 0 };
  }

  // 2. 收集元数据（读正文取字数，不把正文喂给 triage）
  const metas: { slug: string; title: string; summary: string; tags: string[]; bodyChars: number }[] = [];
  for (const slug of scopeSlugs) {
    const doc = readPageInSubject(subject.slug, slug);
    if (!doc) continue;
    metas.push({
      slug,
      title: doc.frontmatter.title,
      summary: doc.frontmatter.summary ?? '',
      tags: doc.frontmatter.tags ?? [],
      bodyChars: doc.body.length,
    });
  }

  // 3. triage
  const triage = await generateStructuredOutput(
    'curate',
    CurateTriageSchema,
    CURATE_TRIAGE_SYSTEM_PROMPT,
    buildCurateTriageUserPrompt(metas, promptCtx),
  );
  const { kept, droppedMerges, droppedSplits } = applyDecisionCaps(triage, LIMITS);
  if (droppedMerges > 0 || droppedSplits > 0) {
    emit('curate:warn', `Capped over-limit decisions: dropped ${droppedMerges} merge(s) / ${droppedSplits} split(s).`, {
      droppedMerges,
      droppedSplits,
    });
  }
  emit('curate:plan', `Plan: ${kept.merges.length} merge candidate(s), ${kept.splits.length} split candidate(s).`, {
    merges: kept.merges.length,
    splits: kept.splits.length,
  });

  let merges = 0;
  let splits = 0;
  let referencesRepointed = 0;
  let skipped = 0;

  // 4. merge 候选：逐条重校验 + confirm + 执行
  for (const cand of kept.merges) {
    const aDoc = readPageInSubject(subject.slug, cand.aSlug);
    const bDoc = readPageInSubject(subject.slug, cand.bSlug);
    if (
      !aDoc ||
      !bDoc ||
      cand.aSlug === cand.bSlug ||
      PROTECTED_SYSTEM_PAGES.has(cand.aSlug) ||
      PROTECTED_SYSTEM_PAGES.has(cand.bSlug)
    ) {
      skipped += 1;
      emit('curate:skip', `Skip merge ${cand.aSlug}+${cand.bSlug} (stale/invalid).`, { ...cand });
      continue;
    }
    const confirm = await generateStructuredOutput(
      'curate',
      CurateMergeConfirmSchema,
      CURATE_MERGE_CONFIRM_SYSTEM_PROMPT,
      buildCurateMergeConfirmUserPrompt(
        { slug: cand.aSlug, title: aDoc.frontmatter.title, body: aDoc.body },
        { slug: cand.bSlug, title: bDoc.frontmatter.title, body: bDoc.body },
        promptCtx,
      ),
    );
    if (!confirm.proceed) {
      skipped += 1;
      emit('curate:skip', `Skip merge ${cand.aSlug}+${cand.bSlug}: ${confirm.reason}`, { ...cand });
      continue;
    }
    const targetSlug = confirm.targetSlug === cand.bSlug ? cand.bSlug : cand.aSlug;
    const sourceSlug = targetSlug === cand.aSlug ? cand.bSlug : cand.aSlug;
    emit('curate:merge', `Merging "${sourceSlug}" into "${targetSlug}"…`, { targetSlug, sourceSlug });
    const res = await executePageMerge(job.id, subject, { targetSlug, sourceSlug });
    merges += 1;
    referencesRepointed += res.referencesRepointed;
  }

  // 5. split 候选：逐条重校验 + confirm + 执行
  for (const cand of kept.splits) {
    const doc = readPageInSubject(subject.slug, cand.slug);
    if (!doc || PROTECTED_SYSTEM_PAGES.has(cand.slug)) {
      skipped += 1;
      emit('curate:skip', `Skip split ${cand.slug} (stale/invalid).`, { ...cand });
      continue;
    }
    const confirm = await generateStructuredOutput(
      'curate',
      CurateSplitConfirmSchema,
      CURATE_SPLIT_CONFIRM_SYSTEM_PROMPT,
      buildCurateSplitConfirmUserPrompt({ slug: cand.slug, title: doc.frontmatter.title, body: doc.body }, promptCtx),
    );
    if (!confirm.proceed) {
      skipped += 1;
      emit('curate:skip', `Skip split ${cand.slug}: ${confirm.reason}`, { ...cand });
      continue;
    }
    emit('curate:split', `Splitting "${cand.slug}"…`, { sourceSlug: cand.slug });
    try {
      const res = await executePageSplit(job.id, subject, { sourceSlug: cand.slug, hint: confirm.hint });
      splits += 1;
      referencesRepointed += res.referencesRepointed;
    } catch (err) {
      // split 要求 ≥2 页；LLM 拆不出时不致命，跳过。
      skipped += 1;
      emit('curate:skip', `Split "${cand.slug}" failed: ${(err as Error).message}`, { ...cand });
    }
  }

  if (merges + splits > 0) enqueueEmbedIndex(subject.id);

  emit(
    'curate:complete',
    `Curation done: ${merges} merge(s), ${splits} split(s), ${referencesRepointed} reference(s) repointed, ${skipped} skipped.`,
    { merges, splits, referencesRepointed, skipped },
  );
  return { merges, splits, referencesRepointed, skipped };
}

registerHandler('curate', runCurateJob);
```

- [ ] **Step 6: Job.type 加 'curate'**

在 `src/lib/contracts.ts` 第 86 行：

```ts
  type: 'ingest' | 'lint' | 'save-to-wiki' | 'merge' | 'split' | 'embed-index';
```

改为：

```ts
  type: 'ingest' | 'lint' | 'save-to-wiki' | 'merge' | 'split' | 'embed-index' | 'curate';
```

- [ ] **Step 7: worker-entry 注册 curate-service**

在 `src/server/worker-entry.ts` 第 40 行（`import './services/embedding-service';`）之后加：

```ts
import './services/curate-service';
```

- [ ] **Step 8: use-job-stream 加 curate 事件**

在 `src/hooks/use-job-stream.ts` 第 171 行（`'split:complete',`）之后、第 172 行 `];` 之前插入：

```ts
        // Curate events
        'curate:start',
        'curate:plan',
        'curate:merge',
        'curate:split',
        'curate:skip',
        'curate:warn',
        'curate:complete',
```

- [ ] **Step 9: 类型检查 + 全量测试**

Run: `npx tsc --noEmit && npm test`
Expected: tsc 无报错；测试全绿（含新增 curate-plan / curate-prompt 用例）。

- [ ] **Step 10: 提交**

```bash
git add src/server/wiki/curate-plan.ts src/server/wiki/__tests__/curate-plan.test.ts src/server/services/curate-service.ts src/lib/contracts.ts src/server/worker-entry.ts src/hooks/use-job-stream.ts
git commit -m "feat(curate): 新增 curate 任务（triage→confirm→执行）与 SSE 事件"
```

---

## Task 5: 手动触发 —— `POST /api/curate` + Health 页「整理结构」按钮

**Files:**
- Create: `src/app/api/curate/route.ts`
- Modify: `src/components/health/health-view.tsx`

**Interfaces:**
- Consumes: `queue.enqueue('curate', { scope: 'subject', subjectId }, subjectId)`；`useJobStream(jobId)`；`useApiFetch()`。
- `POST /api/curate` 返回 `202 { jobId, subjectId }`。

- [ ] **Step 1: 创建 /api/curate 路由（仿 /api/lint）**

Create `src/app/api/curate/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';

export const runtime = 'nodejs';

/**
 * POST /api/curate — 对当前 subject 全库做一次 agent 策展（合并/拆分）。
 * 异步：入队 'curate' job（scope: 'subject'），立即返回 202 + jobId。
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

  const job = queue.enqueue('curate', { scope: 'subject', subjectId: subject.id }, subject.id);
  return NextResponse.json(
    { jobId: job.id, subjectId: subject.id, subjectSlug: subject.slug },
    { status: 202 },
  );
}
```

- [ ] **Step 2: Health 页加「整理结构」按钮 + 跟踪**

在 `src/components/health/health-view.tsx` 做以下修改：

(a) import 行（第 5 行）把图标换成含 `Wand2`：

```tsx
import { Activity, RefreshCw, Wand2 } from 'lucide-react';
```

(b) 在 `runLint` 函数（第 62 行 `}` 之后）插入策展状态与触发逻辑：

```tsx
  const [curateJobId, setCurateJobId] = useState<string | null>(null);
  const [curateStarting, setCurateStarting] = useState(false);
  const { status: curateStatus, latestMessage: curateMessage } = useJobStream(curateJobId);
  const curating = curateStarting || (curateJobId !== null && curateStatus !== 'completed' && curateStatus !== 'failed');

  useEffect(() => {
    if (curateStatus === 'completed') {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['lint-latest', allSubjects ? 'all' : subjectId] });
      setCurateJobId(null);
    } else if (curateStatus === 'failed') {
      setCurateJobId(null);
    }
  }, [curateStatus, queryClient, allSubjects, subjectId]);

  async function runCurate() {
    setCurateStarting(true);
    try {
      const res = await apiFetch('/api/curate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
      if (res.ok) {
        const json = (await res.json()) as { jobId: string };
        setCurateJobId(json.jobId);
      }
    } finally {
      setCurateStarting(false);
    }
  }
```

(c) 在 header 的按钮组（第 127-130 行 `Run health check` 那个 `<Button>`）之后、`</div>` 之前插入「整理结构」按钮（仅当前 subject 可用，全量 scope 下禁用）：

```tsx
          <Button intent="secondary" onClick={runCurate} loading={curating} disabled={allSubjects}>
            <Wand2 className="h-3.5 w-3.5" />
            Tidy structure
          </Button>
```

(d) 在 `running` 提示块（第 134-136 行）之后插入策展进度提示：

```tsx
      {curating && (
        <p className="text-sm text-foreground-secondary">{curateMessage || 'Curating structure…'}</p>
      )}
```

> 说明：`Button` 是否支持 `intent="secondary"` / `disabled` 由现有 `ui/button.tsx` 决定；若 `secondary` 不存在，用默认 intent（去掉 `intent` 属性）。`disabled` 为标准 button 属性，按现有用法传入即可。

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无报错。若 `Button` 不接受 `intent="secondary"`，按 Step 2(c) 说明去掉该属性后重跑。

- [ ] **Step 4: 手动冒烟（worker 在跑时）**

Run（开发环境）：`npm run dev:all` 起服务后，打开 `/health` 点 "Tidy structure"；或用 curl：
```bash
curl -s -X POST http://localhost:3000/api/curate -H 'Content-Type: application/json' -d '{}' --cookie 'wiki_subject=general'
```
Expected: 返回 `202` 且 body 含 `jobId`；worker 日志出现 `curate:start` → `curate:plan` → `curate:complete`。

- [ ] **Step 5: 提交**

```bash
git add src/app/api/curate/route.ts src/components/health/health-view.tsx
git commit -m "feat(health): 手动整理结构入口 + POST /api/curate"
```

---

## Task 6: 自动触发 —— ingest 成功后按开关入队 curate

**Files:**
- Modify: `src/server/services/ingest-service.ts`（import 段 + 第 218-220 行附近）

**Interfaces:**
- Consumes: `getAgentAutoCurate()`（Task 1）、`queue.enqueue`、`result.pagesCreated` / `result.pagesUpdated`（`IngestResult`）。

- [ ] **Step 1: ingest-service 加 import**

在 `src/server/services/ingest-service.ts` 顶部 import 段加（与现有 import 风格一致）：

```ts
import * as queue from '../jobs/queue';
import { getAgentAutoCurate } from '../db/repos/settings-repo';
```

> 若 `settings-repo` 已被部分 import（如 `getWikiLanguage`），把 `getAgentAutoCurate` 并入同一 import 语句即可，避免重复 from。

- [ ] **Step 2: 成功提交后按开关入队 curate**

在 `src/server/services/ingest-service.ts` 第 218 行（`enqueueEmbedIndex(subject.id);`）与第 220 行（`return result as unknown as Record<string, unknown>;`）之间插入：

```ts
  // 自动策展：ingest 已提交成功 → 对本次受影响页（+ 邻居）做一次保守策展（受全局开关控制）。
  // fire-and-forget 入队，不影响本次 ingest 的成功返回。
  if (getAgentAutoCurate()) {
    const touchedSlugs = [...result.pagesCreated, ...result.pagesUpdated].filter(
      (s) => s !== 'index' && s !== 'log',
    );
    if (touchedSlugs.length > 0) {
      queue.enqueue('curate', { scope: 'pages', slugs: touchedSlugs, subjectId: subject.id }, subject.id);
      emit('ingest:complete', `Queued auto-curation for ${touchedSlugs.length} touched page(s).`, {
        curateSlugs: touchedSlugs.length,
      });
    }
  }
```

> `result` 类型为 `IngestResult`（`{ pagesCreated: string[]; pagesUpdated: string[]; ... }`，见 contracts）。若该处 `result` 已被 `as unknown` 擦除类型，则在 `const result = await finalizeIngest(...)` 处它仍是 `IngestResult`，本插入位于 `return` 之前、类型未擦除，`result.pagesCreated` 可直接访问。

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无报错（`result.pagesCreated`/`pagesUpdated` 为 `string[]`）。

- [ ] **Step 4: 提交**

```bash
git add src/server/services/ingest-service.ts
git commit -m "feat(ingest): 摄入成功后按 agentAutoCurate 开关自动入队策展"
```

---

## Task 7: 下线手动 merge/split 全部入口（UI / 路由 / handler / 类型 / 事件）

**Files:**
- Modify: `src/components/wiki/frontmatter-display.tsx`（移除两个按钮 + import + props）
- Delete: `src/components/wiki/merge-button.tsx`、`src/components/wiki/split-button.tsx`、`src/components/wiki/merge-dialog.tsx`、`src/components/wiki/split-dialog.tsx`
- Delete: `src/app/api/merge/route.ts`、`src/app/api/split/route.ts`
- Delete: `src/server/services/merge-service.ts`、`src/server/services/split-service.ts`
- Modify: `src/server/worker-entry.ts`（移除 merge/split import）
- Modify: `src/lib/contracts.ts:86,213`（Job.type 去 merge/split；更新 operation 注释）
- Modify: `src/hooks/use-job-stream.ts`（移除 merge/split 事件）
- Modify: `src/components/history/operation-list.tsx:13-17`（TYPE_LABELS 加 curate）

**Interfaces:**
- 结果：`merge`/`split` 不再作为 job 类型或路由存在；策展是唯一的合并/拆分入口。`FrontmatterDisplay` 不再接收/使用 `slug` 触发 merge/split（`slug` prop 仍可保留供其它用途，但移除 Merge/Split 渲染）。

- [ ] **Step 1: frontmatter-display 移除 Merge/Split 按钮**

在 `src/components/wiki/frontmatter-display.tsx`：

删除第 7-8 行：

```tsx
import { MergeButton } from '@/components/wiki/merge-button';
import { SplitButton } from '@/components/wiki/split-button';
```

删除第 59-60 行：

```tsx
          {slug && <MergeButton slug={slug} title={title} />}
          {slug && <SplitButton slug={slug} title={title} />}
```

`slug` prop 此后在本组件未被使用 —— 删除 interface 中的 `slug?: string;`（第 18 行）、解构参数中的 `slug,`（第 48 行）。若 `tsc` 报 `slug` 在调用方仍被传入（`page-renderer.tsx`）— 那是多余 prop，传入无害，但应一并清理：在 `page-renderer.tsx` 调用 `FrontmatterDisplay` 处去掉 `slug={...}`。

> 验证 slug 是否还有其它用途：本组件 Step 1 后 `slug` 仅曾用于两个按钮，已无引用，删除安全。

- [ ] **Step 2: 删除 UI 组件文件**

```bash
git rm src/components/wiki/merge-button.tsx src/components/wiki/split-button.tsx src/components/wiki/merge-dialog.tsx src/components/wiki/split-dialog.tsx
```

- [ ] **Step 3: 删除 API 路由**

```bash
git rm src/app/api/merge/route.ts src/app/api/split/route.ts
```

- [ ] **Step 4: 删除 merge/split service + worker-entry import**

```bash
git rm src/server/services/merge-service.ts src/server/services/split-service.ts
```

在 `src/server/worker-entry.ts` 删除第 38-39 行：

```ts
import './services/merge-service';
import './services/split-service';
```

- [ ] **Step 5: Job.type 去掉 merge/split + 更新 operation 注释**

在 `src/lib/contracts.ts` 第 86 行改为：

```ts
  type: 'ingest' | 'lint' | 'save-to-wiki' | 'embed-index' | 'curate';
```

第 213 行注释改为：

```ts
  type: string;           // 'ingest'|'curate'|'save-to-wiki'|'edit'|'delete'（merge/split 现归 curate）
```

- [ ] **Step 6: use-job-stream 移除 merge/split 事件**

在 `src/hooks/use-job-stream.ts` 删除第 166-171 行：

```ts
        // Merge events
        'merge:start',
        'merge:complete',
        // Split events
        'split:start',
        'split:complete',
```

- [ ] **Step 7: history TYPE_LABELS 加 curate**

在 `src/components/history/operation-list.tsx` 第 13-17 行的 `TYPE_LABELS` 对象内（保留 merge/split 历史标签），加一行：

```ts
  curate: '整理',
```

- [ ] **Step 8: 全局清查残留引用**

Run:
```bash
grep -rn "merge-button\|split-button\|merge-dialog\|split-dialog\|/api/merge\|/api/split\|merge-service\|split-service\|'merge'\|'split'\|\"merge\"\|\"split\"" src/ | grep -v "page-ops\|merge-prompt\|split-prompt\|split-plan\|MergeResult\|SplitResult\|MERGE_SYSTEM\|SPLIT_SYSTEM\|buildMerge\|buildSplit\|executePageMerge\|executePageSplit\|__tests__\|TYPE_LABELS"
```
Expected: 无输出（除上述保留项：page-ops/prompts/plan/TYPE_LABELS 历史标签/测试）。若有命中，逐个清理。

> 注意：`BUILTIN_LLM_TASKS` 中的 `'merge'`/`'split'` LLM task **保留**（page-ops 仍用 `generateStructuredOutput('merge'/'split')`），不在清理范围。

- [ ] **Step 9: 类型检查 + 全量测试**

Run: `npx tsc --noEmit && npm test`
Expected: tsc 无报错（无悬空 import / 类型）；测试全绿。

- [ ] **Step 10: 提交**

```bash
git add -A
git commit -m "refactor(wiki): 下线手动 merge/split 入口，合并/拆分统一由 curate 承担"
```

---

## Self-Review

**1. Spec coverage（逐节核对 spec → task）：**
- spec §1 去按钮留 Edit → T7 Step 1-2 ✓
- spec §2 决策1 service-level curator → T4 curate-service ✓
- spec §2 决策2 复用执行层抽纯函数 → T2 page-ops ✓
- spec §2 决策3 triage→confirm→execute → T3 prompt + T4 service ✓
- spec §3.1 page-ops → T2 ✓；§3.2 curate-service（scope/neighbor/triage/confirm/caps/重校验/收口/事件） → T4 ✓
- spec §3.3 curate LLM task + prompts → T3 ✓
- spec §3.4 自动（ingest 收尾）→ T6；手动（/api/curate + Health）→ T5 ✓
- spec §3.5 agentAutoCurate 设置 → T1 ✓
- spec §4 契约/数据（Job.type、注释、前端事件、history label）→ T4（加 curate）+ T7（去 merge/split）✓
- spec §5 删除清单 → T7 ✓
- spec §6 安全保守（保护页/target≠source/逐条重校验/上限/保守 prompt）→ T3 prompt + T4 service ✓
- spec §7 测试（page-ops 复用既有/curate-plan/curate-prompt）→ T2 Step4 + T3 + T4 ✓
- spec §8 rollout（无 DB 迁移、llm-config 可选 curate）→ 无迁移 task（确认零 DB 改动）✓

**2. Placeholder scan：** 无 TBD/TODO/"类似 Task N"；所有代码步骤含完整代码或精确行号 diff。Health 按钮的 `intent="secondary"` 已给出回退说明（非占位，是条件分支）。

**3. Type consistency：**
- `executePageMerge(jobId, subject, {targetSlug, sourceSlug})` / `executePageSplit(jobId, subject, {sourceSlug, hint?})` 在 T2 定义、T2 包装层与 T4 curate-service 调用一致 ✓
- `CurateTriage` 类型在 curate-prompt 定义、curate-plan import、curate-service 使用一致 ✓
- `applyDecisionCaps` 返回 `{ kept, droppedMerges, droppedSplits }`，T4 service 解构一致 ✓
- `expandScopeWithNeighbors(seedSlugs, links, subjectId, metaSlugs)` 签名在 curate-plan 定义、curate-service 调用一致（links 取 `pagesRepo.getAllLinks(subjectId)`，其元素含 `sourceSlug/targetSlug/targetSubjectId`）✓
- `agentAutoCurate` 在 contracts AppSettings/Schema、settings-repo、/api/settings、settings-content 四处类型一致（boolean）✓
- `curate` 在 BUILTIN_LLM_TASKS（T3）、Job.type（T4）、TYPE_LABELS（T7）一致 ✓

> 待执行者注意：`pagesRepo.getAllLinks(subjectId)` 返回的 `WikiLink` 字段命名若为 `sourceSlug/targetSlug/targetSubjectId`（见 contracts WikiLink）即可直接用；执行 T4 前用 `getAllLinks` 的实际返回类型核对一次字段名，必要时在 curate-service 内做一次 `.map` 适配后再传入纯函数（纯函数签名不变）。
