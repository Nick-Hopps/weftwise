[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **db**

# `src/server/db/` — 数据访问层（Drizzle + SQLite）

## 模块职责

1. 启动并持有**全局唯一** better-sqlite3 连接（`client.ts`）。
2. 声明 Drizzle schema（`schema.ts`）—— 但实际建表是启动时的原生 `CREATE TABLE IF NOT EXISTS`（见 `client.ts` 的 `ensureTables`，含 FTS5 虚拟表与触发器）。
3. **legacy schema 自迁移**（`client.ts::ensureTables`）：检测到旧的 `pages.slug PK / sources` 没 `subject_id` 等 → 用 `pragma foreign_keys=OFF` 包裹 `_new + INSERT FROM + DROP + RENAME`，所有 legacy 行继承 `general` subject_id。
4. 启动时确保 `general` subject 存在（`ensureSubjectsAndGeneral()`）。
5. 对外提供 `repos/*` —— 面向领域的 CRUD + 聚合查询。

## 入口与启动

- `getDb()` —— 返回 drizzle 实例（首次调用会懒初始化连接并建表）。
- `getRawDb()` —— 直接拿到 `Database.Database`（用于 FTS 原生 SQL、事务、PRAGMA）。

## 对外接口（`repos/`）

### `subjects-repo.ts` 🆕

- `listSubjects(): Subject[]` —— 按 `name asc`
- `getById(id) / getBySlug(slug) / getBySlugOrThrow(slug)`
- `create({ slug, name, description? }): Subject` —— slug 必须 `^[a-z0-9][a-z0-9-]*$`，冲突 throw `SubjectError('slug-conflict')`
- `rename(id, { name?, description? })` —— 不允许改 slug
- `countPages(subjectId): number`
- `deleteIfEmpty(id): void` —— 非空抛 `SubjectError('not-empty')`，由 API 层转 409
- 错误类：`SubjectError` 含 `code: 'invalid-slug' | 'slug-conflict' | 'not-empty' | 'not-found'`

### `pages-repo.ts`

> **所有方法第一形参强制 `subjectId`**（除显式跨主题查询外）。

- `createPage / upsertPage / updatePage / deletePage`
- `getPageBySlug(subjectId, slug): WikiPage | null`
- `getAllPages(subjectId): WikiPage[]`
- `getAllLinks(subjectId?): WikiLink[]`（不传时全量，用于 graph 全景图）
- `searchPages(subjectId, query): WikiPage[]`（FTS5 + `subject_id` filter）
- `getBacklinks(subjectId, slug): WikiLink[]`
- `getMetaPageKeys(subjectId): Set<string>`（复合键 `<subjectId>:<slug>` 防跨主题误命中）
- `findPageInOtherSubjects(slug): { subjectId, slug, title }[]`（404 兜底提示用）

### `jobs-repo.ts`

- `enqueueJob(type, subjectId, params): Job` —— `subject_id` 写入 jobs；`ingest` / `save-to-wiki` 必填，全量 `lint` / `reset` 可为 NULL
- `claimNextJob(type?): Job | null` —— 原子"pending → running"并写 `lease_expires_at`
- `updateHeartbeat(id)`
- `completeJob / failJob / requeueJob / reclaimExpiredJobs`
- `getJob / listJobs({ status?, type?, subjectId? })`
- `listJobEvents(jobId, afterId?)`

### `sources-repo.ts`

- `upsertSource(subjectId, payload) / findByHash(subjectId, hash) / linkPageToSource(subjectId, pageSlug, sourceId)`

### `operations-repo.ts`

版本历史/回滚核心（⑥）：管理 Saga 操作记录与可恢复性。

- `listForSubject(subjectId): OperationRow[]` —— 按 `rowid DESC` 倒序（id 恒为新 UUID → 纯 INSERT → rowid=时序），过滤 `post_head IS NOT NULL AND status IN (applied, reverted)`；返回 `OperationRow { id, jobId, subjectId, preHead, postHead, changesetJson, status, jobType }`（LEFT JOIN jobs 取 `jobType`，同步编辑/删除无 jobs 行 → null）
- `getById(id): OperationRow | null` —— 取单条记录
- `markReverted(id): void` —— 设 `status='reverted'`（表示用户手动回滚过该操作；与 `rolled-back` 区分）

### `conversations-repo.ts` 🆕

多轮对话持久化（⑦）：`subject_id` scoped，级联 ON DELETE CASCADE。

- `createConversation(subjectId, title): Conversation` —— 新建会话
- `listConversations(subjectId): Conversation[]` —— 按 `updated_at DESC, rowid DESC` 排序
- `getConversation(id): Conversation | null` —— 取单条（不限 subject，由路由校验）
- `renameConversation(id, title): void` —— 改标题 + touch `updated_at`
- `deleteConversation(id): void` —— 级联删 messages
- `appendMessage(conversationId, role, content, citationsJson): ConversationMessage` —— 新增消息
- `listMessages(conversationId): ConversationMessage[]` —— 按 `created_at, rowid ASC` 排序
- `touchConversation(id): void` —— 更新 `updated_at = now`（新消息到达时置顶）

### `embeddings-repo.ts` 🆕

向量语义检索（⑧）：`subject_id` scoped，FK CASCADE。

- `upsertEmbedding(row: { subjectId, slug, model, contentHash, dim, vector: Buffer }): void` —— 按 `(subject_id, slug)` ON CONFLICT 覆盖
- `listForSubject(subjectId, model): { slug, contentHash, dim, vector: Buffer }[]` —— **按 model 过滤**（只返回当前模型向量）
- `deleteBySlug(subjectId, slug): void` —— 删单页向量（导出备用；当前删除/拆分由 embed-index `pruneOrphans` 统一清理）
- `pruneOrphans(subjectId, liveSlugs): void` —— 删 slug ∉ liveSlugs 的孤儿向量（embed-index 任务每次调用）

### `settings-repo.ts`（全局键值设置）

通用 key/value 表，承载所有"全 app 单实例"的全局设置（首个使用方：`wikiLanguage`，存语言名字符串如 "English" / "Chinese"）。

| 列 | 类型 | 备注 |
|----|------|------|
| `key` | TEXT PK | 设置名（如 `wikiLanguage`）|
| `value` | TEXT | 字符串值（zod 校验由调用方 `WikiLanguageSchema` 负责）|
| `updated_at` | TEXT | ISO-8601 时间戳 |

读写统一走 `repos/settings-repo.ts`：

- `getWikiLanguage()` — 缺失时返回 `DEFAULT_WIKI_LANGUAGE`（`English`）
- `setWikiLanguage(value)` — 经 `WikiLanguageSchema.parse()` 校验（trim + min 1 + max 64）后 upsert

服务层（`ingest` / `query` / `lint`）每次调用时**实时**读取，不在启动时缓存，方便 UI 修改即时生效。

**Phase 1 新增的 5 个 agent 配置 key**（由 `app_settings` 表承载，`runPipeline` 每次调用时实时读取）：

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `agentMaxSteps` | number | `25` | 单 job 跨所有 skill step 的最大 tool-call 轮次 |
| `agentMaxTokensPerJob` | number | `1200000` | 单 job token 总预算（in + out 合计）；P2 三轮内容阶段后由 500k 提升至 1.2M |
| `agentMaxParallelSubAgents` | number | `3` | fanout writer step 的最大并发数 |
| `agentMcpLifecycle` | string | `'lazy'` | MCP 连接生命周期（`eager` / `lazy` / `per-job`）|
| `agentTaskRouterMode` | string | `'frontmatter-override'` | skill LLM 选择策略 |
| `agentAutoCurate` | boolean | `true` | 🆕 ingest 完成后自动入队 curate（scope:'pages', touched slugs）；false 关闭自动策展 |

对应 getter/setter 统一在 `settings-repo.ts` 封装，UI 通过 `PUT /api/settings` 写入，**不**镜像到 Zustand。

## 关键依赖与配置

- **依赖**：`better-sqlite3@11`、`drizzle-orm@0.38`、`drizzle-kit@0.29`（生成迁移用）。
- **PRAGMA**：`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`。
- **FTS5**：`pages_fts(title, summary, body, subject_id UNINDEXED, slug UNINDEXED)` + 同步触发器（`pages_ai / pages_ad / pages_au`，触发器同时复制 subject_id/slug）。
- **环境**：`DATABASE_PATH`（默认 `./data/wiki.db`）。
- 迁移命令：
  - `npm run db:generate` / `npm run db:migrate`：drizzle-kit 生成/应用结构性迁移
  - `npm run db:migrate-subjects`：一次性脚本（`scripts/migrate-introduce-subject.ts`），把 legacy DB / vault 升级为 subject-aware（备份 → backfill → vault git mv）
  - 目前实际建表 + 自迁移走 `client.ts::ensureTables`

## 数据模型

见 [根级 CLAUDE.md 数据模型章节](../CLAUDE.md#数据模型见-dbschemats)，核心表：

| 表 | 主键 | 关键约束 |
|----|------|---------|
| `subjects` | `id` | `slug` UNIQUE；`general` 必须存在；`description` 默认 `''` |
| `pages` | `(subject_id, slug)` 复合 PK | 同时 `path` UNIQUE；跨 subject 同名 slug 合法但 path 不能撞 |
| `page_aliases` | `(subject_id, old_slug, new_slug)` | 复合主键，alias 不跨 subject |
| `wiki_links` | `id`（自增） | `subject_id` + `target_subject_id` 必填，allows graph join |
| `sources` | `id` | `subject_id` 必填；`content_hash` 用于去重 |
| `page_sources` | `(subject_id, page_slug, source_id)` | 多对多溯源 |
| `jobs` | `id` | `subject_id` 可空（全局型 lint / reset）；ingest/save-to-wiki 必填 |
| `job_events` | `id` | 顺序由 `created_at` 决定；SSE 用 `Last-Event-Id` 续播 |
| `operations` | `id` | `subject_id` 用于 rollback 时仅 reindex 该 subject；状态机 `pending / applied / rolled-back` |
| `ingest_checkpoints` | `(job_id, kind, key)` 复合 PK | 断点续传：chunk 摘要 / plan / 每页 writer 产出；job 成功即删；不进 vault |
| `conversations` | `id` | `subject_id` FK→subjects ON DELETE CASCADE；`title` + `created_at` + `updated_at` |
| `messages` | `id` | `conversation_id` FK→conversations ON DELETE CASCADE；`role` ('user'\|'assistant') + `content` + `citations_json` (nullable) |
| `page_embeddings` | `(subject_id, slug)` 复合 PK | model + content_hash + dim + vector BLOB + updated_at；FK subject_id CASCADE |
| `page_maturity` | `(subject_id, slug)` 复合 PK | passes + last_enriched + interval_hours + next_due_at + state (active/graduated) + priority；FK subject_id CASCADE |

## 扩展指南

- **新增表**：
  1. `schema.ts` 新增 `sqliteTable(...)`；
  2. `client.ts::ensureTables` 补 `CREATE TABLE IF NOT EXISTS`；
  3. 对应 `repos/` 新建文件封装查询；
  4. 若涉及全文搜索，补 FTS 虚拟表 + 同步触发器。
- **事务**：用 `getRawDb().transaction(fn)()`（better-sqlite3 原生同步事务）。

## 测试与质量

- 无测试。建议添加：
  - `jobs-repo.claimNextJob`：并发情况下只能有一个 worker 拿到（用 `pragma busy_timeout`）。
  - FTS 触发器：插入/更新/删除 `pages` 后 `pages_fts` 一致性。

## 常见问题 (FAQ)

- **为什么不用 Prisma？**
  better-sqlite3 是同步 API、零网络开销，适合 CLI/本地工具；Drizzle 对同步 SQLite 支持优雅且类型安全。
- **ENV 读取在哪？**
  `client.ts` **直接** `process.env.DATABASE_PATH`（没经过 zod 校验），因为 DB 要在最早阶段启动。其它模块仍用 `config/env.ts::getConfig()`。

## 相关文件清单

```
src/server/db/
├── client.ts          # 单例连接 + ensureTables + FTS + legacy 自迁移
├── schema.ts          # Drizzle schema（subjects / pages 复合 PK / target_subject_id）
└── repos/
    ├── subjects-repo.ts       # 主题 CRUD + countPages + deleteIfEmpty
    ├── pages-repo.ts          # 全部强制 subjectId
    ├── jobs-repo.ts           # 写入/查询带 subject_id
    ├── sources-repo.ts        # subject-scoped
    ├── settings-repo.ts       # 全局 key/value 设置（wikiLanguage + 5 个 agent 配置 key + agentAutoCurate）
    ├── checkpoints-repo.ts    # ingest 断点 CRUD + getProgress（getCheckpoints / putCheckpoint / deleteCheckpoints）
    ├── operations-repo.ts     # 版本历史（listForSubject / getById / markReverted，⑥）
    ├── conversations-repo.ts  # 多轮对话 CRUD（⑦）
    ├── embeddings-repo.ts     # 向量语义检索（upsertEmbedding / listForSubject / deleteBySlug / pruneOrphans，⑧）
    └── maturity-repo.ts       # 页面成熟度 CRUD（initMaturity / getMaturity / updateMaturity / listDue / listForSubject，P5）
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化 |
| 2026-04-25 | Subject：复合 PK / target_subject_id / subjects-repo / FTS5 带 subject filter / 启动自迁移 |
| 2026-04-26 | wikiLanguage：新增 `app_settings` 表 + `settings-repo.ts`（`getWikiLanguage` / `setWikiLanguage`）|
| 2026-04-27 | settings-repo 新增 5 个 agent 配置 key（maxSteps / maxTokensPerJob / maxParallelSubAgents / mcpLifecycle / taskRouterMode）|
| 2026-06-20 | ingest_checkpoints 表 + checkpoints-repo（断点续传：getCheckpoints / putCheckpoint / deleteCheckpoints / getProgress）|
| 2026-06-22 | 新增 operations-repo（版本历史时间线取数：listForSubject/getById/markReverted）（⑥）|
| 2026-06-22 | 新增 conversations/messages 两表 + conversations-repo（多轮对话持久化，subject-scoped，级联删除）（⑦）|
| 2026-06-22 | 新增 page_embeddings 表 + embeddings-repo（向量语义检索，subject-scoped，FK CASCADE，无 legacy 迁移）（⑧）|
| 2026-06-22 | settings-repo 加 web 搜索 3 key（`webSearchProvider/webSearchApiKey/webSearchMaxResults` + getter/setter + `getWebSearchConfig()`，无新表，复用 app_settings）（⑨ verifier 联网核查）|
| 2026-06-23 | settings-repo 新增 `agentAutoCurate` key（boolean，默认 true）+ `getAgentAutoCurate` / `setAgentAutoCurate`；UI 通过 `PUT /api/settings` 写入，Agents settings panel 展示；ingest finalize 读取决定是否自动入队 curate |

---

_生成时间：2026-04-22 00:25:29_
