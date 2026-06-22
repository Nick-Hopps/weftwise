[根目录](../../CLAUDE.md) > [src](../) > **server**

# `src/server/` — 后端业务逻辑总入口

## 模块职责

承载所有 "server-only" 的逻辑，按能力纵向分层。**客户端代码一律不得直接 import 此目录下的文件**（靠 Next.js runtime + 代码约定隔离）。

```
Route Handler / Worker Handler
        │
        ▼
┌─────────────────────────────────────────────────────────┐
│  services/   ingest-service / query-service / lint-*    │ ← 长任务总指挥
├─────────────────────────────────────────────────────────┤
│  llm/        provider-registry / task-router / prompts  │ ← LLM 多供应商抽象
│  wiki/       changeset / saga / indexer / wikilinks     │ ← Vault 事务核心
│  sources/    parser-registry / source-store             │ ← 原始文档摄入
├─────────────────────────────────────────────────────────┤
│  jobs/       queue / worker / events                    │ ← 异步任务基础设施
│  db/         client / schema / repos/*                  │ ← Drizzle + SQLite
│  git/        git-service                                │ ← simple-git 封装
│  middleware/ auth / subject                             │ ← 鉴权/CSRF + subject 解析
│  config/     env                                        │ ← 环境变量
└─────────────────────────────────────────────────────────┘
```

## 入口与启动

- **Worker 进程入口**：`worker-entry.ts`
  - 自加载 `.env`；
  - 初始化 DB；
  - **确保 `general` subject 存在**（首次启动 seed）；
  - FTS 自愈（空索引重建）；
  - 回收过期租约的任务 (`queue.reclaimExpired`)；
  - 回滚 `operations` 表中 `status='pending'` 的记录（按 `operations.subject_id` 仅 reindex 该 subject，缺失则 warn 跳过）；
  - 确保 vault git 仓库存在；
  - 启动 `startWorker(pollMs)` 轮询；
  - 注册 `SIGTERM` / `SIGINT` 优雅关停。

- **Next.js 侧入口**：通过 Route Handler import `server/jobs/queue` 入队；不直接 import `worker.ts`。

## 对外接口（主要导出符号）

| 子模块 | 关键导出 |
|--------|----------|
| `jobs/queue` | `enqueue / claim / complete / fail / get / list / requeue / reclaimExpired` |
| `jobs/worker` | `registerHandler / startWorker / stopWorker` |
| `jobs/events` | `emit`（写 `job_events` 并推送到 SSE 订阅者） |
| `wiki/wiki-transaction` | `createChangeset(jobId, subject, entries) / validateChangeset / applyChangeset / rollbackChangeset` |
| `wiki/wiki-store` | `readPageBySlug(subjectSlug, slug) / writeVaultFiles / deleteVaultFile / scanWikiPages(subjectSlug?)` |
| `wiki/markdown` | `parseWikiDocument / serializeWikiDocument`（单一真相 round-trip） |
| `wiki/wikilinks` | `extractWikiLinks(md, { currentSubjectSlug, titleResolver }) / resolveWikiLinkTarget / normalizeWikiLink` |
| `wiki/indexer` | `indexTouchedPages(subjectId, slugs) / rebuildSearchIndex`（写 pages + wiki_links + FTS） |
| `wiki/page-identity` | `parseWikiPath / wikiPathFor(subjectSlug, slug) / normalizeSlug / GENERAL_SUBJECT_SLUG` |
| `llm/provider-registry` | `generateStructuredOutput / streamTextResponse / generateEmbeddings / isEmbeddingConfigured / embeddingModelId`（⑧） |
| `llm/task-router` | `resolveTask`（合并 defaults / task / override） |
| `search/vector-math` | `encodeVector / decodeVector / cosineSimilarity / rrfMerge`（⑧ 向量纯函数） |
| `search/semantic-search` | `semanticSearch(query, subjectId, model)`（⑧ 向量 topK cosine） |
| `search/hybrid-retrieval` | `hybridRankSlugs(query, subjectId)`（⑧ FTS + 向量 RRF；未配置回落纯 FTS） |
| `db/client` | `getDb / getRawDb`（启动时自迁移 legacy schema → subject-aware） |
| `db/repos/*` | `subjectsRepo / pagesRepo / jobsRepo / sourcesRepo / embeddingsRepo` 的 CRUD + FTS search（全部要求 `subjectId`）|
| `git/git-service` | `ensureVaultRepo / getVaultHead / commitVaultChanges / restoreToHead / getFileAtCommit / getDiff / getVaultLog / parseGitLog` |
| `middleware/auth` | `requireAuth / requireCsrf / createSessionResponse` |
| `middleware/subject` | `resolveSubjectFromRequest(request, { required?, body? })` |
| `config/env` | `getConfig / vaultPath` |

