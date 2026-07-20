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
- `deleteWithContents(id): void` —— 级联删除：守卫（不存在→`not-found`；`general`→`protected`；有入站跨主题引用→`has-inbound-refs`）后单事务按子→父清全部 subject-scoped 行 + subject 行（原生 SQL，同 `/api/reset?subjectId` 风格）
- `listInboundReferences(id): { id, slug }[]` —— 其他 subject 指向本 subject 的去重 referrer（删除前入站引用守卫用）
- 错误类：`SubjectError` 含 `code: 'invalid-slug' | 'slug-conflict' | 'not-found' | 'protected' | 'has-inbound-refs'`

### `pages-repo.ts`

> **所有方法第一形参强制 `subjectId`**（除显式跨主题查询外）。

- `createPage / upsertPage / updatePage / deletePage`
- `getPageBySlug(subjectId, slug): WikiPage | null`
- `getAllPages(subjectId): WikiPage[]`
- `getAllLinks(subjectId?): WikiLink[]`（不传时全量，用于 graph 全景图）
- `searchPages(subjectId, query): { page, snippet, rank }[]`（FTS5 + `subject_id` filter；snippet 固定取正文列并携带受控 `<mark>` 命中标记）
- `getBacklinks(subjectId, slug): WikiLink[]`
- `getMetaPageKeys(subjectId): Set<string>`（复合键 `<subjectId>:<slug>` 防跨主题误命中）
- `findPageInOtherSubjects(slug): { subjectId, slug, title }[]`（404 兜底提示用）

### `jobs-repo.ts`

- `enqueueJob(type, subjectId, params): Job` —— `subject_id` 写入 jobs；`ingest` / `save-to-wiki` 必填，全量 `lint` / `reset` 可为 NULL
- `claimNextJob(type?): Job | null` —— 原子"pending → running"并写 `lease_expires_at`
- `updateHeartbeat(id, expectedAttempt)` —— `attempt_count` fencing token 防旧 worker 续租新 attempt
- `completeJob / failJob / requeueJob / reclaimExpiredJobs`
- `requestCancel(jobId)` —— pending/running 原子落 failed+cancelled；普通 failed 可终结；completed 或已取消 failed 返回 `already-terminal`
- `getJob / listJobs({ status?, type?, subjectId? })`
- `listRecentJobs(filter, limit)` / `listLatestCompletedLint(subjectId)` —— 分别用于有界状态恢复与单行最新 lint CAS
- `getOrCreateJobAtomic(...)` —— `BEGIN IMMEDIATE` 内只查同 subject/type 的在途或仍可复用 completed 候选，再由 matcher 精确匹配 context
- `reingestSourceAtomic(...)` / `findLatestIngestJobForSource(subjectId, sourceId)` —— 通过 JSON 表达式索引精确读取同源 ingest；reingest 会读取全部 active 并优先复用 exact-context job，否则任取 active 阻止新建；DELETE 查询只需任一 active；只有无 active 才取最新 terminal，再原子重排或创建
- `getJobEvents(jobId, afterId?)` —— 按 SQLite rowid 插入顺序读取；afterId 先解析 cursor rowid，避免同毫秒随机 UUID 漏事件

### `sources-repo.ts`

- `upsertSource(subjectId, payload) / findByHash(subjectId, hash) / linkPageToSource(subjectId, pageSlug, sourceId)`
- `listUnreferencedSources(subjectId)` —— 零 page_sources 关联的 source（孤儿候选）；`deleteSource(id)` —— 删单行（文件清理归 source-store）；`findLatestIngestJobForSource(subjectId, sourceId)`（jobs-repo）—— 使用受 `json_valid` 保护的 source 与 source+status 两个 JSON 表达式索引，先返回任意 pending/running，只有无 active 才返回最新 terminal；损坏 JSON 历史不会中断查询或建索引
- `listPageSourceIntegrityRows(subjectId, pageSlugs)` —— 定向 LEFT JOIN pages/sources，保留 page/source 悬空与 source Subject 错配行，供 Fix / Curate 写后只读校验

