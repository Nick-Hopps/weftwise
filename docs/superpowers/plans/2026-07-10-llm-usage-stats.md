# LLM 用量统计（设置页 Usage 面板）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 持久化每次 LLM 调用的 task/模型/token 用量，并在设置弹窗新增 Usage 分类按 task 逐行展示，支持 7 天 / 30 天 / 全部时间窗。

**Architecture:** 新 `llm_usage` 明细表（一次调用一行）+ `usage-repo`（记账/聚合/GC）；埋点收口在 `provider-registry.ts` 五个入口 + `agent-loop.ts`（ingest 各阶段绕过 registry 直调 AI SDK，必须单独埋点）；`GET /api/usage` 聚合返回；设置弹窗新增 Usage 分类面板。Spec：`docs/superpowers/specs/2026-07-10-llm-usage-stats-design.md`。

**Tech Stack:** Drizzle + better-sqlite3、Vercel AI SDK v5、Next.js Route Handler、React Query、vitest。

## Global Constraints

- 记账必须 best-effort：`recordUsage` 内部 try/catch 全吞 + `console.warn`，绝不影响 LLM 调用。
- usage 的 input/output **两者都缺失（非 finite number）时不写行**；仅一侧缺失按 0 记；负数按 0。
- 失败的 LLM 调用不记账。
- `task`/`model` 取 `resolveTask` 后的 `route.task` / `route.model`。
- 表全局非 subject-scoped、无 FK；GC 保留 90 天。
- 生成代码用中文注释；commit message 中文一句话；**不加任何 AI 署名 trailer**。
- 校验用 `npx tsc --noEmit` + `npx vitest run <files>`（`npm run lint` 不可用）。

---

### Task 1: `llm_usage` 表 + `usage-repo`

**Files:**
- Modify: `src/server/db/schema.ts`（`researchBacklog` 之后追加）
- Modify: `src/server/db/client.ts`（新增 `migrateLlmUsage()`，在迁移调用序列 `migrateResearchBacklog();` 之后调用，约 570 行）
- Create: `src/server/db/repos/usage-repo.ts`
- Test: `src/server/db/repos/__tests__/usage-repo.test.ts`

**Interfaces:**
- Produces:
  - `recordUsage(entry: { task: string; model: string; inputTokens?: number; outputTokens?: number }): boolean`（写入返回 true；两 token 都缺失或写库失败返回 false，永不抛错）
  - `summarizeUsage(sinceMs?: number): UsageSummaryRow[]`，`UsageSummaryRow = { task: string; model: string; calls: number; inputTokens: number; outputTokens: number }`，按 `task ASC, model ASC` 排序
  - `pruneOldUsage(cutoffMs: number): number`
  - 常量 `USAGE_RETENTION_MS = 90 * 24 * 3600 * 1000`

- [ ] **Step 1: 写失败测试**

