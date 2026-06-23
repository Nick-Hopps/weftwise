# 增益流水线 P5 实现计划 — 维护层（成熟度节律 + 事件唤醒）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让页面在 ingest 后不再冻结，而像人类学习一样被周期性回访深化：用「本遍增益新增量」作收敛信号驱动自适应间隔（递减回报 → 自动毕业），事件（新页/源 commit）唤醒相关旧页，调度器在每轮页数上限内入队复用 P4 的 `re-enrich` job。

**Architecture:** 新 `page_maturity` 表（每页一行：passes/interval/next_due/state/priority）+ `maturity-repo`。纯函数 `maintenance-policy.ts` 把「新增量 + 当前态」映射为新间隔/状态（spacing 阶梯 1→3→7→21→60→毕业）。`reenrich-service`（P4）跑完按 callout 增量回写成熟度。`maintenance-scheduler.ts` 选「到期 + 高优先级」页、受每轮页数上限约束、入队 `re-enrich`（只入队不写盘）。worker 轮询循环挂一个低频 sweep tick（持久化上次扫描时间，默认每日）。indexer commit 后按 `wiki_links` 邻居唤醒、并为新页初始化成熟度行。

**Tech Stack:** better-sqlite3 + Drizzle / Vitest / 既有 jobs/worker 基础设施 / P4 的 `re-enrich` 流水线。

## Global Constraints

- **依赖 P4**：本计划要求 `docs/superpowers/plans/2026-06-23-augmentation-p4-reenrich.md` 已完成（`re-enrich` job + `reenrich-service` + `Subject.augmentationLevel`）。
- **维护 sweep 只入队、不直接写盘**：`re-enrich` job 仍走 worker 单任务串行 + `vault-mutex`，sweep tick 不得在轮询回调里跑 LLM/写 git。
- **增量不 churn**：re-enrich 重跑不得翻新整页，否则收敛信号（callout 增量）失真。靠 enricher skill「逐字保留忠实层、只增 callout」约束 + maturity 用 callout 增量度量。
- **成本护栏（已定）**：sweep 层用「每轮页数上限」`maintenanceMaxPagesPerSweep`（默认 5）限流；每个 re-enrich job 的 token 仍由 `agentMaxTokensPerJob` 兜底。**不**做每日 token 预算（首版按 Nick 决策取页数上限）。扫到上限的剩余到期页 `log()` 出来（不静默截断）。
- **P5c（使用加权/阅读 beacon）本计划不做**（按 Nick 决策延后）；维护层不依赖它即可自适应收敛。
- **强 TypeScript / server-only 屏障 / Saga 不绕过**：同 P4。
- **app 代码可用 `new Date()`**（仅 Workflow 脚本禁用，与本计划无关）。
- **测试命令**：`npx vitest run <path>`；类型检查 `npx tsc --noEmit`；`npm run lint` 不可用。
- **生成代码注释/commit message 用中文；禁止 AI 署名 trailer。**

## File Structure

| 文件 | 职责 |
|------|------|
| `src/server/db/schema.ts` | 新增 `pageMaturity` 表定义 |
| `src/server/db/client.ts` | `migratePageMaturity()` + `ensureTables` 调用 |
| `src/lib/contracts.ts` | `MaturityState` / `PageMaturity` 类型 + 维护设置 schema |
| `src/server/db/repos/maturity-repo.ts` | page_maturity CRUD + 选页/邻居唤醒查询（新增） |
| `src/server/services/maintenance-policy.ts` | 间隔/状态纯函数 + callout 计数 + 唤醒（新增、易单测） |
| `src/server/services/maintenance-scheduler.ts` | sweep：选页 → 回调入队，受页数上限约束（新增） |
| `src/server/services/reenrich-service.ts` | （P4 已建）追加：commit 后按增量回写成熟度 |
| `src/server/wiki/indexer.ts` | commit 后初始化成熟度行 + 按 wiki_links 邻居唤醒 |
| `src/server/jobs/worker.ts` | 低频 sweep tick + 上次扫描时间闸门 |
| `src/server/db/repos/settings-repo.ts` | 维护开关/节律/页数上限/上次扫描时间 getter+setter |
| `src/app/api/settings/route.ts` + 设置 UI | 维护设置读写行 |

---

### Task 1: page_maturity 表 + 迁移 + 契约

**Files:**
- Modify: `src/server/db/schema.ts`（`pageMaturity` 表）
- Modify: `src/server/db/client.ts`（`migratePageMaturity()` + 在 `ensureTables` 调用）
- Modify: `src/lib/contracts.ts`（`MaturityState` + `PageMaturity`）
- Test: `src/server/db/repos/__tests__/maturity-repo.test.ts`（在 Task 2 用，先建表）

**Interfaces:**
- Produces:
  - `MaturityState = 'active' | 'dormant' | 'graduated'`
  - `PageMaturity = { subjectId; slug; passes; lastEnrichedAt: string | null; intervalDays; nextDueAt; state: MaturityState; priority; updatedAt }`
  - 表 `page_maturity`，复合 PK `(subject_id, slug)`，FK `subject_id` CASCADE

- [ ] **Step 1: 加契约类型**

`src/lib/contracts.ts`（与其它领域类型同处）新增：

```ts
export type MaturityState = 'active' | 'dormant' | 'graduated';

/** 每页成熟度（维护层 P5）。spacing 阶梯由 maintenance-policy 推进。 */
export interface PageMaturity {
  subjectId: SubjectId;
  slug: string;
  passes: number;
  lastEnrichedAt: string | null;
  intervalDays: number;
  nextDueAt: string;
  state: MaturityState;
  priority: number;
  updatedAt: string;
}
```

- [ ] **Step 2: 加 schema 表**

`src/server/db/schema.ts`（`pageEmbeddings` 之后，镜像其复合 PK + CASCADE 风格）：

```ts
export const pageMaturity = sqliteTable(
  'page_maturity',
  {
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    passes: integer('passes').notNull().default(0),
    lastEnrichedAt: text('last_enriched_at'),
    intervalDays: integer('interval_days').notNull().default(1),
    nextDueAt: text('next_due_at').notNull(),
    state: text('state').notNull().default('active'),
    priority: integer('priority').notNull().default(0),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.subjectId, t.slug] }) })
);
```

- [ ] **Step 3: 加建表迁移**

`src/server/db/client.ts` 新增函数（镜像 `migratePageEmbeddings`）：

```ts
function migratePageMaturity(): void {
  const sqlite = rawSqlite!;
  if (tableExists('page_maturity')) return;
  sqlite.exec(`
    CREATE TABLE page_maturity (
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      passes INTEGER NOT NULL DEFAULT 0,
      last_enriched_at TEXT,
      interval_days INTEGER NOT NULL DEFAULT 1,
      next_due_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      priority INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (subject_id, slug)
    );
  `);
}
```

在 `ensureTables` 的 try 块里、`migratePageEmbeddings();` 之后加：

