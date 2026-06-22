# 语义检索（混合 FTS + 向量）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** chat 检索（`prepareQueryContext`）加入向量语义召回，与 FTS5 关键词召回 RRF 混合；embedding 经 OpenAI-compatible（llm-config 配置），向量存 SQLite BLOB + JS 暴力 cosine；嵌入索引走脱离 Saga 的 `embed-index` worker 任务；未配置时优雅降级纯 FTS。

**Architecture:** 写侧——`embed-index` 任务回填缺/过期页向量（按 model+content_hash 判定）+ prune 孤儿，写后 enqueue + 启动自愈。读侧——`prepareQueryContext` 改 async，`hybridRankSlugs` 跑 FTS + 向量两路经 `rrfMerge` 合并。纯函数（编解码/cosine/RRF）集中在 `server/search/vector-math.ts`。

**Tech Stack:** Next.js 15 + better-sqlite3（BLOB）+ Vercel AI SDK（`embedMany`）+ vitest（node-only）。

关联 spec：`docs/superpowers/specs/2026-06-22-semantic-search-design.md`。

## Global Constraints

- 思考英文；task/plan/comment/commit message 用**中文**；commit message 一句话；**禁止任何 AI 署名 trailer/脚注**（无 `Co-Authored-By`、无 "Generated with Claude Code"）。
- 门禁 = `npx tsc --noEmit` 0 + `npx vitest run` 全绿；`npm run lint` BASE 即坏，**非**门禁。
- **不**改 Saga 主控 / git-service / `streamTextResponse` 签名 / `seedSkillFiles` / FTS5 / 命令面板检索（`/api/search`）；新表无 legacy 迁移（仅 `tableExists` 守卫的 CREATE）。
- 嵌入索引**严禁**进 `applyChangeset` 事务；走 worker `embed-index` 任务（registerHandler + 强校验 subjectId）。
- embedding 经 `resolveTask('embedding')` + provider 抽象，不绕过 llm-config；`isEmbeddingConfigured()` 为 false 时索引 no-op、检索纯 FTS。
- 向量编解码/cosine/RRF 为纯函数（`server/search/vector-math.ts`），单一真实源，不在别处复刻。
- 过期判定：页 `contentHash` 变 或 配置 `model` 变 → 重嵌；`semanticSearch`/`listForSubject` 仅取当前模型向量。
- `foreign_keys=ON`：测试涉及 FK 表须先插 subjects。
- 路由/服务沿用既有鉴权与 subject 解析约定。

---

### Task 1: `server/search/vector-math.ts` 纯函数

**Files:**
- Create: `src/server/search/vector-math.ts`
- Test: `src/server/search/__tests__/vector-math.test.ts`

**Interfaces:**
- Produces:
  ```ts
  encodeVector(v: number[]): Buffer
  decodeVector(buf: Buffer): Float32Array
  cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number   // 维度不等 → 0；任一零向量 → 0
  rrfMerge(listA: string[], listB: string[], k: number, topN: number): string[]
  ```

- [ ] **Step 1: 写失败测试**

新建 `src/server/search/__tests__/vector-math.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { encodeVector, decodeVector, cosineSimilarity, rrfMerge } from '../vector-math';

describe('vector-math', () => {
  it('encode/decode round-trip（Float32 精度）', () => {
    const v = [0.1, -0.5, 1.0, 0.3333333];
    const out = Array.from(decodeVector(encodeVector(v)));
    expect(out).toHaveLength(4);
    out.forEach((x, i) => expect(x).toBeCloseTo(v[i], 5));
  });

  it('cosine 同向≈1 / 正交=0 / 反向≈-1', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('cosine 维度不等 → 0；零向量 → 0', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('rrfMerge 融合两路排名 + 去重 + topN', () => {
    // a 中 x 排第 0、y 第 1；b 中 y 第 0、z 第 1 → y 双榜得分最高
    const merged = rrfMerge(['x', 'y'], ['y', 'z'], 60, 3);
    expect(merged[0]).toBe('y');
    expect(new Set(merged).size).toBe(merged.length); // 去重
    expect(merged.length).toBeLessThanOrEqual(3);
  });

  it('rrfMerge 一路为空 → 退化为另一路顺序', () => {
    expect(rrfMerge(['a', 'b', 'c'], [], 60, 2)).toEqual(['a', 'b']);
    expect(rrfMerge([], ['a', 'b', 'c'], 60, 2)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/search/__tests__/vector-math.test.ts`
Expected: FAIL（找不到模块 `../vector-math`）

- [ ] **Step 3: 实现**

新建 `src/server/search/vector-math.ts`：

```ts
/** Float32 向量 ↔ Buffer 编解码 + cosine + RRF（语义检索纯函数单一真实源）。 */

export function encodeVector(v: number[]): Buffer {
  const f32 = Float32Array.from(v);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function decodeVector(buf: Buffer): Float32Array {
  // 复制到对齐的 ArrayBuffer，避免共享底层 buffer 的偏移问题
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, Math.floor(copy.byteLength / 4));
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Reciprocal Rank Fusion：每个 id 分数 = Σ 1/(k + rank0based)（出现在某列表才计该项），
 * 按分数降序去重取 topN。无需归一化两路分数。
 */
export function rrfMerge(listA: string[], listB: string[], k: number, topN: number): string[] {
  const score = new Map<string, number>();
  const add = (list: string[]) => {
    list.forEach((id, rank) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (k + rank));
    });
  };
  add(listA);
  add(listB);
  return [...score.entries()]
    .sort((x, y) => y[1] - x[1])
    .slice(0, topN)
    .map(([id]) => id);
}
```

- [ ] **Step 4: 运行确认通过 + tsc + 提交**

Run: `npx vitest run src/server/search/__tests__/vector-math.test.ts`
Expected: PASS（5 个用例）

```bash
npx tsc --noEmit
git add src/server/search/vector-math.ts src/server/search/__tests__/vector-math.test.ts
git commit -m "feat: vector-math 纯函数（向量编解码/cosine/RRF 合并）"
```

