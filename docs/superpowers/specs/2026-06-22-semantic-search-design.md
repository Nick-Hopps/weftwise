# 语义检索（混合 FTS + 向量）设计

> 日期：2026-06-22
> 状态：已确认，待写实现计划
> 关联：特性序列第 ⑧ 项「语义检索」

---

## 一、背景与动机

现状勘察结论（已核实）：

- 现有检索 = FTS5：`pagesRepo.searchPages(subjectId, query)`（`pages_fts MATCH` + bm25 `rank` + `snippet`），被 `/api/search`（命令面板 /go）与 `query-service.prepareQueryContext`（chat 取上下文，`TOP_N_FTS=5`）使用。
- Vercel AI SDK（`ai`）已提供 `embed` / `embedMany`；现有 `provider-factory.getLanguageModel(route)` 按 provider 种类构造模型，`ollama`/`openai-compatible` 走 `createOpenAICompatible(...)`，其返回的 provider 暴露 `.textEmbeddingModel(modelId)`。
- `config-schema.ts`：`BUILTIN_LLM_TASKS = ['ingest','query','lint','merge','split']`；`tasks: z.record(LLMTaskSchema, LLMRouteConfigSchema)`；`LLMRouteConfig` 含 `profile?`/`model?`；`resolveTask` 合并 defaults < task < override。
- better-sqlite3 无原生向量类型；个人库规模（百~千页）下「全量加载向量 + JS 暴力 cosine」足够快。
- `pages` 表/`WikiPage` 含 `contentHash`，可用于判定 embedding 过期。
- `prepareQueryContext` 当前同步（FTS 同步）。

---

## 二、范围（v1）

> **为 chat 问答检索（`prepareQueryContext`）加入向量语义召回，与现有 FTS5 关键词召回混合（RRF 合并）。embedding 经现有多供应商抽象（OpenAI-compatible，llm-config 配置）。向量存 SQLite BLOB + JS 暴力 cosine。嵌入索引完全脱离 Saga（embed-index worker 任务 + 写后 enqueue + 启动自愈）。未配置 embedding 时优雅降级为纯 FTS。**

### 已定决策

1. **检索策略 = 混合**：保留 FTS5，新增向量检索，两路排名经 RRF（互惠排名融合）合并去重。
2. **应用范围 = 仅 chat 检索**（`prepareQueryContext`）；命令面板 /go（`/api/search`）保持纯 FTS 不动。
3. **embedding 源 = OpenAI-compatible**：`llm-config.json` 新增 `tasks.embedding`（profile + model），用户填模型名（如 `text-embedding-3-small`）。架构 provider-agnostic。
4. **嵌入索引脱离 Saga**：embedding 不在 `applyChangeset`/`indexTouchedPages`（同步 SQLite 事务内无法做 async 网络调用）计算；改由 `embed-index` worker 任务回填，写后 enqueue + worker 启动自愈。零写路径延迟。
5. **按页一个向量**（v1 不分块）：embed `title + summary + body`（截 ~8000 字符）；存 `model` + `content_hash` 判定过期。
6. **优雅降级**：`isEmbeddingConfigured()` 为 false 时，embed-index no-op、`prepareQueryContext` 走纯 FTS。
7. **存储 = SQLite BLOB**（Float32）+ JS 暴力 cosine；无 sqlite-vec 扩展依赖。

### 明确不做（YAGNI）

- 命令面板 /go（`/api/search`）语义化。
- 分块 embedding（per-chunk）。
- sqlite-vec / sqlite-vss 原生向量扩展。
- 嵌入在 Saga 写路径同步计算。
- ANN 索引（暴力 cosine 对个人库足够）。
- 手动 reindex UI/路由（靠 worker 启动自愈 + 写后 enqueue 覆盖；存量首嵌靠下次 `npm run dev:all` 启动自愈）。

---

## 三、架构与数据流

### 新表 `page_embeddings`（`db/schema.ts` + `db/client.ts::ensureTables`，无 legacy 迁移）

```sql
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
```

> 过期判定：页 `content_hash` 变 或 配置 `model` 变 → 需重嵌。`semanticSearch` 仅取「当前模型」向量（换模型天然隔离旧维度向量）。

### LLM 层（embedding 能力）

```
config-schema.ts:
  BUILTIN_LLM_TASKS 加 'embedding'

provider-factory.ts:
  getEmbeddingModel(route: ResolvedTaskRoute): EmbeddingModel
    // 镜像 getLanguageModel 的 provider 分支；openai-compatible/ollama/openai 等用 provider.textEmbeddingModel(route.model)

provider-registry.ts:
  isEmbeddingConfigured(): boolean             // !!getLLMConfig().tasks?.embedding?.model
  embeddingModelId(): string                   // resolveTask('embedding').model（用于 page_embeddings.model 列）
  generateEmbeddings(texts: string[]): Promise<number[][]>   // AI SDK embedMany，model=getEmbeddingModel(resolveTask('embedding'))
```

### 写侧（嵌入索引，脱离 Saga）