```ts
    migratePageMaturity();
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 5: 提交**

```bash
git add src/lib/contracts.ts src/server/db/schema.ts src/server/db/client.ts
git commit -m "feat(maturity): 新增 page_maturity 表 + 契约类型"
```

---

### Task 2: maturity-repo

**Files:**
- Create: `src/server/db/repos/maturity-repo.ts`
- Test: `src/server/db/repos/__tests__/maturity-repo.test.ts`

**Interfaces:**
- Produces（全部 raw SQL，镜像 `embeddings-repo.ts` 用 `getRawDb()`）:
  - `get(subjectId, slug): PageMaturity | null`
  - `ensureRow(subjectId, slug, nowIso, initialIntervalDays): void`（INSERT OR IGNORE，新行 `next_due_at = now + interval`）
  - `listDue(nowIso, limit): { subjectId: string; slug: string }[]`（`state != 'graduated' AND next_due_at <= now` ORDER BY `priority DESC, next_due_at ASC`）
  - `applyAfterEnrich(subjectId, slug, next: { passes; intervalDays; state; nextDueAt }, nowIso): void`（回写成熟度 + 重置 priority=0 + last_enriched_at）
  - `bumpNeighbor(subjectId, slug, nowIso): void`（priority+1、`next_due_at = min(next_due_at, now)`、dormant/graduated → active）
  - `pruneOrphans(subjectId, liveSlugs): void`（删孤儿，供索引时清理；可选调用）

- [ ] **Step 1: 写失败测试**

新建 `src/server/db/repos/__tests__/maturity-repo.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import * as subjectsRepo from '../subjects-repo';
import * as maturityRepo from '../maturity-repo';

let subjectId: string;

beforeEach(() => {
  process.env.DATABASE_PATH = `/private/tmp/claude-test-${randomUUID()}.db`;
  subjectId = subjectsRepo.create({ slug: `s-${randomUUID().slice(0, 8)}`, name: 'S' }).id;
});

const ISO = (d: Date) => d.toISOString();
const days = (n: number) => new Date(Date.now() + n * 86_400_000);