---

### Task 2: `page_embeddings` 表 + `embeddings-repo`

**Files:**
- Modify: `src/server/db/schema.ts`（Drizzle `pageEmbeddings` 表）
- Modify: `src/server/db/client.ts`（`migratePageEmbeddings()` + 在 `ensureTables` 注册）
- Create: `src/server/db/repos/embeddings-repo.ts`
- Test: `src/server/db/repos/__tests__/embeddings-repo.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function upsertEmbedding(row: { subjectId: string; slug: string; model: string; contentHash: string; dim: number; vector: Buffer }): void
  export function listForSubject(subjectId: string, model: string): { slug: string; contentHash: string; dim: number; vector: Buffer }[]
  export function deleteBySlug(subjectId: string, slug: string): void
  export function pruneOrphans(subjectId: string, liveSlugs: string[]): void
  ```
- Consumes: `getRawDb`（`../client`）；`new Date().toISOString()`。

- [ ] **Step 1: Drizzle schema 加表**

`src/server/db/schema.ts` 末尾追加：

```ts
export const pageEmbeddings = sqliteTable(
  'page_embeddings',
  {
    subjectId: text('subject_id')
      .notNull()
      .references(() => subjects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    model: text('model').notNull(),
    contentHash: text('content_hash').notNull(),
    dim: integer('dim').notNull(),
    vector: blob('vector').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.subjectId, t.slug] }) })
);
```

> 若 `blob` / `integer` / `primaryKey` 未在 schema.ts 顶部 import，则补到现有 `drizzle-orm/sqlite-core` import 行。

- [ ] **Step 2: client.ts 建表 + 注册**

`src/server/db/client.ts` 在 `migrateIngestCheckpoints`（或 `migrateMessages`）之后追加：

```ts
function migratePageEmbeddings(): void {
  const sqlite = rawSqlite!;
  if (tableExists('page_embeddings')) return;
  sqlite.exec(`
    CREATE TABLE page_embeddings (
      subject_id TEXT NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      model TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vector BLOB NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (subject_id, slug)
    );
  `);
}
```

在 `ensureTables` 内（`ensurePagesFts();` 之前）插入 `migratePageEmbeddings();`。

- [ ] **Step 3: 写失败测试**

