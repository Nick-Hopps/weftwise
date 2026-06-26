# 认知画像驱动的读时内容透镜（Cognitive Lens）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每个 vault 主人阅读页面时看到按其「认知画像」（背景 + 表达偏好）实时重塑的版本——只换讲法不换事实、永远可一键看原文，画像随交互信号确定性上升。

**Architecture:** canonical 正文不变（vault/Saga/git/verifier 零侵入）。重塑是纯读侧派生视图，落一张可丢弃的 `page_renditions` 缓存表（按 `canonical_hash × profile_version` 惰性失效）。打开页时客户端**先即时显示 canonical**，再请求 `GET /api/lens/[...slug]` 拿重塑版**后台替换**；「看原文」开关即时切回。画像存独立 `user_profiles` 表（user-keyed，今天单例），经 `POST /api/profile/signals` 的确定性 reducer 微调。

**Tech Stack:** Next.js 15 App Router + React 19 + TypeScript 5；better-sqlite3 + Drizzle ORM；Vercel AI SDK 4（`streamTextResponse`，无 tools）；zod；vitest；TanStack React Query；gray-matter / unified（既有渲染管线）。

## Global Constraints

- **canonical 神圣**：重塑产物**永不写回 vault**、不经 Saga / git / `validateChangeset`，只写 `page_renditions` 缓存表。
- **重塑纯呈现**：禁止新增/篡改事实；不得新增 wikilink 目标；新增类比/示例须包进 `> [!example]` / `> [!note]` callout。
- **不直出 vault 文件**：本特性属"读侧"（同 Ask AI 流式作答），用 `streamTextResponse`；项目「vault 写入必须 `generateObject`」规则不适用且不被触碰。
- **建表走 `ensureTables()`**：新表加在 `src/server/db/client.ts::ensureTables()`（`CREATE TABLE IF NOT EXISTS`），**不依赖** `drizzle-kit migrate`。`npm run db:generate` 仅生成参考迁移。
- **时间戳列存 TEXT ISO-8601**：`text('...').notNull()` + `new Date().toISOString()`，不用 integer。
- **画像走 server 唯一真实源**：`user_profiles` 表 + `/api/profile`，**不镜像进 Zustand**（与 `wikiLanguage` 同规）。
- **前端通信**：仅用 `@/lib/api-fetch` 的 `useApiFetch()`（GET 自动带 `?subjectId`，POST 在 body 显式带 `subjectId`）；禁止裸 `fetch`。
- **路径别名**：`@/*` → `src/*`。
- **TS 严格**：领域类型集中 `src/lib/contracts.ts`；`src/server/**` 不得被客户端组件直接 import。
- **验证命令**：`npx vitest run <file>`（单测）、`npx tsc --noEmit`（类型）。`npm run lint` 不可用，勿用。
- **commit message 用中文**，一句话总结；**禁止** AI 署名 / Co-Authored-By。

## 文件结构图（新增 / 修改）

```
src/server/profile/                      # 新目录：纯函数（无 IO，易 TDD）
├── style.ts                  [新] StylePrefs zod schema + 类型 + DEFAULT + 档位数组 + stepLevel
├── signal-reducer.ts         [新] applySignalsToStyle 纯函数
├── rendition-hash.ts         [新] computeCanonicalHash
└── fidelity.ts               [新] checkLinkSubset（复用 extractWikiLinks）

src/server/db/
├── schema.ts                 [改] +user_profiles / page_renditions / profile_signals
├── client.ts                 [改] ensureTables() +3 张 CREATE TABLE IF NOT EXISTS
└── repos/
    ├── profiles-repo.ts      [新] getProfile / getProfileOrDefault / upsertProfile
    ├── renditions-repo.ts    [新] getRendition / upsertRendition / deleteBySubject
    └── signals-repo.ts       [新] appendSignal / recentSignals

src/server/llm/
├── provider-registry.ts      [改] +isReshapeConfigured()
├── prompts/reshape-prompt.ts [新] RESHAPE_PAGE/SECTION_SYSTEM_PROMPT + build*UserPrompt
└── (llm-config.json / .example.json)  [改] +tasks["reshape:page"] / ["reshape:section"]

src/server/services/
└── reshape-service.ts        [新] reshapePageBody / reshapeSection

src/server/middleware/
└── user.ts                   [新] LOCAL_USER_ID + resolveUserId()

src/app/api/
├── profile/route.ts          [新] GET / PUT
├── profile/signals/route.ts  [新] POST
├── lens/[...slug]/route.ts    [新] GET（JSON，非 SSE）
└── reshape-section/route.ts  [新] POST（Phase B）

src/lib/contracts.ts          [改] +UserProfileDTO / StylePrefs 导出（供前端）
src/hooks/
├── use-profile.ts            [新] React Query 读 + 改画像
└── use-lens.ts               [新] React Query 取重塑版

src/components/wiki/wiki-reading-view.tsx     [改] lens 默认 + 看原文 toggle + 反馈控件
src/components/wiki/lens-feedback.tsx         [新] 太难/太浅 + 段级（Phase B）
src/components/layout/cognitive-lens-onboarding.tsx  [新] 首次 onboarding 向导
src/components/layout/settings-categories.ts  [改] +'cognitive-lens' 分类
src/components/layout/settings-content.tsx    [改] +CognitiveLensPanel
```

> **Next.js 路由约束**：`/api/pages/[...slug]` 是 catch-all，**不能**在其下嵌 `/lens`（会被并入 slug）。故 lens 用独立顶层 `GET /api/lens/[...slug]`；段级用 `POST /api/reshape-section`（slug 进 body），避免与 catch-all 冲突。

> **分期off-ramp**：Task 1–17 = MVP 核心（A 整页重塑 + 画像 + 学习闭环 + onboarding）。Task 18–19 = 段级重塑 B，可在 MVP 验收后再做。Task 20 = 文档。

---

## Phase 0 — 纯函数（无 IO）

### Task 1: StylePrefs 模型

**Files:**
- Create: `src/server/profile/style.ts`
- Test: `src/server/profile/__tests__/style.test.ts`

**Interfaces:**
- Produces: `StylePrefs`（type）、`StylePrefsSchema`（zod）、`DEFAULT_STYLE_PREFS: StylePrefs`、`READING_LEVELS / VERBOSITY_LEVELS / EXAMPLE_DENSITIES / FORMALITIES`（有序数组）、`stepLevel<T extends string>(levels: T[], current: T, delta: number): T`

- [ ] **Step 1: 写失败测试**

```ts
// src/server/profile/__tests__/style.test.ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STYLE_PREFS, StylePrefsSchema, READING_LEVELS, stepLevel,
} from '../style';

describe('style', () => {
  it('DEFAULT_STYLE_PREFS 通过 schema', () => {
    expect(() => StylePrefsSchema.parse(DEFAULT_STYLE_PREFS)).not.toThrow();
    expect(DEFAULT_STYLE_PREFS.readingLevel).toBe('intermediate');
  });

  it('schema 拒绝非法枚举', () => {
    expect(() => StylePrefsSchema.parse({ ...DEFAULT_STYLE_PREFS, readingLevel: 'expert' })).toThrow();
  });

  it('stepLevel 在边界钳制、按 delta 移动', () => {
    expect(stepLevel(READING_LEVELS, 'beginner', -1)).toBe('beginner'); // 下界钳制
    expect(stepLevel(READING_LEVELS, 'beginner', +1)).toBe('intermediate');
    expect(stepLevel(READING_LEVELS, 'advanced', +1)).toBe('advanced');  // 上界钳制
    expect(stepLevel(READING_LEVELS, 'nope' as never, +1)).toBe('nope'); // 未知值原样返回
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/profile/__tests__/style.test.ts`
Expected: FAIL（`Cannot find module '../style'`）

- [ ] **Step 3: 实现**

```ts
// src/server/profile/style.ts
import { z } from 'zod';

export const READING_LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export const VERBOSITY_LEVELS = ['terse', 'balanced', 'thorough'] as const;
export const EXAMPLE_DENSITIES = ['few', 'some', 'many'] as const;
export const FORMALITIES = ['casual', 'neutral', 'formal'] as const;

export const StylePrefsSchema = z.object({
  readingLevel: z.enum(READING_LEVELS),
  verbosity: z.enum(VERBOSITY_LEVELS),
  exampleDensity: z.enum(EXAMPLE_DENSITIES),
  formality: z.enum(FORMALITIES),
});

export type StylePrefs = z.infer<typeof StylePrefsSchema>;

export const DEFAULT_STYLE_PREFS: StylePrefs = {
  readingLevel: 'intermediate',
  verbosity: 'balanced',
  exampleDensity: 'some',
  formality: 'neutral',
};

/** 在有序档位数组内移动 delta 档，越界钳制；未知值原样返回。 */
export function stepLevel<T extends string>(levels: readonly T[], current: T, delta: number): T {
  const i = levels.indexOf(current);
  if (i < 0) return current;
  const next = Math.max(0, Math.min(levels.length - 1, i + delta));
  return levels[next];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/profile/__tests__/style.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: commit**

```bash
git add src/server/profile/style.ts src/server/profile/__tests__/style.test.ts
git commit -m "feat(profile): 新增 StylePrefs 画像偏好模型与档位步进纯函数"
```

---

### Task 2: 信号 → 画像微调 reducer

**Files:**
- Create: `src/server/profile/signal-reducer.ts`
- Test: `src/server/profile/__tests__/signal-reducer.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `StylePrefs / READING_LEVELS / VERBOSITY_LEVELS / EXAMPLE_DENSITIES / stepLevel`
- Produces: `SignalType`（`'too_hard' | 'too_easy' | 'simplify_click' | 'deepen_click' | 'view_original'`）、`ProfileSignal`（`{ type: SignalType }`）、`applySignalsToStyle(prefs: StylePrefs, recent: ProfileSignal[]): { prefs: StylePrefs; changed: boolean }`、`SIGNAL_THRESHOLD = 2`

- [ ] **Step 1: 写失败测试**

```ts
// src/server/profile/__tests__/signal-reducer.test.ts
import { describe, it, expect } from 'vitest';
import { applySignalsToStyle } from '../signal-reducer';
import { DEFAULT_STYLE_PREFS } from '../style';

const sig = (type: string, n: number) => Array.from({ length: n }, () => ({ type } as never));

describe('applySignalsToStyle', () => {
  it('未达阈值不变', () => {
    const r = applySignalsToStyle(DEFAULT_STYLE_PREFS, sig('too_hard', 1));
    expect(r.changed).toBe(false);
    expect(r.prefs).toEqual(DEFAULT_STYLE_PREFS);
  });

  it('净 too_hard 达阈值 → readingLevel 降一档、verbosity/example 上调', () => {
    const r = applySignalsToStyle(DEFAULT_STYLE_PREFS, sig('too_hard', 2));
    expect(r.changed).toBe(true);
    expect(r.prefs.readingLevel).toBe('beginner');
    expect(r.prefs.verbosity).toBe('thorough');
    expect(r.prefs.exampleDensity).toBe('many');
  });

  it('净 too_easy 达阈值 → readingLevel 升一档、verbosity 下调', () => {
    const r = applySignalsToStyle(DEFAULT_STYLE_PREFS, sig('too_easy', 2));
    expect(r.changed).toBe(true);
    expect(r.prefs.readingLevel).toBe('advanced');
    expect(r.prefs.verbosity).toBe('terse');
  });

  it('simplify_click 计入 simpler 方向；正反相消后不足阈值则不变', () => {
    const mixed = [...sig('too_hard', 2), ...sig('too_easy', 1)]; // net=+1 < 2
    expect(applySignalsToStyle(DEFAULT_STYLE_PREFS, mixed).changed).toBe(false);
  });

  it('view_original 不参与微调（仅记录）', () => {
    expect(applySignalsToStyle(DEFAULT_STYLE_PREFS, sig('view_original', 5)).changed).toBe(false);
  });

  it('已在下界仍不变（changed=false）', () => {
    const atFloor = { ...DEFAULT_STYLE_PREFS, readingLevel: 'beginner' as const, verbosity: 'thorough' as const, exampleDensity: 'many' as const };
    expect(applySignalsToStyle(atFloor, sig('too_hard', 2)).changed).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/profile/__tests__/signal-reducer.test.ts`