### `operations-repo.ts`

版本历史/回滚核心（⑥）：管理 Saga 操作记录与可恢复性。

- `listForSubject(subjectId): OperationRow[]` —— 按 `rowid DESC` 倒序（id 恒为新 UUID → 纯 INSERT → rowid=时序），过滤 `post_head IS NOT NULL AND status IN (applied, reverted)`；返回 `OperationRow { id, jobId, subjectId, preHead, postHead, changesetJson, status, jobType }`（LEFT JOIN jobs 取 `jobType`，同步编辑/删除无 jobs 行 → null）
- `getById(id): OperationRow | null` —— 取单条记录
- `markReverted(id): void` —— 既有 History UI 直接确认后设 `status='reverted'`（与 `rolled-back` 区分）
- `markRevertedIfApplied(id, subjectId): boolean` —— PendingAction 最终化的 subject/status 条件更新，防跨 Subject 或重复回滚
- `listAppliedForJob(jobId, subjectId): OperationRow[]` —— 仅返回 `applied + post_head 非空` 行，按 `rowid ASC` 提交顺序供写后影响范围收集

### `conversations-repo.ts` 🆕

多轮对话持久化（⑦）：`subject_id` scoped，级联 ON DELETE CASCADE。

- `createConversation(subjectId, title): Conversation` —— 新建会话
- `listConversations(subjectId): Conversation[]` —— 按 `updated_at DESC, rowid DESC` 排序
- `getConversation(id): Conversation | null` —— 取单条（不限 subject，由路由校验）
- `renameConversation(id, title): void` —— 改标题 + touch `updated_at`
- `deleteConversation(id): void` —— 级联删 messages
- `appendMessage(conversationId, role, content, evidenceJson): ConversationMessage` —— 新增消息；`messages.citations_json` 作为兼容的角色相关证据容器，user 反序列化到 `references`，assistant 反序列化到 `citations`
- `listMessages(conversationId): ConversationMessage[]` —— 按 `created_at, rowid ASC` 排序
- `touchConversation(id): void` —— 更新 `updated_at = now`（新消息到达时置顶）

### `pending-actions-repo.ts`

审批闭环持久化与原子状态流转：记录服务端规范化 payload/hash、预览、TTL 和执行引用。`workflow-image-insert-start` payload 持久化 canonical 块原文/上下文锚点与图片请求；批准时 `image-insert` job insert 和 action applied 同一 IMMEDIATE transaction。Chat action 带 `conversation_id`，Tags 工作台 `tag-batch` 使用 NULL conversation；状态更新均用条件 UPDATE 防并发双消费。

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
- `getBodyFontSize()` — 缺失或历史脏值时返回当前正文基线 `16`
- `setBodyFontSize(value)` — 经 `BodyFontSizeSchema` 校验后写入 `14–22` 的整数像素字号

服务层（`ingest` / `query` / `lint`）每次调用时**实时**读取，不在启动时缓存，方便 UI 修改即时生效。

**Phase 1 新增的 4 个 agent 配置 key**（由 `app_settings` 表承载，`runPipeline` 每次调用时实时读取）：

| Key | 类型 | 默认值 | 说明 |
|-----|------|--------|------|
| `agentMaxSteps` | number | `25` | 单 job 跨所有 skill step 的最大 tool-call 轮次 |
| `agentMaxTokensPerJob` | number | `1200000` | 单 job token 总预算（in + out 合计）；P2 三轮内容阶段后由 500k 提升至 1.2M |
| `agentMaxParallelSubAgents` | number | `3` | fanout writer step 的最大并发数 |
| `agentTaskRouterMode` | string | `'frontmatter-override'` | skill LLM 选择策略 |
| `agentAutoCurate` | boolean | `true` | 🆕 ingest 完成后自动入队 curate（scope:'pages', touched slugs）；false 关闭自动策展 |