新建 `src/server/db/repos/__tests__/embeddings-repo.test.ts`（夹具同 `conversations-repo.test.ts`；先插 subjects；用 slug `sub-a`/`sub-b` 避开自动 seed 的 general）：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let prevDb: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'embeddings-repo-'));
  prevDb = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  vi.resetModules();
});
afterEach(() => {
  process.env.DATABASE_PATH = prevDb;
  rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const { getRawDb } = await import('../../client');
  const db = getRawDb();
  db.prepare(`INSERT INTO subjects (id, slug, name, description, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run('s1', 'sub-a', 'Sub A', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  return import('../embeddings-repo');
}

const buf = (nums: number[]) => Buffer.from(Float32Array.from(nums).buffer);

describe('embeddings-repo', () => {
  it('upsert + listForSubject(model 过滤) + vector round-trip', async () => {
    const repo = await setup();
    repo.upsertEmbedding({ subjectId: 's1', slug: 'a', model: 'm1', contentHash: 'h1', dim: 2, vector: buf([1, 0]) });
    repo.upsertEmbedding({ subjectId: 's1', slug: 'b', model: 'm2', contentHash: 'h2', dim: 2, vector: buf([0, 1]) });
    const rows = repo.listForSubject('s1', 'm1');
    expect(rows.map((r) => r.slug)).toEqual(['a']); // m2 被过滤
    expect(Array.from(new Float32Array(rows[0].vector.buffer, rows[0].vector.byteOffset, 2))).toEqual([1, 0]);
  });

  it('upsert 同 (subject,slug) 覆盖', async () => {
    const repo = await setup();
    repo.upsertEmbedding({ subjectId: 's1', slug: 'a', model: 'm1', contentHash: 'h1', dim: 2, vector: buf([1, 0]) });
    repo.upsertEmbedding({ subjectId: 's1', slug: 'a', model: 'm1', contentHash: 'h2', dim: 2, vector: buf([0, 1]) });
    const rows = repo.listForSubject('s1', 'm1');
    expect(rows).toHaveLength(1);
    expect(rows[0].contentHash).toBe('h2');
  });

  it('deleteBySlug', async () => {
    const repo = await setup();
    repo.upsertEmbedding({ subjectId: 's1', slug: 'a', model: 'm1', contentHash: 'h1', dim: 2, vector: buf([1, 0]) });
    repo.deleteBySlug('s1', 'a');
    expect(repo.listForSubject('s1', 'm1')).toEqual([]);
  });

  it('pruneOrphans 删除 slug ∉ liveSlugs 的行', async () => {
    const repo = await setup();
    repo.upsertEmbedding({ subjectId: 's1', slug: 'a', model: 'm1', contentHash: 'h1', dim: 2, vector: buf([1, 0]) });
    repo.upsertEmbedding({ subjectId: 's1', slug: 'b', model: 'm1', contentHash: 'h2', dim: 2, vector: buf([0, 1]) });
    repo.pruneOrphans('s1', ['a']);
    expect(repo.listForSubject('s1', 'm1').map((r) => r.slug)).toEqual(['a']);
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `npx vitest run src/server/db/repos/__tests__/embeddings-repo.test.ts`
Expected: FAIL（找不到模块 `../embeddings-repo`）

- [ ] **Step 5: 实现 repo**

新建 `src/server/db/repos/embeddings-repo.ts`：

```ts
import { getRawDb } from '../client';

interface RawRow {
  slug: string;
  content_hash: string;
  dim: number;
  vector: Buffer;
}

export function upsertEmbedding(row: {
  subjectId: string;
  slug: string;
  model: string;
  contentHash: string;
  dim: number;
  vector: Buffer;
}): void {
  getRawDb()
    .prepare(
      `INSERT INTO page_embeddings (subject_id, slug, model, content_hash, dim, vector, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject_id, slug) DO UPDATE SET
         model = excluded.model,
         content_hash = excluded.content_hash,
         dim = excluded.dim,
         vector = excluded.vector,
         updated_at = excluded.updated_at`
    )
    .run(
      row.subjectId,
      row.slug,
      row.model,
      row.contentHash,
      row.dim,
      row.vector,
      new Date().toISOString()
    );
}

export function listForSubject(
  subjectId: string,
  model: string
): { slug: string; contentHash: string; dim: number; vector: Buffer }[] {
  const rows = getRawDb()
    .prepare(
      `SELECT slug, content_hash, dim, vector FROM page_embeddings
       WHERE subject_id = ? AND model = ?`
    )
    .all(subjectId, model) as RawRow[];
  return rows.map((r) => ({
    slug: r.slug,
    contentHash: r.content_hash,
    dim: r.dim,
    vector: r.vector,
  }));
}

export function deleteBySlug(subjectId: string, slug: string): void {
  getRawDb()
    .prepare(`DELETE FROM page_embeddings WHERE subject_id = ? AND slug = ?`)
    .run(subjectId, slug);
}

export function pruneOrphans(subjectId: string, liveSlugs: string[]): void {
  const db = getRawDb();
  const all = db
    .prepare(`SELECT slug FROM page_embeddings WHERE subject_id = ?`)
    .all(subjectId) as { slug: string }[];
  const live = new Set(liveSlugs);
  const del = db.prepare(`DELETE FROM page_embeddings WHERE subject_id = ? AND slug = ?`);
  for (const { slug } of all) {
    if (!live.has(slug)) del.run(subjectId, slug);
  }
}
```

> better-sqlite3 读 BLOB 列返回 Node `Buffer`，故 `r.vector` 即 Buffer，直接回传。

- [ ] **Step 6: 运行确认通过 + tsc + 提交**

Run: `npx vitest run src/server/db/repos/__tests__/embeddings-repo.test.ts`
Expected: PASS（4 个用例）

```bash
npx tsc --noEmit
git add src/server/db/schema.ts src/server/db/client.ts src/server/db/repos/embeddings-repo.ts src/server/db/repos/__tests__/embeddings-repo.test.ts
git commit -m "feat: page_embeddings 表 + embeddings-repo（向量存取 + model 过滤 + prune）"
```

---

### Task 3: LLM embedding 层（config + provider-factory + provider-registry）

**Files:**
- Modify: `src/server/llm/config-schema.ts`（`BUILTIN_LLM_TASKS` 加 `'embedding'`）
- Modify: `src/server/llm/provider-factory.ts`（`getEmbeddingModel`）
- Modify: `src/server/llm/provider-registry.ts`（`generateEmbeddings` / `isEmbeddingConfigured` / `embeddingModelId`）
- Modify: `llm-config.example.json`（`tasks.embedding` 示例）
- Test: `src/server/llm/__tests__/embedding-config.test.ts`（`isEmbeddingConfigured` 配置驱动）

**Interfaces:**
- Consumes: `resolveTask`（task-router）、`getLLMConfig`（config-loader）、`createOpenAICompatible`/`createOpenAI`（provider-factory 已 import）、`embedMany`（`ai`）。
- Produces:
  ```ts
  // provider-factory.ts
  export function getEmbeddingModel(route: ResolvedTaskRoute): EmbeddingModel<string>
  // provider-registry.ts
  export function isEmbeddingConfigured(): boolean       // !!getLLMConfig().tasks?.embedding?.model
  export function embeddingModelId(): string             // resolveTask('embedding').model
  export async function generateEmbeddings(texts: string[]): Promise<number[][]>
  ```

- [ ] **Step 1: config BUILTIN 加 embedding**

`src/server/llm/config-schema.ts`：

```ts
const BUILTIN_LLM_TASKS = ['ingest', 'query', 'lint', 'merge', 'split', 'embedding'] as const;
```

- [ ] **Step 2: provider-factory getEmbeddingModel**

`src/server/llm/provider-factory.ts` 顶部 import 增（与现有 import 合并）：

```ts
import type { EmbeddingModel } from 'ai';
```

文件内新增（`getLanguageModel` 之后）：

```ts
/**
 * 取 embedding 模型。仅 OpenAI 家族（openai / openai-compatible / ollama）支持；
 * 其余 provider 抛错（embedding 应配到这些 profile）。
 */
export function getEmbeddingModel(route: ResolvedTaskRoute): EmbeddingModel<string> {
  const profile = route.provider;
  switch (profile.provider) {
    case 'openai': {
      const p = createOpenAI({
        apiKey: requireApiKey(route.profileName, profile.apiKeyEnv),
        baseURL: profile.baseURL,
      });
      return p.textEmbeddingModel(route.model);
    }
    case 'ollama': {
      const p = createOpenAICompatible({
        name: 'ollama',
        apiKey: optionalApiKey(profile.apiKeyEnv) ?? 'ollama',
        baseURL: ensureV1(profile.baseURL),
      });
      return p.textEmbeddingModel(route.model);
    }
    case 'openai-compatible': {
      const p = createOpenAICompatible({
        name: profile.name,
        apiKey: optionalApiKey(profile.apiKeyEnv),
        baseURL: profile.baseURL,
        headers: profile.headers,
      });
      return p.textEmbeddingModel(route.model);
    }
    default:
      throw new LLMProviderError(
        `Provider "${profile.provider}" does not support embeddings; configure tasks.embedding to an openai / openai-compatible / ollama profile`
      );
  }
}
```

> `route.provider` 是 resolved 的 `LLMProviderProfile`（与 `getLanguageModel` 用的 `route.provider` 一致）；`requireApiKey`/`optionalApiKey`/`ensureV1`/`LLMProviderError` 均为本文件既有符号。若 `route` 上字段名不同（如 `route.profile`），按本文件 `getLanguageModel`/`buildFactory` 的实际取法对齐。

- [ ] **Step 3: provider-registry 三个导出**

`src/server/llm/provider-registry.ts`：顶部 import 增 `embedMany`（与现有 `import { generateObject, streamText } from 'ai'` 合并为 `import { generateObject, streamText, embedMany } from 'ai'`），并 import `getEmbeddingModel`（与现有 `import { getLanguageModel } from './provider-factory'` 合并）、`getLLMConfig`（`from './config-loader'`）。新增：

```ts
export function isEmbeddingConfigured(): boolean {
  return !!getLLMConfig().tasks?.embedding?.model;
}

export function embeddingModelId(): string {
  return resolveTask('embedding').model;
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const route = resolveTask('embedding');
  const { embeddings } = await embedMany({
    model: getEmbeddingModel(route),
    values: texts,
  });
  return embeddings;
}
```

> 确认 `getLLMConfig` 的实际导出名/路径（`config-loader.ts`）；`ResolvedTaskRoute.model` 为 string。

- [ ] **Step 4: llm-config.example.json 示例**

`llm-config.example.json` 的 `tasks` 节加（值按示例占位，注释说明用 OpenAI-compatible profile + embedding 模型）：

```jsonc
    "embedding": { "profile": "primary", "model": "text-embedding-3-small" }
```

- [ ] **Step 5: 写失败测试（isEmbeddingConfigured）**

新建 `src/server/llm/__tests__/embedding-config.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetConfig = vi.fn();
vi.mock('../config-loader', () => ({ getLLMConfig: () => mockGetConfig() }));
vi.mock('../task-router', () => ({ resolveTask: () => ({ model: 'text-embedding-3-small' }) }));
vi.mock('../provider-factory', () => ({ getEmbeddingModel: vi.fn(), getLanguageModel: vi.fn() }));

import { isEmbeddingConfigured } from '../provider-registry';

beforeEach(() => mockGetConfig.mockReset());

describe('isEmbeddingConfigured', () => {
  it('tasks.embedding.model 存在 → true', () => {
    mockGetConfig.mockReturnValue({ tasks: { embedding: { model: 'text-embedding-3-small' } } });
    expect(isEmbeddingConfigured()).toBe(true);
  });
  it('无 tasks.embedding → false', () => {
    mockGetConfig.mockReturnValue({ tasks: {} });
    expect(isEmbeddingConfigured()).toBe(false);
  });
  it('tasks.embedding 无 model → false', () => {
    mockGetConfig.mockReturnValue({ tasks: { embedding: {} } });
    expect(isEmbeddingConfigured()).toBe(false);
  });
});
```

> 若 `provider-registry` 还 import 了其它模块导致测试加载报错，按其实际顶部 import 补对应 `vi.mock`（保持 mock 最小：只为让 `isEmbeddingConfigured` 可独立加载）。

- [ ] **Step 6: 运行确认失败 → 实现已在 Step 1-3 → 运行确认通过**

Run: `npx vitest run src/server/llm/__tests__/embedding-config.test.ts`
Expected: 先 FAIL（模块/导出缺失），实现后 PASS（3 用例）

- [ ] **Step 7: tsc + 提交**

```bash
npx tsc --noEmit
git add src/server/llm/config-schema.ts src/server/llm/provider-factory.ts src/server/llm/provider-registry.ts src/server/llm/__tests__/embedding-config.test.ts llm-config.example.json
git commit -m "feat: LLM embedding 层（getEmbeddingModel/generateEmbeddings/isEmbeddingConfigured + embedding 任务）"
```

---

### Task 4: `embedding-service`（embed-index 任务 + enqueueEmbedIndex）

**Files:**
- Modify: `src/lib/contracts.ts`（`Job['type']` 加 `'embed-index'`）
- Create: `src/server/services/embedding-service.ts`
- Modify: `src/server/worker-entry.ts`（顶部 `import './services/embedding-service';`）
- Test: `src/server/services/__tests__/embedding-service.test.ts`

**Interfaces:**
- Consumes: `registerHandler`（jobs/worker）、`queue`（jobs/queue）、`subjectsRepo`、`pagesRepo.getAllPages`、`wiki-store.readPageBySlug`、`embeddings-repo`、`provider-registry.{isEmbeddingConfigured,embeddingModelId,generateEmbeddings}`、`encodeVector`（vector-math）。
- Produces:
  ```ts
  export function enqueueEmbedIndex(subjectId: string): void
  export async function runEmbedIndex(subjectId: string): Promise<void>   // handler 主体，便于测试
  ```
- 行为：`runEmbedIndex` —— 未配置 no-op；否则对 subject 找「缺/model 变/hash 变」的页 → 读正文 → `generateEmbeddings` 批量 → `upsertEmbedding`；再 `pruneOrphans(subjectId, livePageSlugs)`。

- [ ] **Step 1: contracts Job.type 加 embed-index**

`src/lib/contracts.ts` 把 `Job` 的 `type` 联合加 `'embed-index'`（与现有 `'ingest'|'lint'|'save-to-wiki'|'merge'|'split'` 并列）。

- [ ] **Step 2: 写失败测试**

新建 `src/server/services/__tests__/embedding-service.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfigured = vi.fn();
const mockModelId = vi.fn();
const mockGenEmb = vi.fn();
const mockGetAllPages = vi.fn();
const mockReadPage = vi.fn();
const mockList = vi.fn();
const mockUpsert = vi.fn();
const mockPrune = vi.fn();
const mockGetSubject = vi.fn();

vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));
vi.mock('@/server/jobs/queue', () => ({ enqueue: vi.fn() }));
vi.mock('@/server/llm/provider-registry', () => ({
  isEmbeddingConfigured: () => mockConfigured(),
  embeddingModelId: () => mockModelId(),
  generateEmbeddings: (texts: string[]) => mockGenEmb(texts),
}));
vi.mock('@/server/db/repos/pages-repo', () => ({ getAllPages: (s: unknown) => mockGetAllPages(s) }));
vi.mock('@/server/db/repos/subjects-repo', () => ({ getById: (s: unknown) => mockGetSubject(s) }));
vi.mock('@/server/db/repos/embeddings-repo', () => ({
  listForSubject: (s: unknown, m: unknown) => mockList(s, m),
  upsertEmbedding: (row: unknown) => mockUpsert(row),
  pruneOrphans: (s: unknown, live: unknown) => mockPrune(s, live),
}));
vi.mock('@/server/wiki/wiki-store', () => ({ readPageBySlug: (ss: unknown, slug: unknown) => mockReadPage(ss, slug) }));

import { runEmbedIndex } from '../embedding-service';

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigured.mockReturnValue(true);
  mockModelId.mockReturnValue('m1');
  mockGetSubject.mockReturnValue({ id: 's1', slug: 'sub-a' });
  mockReadPage.mockReturnValue({ body: 'BODY' });
  mockGenEmb.mockResolvedValue([[1, 0]]);
});