Expected: FAIL（`Cannot find module '../signal-reducer'`）

- [ ] **Step 3: 实现**

```ts
// src/server/profile/signal-reducer.ts
import {
  StylePrefs, READING_LEVELS, VERBOSITY_LEVELS, EXAMPLE_DENSITIES, stepLevel,
} from './style';

export type SignalType =
  | 'too_hard' | 'too_easy' | 'simplify_click' | 'deepen_click' | 'view_original';

export interface ProfileSignal {
  type: SignalType;
}

export const SIGNAL_THRESHOLD = 2;

/**
 * 把近期信号聚合成对 StylePrefs 的一次有界微调。
 * simpler 方向：too_hard / simplify_click；deeper 方向：too_easy / deepen_click。
 * view_original 仅记录、不参与（可能是怀疑而非难度）。
 * 仅当净方向计数达到 SIGNAL_THRESHOLD 才动一档（防抖）。
 */
export function applySignalsToStyle(
  prefs: StylePrefs,
  recent: ProfileSignal[],
): { prefs: StylePrefs; changed: boolean } {
  let simpler = 0;
  let deeper = 0;
  for (const s of recent) {
    if (s.type === 'too_hard' || s.type === 'simplify_click') simpler++;
    else if (s.type === 'too_easy' || s.type === 'deepen_click') deeper++;
  }
  const net = simpler - deeper;
  if (Math.abs(net) < SIGNAL_THRESHOLD) return { prefs, changed: false };

  const wantsSimpler = net > 0;
  const next: StylePrefs = {
    ...prefs,
    readingLevel: stepLevel(READING_LEVELS, prefs.readingLevel, wantsSimpler ? -1 : +1),
    verbosity: stepLevel(VERBOSITY_LEVELS, prefs.verbosity, wantsSimpler ? +1 : -1),
    exampleDensity: wantsSimpler
      ? stepLevel(EXAMPLE_DENSITIES, prefs.exampleDensity, +1)
      : prefs.exampleDensity,
  };
  const changed = JSON.stringify(next) !== JSON.stringify(prefs);
  return { prefs: next, changed };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/profile/__tests__/signal-reducer.test.ts`
Expected: PASS（6 passed）

- [ ] **Step 5: commit**

```bash
git add src/server/profile/signal-reducer.ts src/server/profile/__tests__/signal-reducer.test.ts
git commit -m "feat(profile): 新增信号→画像偏好的确定性微调 reducer"
```

---

### Task 3: canonical 内容 hash

**Files:**
- Create: `src/server/profile/rendition-hash.ts`
- Test: `src/server/profile/__tests__/rendition-hash.test.ts`

**Interfaces:**
- Produces: `computeCanonicalHash(body: string): string`（sha256 前 16 hex）

- [ ] **Step 1: 写失败测试**

```ts
// src/server/profile/__tests__/rendition-hash.test.ts
import { describe, it, expect } from 'vitest';
import { computeCanonicalHash } from '../rendition-hash';

describe('computeCanonicalHash', () => {
  it('同输入稳定、不同输入不同', () => {
    expect(computeCanonicalHash('hello')).toBe(computeCanonicalHash('hello'));
    expect(computeCanonicalHash('hello')).not.toBe(computeCanonicalHash('world'));
  });
  it('输出 16 位 hex', () => {
    expect(computeCanonicalHash('x')).toMatch(/^[0-9a-f]{16}$/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/profile/__tests__/rendition-hash.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/server/profile/rendition-hash.ts
import { createHash } from 'node:crypto';

/** 用于缓存失效：canonical 正文（不含 frontmatter）变了，hash 就变。 */
export function computeCanonicalHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/profile/__tests__/rendition-hash.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/server/profile/rendition-hash.ts src/server/profile/__tests__/rendition-hash.test.ts
git commit -m "feat(profile): 新增 canonical 正文 hash（重塑缓存失效用）"
```

---

### Task 4: 保真护栏 — wikilink 目标子集校验

**Files:**
- Create: `src/server/profile/fidelity.ts`
- Test: `src/server/profile/__tests__/fidelity.test.ts`

**Interfaces:**
- Consumes: `extractWikiLinks(markdown: string): ExtractedLink[]`（`@/server/wiki/wikilinks`，无参重载，返回含 `target` / `targetSubjectSlug` / `raw`）
- Produces: `checkLinkSubset(canonicalBody: string, reshapedBody: string): { ok: boolean; offending: string[] }`

> 说明：重塑只作用于**正文**（`readPageInSubject` 已把 frontmatter 单独剥出），故 frontmatter 由代码侧天然免疫，无需在此处理。本护栏只保证重塑后未**新增/篡改** wikilink 目标（可少不可多）。canonical 与 reshaped 都用无参 `extractWikiLinks`，二者前缀/无前缀表示一致，子集比较成立。

- [ ] **Step 1: 写失败测试**

```ts
// src/server/profile/__tests__/fidelity.test.ts
import { describe, it, expect } from 'vitest';
import { checkLinkSubset } from '../fidelity';

describe('checkLinkSubset', () => {
  const canon = '见 [[Alpha]] 和 [[Beta|别名]]，以及 [[other:Gamma]]。';

  it('重塑省略部分链接 → ok', () => {
    expect(checkLinkSubset(canon, '只保留 [[Alpha]]。').ok).toBe(true);
  });
  it('重塑保留全部链接 → ok', () => {
    expect(checkLinkSubset(canon, '[[Alpha]] [[Beta]] [[other:Gamma]]').ok).toBe(true);
  });
  it('重塑新增不存在的链接 → 不 ok 且报告 offending', () => {
    const r = checkLinkSubset(canon, '[[Alpha]] 还有 [[Delta]]');
    expect(r.ok).toBe(false);
    expect(r.offending.join()).toContain('Delta');
  });
  it('无链接正文 → ok', () => {
    expect(checkLinkSubset('纯文本', '依然纯文本').ok).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/profile/__tests__/fidelity.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/server/profile/fidelity.ts
import { extractWikiLinks } from '@/server/wiki/wikilinks';

function targetKey(l: { targetSubjectSlug: string; target: string }): string {
  return `${l.targetSubjectSlug}:${l.target}`;
}

/**
 * 保真护栏：重塑后的 wikilink 目标集必须是 canonical 的子集。
 * 出现 canonical 中不存在的目标即判失败（防模型臆造链接）。
 */
export function checkLinkSubset(
  canonicalBody: string,
  reshapedBody: string,
): { ok: boolean; offending: string[] } {
  const allowed = new Set(extractWikiLinks(canonicalBody).map(targetKey));
  const offending: string[] = [];
  for (const l of extractWikiLinks(reshapedBody)) {
    if (!allowed.has(targetKey(l))) offending.push(l.raw);
  }
  return { ok: offending.length === 0, offending };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/profile/__tests__/fidelity.test.ts`
Expected: PASS（4 passed）

- [ ] **Step 5: commit**

```bash
git add src/server/profile/fidelity.ts src/server/profile/__tests__/fidelity.test.ts
git commit -m "feat(profile): 新增重塑保真护栏（wikilink 目标子集校验）"
```

---

## Phase 1 — DB 层

### Task 5: 三张表（schema + ensureTables）

**Files:**
- Modify: `src/server/db/schema.ts`（追加 3 个 `sqliteTable`）
- Modify: `src/server/db/client.ts`（`ensureTables()` 内追加 3 个 `CREATE TABLE IF NOT EXISTS`）
- Test: `src/server/db/__tests__/cognitive-lens-tables.test.ts`

**Interfaces:**
- Produces（schema 导出，供 repos 用 Drizzle 查询）：`userProfiles` / `pageRenditions` / `profileSignals` 三个 table 对象。

- [ ] **Step 1: 写失败测试（断言三表存在）**

```ts
// src/server/db/__tests__/cognitive-lens-tables.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lens-tables-'));
  prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});
afterEach(() => {
  process.env.DATABASE_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

it('ensureTables 建出三张认知透镜表', async () => {
  const { getRawDb } = await import('../client');
  const db = getRawDb();
  const names = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map((r: { name: string }) => r.name);
  expect(names).toContain('user_profiles');
  expect(names).toContain('page_renditions');
  expect(names).toContain('profile_signals');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/db/__tests__/cognitive-lens-tables.test.ts`
Expected: FAIL（三表不存在）

- [ ] **Step 3a: schema.ts 追加表定义**

在 `src/server/db/schema.ts` 末尾追加（沿用现有 `sqliteTable` / `primaryKey` 导入，已在文件顶部）：

```ts
// ── Cognitive Lens（读时内容重塑）─────────────────────────────────
export const userProfiles = sqliteTable('user_profiles', {
  userId: text('user_id').primaryKey(),
  backgroundSummary: text('background_summary').notNull().default(''),
  stylePrefs: text('style_prefs').notNull(), // JSON: StylePrefs
  version: integer('version').notNull().default(1),
  onboardedAt: text('onboarded_at'),
  updatedAt: text('updated_at').notNull(),
});

export const pageRenditions = sqliteTable(
  'page_renditions',
  {
    subjectId: text('subject_id').notNull(),
    slug: text('slug').notNull(),
    canonicalHash: text('canonical_hash').notNull(),
    profileVersion: integer('profile_version').notNull(),
    renderedMd: text('rendered_md').notNull(),
    model: text('model'),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.subjectId, t.slug] }) }),
);

export const profileSignals = sqliteTable('profile_signals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: text('user_id').notNull(),
  type: text('type').notNull(),
  subjectId: text('subject_id'),
  slug: text('slug'),
  createdAt: text('created_at').notNull(),
});
```

> 若 `integer` 未在 schema.ts 顶部 import，补进 `import { sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';`（按现有 import 行实际补缺项）。

- [ ] **Step 3b: client.ts 的 ensureTables() 追加建表**

在 `src/server/db/client.ts::ensureTables()` 内（与其它 `CREATE TABLE IF NOT EXISTS` 并列）追加：

```ts
rawSqlite!.exec(`
  CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    background_summary TEXT NOT NULL DEFAULT '',
    style_prefs TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    onboarded_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS page_renditions (
    subject_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    canonical_hash TEXT NOT NULL,
    profile_version INTEGER NOT NULL,
    rendered_md TEXT NOT NULL,
    model TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (subject_id, slug)
  );
  CREATE TABLE IF NOT EXISTS profile_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    type TEXT NOT NULL,
    subject_id TEXT,
    slug TEXT,
    created_at TEXT NOT NULL
  );
`);
```