对应 getter/setter 统一在 `settings-repo.ts` 封装，UI 通过 `PUT /api/settings` 写入，**不**镜像到 Zustand。

## 关键依赖与配置

- **依赖**：`better-sqlite3@11`、`drizzle-orm@0.38`、`drizzle-kit@0.29`（生成迁移用）。
- **PRAGMA**：`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`。
- **FTS5**：`pages_fts(title, summary, body, subject_id UNINDEXED, slug UNINDEXED)`。**没有** `CREATE TRIGGER`（`pages_ai/pages_ad/pages_au` 这类触发器在代码中不存在）——一致性完全靠**手动维护**：`pages-repo.ts::updateFtsEntry`（写/改）与 `deleteFtsEntry`（删）两个函数，调用点集中在 `wiki/indexer.ts`（`rebuildPageIndex`/单页重索引路径）与 `pages-repo.ts` 自身的删除逻辑。**警示**：任何绕开 `indexTouchedPages`/`updateFtsEntry`/`deleteFtsEntry` 直接写 `pages` 表的代码（例如临时脚本用原生 SQL `UPDATE pages`）都会造成 `pages_fts` 与 `pages` 静默漂移（全文搜索结果与实际内容不一致），且没有触发器兜底纠正；发现漂移时用 `npm run db:rebuild` 全量重建修复。
- **环境**：`DATABASE_PATH`（默认 `./data/wiki.db`）。
- 迁移命令：
  - `npm run db:generate` / `npm run db:migrate`：drizzle-kit 生成/应用结构性迁移
  - `npm run db:migrate-subjects`：一次性脚本（`scripts/migrate-introduce-subject.ts`），把 legacy DB / vault 升级为 subject-aware（备份 → backfill → vault git mv）
  - `npm run db:rebuild`：灾难恢复脚本（`scripts/rebuild-cache.ts`），DB 丢失/损坏/与 vault 不同步时从 vault 全量重建（`rebuild.ts::rebuildDatabaseFromVault`：清空 pages/pages_fts/wiki_links/page_aliases/sources/page_sources → 按 vault 文件重新索引 → 从 `.llm-wiki/sources/<subject>/*.json` 侧车恢复 source 记录与 page_sources 关联）；运行前会先抢 vault 写锁，抢不到（worker 仍在跑）会报错退出，提示先停 worker
  - 目前实际建表 + 自迁移走 `client.ts::ensureTables`

## 数据模型