describe('maturity-repo', () => {
  it('ensureRow 新建后 get 可读、再 ensureRow 不覆盖', () => {
    const now = ISO(new Date());
    maturityRepo.ensureRow(subjectId, 'p', now, 1);
    const a = maturityRepo.get(subjectId, 'p');
    expect(a?.state).toBe('active');
    expect(a?.intervalDays).toBe(1);
    // 改动后再 ensureRow 不应回退
    maturityRepo.applyAfterEnrich(subjectId, 'p', { passes: 1, intervalDays: 7, state: 'active', nextDueAt: ISO(days(7)) }, now);
    maturityRepo.ensureRow(subjectId, 'p', now, 1);
    expect(maturityRepo.get(subjectId, 'p')?.intervalDays).toBe(7);
  });

  it('listDue 只返回到期且未毕业，按 priority 优先', () => {
    const now = new Date();
    // 用 days(-5) + interval 1 → next_due ≈ days(-4)，明确早于 now（避免 days(-1)+1≈now 的边界竞态）
    maturityRepo.ensureRow(subjectId, 'due-low', ISO(days(-5)), 1); // 已到期，priority 0
    maturityRepo.ensureRow(subjectId, 'due-high', ISO(days(-5)), 1);
    maturityRepo.bumpNeighbor(subjectId, 'due-high', ISO(now)); // priority +1
    maturityRepo.ensureRow(subjectId, 'future', ISO(now), 30);   // 未到期（next_due = now+30d）
    maturityRepo.ensureRow(subjectId, 'grad', ISO(days(-5)), 1);
    maturityRepo.applyAfterEnrich(subjectId, 'grad', { passes: 3, intervalDays: 0, state: 'graduated', nextDueAt: ISO(days(3650)) }, ISO(now));

    const due = maturityRepo.listDue(ISO(now), 10);
    const slugs = due.map((d) => d.slug);
    expect(slugs).toContain('due-low');
    expect(slugs).toContain('due-high');
    expect(slugs).not.toContain('future');
    expect(slugs).not.toContain('grad');
    expect(slugs[0]).toBe('due-high'); // 高 priority 排前
  });

  it('bumpNeighbor 复活 dormant 并提前到期', () => {
    const now = new Date();
    maturityRepo.ensureRow(subjectId, 'd', ISO(days(30)), 21);
    maturityRepo.applyAfterEnrich(subjectId, 'd', { passes: 5, intervalDays: 60, state: 'dormant', nextDueAt: ISO(days(60)) }, ISO(now));
    maturityRepo.bumpNeighbor(subjectId, 'd', ISO(now));
    const row = maturityRepo.get(subjectId, 'd');
    expect(row?.state).toBe('active');
    expect(new Date(row!.nextDueAt).getTime()).toBeLessThanOrEqual(now.getTime());
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/maturity-repo.test.ts`
Expected: FAIL（`maturity-repo` 不存在）。

- [ ] **Step 3: 实现 maturity-repo**

新建 `src/server/db/repos/maturity-repo.ts`：

```ts
import { getRawDb } from '../client';
import type { PageMaturity, MaturityState } from '@/lib/contracts';

interface RawRow {
  subject_id: string;
  slug: string;
  passes: number;
  last_enriched_at: string | null;
  interval_days: number;
  next_due_at: string;
  state: string;
  priority: number;
  updated_at: string;
}

function toDomain(r: RawRow): PageMaturity {
  return {
    subjectId: r.subject_id,
    slug: r.slug,
    passes: r.passes,
    lastEnrichedAt: r.last_enriched_at,
    intervalDays: r.interval_days,
    nextDueAt: r.next_due_at,
    state: r.state as MaturityState,
    priority: r.priority,
    updatedAt: r.updated_at,
  };
}

export function get(subjectId: string, slug: string): PageMaturity | null {
  const row = getRawDb()
    .prepare(`SELECT * FROM page_maturity WHERE subject_id = ? AND slug = ?`)
    .get(subjectId, slug) as RawRow | undefined;
  return row ? toDomain(row) : null;
}

/** 新页入场：不存在则建行（active，next_due = now + initialIntervalDays）；已存在不动。 */
export function ensureRow(
  subjectId: string,
  slug: string,
  nowIso: string,
  initialIntervalDays: number,
): void {
  const nextDue = new Date(new Date(nowIso).getTime() + initialIntervalDays * 86_400_000).toISOString();
  getRawDb()
    .prepare(
      `INSERT INTO page_maturity
         (subject_id, slug, passes, last_enriched_at, interval_days, next_due_at, state, priority, updated_at)
       VALUES (?, ?, 0, NULL, ?, ?, 'active', 0, ?)
       ON CONFLICT(subject_id, slug) DO NOTHING`,
    )
    .run(subjectId, slug, initialIntervalDays, nextDue, nowIso);
}

export function listDue(nowIso: string, limit: number): { subjectId: string; slug: string }[] {
  const rows = getRawDb()
    .prepare(
      `SELECT subject_id, slug FROM page_maturity
       WHERE state != 'graduated' AND next_due_at <= ?
       ORDER BY priority DESC, next_due_at ASC
       LIMIT ?`,
    )
    .all(nowIso, limit) as Array<{ subject_id: string; slug: string }>;
  return rows.map((r) => ({ subjectId: r.subject_id, slug: r.slug }));
}

/** re-enrich 跑完回写：推进 passes/interval/state/next_due，重置 priority、记 last_enriched_at。 */
export function applyAfterEnrich(
  subjectId: string,
  slug: string,
  next: { passes: number; intervalDays: number; state: MaturityState; nextDueAt: string },
  nowIso: string,
): void {
  getRawDb()
    .prepare(
      `INSERT INTO page_maturity
         (subject_id, slug, passes, last_enriched_at, interval_days, next_due_at, state, priority, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(subject_id, slug) DO UPDATE SET
         passes = excluded.passes,
         last_enriched_at = excluded.last_enriched_at,
         interval_days = excluded.interval_days,
         next_due_at = excluded.next_due_at,
         state = excluded.state,
         priority = 0,
         updated_at = excluded.updated_at`,
    )
    .run(subjectId, slug, next.passes, nowIso, next.intervalDays, next.nextDueAt, next.state, nowIso);
}

/** 事件唤醒：邻居 priority+1、提前到期、复活 dormant/graduated。仅作用于已有行。 */
export function bumpNeighbor(subjectId: string, slug: string, nowIso: string): void {
  getRawDb()
    .prepare(
      `UPDATE page_maturity SET
         priority = priority + 1,
         next_due_at = MIN(next_due_at, ?),
         state = CASE WHEN state = 'active' THEN 'active' ELSE 'active' END,
         updated_at = ?
       WHERE subject_id = ? AND slug = ?`,
    )
    .run(nowIso, nowIso, subjectId, slug);
}

export function pruneOrphans(subjectId: string, liveSlugs: string[]): void {
  const db = getRawDb();
  const all = db
    .prepare(`SELECT slug FROM page_maturity WHERE subject_id = ?`)
    .all(subjectId) as { slug: string }[];
  const live = new Set(liveSlugs);
  const del = db.prepare(`DELETE FROM page_maturity WHERE subject_id = ? AND slug = ?`);
  for (const { slug } of all) if (!live.has(slug)) del.run(subjectId, slug);
}
```

> `bumpNeighbor` 的 `state` CASE 写成恒等 `'active'`：任何状态（active/dormant/graduated）唤醒后都置 active（复活休眠/已毕业页以整合新知识）。`MIN(next_due_at, ?)` 把到期时间拉到不晚于 now。

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/server/db/repos/__tests__/maturity-repo.test.ts`
Expected: PASS（3 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/server/db/repos/maturity-repo.ts src/server/db/repos/__tests__/maturity-repo.test.ts
git commit -m "feat(maturity): maturity-repo（ensureRow/listDue/applyAfterEnrich/bumpNeighbor）"
```

---

### Task 3: maintenance-policy（纯函数：递减回报 → 间隔/毕业）

**Files:**
- Create: `src/server/services/maintenance-policy.ts`
- Test: `src/server/services/__tests__/maintenance-policy.test.ts`

**Interfaces:**
- Produces:
  - `SPACING_LADDER = [1, 3, 7, 21, 60]`（天）
  - `countCallouts(md: string): number`
  - `nextMaturity(input: { state; passes; intervalDays; newIncrement }): { passes; intervalDays; state; nextDueAt }`（接 `now: Date` 算 nextDueAt；毕业 → 远期 sentinel）
  - `wakeMaturity(): { state: 'active'; intervalDays: number }`（供 repo bump 之外的纯函数复用，可选）

- [ ] **Step 1: 写失败测试**

新建 `src/server/services/__tests__/maintenance-policy.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { countCallouts, nextMaturity, SPACING_LADDER } from '../maintenance-policy';

const NOW = new Date('2026-06-23T00:00:00.000Z');

describe('countCallouts', () => {
  it('计数六类 callout 首行，普通 blockquote 不计', () => {
    const md = [
      '> [!intuition] 💡 直觉',
      '> body',
      '',
      '> just a quote',
      '',
      '> [!example] 📝 例题',
    ].join('\n');
    expect(countCallouts(md)).toBe(2);
  });
});

describe('nextMaturity 递减回报', () => {
  it('零增量 + 已多遍 → 毕业（间隔置 0、状态 graduated）', () => {
    const r = nextMaturity({ state: 'active', passes: 3, intervalDays: 7, newIncrement: 0 }, NOW);
    expect(r.state).toBe('graduated');
    expect(r.intervalDays).toBe(0);
    expect(new Date(r.nextDueAt).getTime()).toBeGreaterThan(NOW.getTime() + 365 * 86_400_000); // 远期
  });

  it('零增量 + 遍数少 → 间隔快涨（阶梯 +2）不毕业', () => {
    const r = nextMaturity({ state: 'active', passes: 0, intervalDays: 1, newIncrement: 0 }, NOW);
    expect(r.state).toBe('active');
    expect(r.intervalDays).toBe(SPACING_LADDER[2]); // 1 → +2 档 → 7
  });

  it('大量新增量 → 间隔慢涨（停在当前档，页还在长身体）', () => {
    const r = nextMaturity({ state: 'active', passes: 1, intervalDays: 3, newIncrement: 5 }, NOW);
    expect(r.intervalDays).toBe(3); // 不前进
    expect(r.passes).toBe(2);
  });

  it('少量新增量 → 阶梯 +1', () => {
    const r = nextMaturity({ state: 'active', passes: 1, intervalDays: 3, newIncrement: 1 }, NOW);
    expect(r.intervalDays).toBe(SPACING_LADDER[2]); // 3 → 7
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/services/__tests__/maintenance-policy.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 maintenance-policy**

新建 `src/server/services/maintenance-policy.ts`：

```ts
/**
 * 维护层策略（纯函数，易单测）。
 *
 * 用「本遍 enricher 新增 callout 数」作收敛信号替代回忆测试（§15.2）：
 *   - 大量新增（页还在长身体）→ 间隔停在当前档，慢涨；
 *   - 少量新增 → 阶梯 +1；
 *   - 零新增（saturation）→ 阶梯 +2；若已跑过 GRADUATE_AFTER_PASSES 遍 → 毕业转休眠。
 */
import type { MaturityState } from '@/lib/contracts';

export const SPACING_LADDER = [1, 3, 7, 21, 60]; // 天
const SUBSTANTIAL_INCREMENT = 3; // ≥ 视为「页还在长身体」
const GRADUATE_AFTER_PASSES = 3; // 至少跑过这么多遍才允许零增量毕业
const GRADUATED_SENTINEL_DAYS = 3650; // 毕业页 next_due 推到远期（listDue 也按 state 排除）

const CALLOUT_RE = /^>\s*\[!(intuition|example|quiz|background|diagram|pitfall)\]/gm;

export function countCallouts(md: string): number {
  const m = md.match(CALLOUT_RE);
  return m ? m.length : 0;
}

function ladderIndex(intervalDays: number): number {
  let idx = 0;
  for (let i = 0; i < SPACING_LADDER.length; i++) {
    if (SPACING_LADDER[i] <= intervalDays) idx = i;
  }
  return idx;
}

function addDays(now: Date, days: number): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

export interface MaturityInput {
  state: MaturityState;
  passes: number;
  intervalDays: number;
  newIncrement: number;
}

export interface MaturityNext {
  passes: number;
  intervalDays: number;
  state: MaturityState;
  nextDueAt: string;
}

export function nextMaturity(input: MaturityInput, now: Date): MaturityNext {
  const passes = input.passes + 1;
  const idx = ladderIndex(input.intervalDays);

  // 零增量 = saturation
  if (input.newIncrement <= 0) {
    if (passes >= GRADUATE_AFTER_PASSES) {
      return {
        passes,
        intervalDays: 0,
        state: 'graduated',
        nextDueAt: addDays(now, GRADUATED_SENTINEL_DAYS),
      };
    }
    const ni = Math.min(SPACING_LADDER.length - 1, idx + 2);
    return { passes, intervalDays: SPACING_LADDER[ni], state: 'active', nextDueAt: addDays(now, SPACING_LADDER[ni]) };
  }

  // 大量新增 → 停在当前档（慢涨）；少量 → +1 档
  const step = input.newIncrement >= SUBSTANTIAL_INCREMENT ? 0 : 1;
  const ni = Math.min(SPACING_LADDER.length - 1, idx + step);
  return { passes, intervalDays: SPACING_LADDER[ni], state: 'active', nextDueAt: addDays(now, SPACING_LADDER[ni]) };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/server/services/__tests__/maintenance-policy.test.ts`
Expected: PASS（5 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/server/services/maintenance-policy.ts src/server/services/__tests__/maintenance-policy.test.ts
git commit -m "feat(maintenance): maintenance-policy 纯函数（递减回报→间隔/毕业 + callout 计数）"
```

---

### Task 4: reenrich-service 回写成熟度（增量信号）

re-enrich 跑完，按 callout 增量推进 page_maturity。

**Files:**
- Modify: `src/server/services/reenrich-service.ts`（commit 后计算增量 → policy → repo）
- Test: `src/server/services/__tests__/reenrich-maturity.test.ts`（测增量推导纯逻辑）

**Interfaces:**
- Consumes: `countCallouts`、`nextMaturity`（Task 3）、`maturityRepo.get` / `applyAfterEnrich`（Task 2）
- Produces: 导出纯函数 `deriveMaturityUpdate(opts: { draftContent; finalContent; current: PageMaturity | null; now: Date }): MaturityNext`

- [ ] **Step 1: 写失败测试 — deriveMaturityUpdate**

新建 `src/server/services/__tests__/reenrich-maturity.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { deriveMaturityUpdate } from '../reenrich-service';

const NOW = new Date('2026-06-23T00:00:00.000Z');
const draft = '# T\nprose';
const enriched = '# T\nprose\n\n> [!intuition] 💡\n> a\n\n> [!example] 📝\n> b';

describe('deriveMaturityUpdate', () => {
  it('首遍（current 为 null）按新增 callout 数推进', () => {
    const r = deriveMaturityUpdate({ draftContent: draft, finalContent: enriched, current: null, now: NOW });
    // 新增 2 callout（< 3）→ 阶梯从默认 1 起 +1 = 3
    expect(r.intervalDays).toBe(3);
    expect(r.passes).toBe(1);
    expect(r.state).toBe('active');
  });

  it('零新增 + 已 3 遍 → 毕业', () => {
    const r = deriveMaturityUpdate({
      draftContent: enriched,
      finalContent: enriched, // 无新增
      current: { subjectId: 's', slug: 'p', passes: 3, lastEnrichedAt: null, intervalDays: 7, nextDueAt: NOW.toISOString(), state: 'active', priority: 0, updatedAt: NOW.toISOString() },
      now: NOW,
    });
    expect(r.state).toBe('graduated');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/services/__tests__/reenrich-maturity.test.ts`
Expected: FAIL（`deriveMaturityUpdate` 未导出）。

- [ ] **Step 3: 实现 deriveMaturityUpdate + 接入 handler**

`src/server/services/reenrich-service.ts` 顶部 import 加：

```ts
import type { PageMaturity } from '@/lib/contracts';
import * as maturityRepo from '../db/repos/maturity-repo';
import { countCallouts, nextMaturity, type MaturityNext } from './maintenance-policy';
```

新增导出纯函数（放在 `buildReenrichInitialInput` 旁）：

```ts
/** 用「新增 callout 数」作收敛信号，结合当前成熟度推导下一态。 */
export function deriveMaturityUpdate(opts: {
  draftContent: string;
  finalContent: string;
  current: PageMaturity | null;
  now: Date;
}): MaturityNext {
  const newIncrement = Math.max(0, countCallouts(opts.finalContent) - countCallouts(opts.draftContent));
  return nextMaturity(
    {
      state: opts.current?.state ?? 'active',
      passes: opts.current?.passes ?? 0,
      intervalDays: opts.current?.intervalDays ?? 1,
      newIncrement,
    },
    opts.now,
  );
}
```

在 handler 里，`commitPending` 之后、`checkpoint.clear()` 之前插入成熟度回写：

```ts
  const result = await commitPending(ctx, []);

  // 维护层：用本遍 callout 增量推进成熟度（draft = 旧正文，final = 提交版正文）。
  const path = `wiki/${subject.slug}/${slug}.md`;
  const finalContent = ctx.pending.entries.find((e) => e.path === path)?.content ?? existing.markdown;
  const now = new Date();
  const next = deriveMaturityUpdate({
    draftContent: existing.markdown,
    finalContent,
    current: maturityRepo.get(subject.id, slug),
    now,
  });
  maturityRepo.applyAfterEnrich(subject.id, slug, next, now.toISOString());
  emit('reenrich:maturity', `Maturity → ${next.state}, next in ${next.intervalDays}d`, {
    slug,
    passes: next.passes,
    state: next.state,
    intervalDays: next.intervalDays,
  });

  checkpoint.clear();
  return result as unknown as Record<string, unknown>;
```

- [ ] **Step 4: 运行测试，确认通过 + 类型检查**

Run: `npx vitest run src/server/services/__tests__/reenrich-maturity.test.ts`
Expected: PASS（2 用例）。
Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 5: 提交**

```bash
git add src/server/services/reenrich-service.ts src/server/services/__tests__/reenrich-maturity.test.ts
git commit -m "feat(maintenance): re-enrich 跑完按 callout 增量回写 page_maturity"
```

---

### Task 5: indexer 事件唤醒 + 新页成熟度初始化（P5b）

commit 后：为本批页建成熟度行；按 wiki_links 邻居唤醒相关旧页。

**Files:**
- Modify: `src/server/wiki/indexer.ts:79-125`（pass 2 后加钩子）
- Test: `src/server/wiki/__tests__/indexer-wakeup.test.ts`（测邻居收集纯函数）

**Interfaces:**
- Consumes: `maturityRepo.ensureRow` / `bumpNeighbor`（Task 2）、`wiki_links` 查询
- Produces: 导出纯函数 `collectNeighborSlugs(subjectId, slug): { subjectId; slug }[]`（聚合该页的 backlink + 出链邻居，去重、排除自身与 meta）

- [ ] **Step 1: 写失败测试 — collectNeighborSlugs**

新建 `src/server/wiki/__tests__/indexer-wakeup.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { collectNeighborSlugs } from '../indexer';

let subjectId: string;
beforeEach(() => {
  process.env.DATABASE_PATH = `/private/tmp/claude-test-${randomUUID()}.db`;
  subjectId = subjectsRepo.create({ slug: `s-${randomUUID().slice(0, 8)}`, name: 'S' }).id;
});

describe('collectNeighborSlugs', () => {
  it('聚合 A 的 backlink 源与出链目标，去重且排除自身', () => {
    // 直接写 wiki_links：B → A（A 的 backlink），A → C（A 的出链）
    pagesRepo.setLinksForPage(subjectId, 'b', [{ targetSubjectId: subjectId, targetSlug: 'a', context: '[[A]]' }]);
    pagesRepo.setLinksForPage(subjectId, 'a', [{ targetSubjectId: subjectId, targetSlug: 'c', context: '[[C]]' }]);

    const n = collectNeighborSlugs(subjectId, 'a').map((x) => x.slug).sort();
    expect(n).toEqual(['b', 'c']);
    expect(n).not.toContain('a');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/wiki/__tests__/indexer-wakeup.test.ts`
Expected: FAIL（`collectNeighborSlugs` 未导出）。

- [ ] **Step 3: 实现 collectNeighborSlugs + 接入 indexer**

`src/server/wiki/indexer.ts` 顶部 import 加：

```ts
import { getRawDb } from '../db/client';
import * as maturityRepo from '../db/repos/maturity-repo';
```

新增导出纯函数：

```ts
/** 收集与 slug 相邻的页（本 subject 内 backlink 源 ∪ 出链目标），去重、排除自身。 */
export function collectNeighborSlugs(subjectId: SubjectId, slug: string): { subjectId: SubjectId; slug: string }[] {
  const db = getRawDb();
  const backlinkSources = db
    .prepare(`SELECT DISTINCT source_slug AS s FROM wiki_links WHERE target_subject_id = ? AND target_slug = ?`)
    .all(subjectId, slug) as Array<{ s: string }>;
  const outgoing = db
    .prepare(`SELECT DISTINCT target_slug AS s FROM wiki_links WHERE subject_id = ? AND source_slug = ? AND target_subject_id = ?`)
    .all(subjectId, slug, subjectId) as Array<{ s: string }>;
  const seen = new Set<string>();
  const out: { subjectId: SubjectId; slug: string }[] = [];
  for (const r of [...backlinkSources, ...outgoing]) {
    if (r.s === slug || seen.has(r.s)) continue;
    seen.add(r.s);
    out.push({ subjectId, slug: r.s });
  }
  return out;
}
```

在 `indexTouchedPages` 末尾（pass 2 的 `for` 之后、函数 return 之前）加初始化 + 唤醒钩子：

```ts
  // P5 维护层：为本批页建成熟度行 + 按 wiki_links 邻居唤醒相关旧页（整合新知识）。
  const MAINTENANCE_INITIAL_INTERVAL_DAYS = 1;
  const now = new Date().toISOString();
  for (const slug of presentSlugs) {
    maturityRepo.ensureRow(subjectId, slug, now, MAINTENANCE_INITIAL_INTERVAL_DAYS);
    for (const nb of collectNeighborSlugs(subjectId, slug)) {
      maturityRepo.bumpNeighbor(nb.subjectId, nb.slug, now);
    }
  }
```

> `bumpNeighbor` 只作用于已有成熟度行（UPDATE）；尚无行的邻居会在它自己被索引时经 `ensureRow` 入场，不漏。

- [ ] **Step 4: 运行测试，确认通过 + 回归索引相关测试**

Run: `npx vitest run src/server/wiki/__tests__/indexer-wakeup.test.ts`
Expected: PASS（1 用例）。
Run: `npx vitest run src/server/wiki`
Expected: 既有 wiki 测试不回归。
Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 5: 提交**

```bash
git add src/server/wiki/indexer.ts src/server/wiki/__tests__/indexer-wakeup.test.ts
git commit -m "feat(maintenance): indexer commit 后初始化成熟度 + wiki_links 邻居唤醒"
```

---

### Task 6: maintenance-scheduler（选页 → 入队，受页数上限约束）

**Files:**
- Create: `src/server/services/maintenance-scheduler.ts`
- Test: `src/server/services/__tests__/maintenance-scheduler.test.ts`

**Interfaces:**
- Consumes: `maturityRepo.listDue`（Task 2）
- Produces: `runMaintenanceSweep(opts: { now: Date; maxPages: number; enqueue: (slug: string, subjectId: string) => void; log: (msg: string) => void }): number`（返回入队页数；超上限的剩余到期页 `log` 出来）

- [ ] **Step 1: 写失败测试**

新建 `src/server/services/__tests__/maintenance-scheduler.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import * as maturityRepo from '@/server/db/repos/maturity-repo';
import { runMaintenanceSweep } from '../maintenance-scheduler';

let subjectId: string;
beforeEach(() => {
  process.env.DATABASE_PATH = `/private/tmp/claude-test-${randomUUID()}.db`;
  subjectId = subjectsRepo.create({ slug: `s-${randomUUID().slice(0, 8)}`, name: 'S' }).id;
});

describe('runMaintenanceSweep', () => {
  it('入队到期页，受 maxPages 上限约束，超出部分 log', () => {
    const now = new Date();
    const past = new Date(now.getTime() - 86_400_000).toISOString();
    for (const s of ['a', 'b', 'c']) maturityRepo.ensureRow(subjectId, s, past, 1);

    const enqueue = vi.fn();
    const log = vi.fn();
    const n = runMaintenanceSweep({ now, maxPages: 2, enqueue, log });

    expect(n).toBe(2);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalled(); // 第 3 页被推迟 → log
  });

  it('无到期页 → 不入队、返回 0', () => {
    const enqueue = vi.fn();
    const n = runMaintenanceSweep({ now: new Date(), maxPages: 5, enqueue, log: vi.fn() });
    expect(n).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/services/__tests__/maintenance-scheduler.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 maintenance-scheduler**

新建 `src/server/services/maintenance-scheduler.ts`：

```ts
/**
 * 维护调度：选「到期 + 高优先级」页，在每轮页数上限内回调入队 re-enrich。
 * 只选页 + 回调入队，不直接写盘（写由 re-enrich job 在 worker 串行执行）。
 */
import * as maturityRepo from '../db/repos/maturity-repo';

export function runMaintenanceSweep(opts: {
  now: Date;
  maxPages: number;
  enqueue: (slug: string, subjectId: string) => void;
  log: (msg: string) => void;
}): number {
  const nowIso = opts.now.toISOString();
  // 多取一个以判断是否还有剩余到期页（用于 log 截断量）。
  const due = maturityRepo.listDue(nowIso, opts.maxPages + 1);
  const selected = due.slice(0, opts.maxPages);
  for (const d of selected) opts.enqueue(d.slug, d.subjectId);
  if (due.length > opts.maxPages) {
    opts.log(
      `maintenance sweep: enqueued ${selected.length} (cap ${opts.maxPages}); more due pages deferred to next sweep`,
    );
  }
  return selected.length;
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run src/server/services/__tests__/maintenance-scheduler.test.ts`
Expected: PASS（2 用例）。

- [ ] **Step 5: 提交**

```bash
git add src/server/services/maintenance-scheduler.ts src/server/services/__tests__/maintenance-scheduler.test.ts
git commit -m "feat(maintenance): maintenance-scheduler（选到期页、页数上限、回调入队）"
```

---

### Task 7: 维护设置（开关/节律/页数上限/上次扫描时间）

**Files:**
- Modify: `src/lib/contracts.ts`（4 个设置 schema + `AppSettings` 字段）
- Modify: `src/server/db/repos/settings-repo.ts`（getter/setter）
- Modify: `src/app/api/settings/route.ts`（PUT schema + 写入）
- Test: `src/server/db/repos/__tests__/maintenance-settings.test.ts`

**Interfaces:**
- Produces:
  - `getMaintenanceEnabled(): boolean` / `setMaintenanceEnabled(boolean)`（默认 `false`——维护层默认关闭，避免静默烧 token）
  - `getMaintenanceSweepIntervalHours(): number` / setter（默认 24）
  - `getMaintenanceMaxPagesPerSweep(): number` / setter（默认 5）
  - `getMaintenanceLastSweepAt(): string | null` / `setMaintenanceLastSweepAt(iso)`
  - contracts: `MaintenanceEnabledSchema` / `MaintenanceSweepIntervalHoursSchema`(1..168) / `MaintenanceMaxPagesPerSweepSchema`(1..50)

- [ ] **Step 1: 写失败测试 — settings-repo 维护键**

新建 `src/server/db/repos/__tests__/maintenance-settings.test.ts`：

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import * as settings from '../settings-repo';

beforeEach(() => {
  process.env.DATABASE_PATH = `/private/tmp/claude-test-${randomUUID()}.db`;
});

describe('maintenance settings', () => {
  it('默认值：关、24h、5 页、无上次扫描', () => {
    expect(settings.getMaintenanceEnabled()).toBe(false);
    expect(settings.getMaintenanceSweepIntervalHours()).toBe(24);
    expect(settings.getMaintenanceMaxPagesPerSweep()).toBe(5);
    expect(settings.getMaintenanceLastSweepAt()).toBeNull();
  });
  it('写后可读回', () => {
    settings.setMaintenanceEnabled(true);
    settings.setMaintenanceMaxPagesPerSweep(3);
    const iso = new Date().toISOString();
    settings.setMaintenanceLastSweepAt(iso);
    expect(settings.getMaintenanceEnabled()).toBe(true);
    expect(settings.getMaintenanceMaxPagesPerSweep()).toBe(3);
    expect(settings.getMaintenanceLastSweepAt()).toBe(iso);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/maintenance-settings.test.ts`
Expected: FAIL（getter/setter 未导出）。

- [ ] **Step 3: 加 contracts schema + AppSettings 字段**

`src/lib/contracts.ts` 设置 schema 区加：

```ts
export const DEFAULT_MAINTENANCE_ENABLED = false;
export const DEFAULT_MAINTENANCE_SWEEP_INTERVAL_HOURS = 24;
export const DEFAULT_MAINTENANCE_MAX_PAGES_PER_SWEEP = 5;

export const MaintenanceEnabledSchema = z.boolean();
export const MaintenanceSweepIntervalHoursSchema = z.number().int().min(1).max(168);
export const MaintenanceMaxPagesPerSweepSchema = z.number().int().min(1).max(50);
```

`AppSettings` 接口加：

```ts
  maintenanceEnabled: boolean;
  maintenanceSweepIntervalHours: number;
  maintenanceMaxPagesPerSweep: number;
```

`AppSettingsSchema`（z.object）同步加这三项。

> `maintenanceLastSweepAt` 是运行态内部时间戳，不进 `AppSettings`/`/api/settings`（仅 settings-repo 内部读写）。

- [ ] **Step 4: settings-repo getter/setter**

`src/server/db/repos/settings-repo.ts` 加常量 + 函数（镜像现有 number/enum 模式）：

```ts
const KEY_MAINTENANCE_ENABLED = 'maintenanceEnabled';
const KEY_MAINTENANCE_SWEEP_INTERVAL_HOURS = 'maintenanceSweepIntervalHours';
const KEY_MAINTENANCE_MAX_PAGES_PER_SWEEP = 'maintenanceMaxPagesPerSweep';
const KEY_MAINTENANCE_LAST_SWEEP_AT = 'maintenanceLastSweepAt';

export function getMaintenanceEnabled(): boolean {
  return readKey(KEY_MAINTENANCE_ENABLED) === 'true';
}
export function setMaintenanceEnabled(value: boolean): boolean {
  const v = MaintenanceEnabledSchema.parse(value);
  writeKey(KEY_MAINTENANCE_ENABLED, v ? 'true' : 'false');
  return v;
}

export function getMaintenanceSweepIntervalHours(): number {
  return readNumber(KEY_MAINTENANCE_SWEEP_INTERVAL_HOURS, DEFAULT_MAINTENANCE_SWEEP_INTERVAL_HOURS);
}
export function setMaintenanceSweepIntervalHours(value: number): number {
  const v = MaintenanceSweepIntervalHoursSchema.parse(value);
  writeKey(KEY_MAINTENANCE_SWEEP_INTERVAL_HOURS, String(v));
  return v;
}

export function getMaintenanceMaxPagesPerSweep(): number {
  return readNumber(KEY_MAINTENANCE_MAX_PAGES_PER_SWEEP, DEFAULT_MAINTENANCE_MAX_PAGES_PER_SWEEP);
}
export function setMaintenanceMaxPagesPerSweep(value: number): number {
  const v = MaintenanceMaxPagesPerSweepSchema.parse(value);
  writeKey(KEY_MAINTENANCE_MAX_PAGES_PER_SWEEP, String(v));
  return v;
}

export function getMaintenanceLastSweepAt(): string | null {
  return readKey(KEY_MAINTENANCE_LAST_SWEEP_AT) ?? null;
}
export function setMaintenanceLastSweepAt(iso: string): void {
  writeKey(KEY_MAINTENANCE_LAST_SWEEP_AT, iso);
}
```

import 区加这三个 schema + 三个 DEFAULT（从 `@/lib/contracts`）。`readNumber`/`readKey`/`writeKey` 为该文件现有私有 helper。

把这三项纳入 `readSettings()` 返回对象（与 `route.ts` 的 GET 一致）：在该函数（settings-repo 或 route 内）补 `maintenanceEnabled/maintenanceSweepIntervalHours/maintenanceMaxPagesPerSweep`。

- [ ] **Step 5: /api/settings PUT 支持写入**

`src/app/api/settings/route.ts` 的 `PutBodySchema` 加：

```ts
  maintenanceEnabled: MaintenanceEnabledSchema.optional(),
  maintenanceSweepIntervalHours: MaintenanceSweepIntervalHoursSchema.optional(),
  maintenanceMaxPagesPerSweep: MaintenanceMaxPagesPerSweepSchema.optional(),
```

PUT 处理体加：

```ts
  if (d.maintenanceEnabled !== undefined) setMaintenanceEnabled(d.maintenanceEnabled);
  if (d.maintenanceSweepIntervalHours !== undefined) setMaintenanceSweepIntervalHours(d.maintenanceSweepIntervalHours);
  if (d.maintenanceMaxPagesPerSweep !== undefined) setMaintenanceMaxPagesPerSweep(d.maintenanceMaxPagesPerSweep);
```

（import 对应 schema 与 setter；`readSettings()` 已含三新字段供 GET 返回。）

- [ ] **Step 6: 运行测试，确认通过 + 类型检查**

Run: `npx vitest run src/server/db/repos/__tests__/maintenance-settings.test.ts`
Expected: PASS（2 用例）。
Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 7: 提交**

```bash
git add src/lib/contracts.ts src/server/db/repos/settings-repo.ts src/app/api/settings/route.ts src/server/db/repos/__tests__/maintenance-settings.test.ts
git commit -m "feat(maintenance): 维护设置（开关/节律/页数上限/上次扫描）落 app_settings"
```

---

### Task 8: worker 低频 sweep tick

worker 轮询循环挂一个独立低频定时器：到节律即跑 sweep（只入队 re-enrich）。

**Files:**
- Modify: `src/server/jobs/worker.ts`（`startWorker` 加第二个 interval + cleanup 清理）
- Test: `src/server/jobs/__tests__/maintenance-tick.test.ts`（测节律闸门纯函数）

**Interfaces:**
- Consumes: `runMaintenanceSweep`（Task 6）、维护设置 getter/setter（Task 7）、`queue.enqueue`
- Produces: 导出纯函数 `shouldSweep(lastSweepAt: string | null, intervalHours: number, now: Date): boolean`

- [ ] **Step 1: 写失败测试 — shouldSweep 节律闸门**

新建 `src/server/jobs/__tests__/maintenance-tick.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { shouldSweep } from '../worker';

const NOW = new Date('2026-06-23T12:00:00.000Z');

describe('shouldSweep', () => {
  it('从未扫描 → 应扫', () => {
    expect(shouldSweep(null, 24, NOW)).toBe(true);
  });
  it('距上次不足节律 → 不扫', () => {
    const last = new Date(NOW.getTime() - 3 * 3600_000).toISOString(); // 3h 前
    expect(shouldSweep(last, 24, NOW)).toBe(false);
  });
  it('距上次超过节律 → 应扫', () => {
    const last = new Date(NOW.getTime() - 25 * 3600_000).toISOString(); // 25h 前
    expect(shouldSweep(last, 24, NOW)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run src/server/jobs/__tests__/maintenance-tick.test.ts`
Expected: FAIL（`shouldSweep` 未导出）。

- [ ] **Step 3: 实现 shouldSweep + sweep tick**

`src/server/jobs/worker.ts` 顶部 import 加：

```ts
import * as queue from './queue';
import { runMaintenanceSweep } from '../services/maintenance-scheduler';
import {
  getMaintenanceEnabled,
  getMaintenanceSweepIntervalHours,
  getMaintenanceMaxPagesPerSweep,
  getMaintenanceLastSweepAt,
  setMaintenanceLastSweepAt,
} from '../db/repos/settings-repo';
```

新增导出纯函数（文件级）：

```ts
/** 维护节律闸门：从未扫描或距上次 ≥ intervalHours 则应扫。 */
export function shouldSweep(lastSweepAt: string | null, intervalHours: number, now: Date): boolean {
  if (!lastSweepAt) return true;
  return now.getTime() - new Date(lastSweepAt).getTime() >= intervalHours * 3600_000;
}
```

新增 sweep 执行函数（不并发跑 LLM——只 enqueue）：

```ts
const MAINTENANCE_TICK_MS = 60_000; // 每分钟检查一次节律闸门（实际扫描受 intervalHours 控制）

function maintenanceTick(): void {
  if (!getMaintenanceEnabled()) return;
  const now = new Date();
  if (!shouldSweep(getMaintenanceLastSweepAt(), getMaintenanceSweepIntervalHours(), now)) return;
  // 先占位 lastSweepAt 防重入（tick 间隔远小于节律）
  setMaintenanceLastSweepAt(now.toISOString());
  const enqueued = runMaintenanceSweep({
    now,
    maxPages: getMaintenanceMaxPagesPerSweep(),
    enqueue: (slug, subjectId) => {
      queue.enqueue('re-enrich', { slug, subjectId }, subjectId);
    },
    log: (msg) => {
      // 复用现有日志门面；若 worker 已有 logger 用之，否则 console。
      console.log(`[maintenance] ${msg}`);
    },
  });
  if (enqueued > 0) console.log(`[maintenance] swept: enqueued ${enqueued} re-enrich job(s)`);
}
```

在 `startWorker` 内、主 `setInterval`（L61）旁加第二个低频定时器，并在 `cleanup` 同时清理：

```ts
export function startWorker(pollIntervalMs = 2000): () => void {
  const intervalId = setInterval(async () => {
    // …（现有主轮询体不变）…
  }, pollIntervalMs);

  // 维护层低频 tick：到节律即选页入队 re-enrich（不在此跑 LLM/写盘）。
  const maintenanceId = setInterval(() => {
    try {
      maintenanceTick();
    } catch (err) {
      console.error('[maintenance] sweep tick failed', err);
    }
  }, MAINTENANCE_TICK_MS);

  const cleanup = () => {
    clearInterval(intervalId);
    clearInterval(maintenanceId);
    cleanupFn = null;
  };

  cleanupFn = cleanup;
  return cleanup;
}
```

> 入队的 `re-enrich` job 由主轮询体正常 claim 执行（worker 单任务串行 + `vault-mutex`），与维护 tick 物理隔离——tick 只写 `jobs` 表，不碰 vault。

- [ ] **Step 4: 运行测试，确认通过 + 回归 + 类型检查**

Run: `npx vitest run src/server/jobs/__tests__/maintenance-tick.test.ts`
Expected: PASS（3 用例）。
Run: `npx vitest run src/server/jobs`
Expected: 既有 worker 测试不回归。
Run: `npx tsc --noEmit`
Expected: 无报错。

- [ ] **Step 5: 提交**

```bash
git add src/server/jobs/worker.ts src/server/jobs/__tests__/maintenance-tick.test.ts
git commit -m "feat(maintenance): worker 低频 sweep tick（节律闸门 + 选页入队 re-enrich）"
```

---

### Task 9: 维护设置 UI + 文档收尾

**Files:**
- Modify: `src/components/layout/settings-categories.ts`（加 `'maintenance'` 分区，或并入 `'agents'`）
- Modify: `src/components/layout/settings-content.tsx`（维护面板：开关 + 节律 + 页数上限三行）
- Modify: `CLAUDE.md` / `src/server/db/CLAUDE.md` / `src/server/services/CLAUDE.md`（Changelog + 清单）

**Interfaces:**
- Consumes: `PUT /api/settings`（Task 7）、`AppSettings` 维护字段

- [ ] **Step 1: 加设置分区**

`src/components/layout/settings-categories.ts`：`CategoryId` union 加 `'maintenance'`；`SETTINGS_CATEGORIES` 数组加一项（图标用现成 lucide，如 `RefreshCw`）：

```ts
  { id: 'maintenance', label: 'Maintenance', icon: RefreshCw },
```

（顶部从 `lucide-react` import `RefreshCw`。）

- [ ] **Step 2: 维护面板**

`src/components/layout/settings-content.tsx` 加 `MaintenancePanel`（镜像 `AgentsPanel` 的 `NumberSettingRow`，开关用 `SelectSettingRow` on/off 或现成 toggle 行）：

```tsx
function MaintenancePanel({
  settings,
  savePartial,
}: Pick<SettingsContentProps, 'settings' | 'savePartial'>) {
  return (
    <div className="space-y-4">
      <SelectSettingRow
        label="Periodic maintenance"
        value={settings?.maintenanceEnabled ? 'on' : 'off'}
        options={[
          { value: 'off', label: 'off (default)' },
          { value: 'on', label: 'on — revisit & deepen pages over time' },
        ]}
        onChange={(v) => savePartial.mutate({ maintenanceEnabled: v === 'on' })}
        pending={savePartial.isPending}
      />
      <NumberSettingRow
        label="Sweep interval (hours)"
        value={settings?.maintenanceSweepIntervalHours ?? 24}
        min={1}
        max={168}
        onSave={(v) => savePartial.mutate({ maintenanceSweepIntervalHours: v })}
        pending={savePartial.isPending}
      />
      <NumberSettingRow
        label="Max pages per sweep"
        description="Caps re-enrich jobs enqueued each cycle (cost guardrail)"
        value={settings?.maintenanceMaxPagesPerSweep ?? 5}
        min={1}
        max={50}
        onSave={(v) => savePartial.mutate({ maintenanceMaxPagesPerSweep: v })}
        pending={savePartial.isPending}
      />
    </div>
  );
}
```

在按 `active` category 渲染面板的 switch 里加 `case 'maintenance': return <MaintenancePanel … />`。

- [ ] **Step 3: 类型检查 + 构建**

Run: `npx tsc --noEmit`
Expected: 无报错。
Run: `npx next build`
Expected: 成功。

- [ ] **Step 4: 文档**

根 `CLAUDE.md` Changelog 加：

```
| 2026-06-23 | 增益 P5：维护层（成熟度节律 + 事件唤醒） | 新增 `page_maturity` 表 + `maturity-repo` + 纯函数 `maintenance-policy`（递减回报→间隔/毕业）+ `maintenance-scheduler`（选到期页、每轮页数上限）；`reenrich-service` 跑完按 callout 增量回写成熟度；indexer commit 后初始化成熟度 + wiki_links 邻居唤醒；worker 低频 sweep tick（节律闸门，默认关）+ 维护设置。P5c 使用加权（阅读 beacon）未做。plan 见 docs/superpowers/plans/2026-06-23-augmentation-p5-maintenance.md |
```

`src/server/db/CLAUDE.md` 数据模型表加 `page_maturity` 行；repos 清单加 `maturity-repo`。
`src/server/services/CLAUDE.md` 加 `maintenance-policy` / `maintenance-scheduler`。

- [ ] **Step 5: 全量回归 + 提交**

Run: `npx vitest run`
Expected: 全绿。
Run: `npx tsc --noEmit`
Expected: 无报错。

```bash
git add src/components/layout CLAUDE.md src/server/db/CLAUDE.md src/server/services/CLAUDE.md
git commit -m "feat(maintenance): 维护设置 UI + 文档；P5a/P5b 收尾"
```

---

## 端到端验收（手测）

1. 在设置 → Maintenance 打开开关，把 sweep interval 设 1h、max pages 设 2。
2. 触发若干 ingest，确认新页在 `page_maturity` 有行（`active`，next_due ≈ 次日）。把某页 `next_due_at` 手动改到过去（SQL）模拟到期。
3. 等 sweep tick（≤1min 检查 + 节律满足）→ 观察 `jobs` 表出现 `re-enrich`，worker 执行后页面新增 callout、`page_maturity` 的 `passes/interval/state` 推进。
4. 反复 re-enrich 同页至无新增 callout → 该页 `state` 变 `graduated`、`listDue` 不再选它。
5. 新建一页链接到旧页 → 旧页 `next_due_at` 被提前（邻居唤醒）。

## Self-Review 对照（spec §15 覆盖）

- §15.2 用递减回报替代回忆测试 → Task 3 `nextMaturity`（callout 增量信号）+ Task 4 接入。
- §15.3 三信号 → 优先级队列：成熟度节律(A) = Task 3+8；事件唤醒(B) = Task 5；使用加权(C) = **本计划不做**（Nick 决策延后，已在 Global Constraints 标注）。`listDue` 按 `priority DESC, next_due ASC` 即「到期 + 高优先级」。
- §15.4 `page_maturity` 表（passes/last_enriched/interval/next_due/state/priority）→ Task 1，列全覆盖。
- §15.5 组件：间隔策略纯函数(Task 3)/调度器(Task 6)/re-enrich job(P4 复用 + Task 4 回写)/事件唤醒钩子(Task 5)/增量 enricher(P4 enricher v2)/维护设置(Task 7+9)。使用埋点(C) 延后。
- §15.6 护栏：① 增量不 churn → enricher skill「逐字保留忠实层」约束（P4）+ 用 callout 增量度量；② 维护预算独立 → 每轮页数上限（Task 6/7），与 `agentMaxTokensPerJob` 分离；③ 不与 ingest 抢锁 → sweep tick 只入队，re-enrich 走 worker 串行 + vault-mutex（Task 8 注释明确）。
- §16 P5a→P5b→P5c 顺序：P5a(Task 1-4,6-8) + P5b(Task 5) 落地；P5c 延后。
- 已知限制：维护默认**关闭**（开关默认 false），避免无人值守烧 token；需用户显式开启。⑥ 回滚不撤源、re-enrich 网页源仅 frontmatter 留痕（承自 P4）。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-23-augmentation-p5-maintenance.md`. **前置依赖：P4 计划须先完成**（`re-enrich` job + `reenrich-service` + `Subject.augmentationLevel`）。

两种执行方式：

1. Subagent-Driven (recommended) — 每个 task 派新 subagent，task 间复核。
2. Inline Execution — 本会话内按 executing-plans 批量执行 + 检查点复核。