> 实现注意：`ensureTables()` 里访问原生句柄的变量名以该文件现状为准（探测显示为 `rawSqlite`/`getRawDb()`）。若 `ensureTables()` 用的是局部 `db`/`sqlite` 变量，则用该变量的 `.exec(...)`。放在该函数已有建表语句之后即可。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/db/__tests__/cognitive-lens-tables.test.ts`
Expected: PASS

- [ ] **Step 5: 生成参考迁移 + 类型检查 + commit**

```bash
npm run db:generate   # 仅生成 drizzle/*.sql 参考；实际建表已走 ensureTables
npx tsc --noEmit
git add src/server/db/schema.ts src/server/db/client.ts src/server/db/__tests__/cognitive-lens-tables.test.ts drizzle/
git commit -m "feat(db): 新增 user_profiles / page_renditions / profile_signals 三表"
```

---

### Task 6: profiles-repo

**Files:**
- Create: `src/server/db/repos/profiles-repo.ts`
- Test: `src/server/db/repos/__tests__/profiles-repo.test.ts`

**Interfaces:**
- Consumes: Task 1 `StylePrefs / StylePrefsSchema / DEFAULT_STYLE_PREFS`；Task 5 `userProfiles`
- Produces:
  - `interface UserProfile { userId: string; backgroundSummary: string; stylePrefs: StylePrefs; version: number; onboardedAt: string | null; updatedAt: string }`
  - `getProfile(userId: string): UserProfile | null`
  - `getProfileOrDefault(userId: string): UserProfile`（缺失返回 `{ stylePrefs: DEFAULT_STYLE_PREFS, version: 0, backgroundSummary: '', onboardedAt: null }`）
  - `upsertProfile(userId: string, patch: { backgroundSummary?: string; stylePrefs?: StylePrefs; markOnboarded?: boolean }): UserProfile`（version = 旧 version + 1）

- [ ] **Step 1: 写失败测试**

```ts
// src/server/db/repos/__tests__/profiles-repo.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string; let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'profiles-repo-'));
  prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});
afterEach(() => { process.env.DATABASE_PATH = prev; rmSync(dir, { recursive: true, force: true }); });