见 [根级 CLAUDE.md 数据模型章节](../CLAUDE.md#数据模型见-dbschemats)，核心表：

| 表 | 主键 | 关键约束 |
|----|------|---------|
| `subjects` | `id` | `slug` UNIQUE；`general` 必须存在；`description` 默认 `''` |
| `pages` | `(subject_id, slug)` 复合 PK | 同时 `path` UNIQUE；跨 subject 同名 slug 合法但 path 不能撞 |
| `page_aliases` | `(subject_id, old_slug, new_slug)` | 复合主键；`(subject_id, old_slug)` UNIQUE，单个旧身份只能解析到一个 canonical page；alias 不跨 subject |
| `wiki_links` | `id`（自增） | `subject_id` + `target_subject_id` 必填，allows graph join |
| `sources` | `id` | `subject_id` 必填；`content_hash` 用于去重 |
| `page_sources` | `(subject_id, page_slug, source_id)` | 多对多溯源 |
| `jobs` | `id` | `subject_id` 可空（全局型 lint / reset）；ingest/save-to-wiki 必填 |
| `job_events` | `id` | 持久化顺序由 SQLite `rowid`（INSERT 顺序）决定；SSE 用 `Last-Event-Id` 解析 cursor rowid 后续播 |
| `operations` | `id` | `subject_id` 用于 rollback 时仅 reindex 该 subject；状态机 `pending / applied / rolled-back / reverted`；🆕 GC：`pruneOldOperations` 每 subject 只保留最近 500 条终态行（`pending` 永不删），挂在 worker 低频 sweep（无时间戳列，退化为单条件数量保留，见 operations-repo.ts 注释） |
| `ingest_checkpoints` | `(job_id, kind, key)` 复合 PK | 断点续传：chunk 摘要 / plan / 每页 writer 产出；job 成功即删；不进 vault |
| `conversations` | `id` | `subject_id` FK→subjects ON DELETE CASCADE；`title` + `created_at` + `updated_at` |
| `messages` | `id` | `conversation_id` FK→conversations ON DELETE CASCADE；`role` ('user'\|'assistant') + `content` + `citations_json` (nullable，role=user 时保存用户正文引用，role=assistant 时保存回答 citations) |
| `pending_actions` | `id` | `conversation_id` 可空（Chat 有值，Tags 工作台为空）/`subject_id` FK CASCADE；状态 `pending/approved/executing/applied/rejected/expired/failed`；30 分钟 TTL；`operation_id` 指向页面或 History inverse Saga，`job_id` 指向已批准的 workflow；operation CHECK 含 `tag-batch/move/history-revert/workflow-*` |
| `page_embeddings` | `(subject_id, slug)` 复合 PK | model + content_hash + dim + vector BLOB + updated_at；FK subject_id CASCADE |
| `page_maturity` | `(subject_id, slug)` 复合 PK | passes + last_enriched + interval_hours + next_due_at + state (active/graduated) + priority；FK subject_id CASCADE |
| `research_backlog` | `id` | `subject_id` FK CASCADE；`question` + `source`('ask-ai'\|'manual') + `status`('open'\|'researched'\|'dismissed') + `research_job_id`（nullable）；同 subject 内 open 项按归一化 question 去重（`research-backlog-repo.create`） |
| `research_runs` | `id` | `research_job_id` UNIQUE；subject/origin/status/version/candidate_set_hash；finding run 关联来源 lint；`verification_lint_job_id` 仅兼容升级前在途验证 |
| `research_run_findings` | `(run_id, finding_id)` | 原始 finding snapshot + `pending/fixed/residual/unverifiable` 验证终态；随 run 级联删除 |
| `research_candidates` | `id` | `(run_id, normalized_url)` UNIQUE；稳定候选快照、rank、decision 与 approval 复合外键，客户端不能改 URL |
| `research_approvals` | `id` | 每 run 唯一；保存 canonical candidate ID selection、payload hash、idempotency key 与 coordinator job ID |
| `research_candidate_ingests` | `(approval_id, candidate_id)` | run/candidate/approval 复合外键；claim token/lease、source/child job、operation/page/commit lineage；`ingest_job_id` UNIQUE |
| `llm_usage` | `id`（自增） | app 级明细；`subject_id` 可空、FK→subjects ON DELETE SET NULL，一次 LLM 调用一行：`task` + `model` + token 数 + `created_at`；`(subject_id, created_at)` 支持项目筛选，旧记录和全局调用保持未归因；90 天 GC（`pruneOldUsage`，worker 低频 sweep） |

## 扩展指南

- **新增表**：
  1. `schema.ts` 新增 `sqliteTable(...)`；
  2. `client.ts::ensureTables` 补 `CREATE TABLE IF NOT EXISTS`；
  3. 对应 `repos/` 新建文件封装查询；
  4. 若涉及全文搜索，补 FTS 虚拟表，并在对应 repo 提供手动维护入口（参照 pages-repo 的 updateFtsEntry/deleteFtsEntry；本项目不使用触发器）。
- **事务**：用 `getRawDb().transaction(fn)()`（better-sqlite3 原生同步事务）。

## 测试与质量

已覆盖（`__tests__/` + `repos/__tests__/`，vitest）：

- repos CRUD/查询：subjects / pages（复合 PK、path unique、跨 Subject 同 slug、精确 upsert/delete、`getBacklinks` JOIN）/ sources / jobs（双进程 claim、到期租约、attempt fencing/requeue、取消幂等、事件清扫、同毫秒插入顺序与 cursor）/ operations / conversations / embeddings / maturity / checkpoints / settings；Research provenance 另覆盖 run 原子创建/批准/忽略、候选约束、delivery token/lease CAS、source+child job 同事务唯一入队、目标化 finding postcondition 终态物化、旧 verification lint 兼容与 subject/reset 级联。
- Research run 仓储还以真实 SQLite 覆盖 v2 finding immutable snapshot（`targetSlug/evidence`）写入及 ID 重算一致性；旧 v1 snapshot 的兼容解析由 service 纯函数测试锁定，无表结构迁移。
- `indexes.test.ts`：用 `EXPLAIN QUERY PLAN` 断言 wiki_links / job_events / jobs 热路径走索引（非全表扫描），包含 remediation CAS 候选与同源 ingest JSON 表达式查询；后者同时覆盖损坏历史参数安全性。
- `pages-repo-invariants.test.ts`：真实 SQLite 覆盖复合身份约束，以及无 trigger 前提下 `updateFtsEntry/deleteFtsEntry/deletePage` 的替换、搜索和 Subject 隔离。
- `jobs-repo.test.ts`：两个独立 Node 进程同时调用真实 `claimNextJob`，在 WAL + busy_timeout 下只有一个领取；并覆盖 `lease_expires_at <= now`、reclaim 与 attempt 语义。
- `rebuild.test.ts`：`rebuildDatabaseFromVault` 核心逻辑（wipe + reindex + 侧车恢复统计）；`scripts/rebuild-cache.ts` 入口脚本本身（CLI 输出 + 锁获取）未覆盖，逻辑极薄，说明即可。

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
    ├── subjects-repo.ts       # 主题 CRUD + countPages + deleteWithContents/listInboundReferences
    ├── pages-repo.ts          # 全部强制 subjectId
    ├── jobs-repo.ts           # 写入/查询带 subject_id
    ├── sources-repo.ts        # subject-scoped
    ├── settings-repo.ts       # 全局 key/value 设置（wikiLanguage + 4 个 agent 配置 key + agentAutoCurate）
    ├── checkpoints-repo.ts    # ingest 断点 CRUD + getProgress（getCheckpoints / putCheckpoint / deleteCheckpoints）
    ├── operations-repo.ts     # 版本历史（listForSubject / getById / markReverted，⑥）
    ├── conversations-repo.ts  # 多轮对话 CRUD（⑦）
    ├── embeddings-repo.ts     # 向量语义检索（upsertEmbedding / listForSubject / deleteBySlug / pruneOrphans，⑧）
    ├── maturity-repo.ts       # 页面成熟度 CRUD（listDue/countDue/listDueDetailed 支持可选 Subject 集合过滤，detailed 版 JOIN pages/subjects 供到期预览；其余 get / ensureRow / applyAfterEnrich / bumpNeighbor / pruneOrphans，P5）
    ├── research-provenance-repo.ts # Research 五表 run/批准/delivery/验证原子状态机
    └── usage-repo.ts          # LLM 用量明细：recordUsage（best-effort 项目归因）/ summarizeUsage（按项目可选过滤、task+model 聚合）/ pruneOldUsage（90 天 GC）
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-07-20 | `retryResearchIngestJobAtomic` 可在既有 lineage 校验内合并 `sourceAuthGrantId`：grant params、failed job→pending、delivery→queued、run→importing 同属一个 IMMEDIATE transaction，任一 CAS 失败整体回滚 |
| 2026-07-20 | `maturity-repo` 新增 `listDueDetailed(nowIso, limit, subjectIds?)`：WHERE/ORDER 与 `listDue` 同口径，LEFT JOIN pages 取标题（孤儿行 title=null）、JOIN subjects 取 slug/name，供 `GET /api/maintenance/due-pages` 到期预览 |
| 2026-07-20 | `llm_usage` 新增可空 `subject_id` 与项目时间复合索引；已知 Subject 的 LLM/Embedding/图片调用显式归因，删除 Subject 时归因置空保留用量，历史未归因记录只进入全局汇总 |
| 2026-07-17 | conversations repo 将既有 `messages.citations_json` 明确为 role-aware 消息证据容器：用户消息恢复到 `references`，Assistant 消息继续恢复到 `citations`；旧 NULL/Assistant JSON 无迁移兼容 |
| 2026-07-17 | `pending_actions.operation` CHECK 加入 `workflow-image-insert-start`；Drizzle `0010` 与启动期原子重建均保留旧行/索引并继续拒绝未知 operation |
| 2026-07-16 | pending_actions 支持工作台来源：`conversation_id` 改可空、CHECK 增 `tag-batch`，Drizzle 0008 与启动期结构化 PRAGMA 检测均原子重建并保留历史；repo 增 Subject-scoped TagBatch 创建/恢复/在途去重 |
| 2026-07-16 | `settings-repo` 新增 `maintenanceScope` JSON key（`all` 或非空 Subject ID 集合，旧配置默认 all）；`maturity-repo.listDue/countDue` 支持同口径 Subject 范围过滤 |
| 2026-07-15 | `research-provenance-repo` 新增 failed child Ingest 原位重试事务：校验 run/approval/candidate/source/job lineage 后同步恢复 jobs、delivery、run，保留 checkpoint 与 attempt history；取消或 verification 后状态 fail-closed |
| 2026-07-15 | Research finding run 停止创建 verification lint；repo 支持 `verificationJobId=null` 时从 importing 原子物化目标化 postcondition，旧 verifying run 仍可按既有 job ID 完成；已物化验证结果禁止误走导入重试 |
| 2026-07-15 | Research finding snapshot JSON 补齐可选 targetSlug/evidence，仓储写前 ID 不变量现可覆盖 v2 coverage-gap/contradiction；字段可选，无 SQLite schema migration |
| 2026-07-14 | job_events 改按 SQLite rowid 的真实插入顺序读取与 afterId 续播，消除同毫秒随机 UUID 乱序/漏读；requestCancel 对已取消 failed 返回 already-terminal，保证取消终态幂等 |
| 2026-07-14 | Worker/DB 不变量测试收尾：双进程真实 repo claim、到期租约与 attempt fencing/requeue 边界；旧 attempt 不得 heartbeat/complete/fail/requeue 新 attempt；pages 复合 PK/path unique、跨 Subject 同 slug 与手动 FTS update/delete/search 一致性 |
| 2026-07-14 | 页面身份迁移 Phase 3D：`page_aliases` 增加 subject+oldSlug 唯一索引并由索引器从 frontmatter aliases 同步；pending_actions CHECK 增加 `move`，Drizzle 0007 与启动迁移均先去重再升级旧库 |
| 2026-07-14 | History 工具 Phase 3B：pending_actions operation CHECK 增加 `history-revert`，Drizzle 0005 与启动期原子重建兼容旧库；operations repo 增加 subject/status 条件标记供审批最终化 |
| 2026-07-14 | Research 批准溯源 Phase 2C：新增 `research_runs / research_run_findings / research_candidates / research_approvals / research_candidate_ingests` 五表、复合外键与热路径索引；Drizzle migration 与启动期原子兼容迁移同构；subject 删除/reset 和重复 source 合并同步维护 provenance 引用；repo 提供 run 批量读取、批准/忽略、delivery 租约、source+child job 唯一入队和 verification CAS |
| 2026-07-13 | Health remediation 原子查询去除 subject 全历史扫描：CAS 只读取同 type 的可复用状态候选；同源 ingest 改走受 `json_valid` 保护的 sourceId/sourceId+status 表达式索引，reingest 全量读取 active 并优先 exact-context，DELETE 只取任一 active，仅在无 active 时取最新 terminal；补历史噪声、双入口去重、requeue 与 EQP 回归 |
| 2026-07-11 | Wiki 审批闭环 Phase 1B：新增 `pending_actions` 表、热路径索引与 repo 条件状态流转；预览 30 分钟 TTL，终态保留 30 天，operation/job 双引用支持 worker 崩溃恢复 |
| 2026-07-12 | Phase 1C：`operations-repo.listAppliedForJob` 提供 Job/Subject 已应用 Changeset 权威范围；`sources-repo.listPageSourceIntegrityRows` 提供定向 provenance 完整性快照 |
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
| 2026-06-24 | 移除 `agentMcpLifecycle` 设置 key + `getAgentMcpLifecycle` / `setAgentMcpLifecycle`（MCP 功能整体移除，详见根 Changelog）；agent 配置 key 由 5 降为 4 |
| 2026-06-24 | 性能：补热路径索引（`ensureIndexes`：wiki_links target/source + job_events + jobs）；`getBacklinks`/`getSourcesForPage` 改 JOIN 消除 N+1；`getAllLinks` 加可选 `metaKeys` 参；新增 `pruneJobEvents`；落地 pages/sources/jobs-repo + indexes 单测 |
| 2026-06-27 | Cognitive Lens：新增 `user_profiles`（账户层画像，单例 user_id='local'）/ `page_renditions`（重塑版本，一页一行，**故意不挂 subjects FK**）/ `profile_signals`（append-only 反馈）三表；新增 profiles/renditions/signals repos |
| 2026-07-17 | Reshape 持久化升级：`page_renditions` 改为保存每页最新成功版本；新增 `page_rendition_assets` 存储重塑专属图片；`replaceRendition` 在单一 SQLite 事务内原子替换 Markdown 与图片，Refresh 失败/取消保留旧版本 |
| 2026-07-17 | Reshape 生命周期补强：`deleteByPage` 原子清理指定页正文与图片；删页、Subject/global reset 与页面 move 均同步维护 `page_rendition_assets`，避免同 slug 重建复活旧版本或遗留图片 |
| 2026-06-29 | Subject 级联删除：subjects-repo 新增 `deleteWithContents(id)`（单事务按子→父清全部 subject-scoped 表 + subject 行，原生 SQL 同 reset 风格）与 `listInboundReferences(id)`（入站跨主题引用守卫）；`SubjectError` code 去 `not-empty`、加 `protected`/`has-inbound-refs`；删除旧 `deleteIfEmpty`。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-29-subject-cascade-delete* |
| 2026-07-07 | T3.2：新增 `research_backlog` 表（subject-scoped，id PK，FK subject_id CASCADE）+ `research-backlog-repo`（create 按归一化 question 去重 open 项 / listForSubject / updateStatus）；`deleteWithContents` 级联清单补该表；`lib/research-question.ts::normalizeResearchQuestion` 纯函数供去重复用 |
| 2026-07-10 | 新增 `llm_usage` 明细表（app 级，非 subject-scoped，无 FK）+ `usage-repo`（`recordUsage` best-effort 记账、`summarizeUsage` 按 task+model 聚合、`pruneOldUsage` 90 天 GC 常量 `USAGE_RETENTION_MS`）；provider-registry 五入口（generateStructuredOutput/generateTextWithTools/streamTextResponse/streamTextWithTools/generateEmbeddings）与 agent-loop ingest 各阶段成功路径记账；worker 低频 sweep 挂 GC；`GET /api/usage?window=7d\|30d\|all` 供设置弹窗 Usage 面板读取 |

---

_生成时间：2026-04-22 00:25:29_