`src/server/db/repos/__tests__/usage-repo.test.ts`（沿用 settings-repo.test.ts 的临时 DB + `vi.resetModules()` 模式）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'usage-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('usage-repo', () => {
  it('recordUsage 写入一行并可被 summarizeUsage 聚合', async () => {
    const repo = await import('../usage-repo');
    expect(repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 100, outputTokens: 20 })).toBe(true);
    expect(repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 50, outputTokens: 5 })).toBe(true);
    expect(repo.recordUsage({ task: 'lint', model: 'm2', inputTokens: 10, outputTokens: 1 })).toBe(true);
    const rows = repo.summarizeUsage();
    expect(rows).toEqual([
      { task: 'lint', model: 'm2', calls: 1, inputTokens: 10, outputTokens: 1 },
      { task: 'query', model: 'm1', calls: 2, inputTokens: 150, outputTokens: 25 },
    ]);
  });

  it('input/output 全缺失不写行；单侧缺失按 0；负数按 0', async () => {
    const repo = await import('../usage-repo');
    expect(repo.recordUsage({ task: 'query', model: 'm1' })).toBe(false);
    expect(repo.recordUsage({ task: 'query', model: 'm1', inputTokens: NaN, outputTokens: NaN })).toBe(false);
    expect(repo.recordUsage({ task: 'embedding', model: 'e1', inputTokens: 40 })).toBe(true);
    expect(repo.recordUsage({ task: 'query', model: 'm1', inputTokens: -5, outputTokens: 3 })).toBe(true);
    const rows = repo.summarizeUsage();
    expect(rows).toEqual([
      { task: 'embedding', model: 'e1', calls: 1, inputTokens: 40, outputTokens: 0 },
      { task: 'query', model: 'm1', calls: 1, inputTokens: 0, outputTokens: 3 },
    ]);
  });

  it('summarizeUsage(sinceMs) 只统计 created_at >= sinceMs 的行（含边界）', async () => {
    const repo = await import('../usage-repo');
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 1, outputTokens: 1 });
    vi.setSystemTime(2_000_000);
    repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 10, outputTokens: 10 });
    vi.useRealTimers();
    expect(repo.summarizeUsage(2_000_000)).toEqual([
      { task: 'query', model: 'm1', calls: 1, inputTokens: 10, outputTokens: 10 },
    ]);
    expect(repo.summarizeUsage()).toEqual([
      { task: 'query', model: 'm1', calls: 2, inputTokens: 11, outputTokens: 11 },
    ]);
  });

  it('pruneOldUsage 删除 cutoff 之前的行并返回删除数', async () => {
    const repo = await import('../usage-repo');
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 1, outputTokens: 1 });
    vi.setSystemTime(5_000);
    repo.recordUsage({ task: 'query', model: 'm1', inputTokens: 2, outputTokens: 2 });
    vi.useRealTimers();
    expect(repo.pruneOldUsage(5_000)).toBe(1);
    expect(repo.summarizeUsage()[0].calls).toBe(1);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/usage-repo.test.ts`
Expected: FAIL（Cannot find module '../usage-repo'）

- [ ] **Step 3: 实现 schema + 迁移 + repo**

`src/server/db/schema.ts` 追加：

```ts
// LLM 用量明细：一次 LLM 调用一行（app 级资源，非 subject-scoped，无 FK）。
export const llmUsage = sqliteTable('llm_usage', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  task: text('task').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  createdAt: integer('created_at').notNull(), // epoch ms
});
```

`src/server/db/client.ts` 追加（仿 `migrateResearchBacklog`，并在迁移序列里 `migrateResearchBacklog();` 之后调 `migrateLlmUsage();`）：

```ts
// LLM 用量明细表（设置页 Usage 统计）。
function migrateLlmUsage(): void {
  const sqlite = rawSqlite!;
  if (tableExists('llm_usage')) return;
  sqlite.exec(`
    CREATE TABLE llm_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX idx_llm_usage_created_at ON llm_usage(created_at);
  `);
}
```

`src/server/db/repos/usage-repo.ts`：

```ts
import { asc, count, gte, lt, sql } from 'drizzle-orm';
import { getDb } from '../client';
import { llmUsage } from '../schema';
import type { UsageSummaryRow } from '@/lib/contracts';

/** llm_usage 保留窗口：90 天（worker sweep tick 按此清理）。 */
export const USAGE_RETENTION_MS = 90 * 24 * 3600 * 1000;

/** 非 finite / 负数归一化为 null（两者皆 null 时整行不记）。 */
function normalizeTokens(n: number | undefined): number | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

/**
 * 记录一次 LLM 调用用量。best-effort：写库失败吞错返回 false，绝不影响调用方。
 * input/output 两者都缺失（供应商未返回 usage）时不写行，避免污染统计。
 */