describe('profiles-repo', () => {
  it('缺失时 getProfile=null、getProfileOrDefault 给默认 version=0', async () => {
    const repo = await import('../profiles-repo');
    expect(repo.getProfile('local')).toBeNull();
    const d = repo.getProfileOrDefault('local');
    expect(d.version).toBe(0);
    expect(d.stylePrefs.readingLevel).toBe('intermediate');
  });

  it('upsert 自增 version、round-trip stylePrefs、可标记 onboarded', async () => {
    const repo = await import('../profiles-repo');
    const p1 = repo.upsertProfile('local', {
      backgroundSummary: '我是后端工程师',
      stylePrefs: { readingLevel: 'advanced', verbosity: 'terse', exampleDensity: 'few', formality: 'formal' },
      markOnboarded: true,
    });
    expect(p1.version).toBe(1);
    expect(p1.onboardedAt).not.toBeNull();
    expect(p1.stylePrefs.readingLevel).toBe('advanced');

    const p2 = repo.upsertProfile('local', { backgroundSummary: '改了背景' });
    expect(p2.version).toBe(2);
    expect(p2.stylePrefs.readingLevel).toBe('advanced'); // 未传则保留
    expect(p2.backgroundSummary).toBe('改了背景');
    expect(repo.getProfile('local')!.version).toBe(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/profiles-repo.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/server/db/repos/profiles-repo.ts
import { eq } from 'drizzle-orm';
import { getDb } from '../client';
import { userProfiles } from '../schema';
import { StylePrefs, StylePrefsSchema, DEFAULT_STYLE_PREFS } from '@/server/profile/style';

export interface UserProfile {
  userId: string;
  backgroundSummary: string;
  stylePrefs: StylePrefs;
  version: number;
  onboardedAt: string | null;
  updatedAt: string;
}

function parsePrefs(json: string): StylePrefs {
  try {
    return StylePrefsSchema.parse(JSON.parse(json));
  } catch {
    return DEFAULT_STYLE_PREFS;
  }
}

export function getProfile(userId: string): UserProfile | null {
  const row = getDb()
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.userId, userId))
    .get();
  if (!row) return null;
  return {
    userId: row.userId,
    backgroundSummary: row.backgroundSummary,
    stylePrefs: parsePrefs(row.stylePrefs),
    version: row.version,
    onboardedAt: row.onboardedAt ?? null,
    updatedAt: row.updatedAt,
  };
}

export function getProfileOrDefault(userId: string): UserProfile {
  return (
    getProfile(userId) ?? {
      userId,
      backgroundSummary: '',
      stylePrefs: DEFAULT_STYLE_PREFS,
      version: 0,
      onboardedAt: null,
      updatedAt: '',
    }
  );
}

export function upsertProfile(
  userId: string,
  patch: { backgroundSummary?: string; stylePrefs?: StylePrefs; markOnboarded?: boolean },
): UserProfile {
  const existing = getProfile(userId);
  const now = new Date().toISOString();
  const next: UserProfile = {
    userId,
    backgroundSummary: patch.backgroundSummary ?? existing?.backgroundSummary ?? '',
    stylePrefs: patch.stylePrefs ?? existing?.stylePrefs ?? DEFAULT_STYLE_PREFS,
    version: (existing?.version ?? 0) + 1,
    onboardedAt: patch.markOnboarded ? (existing?.onboardedAt ?? now) : (existing?.onboardedAt ?? null),
    updatedAt: now,
  };
  getDb()
    .insert(userProfiles)
    .values({
      userId,
      backgroundSummary: next.backgroundSummary,
      stylePrefs: JSON.stringify(next.stylePrefs),
      version: next.version,
      onboardedAt: next.onboardedAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userProfiles.userId,
      set: {
        backgroundSummary: next.backgroundSummary,
        stylePrefs: JSON.stringify(next.stylePrefs),
        version: next.version,
        onboardedAt: next.onboardedAt,
        updatedAt: now,
      },
    })
    .run();
  return next;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/db/repos/__tests__/profiles-repo.test.ts`
Expected: PASS（2 passed）

- [ ] **Step 5: commit**

```bash
git add src/server/db/repos/profiles-repo.ts src/server/db/repos/__tests__/profiles-repo.test.ts
git commit -m "feat(db): 新增 profiles-repo（画像读写 + 自增 version）"
```

---

### Task 7: renditions-repo（重塑缓存）

**Files:**
- Create: `src/server/db/repos/renditions-repo.ts`
- Test: `src/server/db/repos/__tests__/renditions-repo.test.ts`

**Interfaces:**
- Consumes: Task 5 `pageRenditions`
- Produces:
  - `getRendition(subjectId: string, slug: string, canonicalHash: string, profileVersion: number): string | null`（仅当行存在且 hash+version 都匹配才返回 `renderedMd`）
  - `upsertRendition(row: { subjectId: string; slug: string; canonicalHash: string; profileVersion: number; renderedMd: string; model: string | null }): void`
  - `deleteBySubject(subjectId: string): void`

- [ ] **Step 1: 写失败测试**

```ts
// src/server/db/repos/__tests__/renditions-repo.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string; let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'renditions-repo-'));
  prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});
afterEach(() => { process.env.DATABASE_PATH = prev; rmSync(dir, { recursive: true, force: true }); });

const base = { subjectId: 's1', slug: 'a', canonicalHash: 'h1', profileVersion: 1, renderedMd: '重塑版', model: 'm' };

describe('renditions-repo', () => {
  it('命中：hash+version 都匹配才返回', async () => {
    const repo = await import('../renditions-repo');
    repo.upsertRendition(base);
    expect(repo.getRendition('s1', 'a', 'h1', 1)).toBe('重塑版');
    expect(repo.getRendition('s1', 'a', 'h2', 1)).toBeNull(); // canonical 变了
    expect(repo.getRendition('s1', 'a', 'h1', 2)).toBeNull(); // 画像变了
  });

  it('upsert 覆盖（一页一行）', async () => {
    const repo = await import('../renditions-repo');
    repo.upsertRendition(base);
    repo.upsertRendition({ ...base, canonicalHash: 'h9', profileVersion: 5, renderedMd: '新版' });
    expect(repo.getRendition('s1', 'a', 'h1', 1)).toBeNull();
    expect(repo.getRendition('s1', 'a', 'h9', 5)).toBe('新版');
  });

  it('deleteBySubject 清空该 subject 缓存', async () => {
    const repo = await import('../renditions-repo');
    repo.upsertRendition(base);
    repo.upsertRendition({ ...base, subjectId: 's2' });
    repo.deleteBySubject('s1');
    expect(repo.getRendition('s1', 'a', 'h1', 1)).toBeNull();
    expect(repo.getRendition('s2', 'a', 'h1', 1)).toBe('重塑版');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/renditions-repo.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/server/db/repos/renditions-repo.ts
import { and, eq } from 'drizzle-orm';
import { getDb } from '../client';
import { pageRenditions } from '../schema';

export function getRendition(
  subjectId: string,
  slug: string,
  canonicalHash: string,
  profileVersion: number,
): string | null {
  const row = getDb()
    .select()
    .from(pageRenditions)
    .where(and(eq(pageRenditions.subjectId, subjectId), eq(pageRenditions.slug, slug)))
    .get();
  if (!row) return null;
  if (row.canonicalHash !== canonicalHash || row.profileVersion !== profileVersion) return null;
  return row.renderedMd;
}

export function upsertRendition(row: {
  subjectId: string;
  slug: string;
  canonicalHash: string;
  profileVersion: number;
  renderedMd: string;
  model: string | null;
}): void {
  const now = new Date().toISOString();
  getDb()
    .insert(pageRenditions)
    .values({ ...row, updatedAt: now })
    .onConflictDoUpdate({
      target: [pageRenditions.subjectId, pageRenditions.slug],
      set: {
        canonicalHash: row.canonicalHash,
        profileVersion: row.profileVersion,
        renderedMd: row.renderedMd,
        model: row.model,
        updatedAt: now,
      },
    })
    .run();
}

export function deleteBySubject(subjectId: string): void {
  getDb().delete(pageRenditions).where(eq(pageRenditions.subjectId, subjectId)).run();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/db/repos/__tests__/renditions-repo.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: commit**

```bash
git add src/server/db/repos/renditions-repo.ts src/server/db/repos/__tests__/renditions-repo.test.ts
git commit -m "feat(db): 新增 renditions-repo（一页一行重塑缓存，hash+version 判失效）"
```

---

### Task 8: signals-repo

**Files:**
- Create: `src/server/db/repos/signals-repo.ts`
- Test: `src/server/db/repos/__tests__/signals-repo.test.ts`

**Interfaces:**
- Consumes: Task 5 `profileSignals`；Task 2 `SignalType`
- Produces:
  - `appendSignal(sig: { userId: string; type: SignalType; subjectId?: string | null; slug?: string | null }): void`
  - `recentSignals(userId: string, limit: number): { type: SignalType }[]`（按 id DESC 取 limit 条）

- [ ] **Step 1: 写失败测试**

```ts
// src/server/db/repos/__tests__/signals-repo.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string; let prev: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'signals-repo-'));
  prev = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});
afterEach(() => { process.env.DATABASE_PATH = prev; rmSync(dir, { recursive: true, force: true }); });

it('append + recent（DESC + limit + 按 user 隔离）', async () => {
  const repo = await import('../signals-repo');
  repo.appendSignal({ userId: 'u1', type: 'too_hard' });
  repo.appendSignal({ userId: 'u1', type: 'simplify_click', slug: 'a' });
  repo.appendSignal({ userId: 'u2', type: 'too_easy' });
  const r = repo.recentSignals('u1', 10);
  expect(r.map((x) => x.type)).toEqual(['simplify_click', 'too_hard']); // DESC
  expect(repo.recentSignals('u1', 1).map((x) => x.type)).toEqual(['simplify_click']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/signals-repo.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/server/db/repos/signals-repo.ts
import { desc, eq } from 'drizzle-orm';
import { getDb } from '../client';
import { profileSignals } from '../schema';
import type { SignalType } from '@/server/profile/signal-reducer';

export function appendSignal(sig: {
  userId: string;
  type: SignalType;
  subjectId?: string | null;
  slug?: string | null;
}): void {
  getDb()
    .insert(profileSignals)
    .values({
      userId: sig.userId,
      type: sig.type,
      subjectId: sig.subjectId ?? null,
      slug: sig.slug ?? null,
      createdAt: new Date().toISOString(),
    })
    .run();
}

export function recentSignals(userId: string, limit: number): { type: SignalType }[] {
  return getDb()
    .select({ type: profileSignals.type })
    .from(profileSignals)
    .where(eq(profileSignals.userId, userId))
    .orderBy(desc(profileSignals.id))
    .limit(limit)
    .all()
    .map((r) => ({ type: r.type as SignalType }));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/db/repos/__tests__/signals-repo.test.ts`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/server/db/repos/signals-repo.ts src/server/db/repos/__tests__/signals-repo.test.ts
git commit -m "feat(db): 新增 signals-repo（反馈信号 append/recent）"
```

---

## Phase 2 — LLM 与服务

### Task 9: reshape prompts + llm-config 路由 + isReshapeConfigured

**Files:**
- Create: `src/server/llm/prompts/reshape-prompt.ts`
- Modify: `src/server/llm/provider-registry.ts`（+`isReshapeConfigured`）
- Modify: `llm-config.json` + `llm-config.example.json`（+`reshape:page` / `reshape:section`）
- Test: `src/server/llm/prompts/__tests__/reshape-prompt.test.ts`

**Interfaces:**
- Consumes: `PromptContext`（`@/server/llm/prompts/prompt-context`）、`renderLanguageDirective`、Task 1 `StylePrefs`
- Produces:
  - `RESHAPE_PAGE_SYSTEM_PROMPT: string`、`RESHAPE_SECTION_SYSTEM_PROMPT: string`
  - `buildReshapePageUserPrompt(body: string, profile: { backgroundSummary: string; stylePrefs: StylePrefs }, ctx: PromptContext): string`
  - `buildReshapeSectionUserPrompt(block: string, direction: 'simpler' | 'deeper', profile: {...}, ctx: PromptContext, context?: string): string`
  - `isReshapeConfigured(): boolean`（provider-registry，仿 `isEmbeddingConfigured`，检查 `reshape:page` 是否有 model）

- [ ] **Step 1: 写失败测试**

```ts
// src/server/llm/prompts/__tests__/reshape-prompt.test.ts
import { describe, it, expect } from 'vitest';
import {
  RESHAPE_PAGE_SYSTEM_PROMPT,
  buildReshapePageUserPrompt,
  buildReshapeSectionUserPrompt,
} from '../reshape-prompt';
import { DEFAULT_STYLE_PREFS } from '@/server/profile/style';

const ctx = { language: 'Chinese' as const };
const profile = { backgroundSummary: '后端工程师，懂分布式', stylePrefs: DEFAULT_STYLE_PREFS };

describe('reshape-prompt', () => {
  it('system prompt 含保真约束关键词', () => {
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/fact|事实/i);
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/\[!/); // callout 标记规则
    expect(RESHAPE_PAGE_SYSTEM_PROMPT).toMatch(/wikilink|\[\[/i);
  });

  it('page user prompt 注入语言指令 + 画像 + 正文', () => {
    const p = buildReshapePageUserPrompt('# 标题\n正文 [[X]]', profile, ctx);
    expect(p).toContain('Chinese');               // renderLanguageDirective
    expect(p).toContain('后端工程师');             // background
    expect(p).toContain('intermediate');          // readingLevel
    expect(p).toContain('正文 [[X]]');             // canonical body
  });

  it('section user prompt 含 direction 与待改块', () => {
    const p = buildReshapeSectionUserPrompt('某段', 'simpler', profile, ctx, '上文');
    expect(p).toMatch(/simpler|更简单|简单/i);
    expect(p).toContain('某段');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/llm/prompts/__tests__/reshape-prompt.test.ts`
Expected: FAIL

- [ ] **Step 3a: 实现 prompts**

```ts
// src/server/llm/prompts/reshape-prompt.ts
import { renderLanguageDirective } from './prompt-context';
import type { PromptContext } from './prompt-context';
import type { StylePrefs } from '@/server/profile/style';

export const RESHAPE_PAGE_SYSTEM_PROMPT = `You reshape an existing wiki page for one specific reader. This is PRESENTATION ONLY.

HARD RULES (never violate):
- Do NOT add, remove, or change any FACT. Same claims, same numbers, same conclusions.
- Do NOT introduce any new [[wikilink]]. You may keep or drop existing ones, but never invent or alter a link target.
- Any analogy, worked example, or prerequisite primer you ADD for the reader MUST be wrapped in a callout: \`> [!example]\` or \`> [!note]\`. Plain factual statements must stay outside callouts.
- Output ONLY the reshaped markdown body — no frontmatter, no preamble, no "here is".
- Preserve markdown structure (headings, lists, code blocks, math) where it still serves the reader.

GOAL: match the reader's background and style preferences so the page is as easy to internalize as possible for THEM — neither over-explaining what they already know nor under-explaining what they don't.`;

export const RESHAPE_SECTION_SYSTEM_PROMPT = `You reshape ONE block of a wiki page for one reader. PRESENTATION ONLY.
Same hard rules as page reshaping: no fact changes, no new wikilinks, added scaffolding wrapped in \`> [!example]\`/\`> [!note]\`, output only the reshaped block markdown.`;

function renderProfile(profile: { backgroundSummary: string; stylePrefs: StylePrefs }): string {
  const s = profile.stylePrefs;
  return [
    '=== READER PROFILE ===',
    `Background: ${profile.backgroundSummary || '(unknown — assume a curious generalist)'}`,
    `Reading level: ${s.readingLevel}`,
    `Verbosity: ${s.verbosity}`,
    `Example/analogy density: ${s.exampleDensity}`,
    `Formality: ${s.formality}`,
  ].join('\n');
}

export function buildReshapePageUserPrompt(
  body: string,
  profile: { backgroundSummary: string; stylePrefs: StylePrefs },
  ctx: PromptContext,
): string {
  return [
    renderLanguageDirective(ctx.language),
    '',
    renderProfile(profile),
    '',
    '=== PAGE BODY TO RESHAPE (canonical) ===',
    body,
    '',
    '=== OUTPUT ===',
    'Return the reshaped markdown body only.',
  ].join('\n');
}

export function buildReshapeSectionUserPrompt(
  block: string,
  direction: 'simpler' | 'deeper',
  profile: { backgroundSummary: string; stylePrefs: StylePrefs },
  ctx: PromptContext,
  context?: string,
): string {
  return [
    renderLanguageDirective(ctx.language),
    '',
    renderProfile(profile),
    '',
    `=== DIRECTION ===`,
    direction === 'simpler'
      ? 'Make this block SIMPLER / easier to grasp for this reader.'
      : 'Make this block DEEPER / more thorough for this reader.',
    context ? `\n=== SURROUNDING CONTEXT (do not rewrite) ===\n${context}` : '',
    '',
    '=== BLOCK TO RESHAPE ===',
    block,
    '',
    '=== OUTPUT ===',
    'Return the reshaped block markdown only.',
  ].join('\n');
}
```

> 注：`renderLanguageDirective(ctx.language)` 内部已生成含语言名（如 `Chinese`）的指令段，故测试断言 `toContain('Chinese')` 成立。

- [ ] **Step 3b: provider-registry 加 isReshapeConfigured**

参照 `isEmbeddingConfigured`（`src/server/llm/provider-registry.ts:237`），追加：

```ts
// src/server/llm/provider-registry.ts （在 isEmbeddingConfigured 附近）
export function isReshapeConfigured(): boolean {
  try {
    const route = resolveTask('reshape:page');
    return Boolean(route.model);
  } catch {
    return false;
  }
}
```

> `resolveTask` 已在本文件被 import（streamTextResponse 用它）。若未 import 则补 `import { resolveTask } from './task-router';`（以文件现状为准）。

- [ ] **Step 3c: llm-config 加路由**

`llm-config.json` 与 `llm-config.example.json` 的 `tasks` 段各加（example 用与现有 ingest 阶段一致的 profile）：

```json
"reshape:page": { "profile": "anthropic-default", "model": "claude-sonnet-4-6", "maxTokens": 8192, "temperature": 0.2 },
"reshape:section": { "profile": "anthropic-default", "model": "claude-sonnet-4-6", "maxTokens": 2048, "temperature": 0.2 }
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run src/server/llm/prompts/__tests__/reshape-prompt.test.ts`
Expected: PASS（3 passed）
Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: commit**

```bash
git add src/server/llm/prompts/reshape-prompt.ts src/server/llm/prompts/__tests__/reshape-prompt.test.ts src/server/llm/provider-registry.ts llm-config.json llm-config.example.json
git commit -m "feat(llm): 新增 reshape prompts + reshape:* 路由 + isReshapeConfigured"
```

---

### Task 10: reshape-service（整页重塑 + 保真重试/回落）

**Files:**
- Create: `src/server/services/reshape-service.ts`
- Test: `src/server/services/__tests__/reshape-service.test.ts`

**Interfaces:**
- Consumes: `streamTextResponse`（`@/server/llm/provider-registry`）、Task 9 prompts、Task 4 `checkLinkSubset`、`getWikiLanguage`（`@/server/db/repos/settings-repo`）、`Subject`（`@/lib/contracts`）
- Produces:
  - `reshapePageBody(input: { subject: Subject; body: string; profile: { backgroundSummary: string; stylePrefs: StylePrefs }; abortSignal?: AbortSignal }): Promise<{ body: string; fallback: boolean; model: string | null }>`
  - `reshapeSection(input: { subject: Subject; block: string; direction: 'simpler' | 'deeper'; profile: {...}; context?: string }): Promise<{ block: string; fallback: boolean }>`

**实现要点（写进代码）：**
- 用 `streamTextResponse` 收全 `textStream` 成字符串（本服务**不流式对外**——路由是 JSON 响应）。
- 整页：生成 → `checkLinkSubset(body, out)`；失败 → 追加"上次臆造了不存在的链接，请勿新增任何 [[链接]]"重写一次；二次仍失败 → `{ body, fallback: true }`（回落 canonical，不缓存）。
- 任意异常向上抛（路由层 try/catch 回落 canonical）。

- [ ] **Step 1: 写失败测试（mock provider-registry）**

```ts
// src/server/services/__tests__/reshape-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const streamMock = vi.fn();
vi.mock('@/server/llm/provider-registry', () => ({
  streamTextResponse: (...args: unknown[]) => streamMock(...args),
}));
vi.mock('@/server/db/repos/settings-repo', () => ({ getWikiLanguage: () => 'Chinese' }));

// 让 streamTextResponse 返回一个带 textStream 的对象
function fakeStream(text: string) {
  return {
    textStream: (async function* () { yield text; })(),
  };
}

const subject = { id: 's1', slug: 'general', name: 'G', description: '', augmentationLevel: 'standard', createdAt: '', updatedAt: '' } as never;
const profile = { backgroundSummary: '', stylePrefs: { readingLevel: 'intermediate', verbosity: 'balanced', exampleDensity: 'some', formality: 'neutral' } } as never;

beforeEach(() => streamMock.mockReset());

describe('reshapePageBody', () => {
  it('保真通过 → 返回重塑正文，fallback=false', async () => {
    streamMock.mockReturnValueOnce(fakeStream('重塑：见 [[Alpha]]'));
    const { reshapePageBody } = await import('../reshape-service');
    const r = await reshapePageBody({ subject, body: '原文 [[Alpha]]', profile });
    expect(r.fallback).toBe(false);
    expect(r.body).toContain('重塑');
    expect(streamMock).toHaveBeenCalledTimes(1);
  });

  it('首次臆造链接 → 重写一次；第二次干净 → 通过', async () => {
    streamMock
      .mockReturnValueOnce(fakeStream('[[Alpha]] 还有臆造 [[Ghost]]'))
      .mockReturnValueOnce(fakeStream('干净 [[Alpha]]'));
    const { reshapePageBody } = await import('../reshape-service');
    const r = await reshapePageBody({ subject, body: '原文 [[Alpha]]', profile });
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(r.fallback).toBe(false);
    expect(r.body).toContain('干净');
  });

  it('两次都臆造 → 回落 canonical，fallback=true', async () => {
    streamMock
      .mockReturnValueOnce(fakeStream('[[Ghost1]]'))
      .mockReturnValueOnce(fakeStream('[[Ghost2]]'));
    const { reshapePageBody } = await import('../reshape-service');
    const r = await reshapePageBody({ subject, body: '原文 [[Alpha]]', profile });
    expect(r.fallback).toBe(true);
    expect(r.body).toBe('原文 [[Alpha]]');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/reshape-service.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/server/services/reshape-service.ts
import type { Subject } from '@/lib/contracts';
import { streamTextResponse } from '@/server/llm/provider-registry';
import { getWikiLanguage } from '@/server/db/repos/settings-repo';
import { checkLinkSubset } from '@/server/profile/fidelity';
import type { StylePrefs } from '@/server/profile/style';
import {
  RESHAPE_PAGE_SYSTEM_PROMPT,
  RESHAPE_SECTION_SYSTEM_PROMPT,
  buildReshapePageUserPrompt,
  buildReshapeSectionUserPrompt,
} from '@/server/llm/prompts/reshape-prompt';
import type { PromptContext } from '@/server/llm/prompts/prompt-context';

type ProfileLite = { backgroundSummary: string; stylePrefs: StylePrefs };

function ctxFor(subject: Subject): PromptContext {
  return {
    language: getWikiLanguage(),
    subject: { slug: subject.slug, name: subject.name, description: subject.description },
  } as PromptContext;
}

async function collect(task: 'reshape:page' | 'reshape:section', system: string, user: string, signal?: AbortSignal): Promise<string> {
  const res = streamTextResponse(task, system, user, signal);
  let out = '';
  for await (const chunk of res.textStream) out += chunk;
  return out.trim();
}

export async function reshapePageBody(input: {
  subject: Subject;
  body: string;
  profile: ProfileLite;
  abortSignal?: AbortSignal;
}): Promise<{ body: string; fallback: boolean; model: string | null }> {
  const ctx = ctxFor(input.subject);
  const baseUser = buildReshapePageUserPrompt(input.body, input.profile, ctx);

  let out = await collect('reshape:page', RESHAPE_PAGE_SYSTEM_PROMPT, baseUser, input.abortSignal);
  if (!checkLinkSubset(input.body, out).ok) {
    const retryUser = `${baseUser}\n\n=== CORRECTION ===\nYour previous attempt invented wikilinks not present in the canonical body. Do NOT introduce any new [[link]]. Only use links that already exist.`;
    out = await collect('reshape:page', RESHAPE_PAGE_SYSTEM_PROMPT, retryUser, input.abortSignal);
    if (!checkLinkSubset(input.body, out).ok) {
      return { body: input.body, fallback: true, model: null };
    }
  }
  return { body: out, fallback: false, model: null };
}

export async function reshapeSection(input: {
  subject: Subject;
  block: string;
  direction: 'simpler' | 'deeper';
  profile: ProfileLite;
  context?: string;
}): Promise<{ block: string; fallback: boolean }> {
  const ctx = ctxFor(input.subject);
  const user = buildReshapeSectionUserPrompt(input.block, input.direction, input.profile, ctx, input.context);
  const out = await collect('reshape:section', RESHAPE_SECTION_SYSTEM_PROMPT, user);
  if (!checkLinkSubset(input.block, out).ok) {
    return { block: input.block, fallback: true };
  }
  return { block: out, fallback: false };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/server/services/__tests__/reshape-service.test.ts`
Expected: PASS（3 passed）

- [ ] **Step 5: commit**

```bash
git add src/server/services/reshape-service.ts src/server/services/__tests__/reshape-service.test.ts
git commit -m "feat(service): 新增 reshape-service（整页/段级重塑 + 保真重试再回落）"
```

---

## Phase 3 — API 路由

### Task 11: resolveUserId + GET/PUT /api/profile

**Files:**
- Create: `src/server/middleware/user.ts`
- Create: `src/app/api/profile/route.ts`
- Modify: `src/lib/contracts.ts`（+`UserProfileDTO` 导出供前端类型）
- Test: `src/server/middleware/__tests__/user.test.ts`

**Interfaces:**
- Produces:
  - `LOCAL_USER_ID = 'local'`、`resolveUserId(request: NextRequest): string`（今天恒返回 `LOCAL_USER_ID`）
  - `GET /api/profile` → `{ profile: UserProfileDTO; onboarded: boolean }`
  - `PUT /api/profile` body `{ backgroundSummary?: string; stylePrefs?: StylePrefs; markOnboarded?: boolean }` → `{ profile: UserProfileDTO }`
  - `UserProfileDTO`（contracts）= `{ backgroundSummary: string; stylePrefs: StylePrefs; version: number; onboardedAt: string | null }`

- [ ] **Step 1: 写失败测试（resolveUserId 纯逻辑）**

```ts
// src/server/middleware/__tests__/user.test.ts
import { describe, it, expect } from 'vitest';
import { LOCAL_USER_ID, resolveUserId } from '../user';

describe('resolveUserId', () => {
  it('当前单例：恒返回 LOCAL_USER_ID', () => {
    expect(resolveUserId({} as never)).toBe(LOCAL_USER_ID);
    expect(LOCAL_USER_ID).toBe('local');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/middleware/__tests__/user.test.ts`
Expected: FAIL

- [ ] **Step 3a: 实现 middleware/user.ts**

```ts
// src/server/middleware/user.ts
import type { NextRequest } from 'next/server';

/** 单租户占位用户。未来多租户时由 auth 解析真实 userId。 */
export const LOCAL_USER_ID = 'local';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function resolveUserId(_request: NextRequest): string {
  return LOCAL_USER_ID;
}
```

- [ ] **Step 3b: contracts.ts 加 DTO**

在 `src/lib/contracts.ts` 追加（`StylePrefs` 从 server/profile 复制为前端可用的纯类型；为避免 server-only 屏障，这里直接内联同形类型）：

```ts
// src/lib/contracts.ts
export type LensReadingLevel = 'beginner' | 'intermediate' | 'advanced';
export type LensVerbosity = 'terse' | 'balanced' | 'thorough';
export type LensExampleDensity = 'few' | 'some' | 'many';
export type LensFormality = 'casual' | 'neutral' | 'formal';

export interface StylePrefs {
  readingLevel: LensReadingLevel;
  verbosity: LensVerbosity;
  exampleDensity: LensExampleDensity;
  formality: LensFormality;
}

export interface UserProfileDTO {
  backgroundSummary: string;
  stylePrefs: StylePrefs;
  version: number;
  onboardedAt: string | null;
}
```

> 让 server 的 `style.ts` 复用 contracts 的 `StylePrefs`：把 `style.ts` 的 `export type StylePrefs = z.infer<...>` 保留为本地 schema 推导，并在文件加一行编译期一致性断言 `const _assertSame: import('@/lib/contracts').StylePrefs = {} as StylePrefs;`（可选，类型护栏）。两处枚举字面量必须一致。

- [ ] **Step 3c: 实现 /api/profile/route.ts**

```ts
// src/app/api/profile/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { getProfileOrDefault, upsertProfile } from '@/server/db/repos/profiles-repo';
import { StylePrefsSchema } from '@/server/profile/style';
import { z } from 'zod';

export const runtime = 'nodejs';

function toDTO(p: { backgroundSummary: string; stylePrefs: unknown; version: number; onboardedAt: string | null }) {
  return { backgroundSummary: p.backgroundSummary, stylePrefs: p.stylePrefs, version: p.version, onboardedAt: p.onboardedAt };
}

export async function GET(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const userId = resolveUserId(request);
  const p = getProfileOrDefault(userId);
  return NextResponse.json({ profile: toDTO(p), onboarded: p.onboardedAt !== null });
}

const PutBody = z.object({
  backgroundSummary: z.string().max(2000).optional(),
  stylePrefs: StylePrefsSchema.optional(),
  markOnboarded: z.boolean().optional(),
});

export async function PUT(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;
  const userId = resolveUserId(request);

  let parsed: z.infer<typeof PutBody>;
  try {
    parsed = PutBody.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid profile body' }, { status: 400 });
  }
  const updated = upsertProfile(userId, parsed);
  return NextResponse.json({ profile: toDTO(updated) });
}
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run src/server/middleware/__tests__/user.test.ts`
Expected: PASS
Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: commit**

```bash
git add src/server/middleware/user.ts src/app/api/profile/route.ts src/lib/contracts.ts src/server/middleware/__tests__/user.test.ts
git commit -m "feat(api): 新增 resolveUserId + GET/PUT /api/profile"
```

---

### Task 12: POST /api/profile/signals（+ reducer 闭环）

**Files:**
- Create: `src/app/api/profile/signals/route.ts`
- Test: `src/server/services/__tests__/signals-apply.test.ts`（测可单测的闭环纯逻辑）
- Create: `src/server/services/apply-signal.ts`（薄封装：append + recent + reducer + 必要时 upsert）

**Interfaces:**
- Consumes: Task 6/8 repos、Task 2 reducer
- Produces:
  - `applySignal(userId: string, type: SignalType, ctx?: { subjectId?: string | null; slug?: string | null }): { changed: boolean; version: number }`
  - `POST /api/profile/signals` body `{ type: SignalType; slug?: string }` → `{ changed: boolean; version: number }`（`subjectId` 经 `resolveSubjectFromRequest` 解析）

- [ ] **Step 1: 写失败测试（mock repos，验证达阈值才 upsert）**

```ts
// src/server/services/__tests__/signals-apply.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const append = vi.fn();
const recent = vi.fn();
const getOrDefault = vi.fn();
const upsert = vi.fn();

vi.mock('@/server/db/repos/signals-repo', () => ({
  appendSignal: (...a: unknown[]) => append(...a),
  recentSignals: (...a: unknown[]) => recent(...a),
}));
vi.mock('@/server/db/repos/profiles-repo', () => ({
  getProfileOrDefault: (...a: unknown[]) => getOrDefault(...a),
  upsertProfile: (...a: unknown[]) => upsert(...a),
}));

beforeEach(() => { append.mockReset(); recent.mockReset(); getOrDefault.mockReset(); upsert.mockReset(); });

const PREFS = { readingLevel: 'intermediate', verbosity: 'balanced', exampleDensity: 'some', formality: 'neutral' };

describe('applySignal', () => {
  it('未达阈值：append 但不 upsert', async () => {
    recent.mockReturnValue([{ type: 'too_hard' }]); // 1 条 < 阈值
    getOrDefault.mockReturnValue({ stylePrefs: PREFS, version: 3 });
    const { applySignal } = await import('../apply-signal');
    const r = applySignal('local', 'too_hard');
    expect(append).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
    expect(r.changed).toBe(false);
    expect(r.version).toBe(3);
  });

  it('达阈值：upsert 新画像，version 自增', async () => {
    recent.mockReturnValue([{ type: 'too_hard' }, { type: 'too_hard' }]);
    getOrDefault.mockReturnValue({ stylePrefs: PREFS, version: 3 });
    upsert.mockReturnValue({ version: 4 });
    const { applySignal } = await import('../apply-signal');
    const r = applySignal('local', 'too_hard');
    expect(upsert).toHaveBeenCalledOnce();
    expect(r.changed).toBe(true);
    expect(r.version).toBe(4);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/server/services/__tests__/signals-apply.test.ts`
Expected: FAIL

- [ ] **Step 3a: 实现 apply-signal.ts**

```ts
// src/server/services/apply-signal.ts
import { appendSignal, recentSignals } from '@/server/db/repos/signals-repo';
import { getProfileOrDefault, upsertProfile } from '@/server/db/repos/profiles-repo';
import { applySignalsToStyle, SIGNAL_THRESHOLD, type SignalType } from '@/server/profile/signal-reducer';

const RECENT_WINDOW = 8;

export function applySignal(
  userId: string,
  type: SignalType,
  ctx?: { subjectId?: string | null; slug?: string | null },
): { changed: boolean; version: number } {
  appendSignal({ userId, type, subjectId: ctx?.subjectId ?? null, slug: ctx?.slug ?? null });
  const recent = recentSignals(userId, RECENT_WINDOW);
  const current = getProfileOrDefault(userId);
  const { prefs, changed } = applySignalsToStyle(current.stylePrefs, recent);
  if (!changed) return { changed: false, version: current.version };
  const updated = upsertProfile(userId, { stylePrefs: prefs });
  return { changed: true, version: updated.version };
}

export { SIGNAL_THRESHOLD };
```

- [ ] **Step 3b: 实现 route**

```ts
// src/app/api/profile/signals/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { applySignal } from '@/server/services/apply-signal';

export const runtime = 'nodejs';

const Body = z.object({
  type: z.enum(['too_hard', 'too_easy', 'simplify_click', 'deepen_click', 'view_original']),
  slug: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid signal' }, { status: 400 });
  }
  const resolution = resolveSubjectFromRequest(request, { body });
  const subjectId = resolution.error ? null : resolution.subject.id;
  const userId = resolveUserId(request);
  const r = applySignal(userId, body.type, { subjectId, slug: body.slug ?? null });
  return NextResponse.json(r);
}
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run src/server/services/__tests__/signals-apply.test.ts`
Expected: PASS（2 passed）
Run: `npx tsc --noEmit`

- [ ] **Step 5: commit**

```bash
git add src/server/services/apply-signal.ts src/app/api/profile/signals/route.ts src/server/services/__tests__/signals-apply.test.ts
git commit -m "feat(api): 新增 POST /api/profile/signals（信号→画像确定性闭环）"
```

---

### Task 13: GET /api/lens/[...slug]（重塑读端点）

**Files:**
- Create: `src/app/api/lens/[...slug]/route.ts`
- Test: `src/app/api/lens/[...slug]/__tests__/lens-route.test.ts`

**Interfaces:**
- Consumes: `requireAuth`、`resolveSubjectFromRequest`、`resolveUserId`、`getPageBySlug`、`readPageInSubject`、`getProfileOrDefault`、`computeCanonicalHash`、`renditions-repo`、`reshapePageBody`、`isReshapeConfigured`
- Produces: `GET /api/lens/[...slug]` → `{ renderedMd: string; source: 'cache' | 'generated' | 'canonical' | 'fallback' }`

**实现要点（按序）：**
1. `requireAuth`。
2. `resolveSubjectFromRequest(request, { required: true })`；error 直接返回。
3. `slug = params.slug.join('/')`；`getPageBySlug(subject.id, slug)` 缺失 → 404。
4. `doc = readPageInSubject(subject.slug, slug)`；`body = doc?.body ?? ''`。
5. `profile = getProfileOrDefault(userId)`；`hash = computeCanonicalHash(body)`。
6. `cached = getRendition(subject.id, slug, hash, profile.version)`；命中 → `{ renderedMd: cached, source: 'cache' }`。
7. `!isReshapeConfigured()` → `{ renderedMd: body, source: 'canonical' }`（不调 LLM）。
8. `try { reshapePageBody(...) }`：`fallback` → `{ renderedMd: body, source: 'fallback' }`（不缓存）；否则 `upsertRendition` + `{ renderedMd, source: 'generated' }`。`catch` → `{ renderedMd: body, source: 'canonical' }`。

- [ ] **Step 1: 写失败测试（mock 依赖，覆盖 缓存命中 / 未配置 / 生成并缓存 / fallback）**

```ts
// src/app/api/lens/[...slug]/__tests__/lens-route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const subject = { id: 's1', slug: 'general', name: 'G', description: '', augmentationLevel: 'standard', createdAt: '', updatedAt: '' };

vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/user', () => ({ resolveUserId: () => 'local', LOCAL_USER_ID: 'local' }));
vi.mock('@/server/middleware/subject', () => ({ resolveSubjectFromRequest: () => ({ subject, error: null }) }));
vi.mock('@/server/db/repos/pages-repo', () => ({ getPageBySlug: () => ({ slug: 'a', title: 'A' }) }));
vi.mock('@/server/wiki/wiki-store', () => ({ readPageInSubject: () => ({ body: '原文 [[Alpha]]' }) }));
vi.mock('@/server/db/repos/profiles-repo', () => ({ getProfileOrDefault: () => ({ stylePrefs: {}, version: 2, backgroundSummary: '' }) }));

const getRendition = vi.fn();
const upsertRendition = vi.fn();
vi.mock('@/server/db/repos/renditions-repo', () => ({
  getRendition: (...a: unknown[]) => getRendition(...a),
  upsertRendition: (...a: unknown[]) => upsertRendition(...a),
}));

const isConfigured = vi.fn();
vi.mock('@/server/llm/provider-registry', () => ({ isReshapeConfigured: () => isConfigured() }));

const reshape = vi.fn();
vi.mock('@/server/services/reshape-service', () => ({ reshapePageBody: (...a: unknown[]) => reshape(...a) }));

const req = () => new NextRequest('http://x/api/lens/a');
const params = { slug: ['a'] };

beforeEach(() => { getRendition.mockReset(); upsertRendition.mockReset(); isConfigured.mockReset(); reshape.mockReset(); });

describe('GET /api/lens/[...slug]', () => {
  it('缓存命中 → source=cache，不调 reshape', async () => {
    getRendition.mockReturnValue('缓存重塑');
    const { GET } = await import('../route');
    const r = await GET(req(), { params: Promise.resolve(params) } as never);
    expect(await r.json()).toEqual({ renderedMd: '缓存重塑', source: 'cache' });
    expect(reshape).not.toHaveBeenCalled();
  });

  it('未配置 reshape → 回落 canonical', async () => {
    getRendition.mockReturnValue(null);
    isConfigured.mockReturnValue(false);
    const { GET } = await import('../route');
    const r = await GET(req(), { params: Promise.resolve(params) } as never);
    expect(await r.json()).toEqual({ renderedMd: '原文 [[Alpha]]', source: 'canonical' });
  });

  it('生成成功 → 缓存 + source=generated', async () => {
    getRendition.mockReturnValue(null);
    isConfigured.mockReturnValue(true);
    reshape.mockResolvedValue({ body: '重塑版', fallback: false, model: null });
    const { GET } = await import('../route');
    const r = await GET(req(), { params: Promise.resolve(params) } as never);
    expect(await r.json()).toEqual({ renderedMd: '重塑版', source: 'generated' });
    expect(upsertRendition).toHaveBeenCalledOnce();
  });

  it('保真 fallback → 回落 canonical，不缓存', async () => {
    getRendition.mockReturnValue(null);
    isConfigured.mockReturnValue(true);
    reshape.mockResolvedValue({ body: '原文 [[Alpha]]', fallback: true, model: null });
    const { GET } = await import('../route');
    const r = await GET(req(), { params: Promise.resolve(params) } as never);
    expect(await r.json()).toEqual({ renderedMd: '原文 [[Alpha]]', source: 'fallback' });
    expect(upsertRendition).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/app/api/lens/[...slug]/__tests__/lens-route.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/app/api/lens/[...slug]/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { getPageBySlug } from '@/server/db/repos/pages-repo';
import { readPageInSubject } from '@/server/wiki/wiki-store';
import { getProfileOrDefault } from '@/server/db/repos/profiles-repo';
import { computeCanonicalHash } from '@/server/profile/rendition-hash';
import { getRendition, upsertRendition } from '@/server/db/repos/renditions-repo';
import { reshapePageBody } from '@/server/services/reshape-service';
import { isReshapeConfigured } from '@/server/llm/provider-registry';

export const runtime = 'nodejs';

export async function GET(request: NextRequest, { params }: { params: Promise<{ slug: string[] }> }) {
  const authError = requireAuth(request);
  if (authError) return authError;

  const resolution = resolveSubjectFromRequest(request, { required: true });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;
  const userId = resolveUserId(request);

  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');
  const page = getPageBySlug(subject.id, slug);
  if (!page) return NextResponse.json({ error: 'Page not found' }, { status: 404 });

  const doc = readPageInSubject(subject.slug, slug);
  const body = doc?.body ?? '';
  const profile = getProfileOrDefault(userId);
  const hash = computeCanonicalHash(body);

  const cached = getRendition(subject.id, slug, hash, profile.version);
  if (cached !== null) return NextResponse.json({ renderedMd: cached, source: 'cache' });

  if (!isReshapeConfigured()) return NextResponse.json({ renderedMd: body, source: 'canonical' });

  try {
    const result = await reshapePageBody({
      subject,
      body,
      profile: { backgroundSummary: profile.backgroundSummary, stylePrefs: profile.stylePrefs },
      abortSignal: request.signal,
    });
    if (result.fallback) return NextResponse.json({ renderedMd: body, source: 'fallback' });
    upsertRendition({
      subjectId: subject.id, slug, canonicalHash: hash, profileVersion: profile.version,
      renderedMd: result.body, model: result.model,
    });
    return NextResponse.json({ renderedMd: result.body, source: 'generated' });
  } catch {
    return NextResponse.json({ renderedMd: body, source: 'canonical' });
  }
}
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run src/app/api/lens/[...slug]/__tests__/lens-route.test.ts`
Expected: PASS（4 passed）
Run: `npx tsc --noEmit`

- [ ] **Step 5: commit**

```bash
git add src/app/api/lens src/app/api/lens/\[...slug\]/__tests__
git commit -m "feat(api): 新增 GET /api/lens/[...slug]（缓存优先的整页重塑读端点）"
```

---

## Phase 4 — 前端（A 整页透镜）

> 前端组件项目内无单元测试惯例（见 `components/CLAUDE.md`）。这些任务以 `npx tsc --noEmit` 为门禁 + 手动验证（`npm run dev:all` 后开页观察）。可单测的逻辑已下沉到 Phase 0–3 的纯函数/服务。

### Task 14: React Query hooks（use-profile / use-lens）

**Files:**
- Create: `src/hooks/use-profile.ts`
- Create: `src/hooks/use-lens.ts`

**Interfaces:**
- Produces:
  - `useProfile(): { data?: { profile: UserProfileDTO; onboarded: boolean }; ... }`（React Query GET `/api/profile`）
  - `useUpdateProfile(): mutation`（PUT `/api/profile`，成功 invalidate `['profile']` + `['lens']`）
  - `useLens(slug: string, enabled: boolean): { data?: { renderedMd: string; source: string }; isLoading; ... }`（GET `/api/lens/<slug>`）
  - `useSendSignal(): mutation`（POST `/api/profile/signals`，成功 invalidate `['profile']` + `['lens']`）

- [ ] **Step 1: 实现 use-profile.ts**

```ts
// src/hooks/use-profile.ts
'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import type { UserProfileDTO, StylePrefs } from '@/lib/contracts';

export function useProfile() {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['profile'],
    queryFn: async (): Promise<{ profile: UserProfileDTO; onboarded: boolean }> => {
      const res = await apiFetch('/api/profile');
      if (!res.ok) throw new Error(`profile ${res.status}`);
      return res.json();
    },
  });
}

export function useUpdateProfile() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: { backgroundSummary?: string; stylePrefs?: StylePrefs; markOnboarded?: boolean }) => {
      const res = await apiFetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`profile PUT ${res.status}`);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['profile'] });
      qc.invalidateQueries({ queryKey: ['lens'] });
    },
  });
}

export function useSendSignal() {
  const apiFetch = useApiFetch();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (payload: { type: string; slug?: string }) => {
      const res = await apiFetch('/api/profile/signals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`signal ${res.status}`);
      return res.json() as Promise<{ changed: boolean; version: number }>;
    },
    onSuccess: (data) => {
      if (data.changed) {
        qc.invalidateQueries({ queryKey: ['profile'] });
        qc.invalidateQueries({ queryKey: ['lens'] }); // 画像变了 → 重塑缓存键变 → 重取
      }
    },
  });
}
```

- [ ] **Step 2: 实现 use-lens.ts**

```ts
// src/hooks/use-lens.ts
'use client';
import { useQuery } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';

export interface LensResult { renderedMd: string; source: 'cache' | 'generated' | 'canonical' | 'fallback'; }

export function useLens(slug: string, enabled: boolean) {
  const apiFetch = useApiFetch();
  return useQuery({
    queryKey: ['lens', slug],
    enabled,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<LensResult> => {
      const res = await apiFetch(`/api/lens/${slug.split('/').map(encodeURIComponent).join('/')}`);
      if (!res.ok) throw new Error(`lens ${res.status}`);
      return res.json();
    },
  });
}
```

- [ ] **Step 3: 类型检查 + commit**

Run: `npx tsc --noEmit`
Expected: 无错误

```bash
git add src/hooks/use-profile.ts src/hooks/use-lens.ts
git commit -m "feat(hooks): 新增 use-profile / use-lens / use-send-signal"
```

---

### Task 15: WikiReadingView 接入透镜（默认重塑 + 看原文开关）

**Files:**
- Modify: `src/components/wiki/wiki-reading-view.tsx`

**Interfaces:**
- Consumes: Task 14 `useLens`、Task 16 的 `LensFeedback`（Task 16 创建；本任务先不挂反馈，仅做 toggle + 渲染切换）

**改造点（在现有组件内）：**
1. 顶部 import `useLens`。
2. 新增 state：`const [showOriginal, setShowOriginal] = useState(false);`
3. 调 `const lens = useLens(slug, true);`
4. 计算要渲染的正文：`const displayContent = showOriginal ? props.content : (lens.data?.renderedMd ?? props.content);`
5. 把 `rendererProps.content` 用 `displayContent` 覆盖后传给 `PageRenderer`。
6. 在 `toolbar` 里加一个透镜状态条 + 「看原文 / 看重塑版」按钮（lens 加载中显示 spinner 文案）。

具体替换：把

```tsx
const article = (
  <>
    <PageRenderer {...rendererProps} />
    <Backlinks backlinks={backlinks} />
  </>
);
```

改为：

```tsx
const lens = useLens(slug, true);
const reshaped = lens.data?.renderedMd;
const usingReshaped = !showOriginal && reshaped != null && lens.data?.source !== 'canonical' && lens.data?.source !== 'fallback';
const displayContent = showOriginal ? props.content : (reshaped ?? props.content);

const article = (
  <>
    <LensBar
      loading={lens.isLoading}
      usingReshaped={usingReshaped}
      showOriginal={showOriginal}
      onToggle={() => setShowOriginal((v) => !v)}
    />
    <PageRenderer {...rendererProps} content={displayContent} />
    <Backlinks backlinks={backlinks} />
  </>
);
```

并新增 `showOriginal` state（与其它 useState 并列）与 `LensBar` 子组件：

```tsx
function LensBar({
  loading, usingReshaped, showOriginal, onToggle,
}: { loading: boolean; usingReshaped: boolean; showOriginal: boolean; onToggle: () => void }) {
  return (
    <div className="mx-auto flex w-full items-center gap-2 px-6 pt-4 max-w-[var(--reading-max-width)] text-xs text-foreground-tertiary">
      {loading && !showOriginal ? (
        <span className="inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> 正在按你的画像调整…</span>
      ) : usingReshaped && !showOriginal ? (
        <span className="inline-flex items-center gap-1.5"><Sparkles className="h-3 w-3 text-accent" /> 已按你的画像调整</span>
      ) : (
        <span>原文</span>
      )}
      <Button intent="outline" size="sm" className="ml-auto" onClick={onToggle}>
        {showOriginal ? '看重塑版' : '看原文'}
      </Button>
    </div>
  );
}
```

> `Loader2` / `Sparkles` 已在该文件 import；`Button` 已 import。`PageRenderer` 接受 `content` prop（覆盖 `rendererProps.content` 即可，spread 后再显式传 `content` 以后者为准）。

- [ ] **Step 1: 按上述改造 wiki-reading-view.tsx**
- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 手动验证**

启动 `npm run dev:all`，打开任一页：
- 默认显示「正在按你的画像调整…」→ 几秒后切重塑版 + 「已按你的画像调整」。
- 点「看原文」→ 即时切回 canonical；再点「看重塑版」切回。
- 未配置 `reshape:*` 时：直接显示原文，状态条显示「原文」。

- [ ] **Step 4: commit**

```bash
git add src/components/wiki/wiki-reading-view.tsx
git commit -m "feat(wiki): 阅读页默认显示画像重塑版 + 看原文即时开关"
```

---

### Task 16: 反馈控件（太难 / 太浅 → 信号）

**Files:**
- Create: `src/components/wiki/lens-feedback.tsx`
- Modify: `src/components/wiki/wiki-reading-view.tsx`（在文末挂 `<LensFeedback slug={slug} />`）

**Interfaces:**
- Consumes: Task 14 `useSendSignal`
- Produces: `LensFeedback({ slug }: { slug: string })` —— 渲染「太难」「太浅」两个按钮，点击发对应信号；发出后短暂提示「已记录，将调整后续呈现」。

- [ ] **Step 1: 实现 lens-feedback.tsx**

```tsx
// src/components/wiki/lens-feedback.tsx
'use client';
import { useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSendSignal } from '@/hooks/use-profile';

export function LensFeedback({ slug }: { slug: string }) {
  const send = useSendSignal();
  const [sent, setSent] = useState<string | null>(null);

  const fire = (type: 'too_hard' | 'too_easy') => {
    send.mutate({ type, slug });
    setSent(type === 'too_hard' ? '太难' : '太浅');
  };

  return (
    <div className="mx-auto w-full px-6 pb-12 max-w-[var(--reading-max-width)]">
      <div className="flex items-center gap-3 border-t border-border pt-6 text-xs text-foreground-tertiary">
        <span>这页的讲法对你合适吗？</span>
        <Button intent="outline" size="sm" onClick={() => fire('too_hard')} disabled={send.isPending}>
          <ThumbsDown className="h-3.5 w-3.5" /> 太难
        </Button>
        <Button intent="outline" size="sm" onClick={() => fire('too_easy')} disabled={send.isPending}>
          <ThumbsUp className="h-3.5 w-3.5" /> 太浅
        </Button>
        {sent && <span className="text-accent-strong">已记录「{sent}」，将调整后续呈现</span>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 在 wiki-reading-view.tsx 挂载**

在 `article` 的 `<Backlinks ... />` 之后加 `<LensFeedback slug={slug} />`，并在顶部 import：`import { LensFeedback } from './lens-feedback';`

- [ ] **Step 3: 类型检查 + 手动验证**

Run: `npx tsc --noEmit`
手动：连点「太难」2 次 → 第二次后（达阈值）刷新页面应观察到正文更简单（readingLevel 降档生效）。

- [ ] **Step 4: commit**

```bash
git add src/components/wiki/lens-feedback.tsx src/components/wiki/wiki-reading-view.tsx
git commit -m "feat(wiki): 阅读页加太难/太浅反馈，喂回画像学习闭环"
```

---

### Task 17: onboarding 向导 + 设置面板「认知画像」区

**Files:**
- Create: `src/components/layout/cognitive-lens-onboarding.tsx`
- Modify: `src/components/layout/settings-categories.ts`（+`'cognitive-lens'`）
- Modify: `src/components/layout/settings-content.tsx`（+`CognitiveLensPanel`）
- Modify: 在某个常驻客户端组件（如 `src/components/providers.tsx` 或 `(app)/layout.tsx` 的客户端子树）挂 `<CognitiveLensOnboarding />`

**Interfaces:**
- Consumes: Task 14 `useProfile` / `useUpdateProfile`

**实现要点：**
- `CognitiveLensOnboarding`：`useProfile()`，若 `data && !data.onboarded` 弹一个轻量 modal：一段背景文本框 + 4 个 `select`（readingLevel/verbosity/exampleDensity/formality）→ 「保存」调 `useUpdateProfile().mutate({ backgroundSummary, stylePrefs, markOnboarded: true })`。「跳过」调 `mutate({ markOnboarded: true })`（用默认偏好）。
- `settings-categories.ts`：`CategoryId` union 加 `'cognitive-lens'`；`SETTINGS_CATEGORIES` 加 `{ id: 'cognitive-lens', label: 'Cognitive Lens', icon: Brain }`（`Brain` from lucide-react）。
- `settings-content.tsx`：加 `{props.active === 'cognitive-lens' && <CognitiveLensPanel />}`；`CognitiveLensPanel` 用 `useProfile()` 读当前值 + 本地 draft + `useUpdateProfile()` 保存（4 个 `SelectSettingRow` + 一个 `TextSettingRow` 背景）。

```tsx
// src/components/layout/cognitive-lens-onboarding.tsx
'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useProfile, useUpdateProfile } from '@/hooks/use-profile';
import type { StylePrefs } from '@/lib/contracts';

const DEFAULTS: StylePrefs = { readingLevel: 'intermediate', verbosity: 'balanced', exampleDensity: 'some', formality: 'neutral' };

export function CognitiveLensOnboarding() {
  const { data } = useProfile();
  const update = useUpdateProfile();
  const [bg, setBg] = useState('');
  const [prefs, setPrefs] = useState<StylePrefs>(DEFAULTS);

  if (!data || data.onboarded) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-6 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold">让内容更贴合你</h2>
        <p className="mb-4 text-sm text-foreground-tertiary">
          告诉我你的背景与喜好，阅读时会按它调整每页的讲法（随时可在设置里改，也会随你的反馈自动微调）。
        </p>
        <textarea
          value={bg}
          onChange={(e) => setBg(e.target.value)}
          placeholder="例如：后端工程师，懂分布式系统，但机器学习是新手"
          className="mb-4 h-24 w-full rounded-md border border-border bg-canvas p-2 text-sm"
        />
        {/* 4 个 select：readingLevel / verbosity / exampleDensity / formality */}
        <PrefSelect label="阅读难度基线" value={prefs.readingLevel} options={['beginner', 'intermediate', 'advanced']} onChange={(v) => setPrefs({ ...prefs, readingLevel: v as StylePrefs['readingLevel'] })} />
        <PrefSelect label="详尽度" value={prefs.verbosity} options={['terse', 'balanced', 'thorough']} onChange={(v) => setPrefs({ ...prefs, verbosity: v as StylePrefs['verbosity'] })} />
        <PrefSelect label="举例/类比密度" value={prefs.exampleDensity} options={['few', 'some', 'many']} onChange={(v) => setPrefs({ ...prefs, exampleDensity: v as StylePrefs['exampleDensity'] })} />
        <PrefSelect label="语气" value={prefs.formality} options={['casual', 'neutral', 'formal']} onChange={(v) => setPrefs({ ...prefs, formality: v as StylePrefs['formality'] })} />
        <div className="mt-5 flex justify-end gap-2">
          <Button intent="ghost" size="sm" onClick={() => update.mutate({ markOnboarded: true })}>跳过</Button>
          <Button intent="primary" size="sm" disabled={update.isPending}
            onClick={() => update.mutate({ backgroundSummary: bg, stylePrefs: prefs, markOnboarded: true })}>
            保存并开始
          </Button>
        </div>
      </div>
    </div>
  );
}

function PrefSelect({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <label className="mb-2 flex items-center justify-between gap-3 text-sm">
      <span className="text-foreground-secondary">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-md border border-border bg-canvas px-2 py-1 text-sm">
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}
```

> `CognitiveLensPanel`（settings-content.tsx 内）结构同上但读 `data.profile`（已 onboarded），改动即 `update.mutate({...})`；复用 `SelectSettingRow` / `TextSettingRow` 原语保持视觉一致。

- [ ] **Step 1: 实现 onboarding 组件**
- [ ] **Step 2: settings-categories.ts 加分类**
- [ ] **Step 3: settings-content.tsx 加 CognitiveLensPanel + 挂 onboarding**
- [ ] **Step 4: 类型检查 + 手动验证**

Run: `npx tsc --noEmit`
手动：清空 `user_profiles`（或新库）首开 → 弹 onboarding；保存后不再弹；设置面板「Cognitive Lens」可改并立即影响下次重塑（lens 缓存因 version 变化失效）。

- [ ] **Step 5: commit**

```bash
git add src/components/layout/cognitive-lens-onboarding.tsx src/components/layout/settings-categories.ts src/components/layout/settings-content.tsx src/components/providers.tsx
git commit -m "feat(ui): 新增认知画像 onboarding 向导 + 设置面板 Cognitive Lens 区"
```

---

## Phase 5 — 段级重塑 B（可在 MVP 验收后再做）

### Task 18: reshapeSection 服务路径 + POST /api/reshape-section

**Files:**
- Create: `src/app/api/reshape-section/route.ts`
- Test: `src/app/api/reshape-section/__tests__/route.test.ts`

**Interfaces:**
- Consumes: Task 10 `reshapeSection`、`resolveSubjectFromRequest`、`resolveUserId`、`getProfileOrDefault`、`applySignal`
- Produces: `POST /api/reshape-section` body `{ slug: string; block: string; direction: 'simpler' | 'deeper'; context?: string }` → `{ block: string; fallback: boolean }`；同时 append `simplify_click`/`deepen_click` 信号。

- [ ] **Step 1: 写失败测试**

```ts
// src/app/api/reshape-section/__tests__/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const subject = { id: 's1', slug: 'general', name: 'G', description: '', augmentationLevel: 'standard', createdAt: '', updatedAt: '' };
vi.mock('@/server/middleware/auth', () => ({ requireAuth: () => null, requireCsrf: () => null }));
vi.mock('@/server/middleware/user', () => ({ resolveUserId: () => 'local' }));
vi.mock('@/server/middleware/subject', () => ({ resolveSubjectFromRequest: () => ({ subject, error: null }) }));
vi.mock('@/server/db/repos/profiles-repo', () => ({ getProfileOrDefault: () => ({ stylePrefs: {}, version: 1, backgroundSummary: '' }) }));
const applySignal = vi.fn();
vi.mock('@/server/services/apply-signal', () => ({ applySignal: (...a: unknown[]) => applySignal(...a) }));
const reshapeSection = vi.fn();
vi.mock('@/server/services/reshape-service', () => ({ reshapeSection: (...a: unknown[]) => reshapeSection(...a) }));

beforeEach(() => { applySignal.mockReset(); reshapeSection.mockReset(); });

it('POST 重塑段并发信号', async () => {
  reshapeSection.mockResolvedValue({ block: '更简单的段', fallback: false });
  const { POST } = await import('../route');
  const req = new NextRequest('http://x/api/reshape-section', {
    method: 'POST',
    body: JSON.stringify({ slug: 'a', block: '原段', direction: 'simpler' }),
    headers: { 'Content-Type': 'application/json' },
  });
  const r = await POST(req);
  expect(await r.json()).toEqual({ block: '更简单的段', fallback: false });
  expect(applySignal).toHaveBeenCalledWith('local', 'simplify_click', expect.anything());
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/app/api/reshape-section/__tests__/route.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// src/app/api/reshape-section/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveUserId } from '@/server/middleware/user';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import { getProfileOrDefault } from '@/server/db/repos/profiles-repo';
import { reshapeSection } from '@/server/services/reshape-service';
import { applySignal } from '@/server/services/apply-signal';

export const runtime = 'nodejs';

const Body = z.object({
  slug: z.string(),
  block: z.string().min(1),
  direction: z.enum(['simpler', 'deeper']),
  context: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const resolution = resolveSubjectFromRequest(request, { required: true, body });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;
  const userId = resolveUserId(request);
  const profile = getProfileOrDefault(userId);

  const result = await reshapeSection({
    subject,
    block: body.block,
    direction: body.direction,
    profile: { backgroundSummary: profile.backgroundSummary, stylePrefs: profile.stylePrefs },
    context: body.context,
  });
  applySignal(userId, body.direction === 'simpler' ? 'simplify_click' : 'deepen_click', {
    subjectId: subject.id, slug: body.slug,
  });
  return NextResponse.json(result);
}
```

- [ ] **Step 4: 跑测试 + 类型检查**

Run: `npx vitest run src/app/api/reshape-section/__tests__/route.test.ts`
Expected: PASS
Run: `npx tsc --noEmit`

- [ ] **Step 5: commit**

```bash
git add src/app/api/reshape-section
git commit -m "feat(api): 新增 POST /api/reshape-section（段级重塑 + 发信号）"
```

---

### Task 19: 段级重塑 UI（选区触发）

**Files:**
- Modify: `src/components/wiki/lens-feedback.tsx`（或新建 `src/components/wiki/section-reshape.tsx`）
- Modify: `src/components/wiki/wiki-reading-view.tsx`

**实现要点（选区触发，避免逐块插桩）：**
- 在 `PageRenderer` 外层容器监听 `mouseup`：若 `window.getSelection()` 文本非空，在选区附近显示一个浮动小工具条（「说简单点 / 讲深点」）。
- 点击 → 取选中文本作为 `block`，POST `/api/reshape-section`，把返回的 `block` 通过一个受控的"段级覆盖"map 注入显示（最简实现：把该选区文本在 `displayContent` 里做一次性字符串替换并 setState；replace 仅作用于当前显示文本，原 canonical 不动）。
- fallback=true → toast「这段暂时无法简化，已保留原文」。

> 此任务为交互体验增强，纯前端、无新单测；以 `npx tsc --noEmit` + 手动验证为门禁。若选区→字符串替换在富 markdown 下不稳定，可降级为「整段所在标题区块」粒度，或推迟到独立迭代（不阻塞 MVP）。

- [ ] **Step 1: 实现选区浮动条 + 调用 `/api/reshape-section`**
- [ ] **Step 2: 类型检查 + 手动验证**

Run: `npx tsc --noEmit`
手动：选中一段 → 浮条出现 → 点「说简单点」→ 该段就地变简单；连点会经信号闭环影响整体画像。

- [ ] **Step 3: commit**

```bash
git add src/components/wiki/section-reshape.tsx src/components/wiki/wiki-reading-view.tsx
git commit -m "feat(wiki): 段级重塑选区交互（说简单点/讲深点）"
```

---

## Phase 6 — 收尾

### Task 20: 文档 + subject 删除清缓存

**Files:**
- Modify: `src/server/db/repos/subjects-repo.ts`（或 subject 删除路由）—— 删 subject 时调 `renditionsRepo.deleteBySubject(id)`
- Modify: 根 `CLAUDE.md`（变更记录加一行）
- Modify: `src/server/db/CLAUDE.md` / `src/server/services/CLAUDE.md` / `src/server/llm/CLAUDE.md` / `src/components/CLAUDE.md`（各补对应小节）

- [ ] **Step 1: 找到 subject 删除路径，删前调 `deleteBySubject`**

```bash
grep -rn "deleteSubject\|DELETE.*subject" src/app/api/subjects src/server/db/repos/subjects-repo.ts
```
在删除 subject 的实现里（fs/DB 删除前后任一处），加：
```ts
import { deleteBySubject } from '@/server/db/repos/renditions-repo';
// ... 删 subject 时：
deleteBySubject(subjectId);
```

- [ ] **Step 2: 跑全量测试 + 类型检查**

Run: `npx vitest run`
Expected: 全绿（含本特性新增用例）
Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 3: 更新文档**

- 根 `CLAUDE.md`「九、变更记录」加：`| 2026-06-26 | 认知画像读时透镜（Cognitive Lens）| 新增 user_profiles/page_renditions/profile_signals 三表 + profiles/renditions/signals repos + profile/{style,signal-reducer,rendition-hash,fidelity} 纯函数 + reshape:* LLM 任务 + reshape-service（保真重试再回落）+ GET /api/lens/[...slug]（缓存优先）+ /api/profile(/signals) + 阅读页默认重塑/看原文开关/太难太浅反馈 + onboarding；canonical 零侵入，重塑为可丢弃读侧缓存；spec/plan 见 docs/superpowers/{specs,plans}/2026-06-26-cognitive-lens* |`
- `src/server/db/CLAUDE.md`：repos 表补 profiles/renditions/signals。
- `src/server/services/CLAUDE.md`：补 reshape-service / apply-signal。
- `src/server/llm/CLAUDE.md`：补 reshape prompts + `isReshapeConfigured` + `reshape:*` 路由。
- `src/components/CLAUDE.md`：补 wiki-reading-view 透镜改造 + lens-feedback + cognitive-lens-onboarding + 设置新增 panel。

- [ ] **Step 4: commit**

```bash
git add -A
git commit -m "docs(cognitive-lens): subject 删除清重塑缓存 + 更新各级 CLAUDE.md 与变更记录"
```

---

## Self-Review（计划对 spec 的覆盖核对）

**1. Spec 覆盖：**
- 决策1 canonical 神圣 → Task 13 路由只写 renditions、reshape-service 不碰 vault ✅
- 决策2 读时重塑 → Task 13 + Task 15 ✅
- 决策3 A 打底 + B 逃生口 → A=Task 13/15；B=Task 18/19（可分期）✅
- 决策4 保真护栏 → Task 4 checkLinkSubset + Task 10 重试再回落；frontmatter 因只重塑 body 而天然免疫（已在 Task 4 说明）✅
- 决策5 双维画像 → Task 1 stylePrefs + backgroundSummary（Task 6）✅
- 决策6 种子+反馈 → onboarding=Task 17；reducer 闭环=Task 2/12 ✅
- 决策7 首开延迟 → **改为** canonical 即时显示 + 重塑后台替换（Task 15），见下方"对 spec 的偏离"✅
- 决策8 缓存键惰性失效 → Task 5 表（一页一行 hash+version）+ Task 7 repo ✅
- 数据模型 3 表 → Task 5 ✅
- API（profile/signals/lens/section）→ Task 11/12/13/18 ✅
- 前端（阅读页/反馈/onboarding/设置）→ Task 15/16/17 ✅
- 测试策略（纯函数/repos/prompt/service/路由）→ Task 1–13、18 均含 ✅
- 范围红线（不做多租户 auth / 不预生成分层 / 不碰 ingest）→ 全程遵守；resolveUserId 单例 ✅

**2. 对 spec 的偏离（已在计划内显式标注，待执行/评审确认）：**
- **lens 端点由 SSE 流式改为 JSON 一次性响应**：客户端先即时显示 canonical，再后台替换重塑版。理由：① 整页改写后才能跑保真护栏 + 重试，流式会把未校验内容先吐给用户；② 用户面向的「canonical 即时 + 重塑跟随」保证不变，且「看原文」本就即时；③ 大幅简化路由与前端（无需 use-lens-stream/SSE 解析）。
- **保真"重试一次再回落"**：整页路径保留（Task 10）；不在流式中途处理（因已改 JSON）。
- **fidelity.ts 去掉 frontmatter 拆拼**：`readPageInSubject` 已分离 body/frontmatter，重塑只作用于 body，frontmatter 由代码侧免疫，无需在护栏处理（spec 第 4.3 的 split/reattach 不再需要）。

**3. 占位符扫描：** 无 TBD/TODO；每个代码步给了完整代码与命令。Task 19 为体验增强、显式标注"可降级/可推迟"，非占位符。

**4. 类型一致性：** `StylePrefs` 在 `style.ts`（zod 推导）与 `contracts.ts`（前端纯类型）两处枚举字面量保持一致（Task 11 Step 3b 加编译期一致性断言护栏）；`getRendition`/`upsertRendition`/`getProfileOrDefault`/`reshapePageBody`/`applySignal` 等跨任务签名前后一致。