describe('runEmbedIndex', () => {
  it('未配置 embedding → no-op（不读页/不嵌入）', async () => {
    mockConfigured.mockReturnValue(false);
    await runEmbedIndex('s1');
    expect(mockGetAllPages).not.toHaveBeenCalled();
    expect(mockGenEmb).not.toHaveBeenCalled();
  });

  it('只嵌入缺/过期页，跳过新鲜页', async () => {
    mockGetAllPages.mockReturnValue([
      { slug: 'a', title: 'A', summary: 'sa', contentHash: 'h1' }, // 已有同 hash → 跳过
      { slug: 'b', title: 'B', summary: 'sb', contentHash: 'h2new' }, // hash 变 → 重嵌
      { slug: 'c', title: 'C', summary: 'sc', contentHash: 'h3' }, // 无向量 → 嵌
    ]);
    mockList.mockReturnValue([
      { slug: 'a', contentHash: 'h1', dim: 2, vector: Buffer.alloc(8) },
      { slug: 'b', contentHash: 'h2old', dim: 2, vector: Buffer.alloc(8) },
    ]);
    mockGenEmb.mockResolvedValue([[1, 0], [0, 1]]); // b, c
    await runEmbedIndex('s1');
    expect(mockGenEmb).toHaveBeenCalledTimes(1);
    const embeddedSlugs = mockUpsert.mock.calls.map((c) => c[0].slug).sort();
    expect(embeddedSlugs).toEqual(['b', 'c']);
    expect(mockPrune).toHaveBeenCalledWith('s1', ['a', 'b', 'c']);
  });

  it('全部新鲜 → 不调 generateEmbeddings，但仍 prune', async () => {
    mockGetAllPages.mockReturnValue([{ slug: 'a', title: 'A', summary: '', contentHash: 'h1' }]);
    mockList.mockReturnValue([{ slug: 'a', contentHash: 'h1', dim: 2, vector: Buffer.alloc(8) }]);
    await runEmbedIndex('s1');
    expect(mockGenEmb).not.toHaveBeenCalled();
    expect(mockPrune).toHaveBeenCalledWith('s1', ['a']);
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `npx vitest run src/server/services/__tests__/embedding-service.test.ts`
Expected: FAIL（找不到 `../embedding-service`）

- [ ] **Step 4: 实现**

新建 `src/server/services/embedding-service.ts`：

```ts
import { registerHandler } from '@/server/jobs/worker';
import * as queue from '@/server/jobs/queue';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import * as embeddingsRepo from '@/server/db/repos/embeddings-repo';
import { readPageBySlug } from '@/server/wiki/wiki-store';
import {
  isEmbeddingConfigured,
  embeddingModelId,
  generateEmbeddings,
} from '@/server/llm/provider-registry';
import { encodeVector } from '@/server/search/vector-math';

const EMBED_TEXT_MAX_CHARS = 8000;
const EMBED_BATCH = 32;

function embedText(p: { title: string; summary?: string | null; body: string }): string {
  return [p.title, p.summary ?? '', p.body].join('\n\n').slice(0, EMBED_TEXT_MAX_CHARS);
}

/** 回填 subject 内缺/过期向量 + prune 孤儿。未配置 embedding 时 no-op。 */
export async function runEmbedIndex(subjectId: string): Promise<void> {
  if (!isEmbeddingConfigured()) return;
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) return;

  const model = embeddingModelId();
  const pages = pagesRepo.getAllPages(subjectId);
  const existing = new Map(
    embeddingsRepo.listForSubject(subjectId, model).map((r) => [r.slug, r.contentHash])
  );

  const stale = pages.filter((p) => existing.get(p.slug) !== p.contentHash);

  for (let i = 0; i < stale.length; i += EMBED_BATCH) {
    const batch = stale.slice(i, i + EMBED_BATCH);
    const texts: string[] = [];
    const metas: { slug: string; contentHash: string }[] = [];
    for (const p of batch) {
      const doc = readPageBySlug(subject.slug, p.slug);
      if (!doc) continue;
      texts.push(embedText({ title: p.title, summary: p.summary, body: doc.body }));
      metas.push({ slug: p.slug, contentHash: p.contentHash });
    }
    if (texts.length === 0) continue;
    const vectors = await generateEmbeddings(texts);
    vectors.forEach((vec, idx) => {
      const m = metas[idx];
      embeddingsRepo.upsertEmbedding({
        subjectId,
        slug: m.slug,
        model,
        contentHash: m.contentHash,
        dim: vec.length,
        vector: encodeVector(vec),
      });
    });
  }

  embeddingsRepo.pruneOrphans(subjectId, pages.map((p) => p.slug));
}

export function enqueueEmbedIndex(subjectId: string): void {
  queue.enqueue('embed-index', { subjectId }, subjectId);
}

registerHandler('embed-index', async (job) => {
  const subjectId = (job.subjectId ?? (job.params as { subjectId?: string } | undefined)?.subjectId) ?? null;
  if (!subjectId) return;
  await runEmbedIndex(subjectId);
});
```

> `registerHandler` 回调签名/`job` 字段（`subjectId` / `params`）以本仓库既有 service（如 `lint-service`）为准对齐；`queue.enqueue(type, params, subjectId)` 参数顺序同既有调用（参考 `query-service` 的 enqueue）。`pagesRepo.getAllPages` 返回 `WikiPage[]`（含 `slug/title/summary/contentHash`）；`readPageBySlug` 返回含 `.body` 的文档或 null。

- [ ] **Step 5: worker-entry import**

`src/server/worker-entry.ts` 顶部 service import 区加：`import './services/embedding-service';`

- [ ] **Step 6: 运行确认通过 + tsc + 提交**

Run: `npx vitest run src/server/services/__tests__/embedding-service.test.ts`
Expected: PASS（3 个用例）

```bash
npx tsc --noEmit
git add src/lib/contracts.ts src/server/services/embedding-service.ts src/server/worker-entry.ts src/server/services/__tests__/embedding-service.test.ts
git commit -m "feat: embedding-service（embed-index 任务回填缺/过期向量 + prune + enqueue 助手）"
```

---

### Task 5: `semantic-search.ts`

**Files:**
- Create: `src/server/search/semantic-search.ts`
- Test: `src/server/search/__tests__/semantic-search.test.ts`

**Interfaces:**
- Consumes: `embeddings-repo.listForSubject`、`embeddingModelId`（provider-registry）、`decodeVector`/`cosineSimilarity`（vector-math）。
- Produces:
  ```ts
  export function semanticSearch(subjectId: string, queryVector: number[], k: number): { slug: string; score: number }[]
  ```
  载入当前模型向量 → cosine vs queryVector → 降序 topK。

- [ ] **Step 1: 写失败测试**

新建 `src/server/search/__tests__/semantic-search.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockList = vi.fn();
const mockModelId = vi.fn();

vi.mock('@/server/db/repos/embeddings-repo', () => ({ listForSubject: (s: unknown, m: unknown) => mockList(s, m) }));
vi.mock('@/server/llm/provider-registry', () => ({ embeddingModelId: () => mockModelId() }));

import { semanticSearch } from '../semantic-search';

const buf = (nums: number[]) => Buffer.from(Float32Array.from(nums).buffer);

beforeEach(() => {
  vi.clearAllMocks();
  mockModelId.mockReturnValue('m1');
});

describe('semanticSearch', () => {
  it('按 cosine 降序返回 topK', () => {
    mockList.mockReturnValue([
      { slug: 'same', contentHash: 'h', dim: 2, vector: buf([1, 0]) },   // cosine=1
      { slug: 'orth', contentHash: 'h', dim: 2, vector: buf([0, 1]) },   // cosine=0
      { slug: 'opp', contentHash: 'h', dim: 2, vector: buf([-1, 0]) },   // cosine=-1
    ]);
    const out = semanticSearch('s1', [1, 0], 2);
    expect(out.map((r) => r.slug)).toEqual(['same', 'orth']);
    expect(out[0].score).toBeCloseTo(1, 6);
    expect(mockList).toHaveBeenCalledWith('s1', 'm1');
  });

  it('无向量 → 空数组', () => {
    mockList.mockReturnValue([]);
    expect(semanticSearch('s1', [1, 0], 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/search/__tests__/semantic-search.test.ts`
Expected: FAIL（找不到 `../semantic-search`）

- [ ] **Step 3: 实现**

新建 `src/server/search/semantic-search.ts`：

```ts
import * as embeddingsRepo from '@/server/db/repos/embeddings-repo';
import { embeddingModelId } from '@/server/llm/provider-registry';
import { decodeVector, cosineSimilarity } from './vector-math';

/** 当前模型向量 → cosine vs queryVector → 降序 topK。 */
export function semanticSearch(
  subjectId: string,
  queryVector: number[],
  k: number
): { slug: string; score: number }[] {
  const model = embeddingModelId();
  const rows = embeddingsRepo.listForSubject(subjectId, model);
  const scored = rows.map((r) => ({
    slug: r.slug,
    score: cosineSimilarity(queryVector, decodeVector(r.vector)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
```

- [ ] **Step 4: 运行确认通过 + tsc + 提交**

Run: `npx vitest run src/server/search/__tests__/semantic-search.test.ts`
Expected: PASS（2 个用例）

```bash
npx tsc --noEmit
git add src/server/search/semantic-search.ts src/server/search/__tests__/semantic-search.test.ts
git commit -m "feat: semanticSearch（当前模型向量 cosine topK）"
```

---

### Task 6: `hybrid-retrieval.ts`（FTS + 向量 RRF 合并）

**Files:**
- Create: `src/server/search/hybrid-retrieval.ts`
- Test: `src/server/search/__tests__/hybrid-retrieval.test.ts`

**Interfaces:**
- Consumes: `pagesRepo.searchPages`、`isEmbeddingConfigured`/`generateEmbeddings`（provider-registry）、`semanticSearch`、`rrfMerge`（vector-math）。
- Produces:
  ```ts
  export async function hybridRankSlugs(subjectId: string, question: string, topN: number): Promise<string[]>
  ```
  纯 FTS（未配置/嵌入失败）或 FTS+向量 RRF 合并。

- [ ] **Step 1: 写失败测试**

新建 `src/server/search/__tests__/hybrid-retrieval.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSearch = vi.fn();
const mockConfigured = vi.fn();
const mockGenEmb = vi.fn();
const mockSemantic = vi.fn();

vi.mock('@/server/db/repos/pages-repo', () => ({ searchPages: (s: unknown, q: unknown) => mockSearch(s, q) }));
vi.mock('@/server/llm/provider-registry', () => ({
  isEmbeddingConfigured: () => mockConfigured(),
  generateEmbeddings: (t: string[]) => mockGenEmb(t),
}));
vi.mock('../semantic-search', () => ({ semanticSearch: (s: unknown, v: unknown, k: unknown) => mockSemantic(s, v, k) }));

import { hybridRankSlugs } from '../hybrid-retrieval';

beforeEach(() => {
  vi.clearAllMocks();
  mockSearch.mockReturnValue([{ page: { slug: 'x' } }, { page: { slug: 'y' } }]);
});

describe('hybridRankSlugs', () => {
  it('未配置 embedding → 纯 FTS（不调 generateEmbeddings）', async () => {
    mockConfigured.mockReturnValue(false);
    const out = await hybridRankSlugs('s1', 'q', 5);
    expect(out).toEqual(['x', 'y']);
    expect(mockGenEmb).not.toHaveBeenCalled();
  });

  it('配置后 → FTS + 向量 RRF 合并去重', async () => {
    mockConfigured.mockReturnValue(true);
    mockGenEmb.mockResolvedValue([[1, 0]]);
    mockSemantic.mockReturnValue([{ slug: 'y', score: 0.9 }, { slug: 'z', score: 0.8 }]);
    const out = await hybridRankSlugs('s1', 'q', 5);
    expect(out[0]).toBe('y'); // 双榜
    expect(new Set(out).size).toBe(out.length);
    expect(out).toContain('z');
  });

  it('查询嵌入抛错 → 回退纯 FTS', async () => {
    mockConfigured.mockReturnValue(true);
    mockGenEmb.mockRejectedValue(new Error('embed down'));
    const out = await hybridRankSlugs('s1', 'q', 5);
    expect(out).toEqual(['x', 'y']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/server/search/__tests__/hybrid-retrieval.test.ts`
Expected: FAIL（找不到 `../hybrid-retrieval`）

- [ ] **Step 3: 实现**

新建 `src/server/search/hybrid-retrieval.ts`：

```ts
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { isEmbeddingConfigured, generateEmbeddings } from '@/server/llm/provider-registry';
import { semanticSearch } from './semantic-search';
import { rrfMerge } from './vector-math';

const RRF_K = 60;
const VEC_K = 10;

/** FTS + 向量两路 RRF 合并的排名 slug 列表；未配置/嵌入失败 → 纯 FTS top-N。 */
export async function hybridRankSlugs(
  subjectId: string,
  question: string,
  topN: number
): Promise<string[]> {
  const ftsSlugs = pagesRepo.searchPages(subjectId, question).map((r) => r.page.slug);
  if (!isEmbeddingConfigured()) return ftsSlugs.slice(0, topN);
  try {
    const [qVec] = await generateEmbeddings([question]);
    const vecSlugs = semanticSearch(subjectId, qVec, VEC_K).map((r) => r.slug);
    return rrfMerge(ftsSlugs, vecSlugs, RRF_K, topN);
  } catch {
    return ftsSlugs.slice(0, topN);
  }
}
```

- [ ] **Step 4: 运行确认通过 + tsc + 提交**

Run: `npx vitest run src/server/search/__tests__/hybrid-retrieval.test.ts`
Expected: PASS（3 个用例）

```bash
npx tsc --noEmit
git add src/server/search/hybrid-retrieval.ts src/server/search/__tests__/hybrid-retrieval.test.ts
git commit -m "feat: hybridRankSlugs（FTS + 向量 RRF 合并，未配置/失败回退纯 FTS）"
```

---

### Task 7: `prepareQueryContext` 改 async + 接入混合检索

**Files:**
- Modify: `src/server/services/query-service.ts`（`prepareQueryContext` async + `hybridRankSlugs`）
- Modify: `src/app/api/query/route.ts`（`await prepareQueryContext(...)`）
- Modify: `src/server/services/query-service.ts` 内 `runQuery`（若调用 prepareQueryContext，改 await）

**Interfaces:**
- Consumes: `hybridRankSlugs`（Task 6）、既有 `subjectsRepo.getById`/`pagesRepo.getPageBySlug`/`readPageInSubject`。
- Produces: `prepareQueryContext(question, subjectId, currentPageSlug?): Promise<QueryContextPage[]>`。

- [ ] **Step 1: 改 prepareQueryContext**

`src/server/services/query-service.ts`：顶部 import 增 `import { hybridRankSlugs } from '@/server/search/hybrid-retrieval';`。把 `prepareQueryContext` 改为：

```ts
export async function prepareQueryContext(
  question: string,
  subjectId: SubjectId,
  currentPageSlug?: string,
): Promise<QueryContextPage[]> {
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) return [];

  const contextBySlug = new Map<string, QueryContextPage>();

  if (currentPageSlug) {
    const page = pagesRepo.getPageBySlug(subjectId, currentPageSlug);
    const doc = readPageInSubject(subject.slug, currentPageSlug);
    if (page && doc && doc.body.trim().length > 0) {
      contextBySlug.set(currentPageSlug, {
        slug: currentPageSlug,
        title: page.title,
        content: doc.body,
        isCurrent: true,
      });
    }
  }

  const rankedSlugs = await hybridRankSlugs(subjectId, question, TOP_N_FTS);
  for (const slug of rankedSlugs) {
    if (contextBySlug.has(slug)) continue;
    const page = pagesRepo.getPageBySlug(subjectId, slug);
    const doc = readPageInSubject(subject.slug, slug);
    const content = doc?.body ?? '';
    if (!page || content.trim().length === 0) continue;
    contextBySlug.set(slug, { slug, title: page.title, content });
  }

  return [...contextBySlug.values()];
}
```

> 保留既有 `TOP_N_FTS` 常量名与 `QueryContextPage`/`readPageInSubject` 用法。原 FTS `snippet` 回退分支移除（统一用页正文；空正文页跳过）——这是与既有行为的细微差异，可接受。

- [ ] **Step 2: 改调用方 await**

`src/app/api/query/route.ts` 流式 start 内：`const context = prepareQueryContext(trimmedQuestion, subject.id, pageSlug);` → `const context = await prepareQueryContext(trimmedQuestion, subject.id, pageSlug);`

`src/server/services/query-service.ts` 内 `runQuery`（若有 `prepareQueryContext(...)` 调用）：改为 `await prepareQueryContext(...)`（`runQuery` 已是 `async`）。

- [ ] **Step 3: tsc + 运行既有 query 路由测试（不回归）**

Run: `npx tsc --noEmit`
Expected: 0 errors

Run: `npx vitest run src/app/api/query/__tests__/route.test.ts`
Expected: PASS（既有 query 路由测试不回归——route 测试 mock 了 query-service，`prepareQueryContext` 被 mock，await 非 promise 安全）

- [ ] **Step 4: 全套 + 提交**

Run: `npx vitest run`
Expected: 全套通过（无回归）

```bash
git add src/server/services/query-service.ts src/app/api/query/route.ts
git commit -m "feat: prepareQueryContext 改 async 接入混合检索（FTS + 向量）"
```

---

### Task 8: 写后 enqueue + worker 启动自愈

**Files:**
- Modify: `src/server/services/ingest-service.ts`（finalize 后 enqueueEmbedIndex）
- Modify: `src/server/services/merge-service.ts`（合并提交后 enqueueEmbedIndex）
- Modify: `src/server/services/split-service.ts`（拆分提交后 enqueueEmbedIndex）
- Modify: `src/app/api/pages/[...slug]/route.ts`（PUT 与 DELETE applyChangeset 后 enqueueEmbedIndex）
- Modify: `src/server/worker-entry.ts`（启动序列：每 subject enqueue embed-index 自愈）

**Interfaces:**
- Consumes: `enqueueEmbedIndex`（Task 4）、`subjectsRepo.listSubjects`（worker-entry）。

> 本任务为接线，无新单测；门禁 = `npx tsc --noEmit` 0 + `npx vitest run` 全套不回归。

- [ ] **Step 1: 各写侧 service 写后 enqueue**

在 `ingest-service.ts`（`finalizeIngest`/`commitPending` 成功后）、`merge-service.ts`（单事务 apply 成功后）、`split-service.ts`（单事务 apply 成功后）各加（import + 调用）：

```ts
import { enqueueEmbedIndex } from '@/server/services/embedding-service';
// ...成功提交后：
enqueueEmbedIndex(subject.id);
```

> 用各 service 内已解析的 `subject`（或 `job.subjectId`）。放在该 service 成功路径末尾（commit 之后、返回之前）。

- [ ] **Step 2: 编辑/删除路由写后 enqueue**

`src/app/api/pages/[...slug]/route.ts`：顶部 import `import { enqueueEmbedIndex } from '@/server/services/embedding-service';`。在 PUT 的 `await applyChangeset(changeset);` 之后与 DELETE 的 `await applyChangeset(changeset);` 之后各加 `enqueueEmbedIndex(subject.id);`。

> 注意：route 是 web 进程，`enqueueEmbedIndex` 仅写 jobs 表（`queue.enqueue`），由 worker 进程消费——安全（不在 web 进程跑 embedding）。

- [ ] **Step 3: worker 启动自愈**

`src/server/worker-entry.ts`：在确保 vault git 仓库存在之后、`startWorker(pollMs)` 之前，加（import + 循环 enqueue）：

```ts
import { enqueueEmbedIndex } from './services/embedding-service';
// ...启动序列中：
try {
  for (const s of subjectsRepo.listSubjects()) enqueueEmbedIndex(s.id);
} catch (err) {
  logger.warn?.('embed-index self-heal enqueue failed', err);
}
```

> `subjectsRepo` 在 worker-entry 是否已 import 按实际补；logger/warn 用本文件既有日志 facade（`server/logging`）；若无 warn 用既有 log 风格。embed-index handler 在未配置 embedding 时 no-op，故自愈 enqueue 永远安全。

- [ ] **Step 4: tsc + 全套 + 提交**

Run: `npx tsc --noEmit`
Expected: 0 errors

Run: `npx vitest run`
Expected: 全套通过（无回归）

```bash
git add src/server/services/ingest-service.ts src/server/services/merge-service.ts src/server/services/split-service.ts "src/app/api/pages/[...slug]/route.ts" src/server/worker-entry.ts
git commit -m "feat: 写后 enqueue embed-index + worker 启动自愈回填向量"
```

- [ ] **Step 5: 手工眼测（Nick）**

先在 `llm-config.json` 配 `tasks.embedding`（OpenAI-compatible profile + embedding 模型），`npm run dev:all` → 启动自愈回填存量页向量 → chat 用语义化问法（改写/同义，非精确关键词）验证能召回相关页 → 摄入/编辑一页后稍候再问，新内容可被语义召回 → 临时移除 `tasks.embedding` 重启，确认 chat 优雅降级为纯 FTS（不报错）。

---

## 自审清单（写计划后自查，已完成）

- **Spec 覆盖**：vector-math（T1）/ page_embeddings+repo（T2）/ LLM embedding 层（T3）/ embed-index 服务（T4）/ semanticSearch（T5）/ hybrid（T6）/ prepareQueryContext 接入（T7）/ 写后 enqueue+启动自愈（T8）—— spec 各节均有任务。
- **占位扫描**：无 TBD/TODO；每步含完整代码或精确编辑 + 命令/预期。
- **类型一致性**：`encodeVector/decodeVector/cosineSimilarity/rrfMerge`（T1 定义，T2 测试用 Buffer、T5/T6 消费）；embeddings-repo `upsertEmbedding/listForSubject/deleteBySlug/pruneOrphans`（T2 定义，T4/T5 消费签名一致）；`isEmbeddingConfigured/embeddingModelId/generateEmbeddings`（T3 定义，T4/T5/T6 消费）；`semanticSearch`（T5 定义，T6 消费）；`hybridRankSlugs`（T6 定义，T7 消费）；`runEmbedIndex/enqueueEmbedIndex`（T4 定义，T8 消费）；Job.type 'embed-index'（T4 加，T4/T8 enqueue）；`page_embeddings.model` 列贯穿过期判定/listForSubject 过滤。
- **YAGNI**：仅 chat 检索、按页一个向量、暴力 cosine、无手动 reindex UI、命令面板不动。