export function recordUsage(entry: {
  task: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}): boolean {
  const input = normalizeTokens(entry.inputTokens);
  const output = normalizeTokens(entry.outputTokens);
  if (input === null && output === null) return false;
  try {
    getDb()
      .insert(llmUsage)
      .values({
        task: entry.task,
        model: entry.model,
        inputTokens: input ?? 0,
        outputTokens: output ?? 0,
        createdAt: Date.now(),
      })
      .run();
    return true;
  } catch (err) {
    console.warn('[usage] recordUsage failed (ignored)', err);
    return false;
  }
}

/** 按 (task, model) 聚合；sinceMs 含边界（created_at >= sinceMs）。 */
export function summarizeUsage(sinceMs?: number): UsageSummaryRow[] {
  const db = getDb();
  const base = db
    .select({
      task: llmUsage.task,
      model: llmUsage.model,
      calls: count(),
      inputTokens: sql<number>`sum(${llmUsage.inputTokens})`,
      outputTokens: sql<number>`sum(${llmUsage.outputTokens})`,
    })
    .from(llmUsage);
  const filtered = sinceMs !== undefined ? base.where(gte(llmUsage.createdAt, sinceMs)) : base;
  return filtered
    .groupBy(llmUsage.task, llmUsage.model)
    .orderBy(asc(llmUsage.task), asc(llmUsage.model))
    .all();
}

/** 删除 cutoffMs 之前的行，返回删除行数。 */
export function pruneOldUsage(cutoffMs: number): number {
  const result = getDb().delete(llmUsage).where(lt(llmUsage.createdAt, cutoffMs)).run();
  return result.changes;
}
```

`src/lib/contracts.ts` 追加（放文件末尾，供 repo/API/UI 三端共用）：

```ts
// ---------------------------------------------------------------------------
// LLM 用量统计（设置页 Usage 面板）
// ---------------------------------------------------------------------------

/** Usage 统计时间窗。 */
export type UsageWindow = '7d' | '30d' | 'all';

