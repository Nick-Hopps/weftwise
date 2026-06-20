# Ingest 断点续传 + 重试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 ingest 失败后能在"已成功处理"的产物（chunk 摘要 / plan / 每页 writer 产出）基础上逐页续传，并提供一个跨刷新持久的重试按钮，避免书本级文本量重跑整条流水线浪费 token。

**Architecture:** 新增一张 `ingest_checkpoints` SQLite 表逐产物增量落盘；orchestrator 在每个 LLM 调用点"先查检查点后跑"，命中即跳过；writer fanout 每页完成瞬间落盘以保住 fail-fast 中止时的已完成页；handler 成功后清除检查点。重试经 `POST /api/jobs/[id]/retry` 无条件 requeue 同一 job（保留 job ID），worker 复用同一 handler 自动恢复。前端加重试按钮 + 挂载时从最近一次失败 ingest 恢复面板。

**Tech Stack:** Next.js 15 App Router + React 19 + TypeScript 5、better-sqlite3 11 + Drizzle 0.38、Vercel AI SDK、vitest（node 环境）。

设计依据见 spec：`docs/superpowers/specs/2026-06-20-ingest-resume-checkpoint-design.md`。

## Global Constraints

- **续传粒度 = 页级**：逐 chunk 摘要、逐页 writer 产出、plan 都能单独跳过。
- **检查点作用域 = job**：按 `job.id` 存取；重试 = requeue 同一 job = 同一 sourceId = 确定性切块 → key 全稳定。chunk id 为 `c${i}`（`source-chunker.ts:80`，纯函数确定性）。
- **writer-page 检查点按 plan page 的 `slug` 存取**，不用 writer 输出的 `path`（查缓存发生在 writer 运行前，只能用输入身份）。
- **检查点仅在 handler 成功 return 时清除**；失败时保留供下次重试。
- **写入边界不变**：只有 reviewer 的 `commit_changeset` 写 vault；检查点只缓存读路径产物。
- **reviewer 永远重跑**：其修正页 / index / log 不进检查点。
- **向后兼容**：`AgentContext.checkpoint` 与 `PipelineStep.checkpointAs` 均可选；缺省时 orchestrator 行为与现状逐字节一致（既有测试不得回归）。
- **server-only 屏障**：`src/server/**` 不得被客户端组件直接 import。
- **建表机制**：本项目实际建表走 `client.ts::ensureTables` 的原生 `CREATE TABLE IF NOT EXISTS`，**不**用 drizzle 迁移文件（`schema.ts` 仅供类型推断）。
- **路径别名**：`@/*` → `src/*`。
- **写接口鉴权**：写 / 敏感 Route Handler 顶部 `requireAuth(request)`；浏览器 POST 再 `requireCsrf(request)`；文件顶部 `export const runtime = 'nodejs'`。
- **测试环境**：vitest `environment: 'node'`，仅匹配 `src/**/__tests__/**/*.test.ts`，**无 jsdom**——React hook / 组件改动用 `tsc`/`lint`/手动运行验证，不写单测（与现有仓库一致）。
- **commit message 用中文一句话总结，禁止 AI 署名 trailer / 脚注。**

---

## File Structure

**新增**

| 文件 | 职责 |
|------|------|
| `src/server/db/repos/checkpoints-repo.ts` | 检查点 CRUD + `getProgress`（纯 DB 访问） |
| `src/server/db/repos/__tests__/checkpoints-repo.test.ts` | 上述 repo 单测 |
| `src/server/agents/runtime/checkpoint.ts` | `loadCheckpoint(jobId)` → `IngestCheckpoint`（内存索引 + 落盘双写） |
| `src/server/agents/runtime/__tests__/checkpoint.test.ts` | 上述 handle 单测 |
| `src/app/api/jobs/[id]/retry/route.ts` | `POST` 手动重试 |
| `src/app/api/jobs/[id]/retry/__tests__/route.test.ts` | 上述路由单测 |

**修改**

| 文件 | 改动 |
|------|------|
| `src/server/db/schema.ts` | 新增 `ingestCheckpoints` 表声明 |
| `src/server/db/client.ts` | 新增 `migrateIngestCheckpoints()` + 在 `ensureTables` 调用 |
| `src/lib/contracts.ts` | 新增 `CheckpointProgress` 接口 |
| `src/server/agents/types.ts` | 新增 `IngestCheckpoint` 接口 + `AgentContext.checkpoint?` |
| `src/server/agents/runtime/orchestrator.ts` | `PipelineStep.checkpointAs` + map/planner/fanout 三分支续传 |
| `src/server/agents/runtime/__tests__/orchestrator.test.ts` | `ctxStub` 加 checkpoint 入参 + 续传测试 |
| `src/server/services/ingest-prep.ts` | 新增 `reduceCostForResume()` 纯函数 |
| `src/server/services/ingest-service.ts` | 构建 handle / 设 checkpointAs flag / resuming 事件 / 成功清理 / 预检折减 |
| `src/server/services/__tests__/ingest-prep.test.ts` | `reduceCostForResume` 测试（文件若不存在则新建） |
| `src/app/api/jobs/[id]/route.ts` | GET 响应附 `checkpointProgress` |
| `src/app/api/jobs/route.ts` | list 响应每条附 `checkpointProgress` |
| `src/hooks/use-job-stream.ts` | `reconnectKey` 参数 + 跳过合成 `final` cursor + `job:retrying`→streaming + 注册 `ingest:resuming` |
| `src/app/(app)/_components/dashboard-ingest-panel.tsx` | 重试按钮 + 挂载恢复失败 ingest + 进度标签 |

依赖顺序：Task 1 → 2 → 3 → 4；Task 5 依赖 Task 1；Task 6 → 7（前端）依赖 Task 5。

---

## Task 1: 检查点表 + repo + CheckpointProgress 类型

**Files:**
- Modify: `src/server/db/schema.ts`
- Modify: `src/server/db/client.ts:368-387`（`ensureTables` 及其上方新增函数）
- Modify: `src/lib/contracts.ts:106`（`JobEvent` 之后）
- Create: `src/server/db/repos/checkpoints-repo.ts`
- Test: `src/server/db/repos/__tests__/checkpoints-repo.test.ts`

**Interfaces:**
- Produces:
  - `CheckpointProgress { plan: boolean; chunkSummaries: number; writerPages: number; totalPages: number | null }`（`@/lib/contracts`）
  - `checkpoints-repo`: `getCheckpoints(jobId: string): CheckpointRow[]`、`putCheckpoint(jobId, kind, key, data): void`、`deleteCheckpoints(jobId): void`、`getProgress(jobId: string): CheckpointProgress | null`
  - `CheckpointRow { kind: string; key: string; data: unknown }`

- [ ] **Step 1: 写失败测试**

Create `src/server/db/repos/__tests__/checkpoints-repo.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'checkpoints-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('checkpoints-repo', () => {
  it('getCheckpoints 在无记录时返回空数组', async () => {
    const repo = await import('../checkpoints-repo');
    expect(repo.getCheckpoints('job-x')).toEqual([]);
  });

  it('putCheckpoint 写入后 getCheckpoints 能读回（data_json 反序列化）', async () => {
    const repo = await import('../checkpoints-repo');
    repo.putCheckpoint('j1', 'chunk-summary', 's1:c0', { summary: '摘要零' });
    repo.putCheckpoint('j1', 'writer-page', 'page-a', { action: 'create', path: 'wiki/general/page-a.md', content: '# A' });
    const rows = repo.getCheckpoints('j1');
    expect(rows).toHaveLength(2);
    const summary = rows.find((r) => r.kind === 'chunk-summary');
    expect(summary).toEqual({ kind: 'chunk-summary', key: 's1:c0', data: { summary: '摘要零' } });
  });

  it('putCheckpoint 同 (job,kind,key) 幂等覆盖（upsert）', async () => {
    const repo = await import('../checkpoints-repo');
    repo.putCheckpoint('j1', 'plan', '', { plan: { pages: [{ slug: 'a' }] } });
    repo.putCheckpoint('j1', 'plan', '', { plan: { pages: [{ slug: 'a' }, { slug: 'b' }] } });
    const rows = repo.getCheckpoints('j1').filter((r) => r.kind === 'plan');
    expect(rows).toHaveLength(1);
    expect((rows[0].data as { plan: { pages: unknown[] } }).plan.pages).toHaveLength(2);
  });

  it('deleteCheckpoints 清空该 job 的全部检查点（不影响其他 job）', async () => {
    const repo = await import('../checkpoints-repo');
    repo.putCheckpoint('j1', 'plan', '', { plan: { pages: [] } });
    repo.putCheckpoint('j2', 'plan', '', { plan: { pages: [] } });
    repo.deleteCheckpoints('j1');
    expect(repo.getCheckpoints('j1')).toEqual([]);
    expect(repo.getCheckpoints('j2')).toHaveLength(1);
  });

  it('getProgress 无检查点返回 null；有则汇总计数并从 plan 推出 totalPages', async () => {
    const repo = await import('../checkpoints-repo');
    expect(repo.getProgress('j1')).toBeNull();
    repo.putCheckpoint('j1', 'plan', '', { plan: { pages: [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }] } });
    repo.putCheckpoint('j1', 'chunk-summary', 's1:c0', { summary: 'x' });
    repo.putCheckpoint('j1', 'chunk-summary', 's1:c1', { summary: 'y' });
    repo.putCheckpoint('j1', 'writer-page', 'a', { action: 'create', path: 'wiki/general/a.md', content: '' });
    expect(repo.getProgress('j1')).toEqual({
      plan: true,
      chunkSummaries: 2,
      writerPages: 1,
      totalPages: 3,
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/checkpoints-repo.test.ts`
Expected: FAIL（`Cannot find module '../checkpoints-repo'`）。