```
embed-index 任务（services/embedding-service.ts，registerHandler('embed-index')）：
  params { subjectId }；强校验 subjectId
  if (!isEmbeddingConfigured()) return（no-op）
  model = embeddingModelId()
  pages = pagesRepo.getAllPages(subjectId)
  存量向量 = embeddingsRepo.listForSubject(subjectId)（取 model+content_hash 映射）
  stale = pages 中「无向量 / 向量.model≠model / 向量.content_hash≠page.contentHash」
  对 stale 分批：读正文（wiki-store.readPageBySlug(subjectSlug, slug)）→ 文本=title+summary+body 截 8000 → generateEmbeddings(批) → embeddingsRepo.upsert(...)
  prune：embeddingsRepo.pruneOrphans(subjectId, 当前 pages 的 slug 集)（删已不存在页的向量）

触发：
  · worker-entry 启动自愈：对每个 subject enqueue('embed-index', {subjectId}, subjectId)（回填存量；未配置则 handler no-op）
  · 写后 enqueue：ingest finalize / 编辑 PUT / merge / split / delete 成功后 enqueueEmbedIndex(subjectId)
  · enqueueEmbedIndex(subjectId) 助手（embedding-service 导出）封装 queue.enqueue
```

### 读侧（混合检索，`prepareQueryContext` 改 async）

```
prepareQueryContext(question, subjectId, currentPageSlug?) → async
  ftsResults = pagesRepo.searchPages(subjectId, question)            // 排名 slug 列表（现有）
  let mergedSlugs: string[]
  if (isEmbeddingConfigured()):
    try:
      qVec = (await generateEmbeddings([question]))[0]
      vecResults = semanticSearch(subjectId, qVec, K=10)              // 排名 slug 列表
      mergedSlugs = rrfMerge(ftsResults.map(r=>r.slug), vecResults.map(r=>r.slug), 60, TOP_N=5)
    catch: mergedSlugs = ftsResults.slice(0,5).map(r=>r.slug)         // 查询嵌入失败 → 纯 FTS
  else:
    mergedSlugs = ftsResults.slice(0,5).map(r=>r.slug)
  // 载入 mergedSlugs 的页正文构造 context（复用现有 currentPageSlug 注入逻辑）
```

### 纯函数（`server/search/vector-math.ts`）

```ts
encodeVector(v: number[]): Buffer            // Float32Array → Buffer
decodeVector(buf: Buffer): Float32Array
cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number   // 维度不等返回 0
rrfMerge(listA: string[], listB: string[], k: number, topN: number): string[]
  // 每个 slug 分数 = Σ 1/(k + rank0based)（出现在某列表才计该列表项）；按分数降序去重取 topN
```

### `server/search/semantic-search.ts`

```ts
semanticSearch(subjectId: string, queryVector: number[], k: number): { slug: string; score: number }[]
  // embeddingsRepo.listForSubject(subjectId) 取当前模型向量 → decodeVector → cosineSimilarity(queryVector, v) → 降序 topK
```

---

## 四、改动契约

### `src/lib/contracts.ts`
- `Job['type']` 联合加 `'embed-index'`。

### `src/server/db/repos/embeddings-repo.ts`（新）

```ts
export interface PageEmbeddingRow { subjectId: string; slug: string; model: string; contentHash: string; dim: number; vector: Buffer; updatedAt: string }
export function upsertEmbedding(row: { subjectId; slug; model; contentHash; dim; vector: Buffer }): void
export function listForSubject(subjectId: string, model: string): { slug: string; contentHash: string; vector: Buffer; dim: number }[]
export function deleteBySlug(subjectId: string, slug: string): void
export function pruneOrphans(subjectId: string, liveSlugs: string[]): void   // 删 slug ∉ liveSlugs 的行
```

> `listForSubject` 按 `model` 过滤（只返回当前模型向量）。

### `src/server/llm/config-schema.ts` / `provider-factory.ts` / `provider-registry.ts`
- 见上「LLM 层」：`BUILTIN_LLM_TASKS` 加 `'embedding'`；`getEmbeddingModel` / `generateEmbeddings` / `isEmbeddingConfigured` / `embeddingModelId`。

### `src/server/search/vector-math.ts` / `semantic-search.ts`（新）
- 见上。

### `src/server/services/embedding-service.ts`（新）
- `registerHandler('embed-index', ...)`（回填+prune，未配置 no-op）+ `export function enqueueEmbedIndex(subjectId: string): void`。
- `worker-entry.ts` 顶部 `import './services/embedding-service'`。

### `src/server/services/query-service.ts`
- `prepareQueryContext` 改 `async`，内部混合 RRF；导出签名变 `Promise<QueryContextPage[]>`。

### 调用方改 await
- `app/api/query/route.ts`（流式 start 内 `await prepareQueryContext(...)`）、`runQuery`（query-service 内，已 async）、`answerQuery`（若存在）。

### 写后 enqueue（4~5 处一行）
- `ingest-service`（finalize 后）、`merge-service`（end）、`split-service`（end）、`app/api/pages/[...slug]/route.ts`（PUT 与 DELETE 后）→ `enqueueEmbedIndex(subject.id)`。

### `worker-entry.ts`
- 启动序列加：对 `subjectsRepo.listSubjects()` 每个 enqueue `embed-index`（自愈回填）。