/** GET /api/usage 聚合行：按 (task, model) 分组。 */
export interface UsageSummaryRow {
  task: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/server/db/repos/__tests__/usage-repo.test.ts`
Expected: PASS（4 用例）

- [ ] **Step 5: Commit**

```bash
git add src/server/db/schema.ts src/server/db/client.ts src/server/db/repos/usage-repo.ts src/server/db/repos/__tests__/usage-repo.test.ts src/lib/contracts.ts
git commit -m "feat(db): 新增 llm_usage 明细表与 usage-repo（记账/聚合/GC）"
```

---

### Task 2: provider-registry 五入口埋点

**Files:**
- Modify: `src/server/llm/provider-registry.ts`
- Test: `src/server/llm/__tests__/provider-registry-usage.test.ts`（新建）

**Interfaces:**
- Consumes: Task 1 的 `recordUsage`。
- Produces: 无新导出；五个既有函数行为不变，仅在成功路径追加记账。

- [ ] **Step 1: 写失败测试**

`src/server/llm/__tests__/provider-registry-usage.test.ts`（沿用 provider-registry-cancel.test.ts 的 `vi.hoisted` mock 模式；`resolveTask` mock 必须带 `model` 字段）：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  generateObject: vi.fn(),
  generateText: vi.fn(),
  embedMany: vi.fn(),
  recordUsage: vi.fn(),
  resolveTask: vi.fn(() => ({
    task: 'query',
    model: 'test-model',
    logLabel: 'test-model',
    timeoutMs: 60_000,
    maxTokens: 1000,
    temperature: 0,
    topP: undefined,
    topK: undefined,
    presencePenalty: undefined,
    frequencyPenalty: undefined,
    seed: undefined,
    maxRetries: 0,
    headers: undefined,
    providerOptions: undefined,
  })),
}));

vi.mock('ai', () => ({
  embedMany: mocks.embedMany,
  generateObject: mocks.generateObject,
  generateText: mocks.generateText,
  streamText: vi.fn(),
  stepCountIs: (n: number) => ({ stepCount: n }),
}));

vi.mock('../task-router', () => ({ resolveTask: mocks.resolveTask }));

vi.mock('../provider-factory', () => ({
  getLanguageModel: vi.fn(() => ({}) as unknown),
  getEmbeddingModel: vi.fn(() => ({}) as unknown),
}));

vi.mock('../config-loader', () => ({
  getLLMConfig: vi.fn(() => ({ tasks: { embedding: { model: 'embed-model' } } })),
}));

vi.mock('../../db/repos/usage-repo', () => ({ recordUsage: mocks.recordUsage }));

import { generateStructuredOutput, generateTextWithTools, generateEmbeddings } from '../provider-registry';
import { z } from 'zod';

beforeEach(() => {
  mocks.generateObject.mockReset();
  mocks.generateText.mockReset();
  mocks.embedMany.mockReset();
  mocks.recordUsage.mockReset();
});

describe('provider-registry usage 记账', () => {
  it('generateStructuredOutput 成功后按 route.task/model 记账', async () => {
    mocks.generateObject.mockResolvedValue({
      object: { ok: true },
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    await generateStructuredOutput('query', z.object({ ok: z.boolean() }), 'sys', 'user');
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      task: 'query',
      model: 'test-model',
      inputTokens: 120,
      outputTokens: 30,
    });
  });

  it('usage 缺失时仍调用 recordUsage（缺失守卫在 repo 层）且不抛错', async () => {
    mocks.generateObject.mockResolvedValue({ object: { ok: true }, usage: undefined });
    await expect(
      generateStructuredOutput('query', z.object({ ok: z.boolean() }), 'sys', 'user'),
    ).resolves.toEqual({ ok: true });
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      task: 'query',
      model: 'test-model',
      inputTokens: undefined,
      outputTokens: undefined,
    });
  });

  it('recordUsage 抛错不影响返回值', async () => {
    mocks.generateObject.mockResolvedValue({
      object: { ok: true },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    mocks.recordUsage.mockImplementation(() => {
      throw new Error('db down');
    });
    await expect(
      generateStructuredOutput('query', z.object({ ok: z.boolean() }), 'sys', 'user'),
    ).resolves.toEqual({ ok: true });
  });

  it('generateTextWithTools 优先 totalUsage（多步累计）', async () => {
    mocks.generateText.mockResolvedValue({
      text: 'done',
      usage: { inputTokens: 10, outputTokens: 5 },
      totalUsage: { inputTokens: 100, outputTokens: 50 },
    });
    await generateTextWithTools('query', { system: 's', messages: [], tools: {}, maxSteps: 3 });
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      task: 'query',
      model: 'test-model',
      inputTokens: 100,
      outputTokens: 50,
    });
  });

  it('LLM 调用失败不记账', async () => {
    mocks.generateObject.mockRejectedValue(new Error('boom'));
    await expect(
      generateStructuredOutput('query', z.object({ ok: z.boolean() }), 'sys', 'user'),
    ).rejects.toThrow('boom');
    expect(mocks.recordUsage).not.toHaveBeenCalled();
  });

  it('generateEmbeddings 把 usage.tokens 记为 inputTokens', async () => {
    mocks.embedMany.mockResolvedValue({ embeddings: [[0.1]], usage: { tokens: 77 } });
    await generateEmbeddings(['hello']);
    expect(mocks.recordUsage).toHaveBeenCalledWith({
      task: 'query', // resolveTask mock 固定返回 task:'query'
      model: 'test-model',
      inputTokens: 77,
      outputTokens: 0,
    });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/llm/__tests__/provider-registry-usage.test.ts`
Expected: FAIL（recordUsage 未被调用）

- [ ] **Step 3: 实现埋点**

`provider-registry.ts` 顶部 import：

```ts
import { recordUsage } from '../db/repos/usage-repo';
```

新增本地 helper（放 import 之后）：

```ts
/**
 * 记一次调用用量（best-effort 双保险：repo 内部已 try/catch，这里再兜一层
 * 保证 mock/异常场景下也绝不影响 LLM 调用返回）。usage 缺失守卫在 repo 层。
 */
function recordCallUsage(
  route: { task: string; model: string },
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
): void {
  try {
    recordUsage({
      task: route.task,
      model: route.model,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens,
    });
  } catch (err) {
    console.warn('[usage] record failed (ignored)', err);
  }
}
```

五处接入：

1. `generateStructuredOutput`：`return result.object;` 之前（done 日志之后）加 `recordCallUsage(route, result.usage);`
2. `generateTextWithTools`：`return { text: result.text };` 之前加 `recordCallUsage(route, result.totalUsage ?? result.usage);`（`totalUsage` 是多步工具循环累计，优先）
3. `streamTextResponse`：`streamText({...})` options 增加：

```ts
    onFinish: ({ usage, totalUsage }) => {
      recordCallUsage(route, totalUsage ?? usage);
    },
```

4. `streamTextWithTools`：同上加 `onFinish`（该函数当前无调用方传 onFinish，无组合冲突）
5. `generateEmbeddings`：把 `const { embeddings } = await embedMany(...)` 改为：

```ts
  const { embeddings, usage } = await embedMany({
    model: getEmbeddingModel(route),
    values: texts,
  });
  recordCallUsage(route, { inputTokens: usage?.tokens, outputTokens: 0 });
  return embeddings;
```

- [ ] **Step 4: 运行确认通过（含既有回归）**

Run: `npx vitest run src/server/llm/__tests__/`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/llm/provider-registry.ts src/server/llm/__tests__/provider-registry-usage.test.ts
git commit -m "feat(llm): provider-registry 五入口成功路径统一记录 token 用量"
```

---

### Task 3: agent-loop 埋点（ingest 各阶段）

**Files:**
- Modify: `src/server/agents/runtime/agent-loop.ts`（`ctx.budget.chargeTokens(...)` 旁，约 95 行）
- Test: `src/server/agents/runtime/__tests__/agent-loop-usage.test.ts`（新建；若既有 agent-loop 测试文件已有可复用的 runAgent 测试脚手架，则并入该文件）

**Interfaces:**
- Consumes: Task 1 的 `recordUsage`；既有 `resolveSkillModel` 返回的 `route`（含 `task`/`model`）与 `generation.inputTokens/outputTokens`。

- [ ] **Step 1: 写失败测试**

先读既有 `src/server/agents/runtime/__tests__/` 下 agent-loop 相关测试，复用其 skill/ctx mock 脚手架构造一次成功的 `runAgent` 调用（mock `ai` 的 `generateObject` 返回 `usage: { inputTokens: 100, outputTokens: 40 }`），并：

```ts
vi.mock('@/server/db/repos/usage-repo', () => ({ recordUsage: mocks.recordUsage }));
// 注意：agent-loop 实际 import 路径按文件内相对路径写法对齐（'../../../db/repos/usage-repo' 或别名，与实现一致）
```

断言：

```ts
expect(mocks.recordUsage).toHaveBeenCalledWith({
  task: expect.any(String),   // skillTaskKey 派生，如 'ingest:planner'
  model: expect.any(String),
  inputTokens: 100,
  outputTokens: 40,
});
```

再加一个用例：`recordUsage` 抛错时 `runAgent` 仍正常返回 output。

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/agent-loop-usage.test.ts`
Expected: FAIL（recordUsage 未被调用）

- [ ] **Step 3: 实现**

`agent-loop.ts` 顶部 import：

```ts
import { recordUsage } from '../../db/repos/usage-repo';
```

在 `ctx.budget.chargeTokens(inputTokens + outputTokens);` 之后加：

```ts
  // 用量统计（设置页 Usage 面板）：ingest 各阶段绕过 provider-registry，这里单独记账。
  try {
    recordUsage({ task: route.task, model: route.model, inputTokens, outputTokens });
  } catch (err) {
    console.warn('[usage] record failed (ignored)', err);
  }
```

注意：`route` 由 45 行 `resolveSkillModel(skill)` 返回，已在作用域内；若 `route` 类型上无 `model` 字段则用 `route.model`（`ResolvedTaskRoute` 必有）。检查点命中路径（orchestrator 的 `tokensUsed: 0` cached 分支）不经过 `runAgent`，天然不记账，符合"不产生调用不记账"。

- [ ] **Step 4: 运行确认通过（含既有回归）**

Run: `npx vitest run src/server/agents/runtime/__tests__/`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/agents/runtime/agent-loop.ts src/server/agents/runtime/__tests__/agent-loop-usage.test.ts
git commit -m "feat(agents): agent-loop 记录 ingest 各阶段 token 用量"
```

---

### Task 4: worker GC 挂点

**Files:**
- Modify: `src/server/jobs/worker.ts`

**Interfaces:**
- Consumes: Task 1 的 `pruneOldUsage` / `USAGE_RETENTION_MS`。

- [ ] **Step 1: 实现（无新增单测：prune 逻辑已在 Task 1 测过，挂点与 pruneOldJobEvents/pruneOldOperationsTick 同模式且无独立可测行为）**

`worker.ts` 顶部 import：

```ts
import { pruneOldUsage, USAGE_RETENTION_MS } from '../db/repos/usage-repo';
```

在 `pruneOldOperationsTick` 函数之后加：

```ts
/**
 * llm_usage 保留清扫：删除 90 天前的用量明细，止住该表无界增长。
 * 独立于成熟度维护开关——基础卫生操作必须始终执行。
 */
function pruneOldUsageTick(): void {
  const removed = pruneOldUsage(Date.now() - USAGE_RETENTION_MS);
  if (removed > 0) console.log(`[maintenance] pruned ${removed} expired llm_usage rows`);
}
```

在 `startWorker` 的两处（启动即清一次 + maintenance setInterval 内），紧跟 `pruneOldOperationsTick()` 的 try/catch 之后各加：

```ts
  try {
    pruneOldUsageTick();
  } catch (err) {
    console.error('[maintenance] llm_usage prune failed', err);
  }
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 错误

- [ ] **Step 3: Commit**

```bash
git add src/server/jobs/worker.ts
git commit -m "feat(jobs): worker sweep tick 清理 90 天前 llm_usage 明细"
```

---

### Task 5: `GET /api/usage` 路由

**Files:**
- Create: `src/app/api/usage/route.ts`

**Interfaces:**
- Consumes: Task 1 的 `summarizeUsage` 与 contracts 的 `UsageWindow`/`UsageSummaryRow`。
- Produces: `GET /api/usage?window=7d|30d|all` → `{ window: UsageWindow, rows: UsageSummaryRow[] }`。

- [ ] **Step 1: 实现（路由是纯粘合层，聚合逻辑已在 Task 1 测过，不写路由级测试——与 /api/research-backlog 等既有只读路由一致）**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { summarizeUsage } from '@/server/db/repos/usage-repo';
import type { UsageWindow } from '@/lib/contracts';

export const runtime = 'nodejs';

const WINDOW_MS: Record<Exclude<UsageWindow, 'all'>, number> = {
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
};

/**
 * GET /api/usage?window=7d|30d|all — LLM 用量统计（设置页 Usage 面板）。
 * app 级资源，非 subject-scoped；只读，仅 requireAuth；非法/缺省 window 按 30d。
 */
export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const param = request.nextUrl.searchParams.get('window');
  const window: UsageWindow = param === '7d' || param === 'all' ? param : '30d';
  const sinceMs = window === 'all' ? undefined : Date.now() - WINDOW_MS[window];