- [ ] **Step 3: 加 schema 声明**

In `src/server/db/schema.ts`，在文件末尾（`operations` 表之后）追加：

```ts
export const ingestCheckpoints = sqliteTable(
  'ingest_checkpoints',
  {
    jobId: text('job_id').notNull(),
    kind: text('kind').notNull(),
    key: text('key').notNull(),
    dataJson: text('data_json').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.jobId, t.kind, t.key] }),
  })
);
```

（`sqliteTable` / `text` / `primaryKey` 已在文件顶部 import，无需新增。）

- [ ] **Step 4: 加建表迁移**

In `src/server/db/client.ts`，在 `migrateAppSettings()` 函数（约 332-342 行）之后新增：

```ts
// 新表：ingest 断点续传检查点（job 运行态，成功即删；同 job_events 不设硬 FK）
function migrateIngestCheckpoints(): void {
  const sqlite = rawSqlite!;
  if (tableExists('ingest_checkpoints')) return;
  sqlite.exec(`
    CREATE TABLE ingest_checkpoints (
      job_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      data_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_id, kind, key)
    );
  `);
}
```

然后在 `ensureTables()`（约 368-387 行）的 `migrateAppSettings();` 之后、`ensurePagesFts();` 之前插入一行：

```ts
    migrateAppSettings();
    migrateIngestCheckpoints();
    ensurePagesFts();
```

- [ ] **Step 5: 加 CheckpointProgress 类型**

In `src/lib/contracts.ts`，在 `JobEvent` 接口（约 99-106 行）之后追加：

```ts
/** ingest 断点续传进度快照（API 响应 + 续传事件共用）。totalPages 仅在 plan 已缓存时可知。 */
export interface CheckpointProgress {
  plan: boolean;
  chunkSummaries: number;
  writerPages: number;
  totalPages: number | null;
}
```

- [ ] **Step 6: 实现 checkpoints-repo**

Create `src/server/db/repos/checkpoints-repo.ts`:

```ts
import { eq } from 'drizzle-orm';
import { getDb, getRawDb } from '../client';
import { ingestCheckpoints } from '../schema';
import type { CheckpointProgress } from '@/lib/contracts';

export interface CheckpointRow {
  kind: string;
  key: string;
  data: unknown;
}

export function getCheckpoints(jobId: string): CheckpointRow[] {
  const db = getDb();
  const rows = db
    .select()
    .from(ingestCheckpoints)
    .where(eq(ingestCheckpoints.jobId, jobId))
    .all();
  return rows.map((r) => ({ kind: r.kind, key: r.key, data: JSON.parse(r.dataJson) }));
}

export function putCheckpoint(jobId: string, kind: string, key: string, data: unknown): void {
  const sqlite = getRawDb();
  sqlite
    .prepare(
      `INSERT INTO ingest_checkpoints (job_id, kind, key, data_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(job_id, kind, key) DO UPDATE SET
         data_json = excluded.data_json,
         created_at = excluded.created_at`,
    )
    .run(jobId, kind, key, JSON.stringify(data), new Date().toISOString());
}

export function deleteCheckpoints(jobId: string): void {
  const sqlite = getRawDb();
  sqlite.prepare(`DELETE FROM ingest_checkpoints WHERE job_id = ?`).run(jobId);
}

export function getProgress(jobId: string): CheckpointProgress | null {
  const sqlite = getRawDb();
  const counts = sqlite
    .prepare(`SELECT kind, COUNT(*) AS n FROM ingest_checkpoints WHERE job_id = ? GROUP BY kind`)
    .all(jobId) as Array<{ kind: string; n: number }>;
  if (counts.length === 0) return null;

  let plan = false;
  let chunkSummaries = 0;
  let writerPages = 0;
  for (const c of counts) {
    if (c.kind === 'plan') plan = c.n > 0;
    else if (c.kind === 'chunk-summary') chunkSummaries = c.n;
    else if (c.kind === 'writer-page') writerPages = c.n;
  }

  let totalPages: number | null = null;
  if (plan) {
    const row = sqlite
      .prepare(`SELECT data_json FROM ingest_checkpoints WHERE job_id = ? AND kind = 'plan' AND key = ''`)
      .get(jobId) as { data_json: string } | undefined;
    if (row) {
      try {
        const parsed = JSON.parse(row.data_json) as { plan?: { pages?: unknown[] } };
        if (parsed?.plan?.pages && Array.isArray(parsed.plan.pages)) {
          totalPages = parsed.plan.pages.length;
        }
      } catch {
        // plan 反序列化失败时 totalPages 留 null（不致命）
      }
    }
  }

  return { plan, chunkSummaries, writerPages, totalPages };
}
```

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run src/server/db/repos/__tests__/checkpoints-repo.test.ts`
Expected: PASS（5 个用例全绿）。

- [ ] **Step 8: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增报错。

- [ ] **Step 9: 提交**

```bash
git add src/server/db/schema.ts src/server/db/client.ts src/lib/contracts.ts src/server/db/repos/checkpoints-repo.ts src/server/db/repos/__tests__/checkpoints-repo.test.ts
git commit -m "feat: 新增 ingest_checkpoints 表与 checkpoints-repo（断点续传存储层）"
```

---

## Task 2: CheckpointHandle（内存索引 + 落盘双写）

**Files:**
- Modify: `src/server/agents/types.ts:1-2`（import）、`:86-103`（`AgentContext`）
- Create: `src/server/agents/runtime/checkpoint.ts`
- Test: `src/server/agents/runtime/__tests__/checkpoint.test.ts`

**Interfaces:**
- Consumes: `checkpoints-repo`（Task 1）、`CheckpointProgress`、`ChangesetEntry`（`@/lib/contracts`）
- Produces:
  - `IngestCheckpoint`（`@/server/agents/types`）含 `getChunkSummary/putChunkSummary/getPlan/putPlan/getWriterPage/putWriterPage/hasAny/progress/clear`
  - `AgentContext.checkpoint?: IngestCheckpoint`
  - `loadCheckpoint(jobId: string): IngestCheckpoint`（`@/server/agents/runtime/checkpoint`）

- [ ] **Step 1: 写失败测试**

Create `src/server/agents/runtime/__tests__/checkpoint.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'checkpoint-handle-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});

afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

describe('loadCheckpoint', () => {
  it('空 job：hasAny=false，各 getter 返回 undefined', async () => {
    const { loadCheckpoint } = await import('../checkpoint');
    const ckpt = loadCheckpoint('j1');
    expect(ckpt.hasAny()).toBe(false);
    expect(ckpt.getPlan()).toBeUndefined();
    expect(ckpt.getChunkSummary('s1:c0')).toBeUndefined();
    expect(ckpt.getWriterPage('a')).toBeUndefined();
  });

  it('put 后内存即时可读，且重新 loadCheckpoint 能从 DB 读回（落盘）', async () => {
    const { loadCheckpoint } = await import('../checkpoint');
    const ckpt = loadCheckpoint('j1');
    ckpt.putChunkSummary('s1:c0', '摘要零');
    ckpt.putPlan({ plan: { pages: [{ slug: 'a' }, { slug: 'b' }] } });
    ckpt.putWriterPage('a', { action: 'create', path: 'wiki/general/a.md', content: '# A' });

    expect(ckpt.getChunkSummary('s1:c0')).toBe('摘要零');
    expect(ckpt.getWriterPage('a')).toEqual({ action: 'create', path: 'wiki/general/a.md', content: '# A' });
    expect(ckpt.hasAny()).toBe(true);

    const reloaded = loadCheckpoint('j1');
    expect(reloaded.getChunkSummary('s1:c0')).toBe('摘要零');
    expect((reloaded.getPlan() as { plan: { pages: unknown[] } }).plan.pages).toHaveLength(2);
    expect(reloaded.getWriterPage('a')).toEqual({ action: 'create', path: 'wiki/general/a.md', content: '# A' });
  });

  it('progress 汇总计数并从 plan 推出 totalPages', async () => {
    const { loadCheckpoint } = await import('../checkpoint');
    const ckpt = loadCheckpoint('j1');
    ckpt.putPlan({ plan: { pages: [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }] } });
    ckpt.putChunkSummary('s1:c0', 'x');
    ckpt.putWriterPage('a', { action: 'create', path: 'wiki/general/a.md', content: '' });
    expect(ckpt.progress()).toEqual({ plan: true, chunkSummaries: 1, writerPages: 1, totalPages: 3 });
  });

  it('clear 后 hasAny=false 且重新加载为空', async () => {
    const { loadCheckpoint } = await import('../checkpoint');
    const ckpt = loadCheckpoint('j1');
    ckpt.putPlan({ plan: { pages: [] } });
    ckpt.clear();
    expect(ckpt.hasAny()).toBe(false);
    expect(loadCheckpoint('j1').hasAny()).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/checkpoint.test.ts`
Expected: FAIL（`Cannot find module '../checkpoint'`）。

- [ ] **Step 3: 加 IngestCheckpoint 接口 + AgentContext 字段**

In `src/server/agents/types.ts`：

把第 2 行 import 改为（追加 `CheckpointProgress`）：

```ts
import type { Job, Subject, ChangesetEntry, CheckpointProgress } from '@/lib/contracts';
```

在 `PendingChangeset` 接口（约 65-67 行）之后追加：

```ts
/** 断点续传句柄：内存索引 + 落盘双写；缺省（undefined）时 orchestrator 行为与现状一致。 */
export interface IngestCheckpoint {
  getChunkSummary(key: string): string | undefined;
  putChunkSummary(key: string, summary: string): void;
  getPlan(): unknown | undefined;
  putPlan(output: unknown): void;
  getWriterPage(slug: string): ChangesetEntry | undefined;   // slug = plan page 身份
  putWriterPage(slug: string, entry: ChangesetEntry): void;
  hasAny(): boolean;
  progress(): CheckpointProgress;
  clear(): void;
}
```

在 `AgentContext` 接口里（`budgetSnapshot` 字段之后，约第 102 行）追加一行：

```ts
  /** Snapshot from settings-repo, captured at root-run start. */
  budgetSnapshot: AgentBudget;
  /** 断点续传句柄；仅 ingest 注入，缺省时不续传。 */
  checkpoint?: IngestCheckpoint;
}
```

- [ ] **Step 4: 实现 checkpoint.ts**

Create `src/server/agents/runtime/checkpoint.ts`:

```ts
import * as checkpointsRepo from '../../db/repos/checkpoints-repo';
import type { ChangesetEntry, CheckpointProgress } from '@/lib/contracts';
import type { IngestCheckpoint } from '../types';

/**
 * 从 DB 载入某 job 的检查点到内存索引，并对外暴露 get/put（put 同步双写内存 + DB）。
 * 一次性 getCheckpoints 载入，避免每次查询命中 DB。
 */
export function loadCheckpoint(jobId: string): IngestCheckpoint {
  const summaries = new Map<string, string>();
  const pages = new Map<string, ChangesetEntry>();
  let plan: unknown | undefined;

  for (const row of checkpointsRepo.getCheckpoints(jobId)) {
    if (row.kind === 'chunk-summary') {
      summaries.set(row.key, (row.data as { summary: string }).summary);
    } else if (row.kind === 'plan') {
      plan = row.data;
    } else if (row.kind === 'writer-page') {
      pages.set(row.key, row.data as ChangesetEntry);
    }
  }

  function progress(): CheckpointProgress {
    let totalPages: number | null = null;
    if (plan && typeof plan === 'object') {
      const p = (plan as { plan?: { pages?: unknown[] } }).plan;
      if (p?.pages && Array.isArray(p.pages)) totalPages = p.pages.length;
    }
    return {
      plan: plan !== undefined,
      chunkSummaries: summaries.size,
      writerPages: pages.size,
      totalPages,
    };
  }

  return {
    getChunkSummary: (key) => summaries.get(key),
    putChunkSummary: (key, summary) => {
      summaries.set(key, summary);
      checkpointsRepo.putCheckpoint(jobId, 'chunk-summary', key, { summary });
    },
    getPlan: () => plan,
    putPlan: (output) => {
      plan = output;
      checkpointsRepo.putCheckpoint(jobId, 'plan', '', output);
    },
    getWriterPage: (slug) => pages.get(slug),
    putWriterPage: (slug, entry) => {
      pages.set(slug, entry);
      checkpointsRepo.putCheckpoint(jobId, 'writer-page', slug, entry);
    },
    hasAny: () => summaries.size > 0 || plan !== undefined || pages.size > 0,
    progress,
    clear: () => {
      summaries.clear();
      pages.clear();
      plan = undefined;
      checkpointsRepo.deleteCheckpoints(jobId);
    },
  };
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/server/agents/runtime/__tests__/checkpoint.test.ts`
Expected: PASS（4 个用例全绿）。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增报错。

- [ ] **Step 7: 提交**

```bash
git add src/server/agents/types.ts src/server/agents/runtime/checkpoint.ts src/server/agents/runtime/__tests__/checkpoint.test.ts
git commit -m "feat: CheckpointHandle（loadCheckpoint）+ AgentContext.checkpoint 注入点"
```

---

## Task 3: Orchestrator 逐页续传（核心）

**Files:**
- Modify: `src/server/agents/runtime/orchestrator.ts:1-8`（import + `PipelineStep`）、`:33-41`（sequence）、`:53-89`（map fn）、`:103-110`（fanout fn）
- Test: `src/server/agents/runtime/__tests__/orchestrator.test.ts`（扩 `ctxStub` + 新增续传 describe）

**Interfaces:**
- Consumes: `IngestCheckpoint`（via `ctx.checkpoint`）、`AgentRunResult`（已 import）、`ChangesetEntry`
- Produces: `PipelineStep` 三个变体各新增可选 `checkpointAs`：
  - sequence: `checkpointAs?: 'plan'`
  - fanout: `checkpointAs?: 'writer-page'`
  - map: `checkpointAs?: 'chunk-summary'`

- [ ] **Step 1: 写失败测试（续传行为 + fail-fast 落盘 + 回归）**

In `src/server/agents/runtime/__tests__/orchestrator.test.ts`：

(1) 顶部第 5 行 import 追加 `ChangesetEntry`：

```ts
import type { AgentContext, SkillTemplate, StoredChunk } from '../../types';
```
改为：
```ts
import type { AgentContext, SkillTemplate, StoredChunk, IngestCheckpoint } from '../../types';
import type { ChangesetEntry } from '@/lib/contracts';
```

(2) 把 `ctxStub` 签名（第 13 行）改为可选接收 checkpoint，并在返回对象里加一行 `checkpoint`：

```ts
function ctxStub(chunks: StoredChunk[] = [], checkpoint?: IngestCheckpoint): AgentContext {
```
并在返回对象 `budgetSnapshot: {...},` 之后加：
```ts
    budgetSnapshot: { maxSteps: 25, maxTokensPerJob: 500_000, maxParallelSubAgents: 2 },
    checkpoint,
  } as AgentContext;
```

(3) 在 `stubSkill` 之后新增内存 checkpoint 工厂：

```ts
function fakeCheckpoint(seed?: {
  summaries?: Record<string, string>;
  plan?: unknown;
  pages?: Record<string, ChangesetEntry>;
}): IngestCheckpoint & { _spies: { putSummary: ReturnType<typeof vi.fn>; putPlan: ReturnType<typeof vi.fn>; putPage: ReturnType<typeof vi.fn> } } {
  const summaries = new Map(Object.entries(seed?.summaries ?? {}));
  const pages = new Map(Object.entries(seed?.pages ?? {}));
  let plan = seed?.plan;
  const putSummary = vi.fn((k: string, s: string) => { summaries.set(k, s); });
  const putPlan = vi.fn((o: unknown) => { plan = o; });
  const putPage = vi.fn((slug: string, e: ChangesetEntry) => { pages.set(slug, e); });
  return {
    getChunkSummary: (k) => summaries.get(k),
    putChunkSummary: putSummary,
    getPlan: () => plan,
    putPlan,
    getWriterPage: (slug) => pages.get(slug),
    putWriterPage: putPage,
    hasAny: () => summaries.size > 0 || plan !== undefined || pages.size > 0,
    progress: () => ({ plan: plan !== undefined, chunkSummaries: summaries.size, writerPages: pages.size, totalPages: null }),
    clear: vi.fn(),
    _spies: { putSummary, putPlan, putPage },
  };
}
```

(4) 文件末尾追加续传 describe：

```ts
describe('orchestrator.runPipeline: 断点续传 (checkpointAs)', () => {
  it('map: 命中缓存摘要跳过 summarizer，未命中跑后落盘', async () => {
    mockRun.mockReset();
    mockRun.mockImplementation(async (opts: { input: { id: string } }) => ({
      runId: `m-${opts.input.id}`, output: { summary: `新摘要:${opts.input.id}` }, tokensUsed: 0, stepCount: 1, cacheHitTokens: 0,
    }));
    const ckpt = fakeCheckpoint({ summaries: { 's1:c0': '缓存摘要c0' } });
    const ctx = ctxStub([chunk('s1', 'c0', '全文零'), chunk('s1', 'c1', '全文一')], ckpt);
    const result = await runPipeline({
      steps: [{ kind: 'map', skillId: 'summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs', checkpointAs: 'chunk-summary' }],
      resolveSkill: stubSkill,
      ctx,
      initialInput: {
        chunkRefs: [
          { key: 's1:c0', sourceId: 's1', id: 'c0', heading: '', content: '' },
          { key: 's1:c1', sourceId: 's1', id: 'c1', heading: '', content: '' },
        ],
      },
    });
    expect(mockRun).toHaveBeenCalledTimes(1); // 只跑 c1
    expect(mockRun.mock.calls[0][0].input.id).toBe('c1');
    const r = result as { chunkRefs: Array<{ content: string }> };
    expect(r.chunkRefs.map((c) => c.content)).toEqual(['缓存摘要c0', '新摘要:c1']);
    expect(ckpt._spies.putSummary).toHaveBeenCalledWith('s1:c1', '新摘要:c1');
    expect(ckpt._spies.putSummary).not.toHaveBeenCalledWith('s1:c0', expect.anything());
  });

  it('planner: 命中缓存 plan 跳过 LLM，carry 结构与正常跑一致', async () => {
    mockRun.mockReset();
    mockRun.mockResolvedValueOnce({ runId: 'w', output: { action: 'create', path: 'wiki/general/a.md', content: '' }, tokensUsed: 0, stepCount: 1, cacheHitTokens: 0 });
    const cachedPlan = { plan: { pages: [{ slug: 'a', sourceRefs: [] }] } };
    const ckpt = fakeCheckpoint({ plan: cachedPlan });
    const ctx = ctxStub([], ckpt);
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages'], checkpointAs: 'plan' },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages', checkpointAs: 'writer-page' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [] },
    });
    // planner 未调 LLM：唯一的 mockRun 调用是 writer
    expect(mockRun).toHaveBeenCalledTimes(1);
    const writerInput = mockRun.mock.calls[0][0].input as Record<string, unknown>;
    expect(writerInput.slug).toBe('a');
    expect(ckpt._spies.putPlan).not.toHaveBeenCalled();
  });

  it('fanout: 命中已写页跳过 writer，未命中跑后即时落盘；pending 含全部页', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'a', sourceRefs: [] }, { slug: 'b', sourceRefs: [] }] } }, tokensUsed: 0, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'wb', output: { action: 'create', path: 'wiki/general/b.md', content: '# B' }, tokensUsed: 0, stepCount: 1, cacheHitTokens: 0 });
    const cachedA: ChangesetEntry = { action: 'create', path: 'wiki/general/a.md', content: '# A(cached)' };
    const ckpt = fakeCheckpoint({ pages: { a: cachedA } });
    const ctx = ctxStub([], ckpt);
    ctx.budgetSnapshot.maxParallelSubAgents = 1;
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages'] },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages', checkpointAs: 'writer-page' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [] },
    });
    // planner 跑 1 次 + 只有 b 跑 writer（a 命中缓存）
    expect(mockRun).toHaveBeenCalledTimes(2);
    expect(ckpt._spies.putPage).toHaveBeenCalledWith('b', { action: 'create', path: 'wiki/general/b.md', content: '# B' });
    expect(ckpt._spies.putPage).not.toHaveBeenCalledWith('a', expect.anything());
    // pending 含缓存 a + 新写 b（reviewer 据此提交全书）
    expect(ctx.pending.entries).toEqual([
      cachedA,
      { action: 'create', path: 'wiki/general/b.md', content: '# B' },
    ]);
  });

  it('fanout: 某页失败时已完成页已落盘（fail-fast 不丢已完成工作）', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'a', sourceRefs: [] }, { slug: 'b', sourceRefs: [] }] } }, tokensUsed: 0, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'wa', output: { action: 'create', path: 'wiki/general/a.md', content: '# A' }, tokensUsed: 0, stepCount: 1, cacheHitTokens: 0 })
      .mockRejectedValueOnce(new Error('writer b 爆炸'));
    const ckpt = fakeCheckpoint();
    const ctx = ctxStub([], ckpt);
    ctx.budgetSnapshot.maxParallelSubAgents = 1; // 串行：a 先完成并落盘，再轮到 b 抛错
    await expect(runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages'] },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages', checkpointAs: 'writer-page' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [] },
    })).rejects.toThrow('writer b 爆炸');
    // a 在抛错前已落盘 → 重试可跳过
    expect(ckpt._spies.putPage).toHaveBeenCalledWith('a', { action: 'create', path: 'wiki/general/a.md', content: '# A' });
    expect(ckpt._spies.putPage).not.toHaveBeenCalledWith('b', expect.anything());
  });

  it('回归：无 checkpoint（ctx.checkpoint=undefined）时 map/planner/fanout 行为不变', async () => {
    mockRun.mockReset();
    mockRun
      .mockResolvedValueOnce({ runId: 'p', output: { plan: { pages: [{ slug: 'a', sourceRefs: [] }] } }, tokensUsed: 0, stepCount: 1, cacheHitTokens: 0 })
      .mockResolvedValueOnce({ runId: 'w', output: { action: 'create', path: 'wiki/general/a.md', content: '# A' }, tokensUsed: 0, stepCount: 1, cacheHitTokens: 0 });
    const ctx = ctxStub(); // 无 checkpoint
    await runPipeline({
      steps: [
        { kind: 'sequence', skillId: 'planner', carryThrough: ['subjectSlug', 'existingPages'], checkpointAs: 'plan' },
        { kind: 'fanout', skillId: 'writer', fromOutput: 'plan.pages', checkpointAs: 'writer-page' },
      ],
      resolveSkill: stubSkill,
      ctx,
      initialInput: { subjectSlug: 'general', existingPages: [] },
    });
    expect(mockRun).toHaveBeenCalledTimes(2); // planner + writer 照常都跑
    expect(ctx.pending.entries).toEqual([{ action: 'create', path: 'wiki/general/a.md', content: '# A' }]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts`
Expected: 新增 5 个续传用例 FAIL（`checkpointAs` 未生效、`putPage` 未被调用等）；旧用例仍 PASS。

- [ ] **Step 3: 改 PipelineStep 类型 + import**

In `src/server/agents/runtime/orchestrator.ts`：

第 1-2 行 import 之后追加（新起一行）：

```ts
import type { AgentContext, SkillTemplate } from '../types';
import { runAgentLoop, AgentCancelled, type AgentRunResult } from './agent-loop';
import { BudgetExceededError } from './budget';
import type { ChangesetEntry } from '@/lib/contracts';
```

`PipelineStep`（第 5-8 行）改为：

```ts
export type PipelineStep =
  | { kind: 'sequence'; skillId: string; carryThrough?: string[]; omitFromInput?: string[]; checkpointAs?: 'plan' }
  | { kind: 'fanout'; skillId: string; fromOutput: string; checkpointAs?: 'writer-page' }
  | { kind: 'map'; skillId: string; fromOutput: string; intoOutput: string; checkpointAs?: 'chunk-summary' };
```

- [ ] **Step 4: sequence 分支续传（planner 缓存）**

把第 33-41 行：

```ts
    if (step.kind === 'sequence') {
      const skill = opts.resolveSkill(step.skillId);
      const input = step.omitFromInput && isPlainObject(carry)
        ? omitKeys(carry, step.omitFromInput)
        : carry;
      const r = await runAgentLoop({ skill, ctx: opts.ctx, input });
      carry = step.carryThrough && isPlainObject(carry) && isPlainObject(r.output)
        ? { ...pickKeys(carry, step.carryThrough), ...r.output }
        : r.output;
    } else if (step.kind === 'map') {
```

改为：

```ts
    if (step.kind === 'sequence') {
      const skill = opts.resolveSkill(step.skillId);
      const input = step.omitFromInput && isPlainObject(carry)
        ? omitKeys(carry, step.omitFromInput)
        : carry;
      // 断点续传：planner 已缓存则跳过 LLM，用缓存 plan 当作步骤输出
      const cachedPlan = step.checkpointAs === 'plan' ? opts.ctx.checkpoint?.getPlan() : undefined;
      let r: AgentRunResult;
      if (cachedPlan !== undefined && cachedPlan !== null) {
        r = { runId: 'cached-plan', output: cachedPlan, tokensUsed: 0, stepCount: 0, cacheHitTokens: 0 };
      } else {
        r = await runAgentLoop({ skill, ctx: opts.ctx, input });
        if (step.checkpointAs === 'plan') opts.ctx.checkpoint?.putPlan(r.output);
      }
      carry = step.carryThrough && isPlainObject(carry) && isPlainObject(r.output)
        ? { ...pickKeys(carry, step.carryThrough), ...r.output }
        : r.output;
    } else if (step.kind === 'map') {
```

- [ ] **Step 5: map 分支续传（chunk 摘要缓存）**

在 map fn 里，`!stored` 的 if 块（约第 55-58 行）之后、`// map 纯收集` 注释之前，插入：

```ts
        if (!stored) {
          opts.ctx.emit('ingest:warn', `Chunk not found in chunkStore: ${item.key}`, { key: item.key });
          return item;
        }
        // 断点续传：命中已缓存摘要则跳过 summarizer（书本级 map 步是 N 次 LLM 调用）
        if (step.checkpointAs === 'chunk-summary') {
          const cached = opts.ctx.checkpoint?.getChunkSummary(item.key);
          if (typeof cached === 'string') return { ...item, content: cached };
        }
```

并把该 fn 末尾（约第 88 行）的：

```ts
        return { ...item, content: out.summary };
```

改为：

```ts
        if (step.checkpointAs === 'chunk-summary') opts.ctx.checkpoint?.putChunkSummary(item.key, out.summary);
        return { ...item, content: out.summary };
```

- [ ] **Step 6: fanout 分支续传（每页缓存 + 即时落盘）**

把 fanout 的 `runWithSemaphore`（约第 103-110 行）：

```ts
      const results = await runWithSemaphore(items, limit, async (item) => {
        const childCtx: AgentContext = {
          ...opts.ctx,
          overlay: baseOverlay.snapshot(),
          parentRunId: opts.ctx.rootRunId,
        };
        return runAgentLoop({ skill, ctx: childCtx, input: buildFanoutInput(carry, item, opts.ctx) });
      });
```

改为：

```ts
      const results = await runWithSemaphore(items, limit, async (item) => {
        const slug = isPlainObject(item) && typeof item.slug === 'string' ? item.slug : undefined;
        // 断点续传：命中已写页则跳过 writer LLM（fanout 是书本级最贵步骤）
        if (step.checkpointAs === 'writer-page' && slug) {
          const cached = opts.ctx.checkpoint?.getWriterPage(slug);
          if (cached) {
            return { runId: 'cached-writer', output: cached, tokensUsed: 0, stepCount: 0, cacheHitTokens: 0 } as AgentRunResult;
          }
        }
        const childCtx: AgentContext = {
          ...opts.ctx,
          overlay: baseOverlay.snapshot(),
          parentRunId: opts.ctx.rootRunId,
        };
        const r = await runAgentLoop({ skill, ctx: childCtx, input: buildFanoutInput(carry, item, opts.ctx) });
        // 每页完成瞬间即落盘（barrier 之前）——fail-fast 中止时已完成 + 在飞页都保住
        if (step.checkpointAs === 'writer-page' && slug) {
          const entry = r.output as ChangesetEntry | undefined;
          if (entry?.path) opts.ctx.checkpoint?.putWriterPage(slug, entry);
        }
        return r;
      });
```

> 注：fanout 后续的 merge / overlay.putEntries / pending.push 逻辑（约第 113-133 行）**不动**——缓存页作为 fn 输出同样流经这段，故 resume 成功路径上 `pending` 会被正确填满全部页。

- [ ] **Step 7: 运行测试确认通过**

Run: `npx vitest run src/server/agents/runtime/__tests__/orchestrator.test.ts`
Expected: PASS（旧用例 + 5 个续传用例全绿）。

- [ ] **Step 8: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增报错。

- [ ] **Step 9: 提交**

```bash
git add src/server/agents/runtime/orchestrator.ts src/server/agents/runtime/__tests__/orchestrator.test.ts
git commit -m "feat: orchestrator 逐页续传——map/planner/fanout 命中检查点跳过 LLM，writer 即时落盘"
```

---

## Task 4: ingest-service 接线 + 预检折减

**Files:**
- Modify: `src/server/services/ingest-prep.ts`（新增 `reduceCostForResume`）
- Test: `src/server/services/__tests__/ingest-prep.test.ts`（若不存在则新建）
- Modify: `src/server/services/ingest-service.ts:1-26`（import）、`:79-92`（预检）、`:112-147`（ctx + steps）、`:151-169`（成功清理）

**Interfaces:**
- Consumes: `loadCheckpoint`（Task 2）、`checkpoints-repo`、orchestrator 的 `checkpointAs`（Task 3）、`CheckpointProgress`
- Produces: `reduceCostForResume(fullEstimate: number, progress: CheckpointProgress): number`（`@/server/services/ingest-prep`）

- [ ] **Step 1: 追加 reduceCostForResume 失败测试**

`src/server/services/__tests__/ingest-prep.test.ts` **已存在**（含 `prepareIngest` / `estimateIngestCost` 等用例，顶部已 import `describe, expect, it`）。本步**追加**，不要新建覆盖。

(a) 把顶部从 `'../ingest-prep'` 的 import（第 2-8 行）改为加入 `reduceCostForResume`，并在其后加一行类型 import：

```ts
import {
  prepareIngest,
  fillInlineContent,
  isInlinePath,
  estimateIngestCost,
  reduceCostForResume,
  PLAN_INLINE_THRESHOLD,
} from '../ingest-prep';
import type { CheckpointProgress } from '@/lib/contracts';
```

(b) 文件末尾追加新 describe（复用文件已有的 `describe/it/expect`）：

```ts
describe('reduceCostForResume', () => {
  const prog = (p: Partial<CheckpointProgress>): CheckpointProgress => ({
    plan: false, chunkSummaries: 0, writerPages: 0, totalPages: null, ...p,
  });

  it('plan 未缓存（totalPages 未知）时不折减', () => {
    expect(reduceCostForResume(100_000, prog({ plan: false, writerPages: 5 }))).toBe(100_000);
  });

  it('totalPages 为 0 时不折减（防除零）', () => {
    expect(reduceCostForResume(100_000, prog({ plan: true, totalPages: 0, writerPages: 0 }))).toBe(100_000);
  });

  it('按已写页比例折减 fanout 占比（60%）', () => {
    // 100 页写完 50 页：减 100000 * 0.6 * 0.5 = 30000
    expect(reduceCostForResume(100_000, prog({ plan: true, totalPages: 100, writerPages: 50 }))).toBe(70_000);
  });

  it('已写页超过 totalPages 时按 100% 封顶（最多减 fanout 全占比）', () => {
    expect(reduceCostForResume(100_000, prog({ plan: true, totalPages: 10, writerPages: 99 }))).toBe(40_000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/server/services/__tests__/ingest-prep.test.ts`
Expected: FAIL（`reduceCostForResume` 未导出）。

- [ ] **Step 3: 实现 reduceCostForResume**

In `src/server/services/ingest-prep.ts`，文件顶部 import 区追加（第 3 行后）：

```ts
import type { ChunkRef, StoredChunk } from '../agents/types';
import type { CheckpointProgress } from '@/lib/contracts';
```

文件末尾追加：

```ts
/**
 * 恢复态预算折减：full 估算按已写页比例扣减 fanout 占比。
 * 仅在 plan 已缓存（totalPages 已知）时折减；保守只折减 writer fanout 这一主成本
 * （估为整体 60%），map/planner/reserve 不折减——宁可少减不致放行后运行期爆预算。
 */
export function reduceCostForResume(fullEstimate: number, progress: CheckpointProgress): number {
  if (!progress.plan || !progress.totalPages || progress.totalPages <= 0) return fullEstimate;
  const FANOUT_SHARE = 0.6;
  const doneFraction = Math.min(1, progress.writerPages / progress.totalPages);
  return Math.round(fullEstimate * (1 - FANOUT_SHARE * doneFraction));
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/server/services/__tests__/ingest-prep.test.ts`
Expected: PASS（4 个用例全绿）。

- [ ] **Step 5: ingest-service 接线**

In `src/server/services/ingest-service.ts`：

(a) import 区（约第 14-24 行）补三行：

```ts
import { runPipeline, type PipelineStep } from '../agents/runtime/orchestrator';
import { createBudgetTracker } from '../agents/runtime/budget';
import { createOverlayVault } from '../agents/runtime/overlay-vault';
import { loadCheckpoint } from '../agents/runtime/checkpoint';
import {
  prepareIngest,
  fillInlineContent,
  isInlinePath,
  estimateIngestCost,
  reduceCostForResume,
} from './ingest-prep';
```

(b) 预检段（约第 79-92 行）改为先建 checkpoint、再按恢复态折减估算，并发 resuming 事件：

把：

```ts
  // 预算预检（spec E.2）：任何 LLM 调用前 fail-fast
  const inline = isInlinePath(prep.totalTokens);
  const estimatedCost = estimateIngestCost(prep.totalTokens, prep.chunkCount, inline);
  emit('ingest:chunking', `Chunked into ${prep.chunkCount} chunks (~${prep.totalTokens} tokens)`, {
    chunkCount: prep.chunkCount,
    totalTokens: prep.totalTokens,
    estimatedCost,
  });
  if (estimatedCost > budgetSnapshot.maxTokensPerJob) {
    throw new Error(
      `Estimated cost ~${estimatedCost} tokens exceeds budget agentMaxTokensPerJob=${budgetSnapshot.maxTokensPerJob}; ` +
      `raise it to >= ${Math.ceil(estimatedCost * 1.1)} in Settings and retry`,
    );
  }
```

改为：

```ts
  // 断点续传：载入该 job 已有检查点（重试 = requeue 同一 job.id）
  const checkpoint = loadCheckpoint(job.id);
  if (checkpoint.hasAny()) {
    const p = checkpoint.progress();
    emit(
      'ingest:resuming',
      `Resuming ingest: plan ${p.plan ? 'cached' : 'pending'}, ${p.chunkSummaries} summaries, ${p.writerPages}${p.totalPages ? `/${p.totalPages}` : ''} pages done`,
      { progress: p },
    );
  }

  // 预算预检（spec E.2）：任何 LLM 调用前 fail-fast；恢复态按已完成产物折减估算
  const inline = isInlinePath(prep.totalTokens);
  const fullEstimate = estimateIngestCost(prep.totalTokens, prep.chunkCount, inline);
  const estimatedCost = checkpoint.hasAny()
    ? reduceCostForResume(fullEstimate, checkpoint.progress())
    : fullEstimate;
  emit('ingest:chunking', `Chunked into ${prep.chunkCount} chunks (~${prep.totalTokens} tokens)`, {
    chunkCount: prep.chunkCount,
    totalTokens: prep.totalTokens,
    estimatedCost,
  });
  if (estimatedCost > budgetSnapshot.maxTokensPerJob) {
    throw new Error(
      `Estimated cost ~${estimatedCost} tokens exceeds budget agentMaxTokensPerJob=${budgetSnapshot.maxTokensPerJob}; ` +
      `raise it to >= ${Math.ceil(estimatedCost * 1.1)} in Settings and retry`,
    );
  }
```

(c) ctx 构建（约第 115-130 行）追加 `checkpoint`：把 `budgetSnapshot,` 之后加一行：

```ts
    chunkStore: prep.chunkStore,
    budgetSnapshot,
    checkpoint,
  };
```

(d) steps 定义（约第 140-147 行）给三步加 `checkpointAs`：

```ts
  const steps: PipelineStep[] = [
    ...(inline
      ? []
      : [{ kind: 'map', skillId: 'ingest-chunk-summarizer', fromOutput: 'chunkRefs', intoOutput: 'chunkRefs', checkpointAs: 'chunk-summary' } as const]),
    { kind: 'sequence', skillId: 'ingest-planner', carryThrough: carryKeys, checkpointAs: 'plan' },
    { kind: 'fanout', skillId: 'ingest-writer', fromOutput: 'plan.pages', checkpointAs: 'writer-page' },
    { kind: 'sequence', skillId: 'ingest-reviewer', omitFromInput: ['chunkRefs', 'outline'] },
  ];
```

(e) 成功清理：把结尾（约第 151-169 行）

```ts
  const result = await runPipeline({
    ...
  }) as IngestResult;

  return result as unknown as Record<string, unknown>;
```

改为（在 return 前清除检查点）：

```ts
  const result = await runPipeline({
    steps,
    resolveSkill: (id) => {
      const s = skillRegistry.get(id);
      if (!s) throw new Error(`Skill not loaded: ${id}`);
      return s;
    },
    ctx,
    initialInput: {
      chunkRefs: inline ? fillInlineContent(prep.chunkRefs, prep.chunkStore) : prep.chunkRefs,
      sources: [{ sourceId, filename }],
      subjectSlug: subject.slug,
      existingPages,
      outline: prep.outline,
      languageDirective,
    },
  }) as IngestResult;

  // 成功（reviewer 已 commit）→ 清除检查点；失败时不清，留给下次重试
  checkpoint.clear();

  return result as unknown as Record<string, unknown>;
```

(f) 保持 `src/server/services/__tests__/ingest-service.test.ts` 的 DB-free：该测试 mock 了所有依赖，但**未** mock checkpoint——新接线的 `loadCheckpoint(job.id)` 会命中真实 DB（`getDb()`），污染测试。在其 mock 区（约第 41-44 行 orchestrator mock 之后）追加一段 mock，使续传逻辑在该测试里成为 no-op：

```ts
vi.mock('../../agents/runtime/checkpoint', () => ({
  loadCheckpoint: () => ({
    getChunkSummary: () => undefined,
    putChunkSummary: () => {},
    getPlan: () => undefined,
    putPlan: () => {},
    getWriterPage: () => undefined,
    putWriterPage: () => {},
    hasAny: () => false,
    progress: () => ({ plan: false, chunkSummaries: 0, writerPages: 0, totalPages: null }),
    clear: () => {},
  }),
}));
```

> 既有 step 断言用 `toMatchObject` / `.map((s) => s.kind)` / `toHaveLength(3)`，新增的 `checkpointAs` 字段不影响（partial match / 只看 kind / 步数不变）；`hasAny()=false` 使 resuming 分支与预检折减都不触发，行为与现状一致。

- [ ] **Step 6: 类型检查 + 回归测试**

Run: `npx tsc --noEmit`
Expected: 无新增报错。

Run: `npx vitest run src/server/services src/server/agents`
Expected: PASS（既有 ingest pipeline 测试 + 新测试全绿）。

- [ ] **Step 7: 提交**

```bash
git add src/server/services/ingest-prep.ts src/server/services/ingest-service.ts src/server/services/__tests__/ingest-prep.test.ts
git commit -m "feat: ingest-service 接入断点续传——载入/清理检查点、steps 标 checkpointAs、预检按恢复折减"
```

---

## Task 5: 重试 API + jobs 响应附 checkpointProgress

**Files:**
- Create: `src/app/api/jobs/[id]/retry/route.ts`
- Test: `src/app/api/jobs/[id]/retry/__tests__/route.test.ts`
- Modify: `src/app/api/jobs/[id]/route.ts`
- Modify: `src/app/api/jobs/route.ts`

**Interfaces:**
- Consumes: `queue.get/requeue/list`、`events.emit`、`requireAuth/requireCsrf`、`checkpoints-repo.getProgress`（Task 1）
- Produces:
  - `POST /api/jobs/[id]/retry` → 202（failed ingest）/ 404 / 422（非 ingest）/ 409（非 failed）
  - `GET /api/jobs/[id]` 响应增加 `checkpointProgress: CheckpointProgress | null`
  - `GET /api/jobs` 列表每项增加 `checkpointProgress: CheckpointProgress | null`

- [ ] **Step 1: 写重试路由失败测试**

Create `src/app/api/jobs/[id]/retry/__tests__/route.test.ts`:

> 注：`vi.mock` 被提升到文件顶部（在 import 之前求值），故工厂里引用的外部变量必须用 `mock` 前缀——vitest 对 `mock*` 命名有 hoist 豁免（与既有 `orchestrator.test.ts` 的 `mockRun` 同款），否则会 TDZ 报错。

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockGet = vi.fn();
const mockRequeue = vi.fn();
const mockEmit = vi.fn();

vi.mock('@/server/middleware/auth', () => ({
  requireAuth: () => null,
  requireCsrf: () => null,
}));
vi.mock('@/server/jobs/queue', () => ({
  get: mockGet,
  requeue: mockRequeue,
}));
vi.mock('@/server/jobs/events', () => ({ emit: mockEmit }));

import { POST } from '../route';

function call() {
  const req = new NextRequest('http://localhost/api/jobs/j1/retry', { method: 'POST' });
  return POST(req, { params: Promise.resolve({ id: 'j1' }) });
}

beforeEach(() => {
  mockGet.mockReset();
  mockRequeue.mockReset();
  mockEmit.mockReset();
});

describe('POST /api/jobs/[id]/retry', () => {
  it('404 当 job 不存在', async () => {
    mockGet.mockReturnValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(mockRequeue).not.toHaveBeenCalled();
  });

  it('422 当 job 非 ingest', async () => {
    mockGet.mockReturnValue({ id: 'j1', type: 'lint', status: 'failed' });
    const res = await call();
    expect(res.status).toBe(422);
    expect(mockRequeue).not.toHaveBeenCalled();
  });

  it('409 当 job 状态非 failed', async () => {
    mockGet.mockReturnValue({ id: 'j1', type: 'ingest', status: 'running' });
    const res = await call();
    expect(res.status).toBe(409);
    expect(mockRequeue).not.toHaveBeenCalled();
  });

  it('202 + requeue + emit job:retrying 当 failed ingest', async () => {
    mockGet
      .mockReturnValueOnce({ id: 'j1', type: 'ingest', status: 'failed' })
      .mockReturnValueOnce({ id: 'j1', type: 'ingest', status: 'pending' });
    const res = await call();
    expect(res.status).toBe(202);
    expect(mockRequeue).toHaveBeenCalledWith('j1');
    expect(mockEmit).toHaveBeenCalledWith('j1', 'job:retrying', expect.any(String), expect.anything());
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run "src/app/api/jobs/[id]/retry/__tests__/route.test.ts"`
Expected: FAIL（`Cannot find module '../route'`）。

- [ ] **Step 3: 实现重试路由**

Create `src/app/api/jobs/[id]/retry/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import * as queue from '@/server/jobs/queue';
import * as events from '@/server/jobs/events';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  const { id } = await params;
  const job = queue.get(id);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  if (job.type !== 'ingest') {
    return NextResponse.json({ error: 'Only ingest jobs can be retried' }, { status: 422 });
  }
  if (job.status !== 'failed') {
    return NextResponse.json(
      { error: `Cannot retry a job with status "${job.status}"` },
      { status: 409 },
    );
  }

  // 无条件 requeue（刻意绕过 worker 的 isRetryableError，让用户能手动重试业务失败）
  queue.requeue(id);
  events.emit(id, 'job:retrying', 'Manual retry — resuming from checkpoint', { manual: true });

  return NextResponse.json(queue.get(id), { status: 202 });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run "src/app/api/jobs/[id]/retry/__tests__/route.test.ts"`
Expected: PASS（4 个用例全绿）。

- [ ] **Step 5: GET /api/jobs/[id] 附 checkpointProgress**

In `src/app/api/jobs/[id]/route.ts`，import 区加一行：

```ts
import * as queue from '@/server/jobs/queue';
import { requireAuth } from '@/server/middleware/auth';
import * as checkpointsRepo from '@/server/db/repos/checkpoints-repo';
```

把 `return NextResponse.json(job);` 改为：

```ts
  return NextResponse.json({ ...job, checkpointProgress: checkpointsRepo.getProgress(id) });
```

- [ ] **Step 6: GET /api/jobs 列表每项附 checkpointProgress**

In `src/app/api/jobs/route.ts`，import 区加一行 `import * as checkpointsRepo from '@/server/db/repos/checkpoints-repo';`，并把：

```ts
  const jobs = queue.list({
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(subjectId ? { subjectId } : {}),
  });

  return NextResponse.json(jobs);
```

改为：

```ts
  const jobs = queue.list({
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(subjectId ? { subjectId } : {}),
  });

  const withProgress = jobs.map((j) => ({
    ...j,
    checkpointProgress: checkpointsRepo.getProgress(j.id),
  }));

  return NextResponse.json(withProgress);
```

- [ ] **Step 7: 类型检查 + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 无新增报错。

- [ ] **Step 8: 提交**

```bash
git add "src/app/api/jobs/[id]/retry/route.ts" "src/app/api/jobs/[id]/retry/__tests__/route.test.ts" "src/app/api/jobs/[id]/route.ts" src/app/api/jobs/route.ts
git commit -m "feat: 新增 POST /api/jobs/[id]/retry 手动重试 + jobs 响应附 checkpointProgress"
```

---

## Task 6: SSE hook 支持重试重连

> **验证方式说明**：vitest 为 node 环境、无 jsdom，仓库无 React hook 单测设施。本任务用 `tsc`/`lint` + 手动运行验证（与既有 hook 一致）。改动是三处定点小修，逻辑已在 spec §5.F / §八 论证。

**Files:**
- Modify: `src/hooks/use-job-stream.ts:23`（签名）、`:91-93`（cursor）、`:109-118`（事件分支）、`:124-159`（namedEventTypes）、`:200-201`（deps）

**Interfaces:**
- Produces: `useJobStream(jobId: string | null, reconnectKey?: number): UseJobStreamResult`（新增可选第二参；`reconnectKey` 变化即对同一 jobId 强制重连）

- [ ] **Step 1: 加 reconnectKey 参数**

把第 23 行：

```ts
export function useJobStream(jobId: string | null): UseJobStreamResult {
```

改为：

```ts
export function useJobStream(jobId: string | null, reconnectKey = 0): UseJobStreamResult {
```

- [ ] **Step 2: cursor 跳过合成 final**

> 失败/完成 job 的 SSE 会补发一条 id 为 `'final'` 的合成 `job:${status}`（`events.ts:75`）。若让它覆盖 cursor，重试重连会以不存在的 `'final'` 为游标 → `getJobEvents` 退化为全量重放、把旧 `job:failed` 一并重放从而立刻关闭新流。故跳过它，保留真实末事件 id 作游标。

把第 91-93 行：

```ts
        if (event.lastEventId) {
          lastEventIdRef.current = event.lastEventId;
        }
```

改为：

```ts
        // 跳过 SSE 合成的终态事件 id（'final'，见 events.ts），否则重试重连游标失效会全量重放旧 job:failed
        if (event.lastEventId && event.lastEventId !== 'final') {
          lastEventIdRef.current = event.lastEventId;
        }
```

- [ ] **Step 3: 处理 job:retrying → streaming**

把第 109-118 行（`job:completed` / `job:failed` 分支）：

```ts
        if (eventType === 'job:completed') {
          updateStatus('completed');
          source?.close();
        } else if (eventType === 'job:failed') {
          updateStatus('failed');
          const errMsg = (parsed.error as string) || 'Job failed';
          setLatestMessage(errMsg);
          source?.close();
        }
```

改为：

```ts
        if (eventType === 'job:completed') {
          updateStatus('completed');
          source?.close();
        } else if (eventType === 'job:failed') {
          updateStatus('failed');
          const errMsg = (parsed.error as string) || 'Job failed';
          setLatestMessage(errMsg);
          source?.close();
        } else if (eventType === 'job:retrying') {
          // 自动重试（worker）或手动重试后，流转回处理中
          updateStatus('streaming');
        }
```

- [ ] **Step 4: 注册 ingest:resuming 事件**

在 `namedEventTypes` 数组（约第 129-142 行的 ingest 段）里，`'ingest:start',` 之后加一行：

```ts
        // Ingest events
        'ingest:start',
        'ingest:resuming',
        'ingest:parsing',
```

- [ ] **Step 5: effect deps 加 reconnectKey**

把第 200-201 行：

```ts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);
```

改为：

```ts
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, reconnectKey]);
```

- [ ] **Step 6: 类型检查 + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 无新增报错（既有 `useJobStream(jobId)` 单参调用因第二参有默认值仍合法）。

- [ ] **Step 7: 提交**

```bash
git add src/hooks/use-job-stream.ts
git commit -m "feat: use-job-stream 支持重试重连（reconnectKey + 跳过合成 final 游标 + job:retrying）"
```

---

## Task 7: Dashboard 面板重试按钮 + 跨刷新恢复

> **验证方式说明**：同 Task 6，用 `tsc`/`lint` + 手动运行验证。

**Files:**
- Modify: `src/app/(app)/_components/dashboard-ingest-panel.tsx`

**Interfaces:**
- Consumes: `useJobStream(jobId, reconnectKey)`（Task 6）、`POST /api/jobs/[id]/retry` 与 `GET /api/jobs/[id]` / `GET /api/jobs`（Task 5）、`CheckpointProgress`（`@/lib/contracts`）

- [ ] **Step 1: import + state**

把第 8 行 import 区补类型 import（在 `import { cn } from '@/lib/cn';` 之后加）：

```ts
import { cn } from '@/lib/cn';
import type { CheckpointProgress, Job } from '@/lib/contracts';
```

在 state 区（约第 26-33 行）`const [jobId, setJobId] = useState<string | null>(null);` 之后追加：

```ts
  const [jobId, setJobId] = useState<string | null>(null);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [checkpointProgress, setCheckpointProgress] = useState<CheckpointProgress | null>(null);
```

把第 35 行：

```ts
  const { events, status } = useJobStream(jobId);
```

改为：

```ts
  const { events, status } = useJobStream(jobId, reconnectKey);
```

- [ ] **Step 2: reset 清掉新增 state**

把 `reset`（约第 69-76 行）改为同时清 checkpointProgress：

```ts
  const reset = () => {
    setJobId(null);
    setError(null);
    setCreatedPages([]);
    setTextInput('');
    setFilenameInput('');
    setCheckpointProgress(null);
    if (fileRef.current) fileRef.current.value = '';
  };
```

- [ ] **Step 3: 重试 handler + 两个恢复 effect**

在 `reset` 定义之后追加：

```ts
  // 手动重试：requeue 同一 job 后，对同一 jobId 强制重连 SSE（bump reconnectKey）
  const handleRetry = useCallback(async () => {
    if (!jobId) return;
    setRetrying(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/jobs/${jobId}/retry`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Retry failed (${res.status})`);
      }
      setReconnectKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  }, [jobId]);

  // 失败后拉取该 job 的断点进度（用于按钮上的 "x/y 页" 标签）
  useEffect(() => {
    if (status !== 'failed' || !jobId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/jobs/${jobId}`);
        if (!res.ok) return;
        const job = (await res.json()) as { checkpointProgress?: CheckpointProgress | null };
        if (!cancelled) setCheckpointProgress(job.checkpointProgress ?? null);
      } catch {
        /* 静默：进度标签只是锦上添花 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, jobId]);

  // 挂载时恢复当前 subject 最近一次「有断点可续」的失败 ingest（关标签页再回来仍能重试）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const subjectId = useUIStore.getState().currentSubjectId;
      if (!subjectId) return;
      try {
        const res = await apiFetch(`/api/jobs?status=failed&type=ingest&subjectId=${encodeURIComponent(subjectId)}`);
        if (!res.ok) return;
        const jobs = (await res.json()) as Array<Job & { checkpointProgress: CheckpointProgress | null }>;
        const resumable = jobs.filter((j) => j.checkpointProgress);
        if (resumable.length === 0) return;
        const latest = resumable[resumable.length - 1]; // listJobs 按 createdAt 升序
        if (cancelled) return;
        setCheckpointProgress(latest.checkpointProgress);
        setJobId(latest.id);
      } catch {
        /* 静默 */
      }
    })();
    return () => {
      cancelled = true;
    };
    // 仅挂载时尝试一次恢复
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 4: 渲染重试按钮**

把失败/完成块里的按钮区（约第 352-373 行）：

```tsx
            {(isDone || isFailed) && (
              <div className="px-3 py-3 border-t border-border space-y-2.5">
                {createdPages.length > 0 && (
                  <div className="space-y-1.5">
                    <SectionLabel>Created pages</SectionLabel>
                    <div className="flex flex-wrap gap-1.5">
                      {createdPages.map((slug) => (
                        <Link
                          key={slug}
                          href={`/wiki/${slug}`}
                          className="focus-ring rounded-sm"
                        >
                          <Tag tone="accent" size="base">{slug}</Tag>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                <Button intent="ghost" size="sm" onClick={reset}>
                  Ingest another source
                </Button>
              </div>
            )}
```

改为（失败时先显示重试按钮）：

```tsx
            {(isDone || isFailed) && (
              <div className="px-3 py-3 border-t border-border space-y-2.5">
                {createdPages.length > 0 && (
                  <div className="space-y-1.5">
                    <SectionLabel>Created pages</SectionLabel>
                    <div className="flex flex-wrap gap-1.5">
                      {createdPages.map((slug) => (
                        <Link
                          key={slug}
                          href={`/wiki/${slug}`}
                          className="focus-ring rounded-sm"
                        >
                          <Tag tone="accent" size="base">{slug}</Tag>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2">
                  {isFailed && (
                    <Button intent="primary" size="sm" onClick={handleRetry} loading={retrying} disabled={retrying}>
                      {checkpointProgress
                        ? `重试（从断点继续${checkpointProgress.totalPages ? `：${checkpointProgress.writerPages}/${checkpointProgress.totalPages} 页` : ''}）`
                        : '重试'}
                    </Button>
                  )}
                  <Button intent="ghost" size="sm" onClick={reset}>
                    Ingest another source
                  </Button>
                </div>
              </div>
            )}
```

- [ ] **Step 5: 类型检查 + lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: 无新增报错。

- [ ] **Step 6: 手动验证（按钮 + 重连 + 恢复）**

Run: `npm run dev:all`，浏览器打开 dashboard。

1. **失败出现按钮**：临时把 `llm-config.json` 的 API key 改错 → 在面板上传一小段文本 → 等任务失败 → 确认面板出现红色 "Ingest failed" 且有「重试」按钮。
2. **重试重连**：点「重试」→ 确认面板从 failed 切回 "Processing…" 并重新出现事件流（key 仍错会再次失败，此处只验证按钮 + 重连工作）。
3. **跨刷新恢复（需有断点）**：恢复正确的 API key，上传一段能让 planner 成功、但随后人为令 writer 失败的输入（例如把 `agentMaxTokensPerJob` 调到刚好够 plan/摘要但不够全部 writer，使运行期 `BudgetExceededError`）→ 任务失败且已落 plan/部分页检查点 → **刷新页面** → 确认面板自动恢复为失败态且「重试」按钮带 "x/y 页" 标签。
4. **续传省 token**：点「重试」→ 观察事件流出现 `ingest:resuming`，且 writer 仅重跑未完成页（已写页不再产生 `agent:run-started`）。
5. 还原 `llm-config.json` 与设置。

> 续传跳过逻辑的正确性由 Task 3 的 orchestrator 单测保证；本手动步骤验证端到端 UI 接线。

- [ ] **Step 7: 提交**

```bash
git add "src/app/(app)/_components/dashboard-ingest-panel.tsx"
git commit -m "feat: ingest 面板加重试按钮 + 跨刷新恢复最近一次失败 ingest"
```

---

## 收尾验证

- [ ] **全量测试**：`npx vitest run`，Expected：全绿（含新增 checkpoints-repo / checkpoint / orchestrator 续传 / ingest-prep / retry 路由用例，且既有 22 文件无回归）。
- [ ] **构建**：`npm run build`，Expected：成功（next build 顺带全量类型检查）。
- [ ] 在根 `CLAUDE.md` 第九节 Changelog 追加一行（日期 2026-06-20：ingest 断点续传 + 重试，引用本 spec/plan），并视情况更新 `src/server/db/CLAUDE.md`（新表）、`src/server/agents/CLAUDE.md`（checkpoint）、`src/server/services/CLAUDE.md`（续传）。提交：`git commit -m "docs: 记录 ingest 断点续传+重试变更"`。