### `llm-config.example.json`
- 加 `tasks.embedding` 示例（注释说明：OpenAI-compatible profile + embedding 模型名）。

---

## 五、新增 / 改动文件清单

| 文件 | 类型 |
|------|------|
| `src/server/db/schema.ts` + `src/server/db/client.ts` | 改（page_embeddings 表）|
| `src/server/db/repos/embeddings-repo.ts` | 新 |
| `src/server/db/repos/__tests__/embeddings-repo.test.ts` | 新 |
| `src/server/search/vector-math.ts` | 新 |
| `src/server/search/__tests__/vector-math.test.ts` | 新 |
| `src/server/search/semantic-search.ts` | 新 |
| `src/server/search/__tests__/semantic-search.test.ts` | 新 |
| `src/server/llm/config-schema.ts` | 改（BUILTIN 加 embedding）|
| `src/server/llm/provider-factory.ts` | 改（getEmbeddingModel）|
| `src/server/llm/provider-registry.ts` | 改（generateEmbeddings / isEmbeddingConfigured / embeddingModelId）|
| `src/server/services/embedding-service.ts` | 新（embed-index handler + enqueueEmbedIndex）|
| `src/server/services/__tests__/embedding-service.test.ts` | 新 |
| `src/server/services/query-service.ts` | 改（prepareQueryContext async + 混合）|
| `src/server/services/__tests__/query-context-merge.test.ts` | 新（混合逻辑纯函数/窄 mock）|
| `src/app/api/query/route.ts` | 改（await）|
| `src/server/services/{ingest,merge,split}-service.ts` | 改（写后 enqueue）|
| `src/app/api/pages/[...slug]/route.ts` | 改（PUT/DELETE 后 enqueue）|
| `src/server/worker-entry.ts` | 改（启动自愈 + import embedding-service）|
| `src/lib/contracts.ts` | 改（Job.type 加 'embed-index'）|
| `llm-config.example.json` | 改（embedding 任务示例）|

> 不改 Saga 主控 / git / `seedSkillFiles` / FTS5（保留）/ 命令面板。

---

## 六、测试（node-only 优先）

1. **`vector-math`**：encode↔decode round-trip（Float32 精度）；cosine（同向≈1 / 正交≈0 / 反向≈-1 / 维度不等→0）；rrfMerge（两路融合排名、去重、topN 截断、一路空时退化为另一路）。
2. **`embeddings-repo`**（临时库，FK 先插 subjects+pages）：upsert + listForSubject(model 过滤掉异模型)；deleteBySlug；pruneOrphans（删 slug∉live）；vector BLOB round-trip。
3. **`semantic-search`**：注入若干向量，给定 query 向量，断言 cosine 排序 topK 顺序正确。
4. **`embedding-service` embed-index**（窄 mock：isEmbeddingConfigured/generateEmbeddings/repos）：只对「缺/model 变/hash 变」的页嵌入 + upsert；prune 孤儿；未配置 → no-op（不调 generateEmbeddings）。
5. **prepareQueryContext 混合**：mock searchPages + isEmbeddingConfigured + generateEmbeddings + semanticSearch，断言 RRF 合并出的 slug 顺序；embedding 未配置 → 纯 FTS（不调 generateEmbeddings）；查询嵌入抛错 → 回退纯 FTS。
6. 真实 embedding 调用、端到端召回质量：眼测（需配 `llm-config.json::tasks.embedding`）。

> 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` BASE 即坏，非门禁。

---

## 七、边界与已知取舍

- **embedding 未配置**：索引 no-op + 检索纯 FTS（功能优雅缺省，零报错）。dev 验收需先配 `tasks.embedding` 并重启 worker（启动自愈回填存量）。
- **新/改页的语义可见性延迟**：写后 enqueue 的 embed-index 异步执行（秒级）；期间该页靠 FTS 召回。
- **模型变更**：旧模型向量被 `listForSubject(model)` 过滤忽略，embed-index 按 model 不符重嵌；无需手动清理（pruneOrphans 只清已删页，旧模型行随重嵌 upsert 覆盖同 PK）。
- **长页截断**：按页一个向量、正文截 8000 字符；超长页尾部内容不进向量（v1 接受，分块=后续）。
- **暴力 cosine**：个人库（≤ 数千页）下每次查询全量加载+点积可接受；更大规模需 ANN（后续）。
- **best-effort**：embed-index 失败不影响 wiki 写与 FTS；下次 job/启动重试。

## 八、不变量与依赖

- 不改 Saga / git-service / `streamTextResponse` 签名 / `seedSkillFiles` / FTS5 / 命令面板检索。
- 嵌入索引严格不进 `applyChangeset` 事务；走 worker 任务（与 ingest/lint 等一致的 registerHandler 模式，强校验 subjectId）。
- 向量编解码、cosine、RRF 为纯函数（`server/search/vector-math.ts`），单一真实源，不在别处复刻。
- embedding 经现有 `resolveTask('embedding')` + provider 抽象，不绕过 llm-config。
- commit message 中文一句话；禁止任何 AI 署名 trailer / 脚注。