  return NextResponse.json({ window, rows: summarizeUsage(sinceMs) });
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 错误

- [ ] **Step 3: Commit**

```bash
git add src/app/api/usage/route.ts
git commit -m "feat(api): 新增 GET /api/usage 用量统计只读路由"
```

---

### Task 6: `formatTokenCount` 纯函数

**Files:**
- Create: `src/lib/format.ts`
- Test: `src/lib/__tests__/format.test.ts`

**Interfaces:**
- Produces: `formatTokenCount(n: number): string`（`0→'0'`、`999→'999'`、`1000→'1k'`、`12345→'12.3k'`、`999_949→'999.9k'`、`1_200_000→'1.2M'`；非 finite/负数 → `'0'`）。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { formatTokenCount } from '../format';

describe('formatTokenCount', () => {
  it('小于 1000 原样显示', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(999)).toBe('999');
  });
  it('千级带 k、保留一位小数（整数则省略）', () => {
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(12345)).toBe('12.3k');
    expect(formatTokenCount(999_949)).toBe('999.9k');
  });
  it('百万级带 M', () => {
    expect(formatTokenCount(1_000_000)).toBe('1M');
    expect(formatTokenCount(1_234_567)).toBe('1.2M');
  });
  it('非法输入回落 0', () => {
    expect(formatTokenCount(NaN)).toBe('0');
    expect(formatTokenCount(-5)).toBe('0');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/__tests__/format.test.ts`
Expected: FAIL（Cannot find module '../format'）

- [ ] **Step 3: 实现**

```ts
/** 数值展示格式化纯函数（客户端/服务端通用，零依赖）。 */

/** 保留一位小数，`.0` 省略：1 → '1'，1.23 → '1.2'。 */
function trimOneDecimal(v: number): string {
  return (Math.floor(v * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

/** token 数格式化：≥1M 显示 `1.2M`，≥1000 显示 `12.3k`，其余原样；非法输入回落 '0'。 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${trimOneDecimal(n / 1_000_000)}M`;
  if (n >= 1000) return `${trimOneDecimal(n / 1000)}k`;
  return String(Math.round(n));
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/__tests__/format.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/format.ts src/lib/__tests__/format.test.ts
git commit -m "feat(lib): 新增 formatTokenCount token 数格式化纯函数"
```

---

### Task 7: 设置弹窗 Usage 分类 + UsagePanel

**Files:**
- Modify: `src/components/layout/settings-categories.ts`
- Modify: `src/components/layout/settings-content.tsx`

**Interfaces:**
- Consumes: Task 5 的 `GET /api/usage`、Task 6 的 `formatTokenCount`、contracts 的 `UsageWindow`/`UsageSummaryRow`、既有 `Segmented`（`components/ui/segmented`）与 `apiFetch`。

- [ ] **Step 1: 加分类**

`settings-categories.ts`：

- import 行加 `BarChart3`（lucide-react）；
- `CategoryId` union 加 `| 'usage'`（放 `'maintenance'` 之后、`'about'` 之前）；
- `SETTINGS_CATEGORIES` 在 About 之前插入 `{ id: 'usage', label: 'Usage', icon: BarChart3 },`。

- [ ] **Step 2: 加 UsagePanel**

`settings-content.tsx`：

- import 补：`useState`（react）、`Segmented`（`@/components/ui/segmented`）、`formatTokenCount`（`@/lib/format`）、类型 `UsageWindow, UsageSummaryRow`（并入既有 `@/lib/contracts` type import）。
- `SettingsContent` 渲染分支加（在 maintenance 与 about 之间）：

```tsx
        {props.active === 'usage' && <UsagePanel />}
```

- 文件内（`AboutPanel` 之前）新增：

```tsx
const USAGE_WINDOW_OPTIONS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
] as const;

/** Usage 面板：LLM 用量统计（app 级，不随 subject；弹窗打开时取数，无轮询）。 */
function UsagePanel() {
  const [window, setWindow] = useState<UsageWindow>('30d');
  const { data, isLoading } = useQuery({
    queryKey: ['usage', window],
    queryFn: async () => {
      const res = await apiFetch(`/api/usage?window=${window}`);
      if (!res.ok) throw new Error('Failed to load usage');
      return (await res.json()) as { window: UsageWindow; rows: UsageSummaryRow[] };
    },
    staleTime: 30_000,
  });

  const rows = data?.rows ?? [];
  const totals = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  );

  return (
    <div className="space-y-4">
      <Segmented
        value={window}
        options={[...USAGE_WINDOW_OPTIONS]}
        onChange={setWindow}
        aria-label="Usage time window"
      />
      {isLoading ? (
        <p className="text-xs text-foreground-tertiary">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-foreground-tertiary">No usage recorded yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-foreground-tertiary">
              <th className="py-1.5 pr-2 font-medium">Task</th>
              <th className="py-1.5 pr-2 font-medium">Model</th>
              <th className="py-1.5 pr-2 text-right font-medium">Calls</th>
              <th className="py-1.5 pr-2 text-right font-medium">Input</th>
              <th className="py-1.5 text-right font-medium">Output</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.task}:${r.model}`} className="border-b border-border/50">
                <td className="py-1.5 pr-2 font-mono text-xs">{r.task}</td>
                <td className="py-1.5 pr-2 truncate max-w-[10rem] text-xs text-foreground-secondary" title={r.model}>
                  {r.model}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{r.calls}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{formatTokenCount(r.inputTokens)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatTokenCount(r.outputTokens)}</td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className="py-1.5 pr-2 text-xs">Total</td>
              <td className="py-1.5 pr-2" />
              <td className="py-1.5 pr-2 text-right tabular-nums">{totals.calls}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{formatTokenCount(totals.inputTokens)}</td>
              <td className="py-1.5 text-right tabular-nums">{formatTokenCount(totals.outputTokens)}</td>
            </tr>
          </tbody>
        </table>
      )}
      <p className="text-xs text-foreground-tertiary">Usage data is retained for 90 days.</p>
    </div>
  );
}
```

注意：本地状态名 `window` 遮蔽全局 `window` 对象——组件内未用到全局 window，可接受；若 lint 报 no-shadow 类告警则改名 `timeWindow`。表格样式若与既有面板不协调，参考同文件其他 panel 的 class 用法微调（保持 `text-foreground-*`/`border-border` 语义变量）。

- [ ] **Step 3: 类型检查 + 手动验证**

Run: `npx tsc --noEmit`
Expected: 0 错误

手动：`npm run dev:all` 起服务 → 打开设置弹窗 → Usage 分类可见；触发一次 Ask AI 问答后刷新面板，`query` 行出现且 token 数非零；切时间窗数据变化正常。

- [ ] **Step 4: Commit**

```bash
git add src/components/layout/settings-categories.ts src/components/layout/settings-content.tsx
git commit -m "feat(ui): 设置弹窗新增 Usage 分类展示各任务模型与 token 用量"
```

---

### Task 8: 全量回归 + 文档同步

**Files:**
- Modify: `CLAUDE.md`（根，变更记录表加一行）
- Modify: `src/server/llm/CLAUDE.md`、`src/server/db/CLAUDE.md`（如叙述受影响则同步一句）

- [ ] **Step 1: 全量测试**

Run: `npx vitest run`
Expected: 全 PASS（新增约 15+ 用例）

Run: `npx tsc --noEmit`
Expected: 0 错误

- [ ] **Step 2: 文档同步**

根 `CLAUDE.md` 变更记录表末尾加一行（日期 2026-07-10）：概述 llm_usage 表 + 六处埋点（provider-registry×5 + agent-loop）+ GET /api/usage + 设置弹窗 Usage 分类 + 90 天 GC。`src/server/db/CLAUDE.md` 数据模型表加 `llm_usage` 行；`src/server/llm/CLAUDE.md` 变更记录加一行。

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md src/server/db/CLAUDE.md src/server/llm/CLAUDE.md
git commit -m "docs: 同步 LLM 用量统计（llm_usage/埋点/API/设置面板）模块文档"
```