## 关键依赖与配置

- **环境变量**（`config/env.ts` 用 zod 校验）：
  - `VAULT_PATH` → 解析成绝对路径
  - `DATABASE_PATH` → 解析成绝对路径
  - `WIKI_API_KEY` → 可选；设置即启用鉴权
- **SQLite PRAGMA**：`journal_mode=WAL` + `foreign_keys=ON` + `busy_timeout=5000`（见 `db/client.ts`）。
- **Next.js 配置**：`serverExternalPackages: ['better-sqlite3']`（`next.config.ts`）。

## 数据模型（见 `db/schema.ts`）

| 表 | 用途 |
|----|------|
| `subjects` | first-class 主题（`id` PK + `slug` UNIQUE + `name` + `description`），`general` 必须存在 |
| `pages` | wiki 页面索引（**复合 PK `(subject_id, slug)`** + `path UNIQUE` + title + summary + tags + hashes） |
| `page_aliases` | slug 重命名映射（PK `(subject_id, old_slug, new_slug)`） |
| `wiki_links` | 每条 `[[link]]` 的 source/target/context；`subject_id` + `target_subject_id` 让 graph/lint 能 join |
| `sources` | 原始源文件元数据（带 `subject_id`） |
| `page_sources` | 页面 ↔ 源 多对多溯源（PK `(subject_id, page_slug, source_id)`） |
| `jobs` | 任务队列（带 `subject_id` + `lease_expires_at` / `heartbeat_at` / `attempt_count`）；task.type 支持 `embed-index`（⑧） |
| `job_events` | SSE 事件持久化，供断线续播 |
| `operations` | Saga changeset 及其 `preHead` / `postHead` / `subject_id`，供崩溃回滚 |
| `page_embeddings` | 向量嵌入存储（PK `(subject_id, slug)` + model + content_hash + vector BLOB，FK CASCADE）（⑧） |
| `pages_fts` | FTS5 虚拟表，title + summary + body（含 UNINDEXED `subject_id` / `slug`） |

## 测试与质量

- **当前没有测试**。建议首先覆盖：
  1. `wiki/wikilinks.ts`（解析+解析目标）
  2. `wiki/frontmatter.ts`（round-trip）
  3. `wiki/wiki-transaction.ts`（validate / rollback 的幂等）
  4. `jobs/worker.ts`（retry 分类 + 租约心跳）

## 常见问题 (FAQ)

- **两个进程同时写 vault 怎么办？**
  - worker 内部用 `isProcessing` flag 串行；
  - 写 vault 时再抢 `acquireVaultLock`（`wiki/vault-mutex.ts`）；
  - git 提交的原子性保证同一时刻只有一次成功。
- **崩溃后 SQLite 与 git 不一致？**
  启动时扫 `operations` 表的 `pending` 记录，调 `rollbackChangeset(pre_head)` 把 git 强制回退并清数据库对应变更；按 `operations.subject_id` 仅 reindex 该 subject。
- **如何为新接口注入 subject？**
  顶部调 `const { subject, error } = resolveSubjectFromRequest(request, { required: true, body })`；error 非空直接 `return error`。

## 相关文件清单（顶层）

```
src/server/
├── worker-entry.ts                # Worker 进程 main
├── db/           → 见 db/CLAUDE.md
├── wiki/         → 见 wiki/CLAUDE.md
├── search/       → 向量语义检索（vector-math / semantic-search / hybrid-retrieval，⑧）
├── jobs/         → 见 jobs/CLAUDE.md
├── llm/          → 见 llm/CLAUDE.md
├── services/     → 见 services/CLAUDE.md
├── sources/      → 见 sources/CLAUDE.md
├── git/git-service.ts
├── middleware/auth.ts
├── middleware/subject.ts            # resolveSubjectFromRequest 单一真实源
└── config/env.ts
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化：梳理后端分层与交叉引用 |
| 2026-04-25 | 引入 Subject：subjects 表 + 复合 PK + middleware/subject + 全链路 subjectId |
| 2026-06-22 | git-service 加 getVaultLog/parseGitLog；新增 operations-repo + wiki/{revert,history}.ts + /api/history* 路由（⑥ 版本历史/diff）|
| 2026-06-22 | 新增 search/ 模块（vector-math/semantic-search/hybrid-retrieval）+ embeddings-repo + embed-index worker 任务（⑧ 向量语义检索）|

---

_生成时间：2026-04-22 00:25:29_
