[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **db**

# `src/server/db/` — 数据访问层（Drizzle + SQLite）

## 模块职责

1. 启动并持有**全局唯一** better-sqlite3 连接（`client.ts`）。
2. 声明 Drizzle schema（`schema.ts`）—— 但实际建表是启动时的原生 `CREATE TABLE IF NOT EXISTS`（见 `client.ts` 的 `ensureTables`，含 FTS5 虚拟表与触发器）。
3. 对外提供 `repos/*` —— 面向领域的 CRUD + 聚合查询。

## 入口与启动

- `getDb()` —— 返回 drizzle 实例（首次调用会懒初始化连接并建表）。
- `getRawDb()` —— 直接拿到 `Database.Database`（用于 FTS 原生 SQL、事务、PRAGMA）。

## 对外接口（`repos/`）

### `pages-repo.ts`

- `createPage / upsertPage / updatePage / deletePage`
- `getPageBySlug(slug): WikiPage | null`
- `getAllPages(): WikiPage[]`
- `getAllLinks(): WikiLink[]`
- `searchPages(query): WikiPage[]`（FTS5）
- `getBacklinks(slug): WikiLink[]`

### `jobs-repo.ts`

- `enqueueJob(type, params): Job`
- `claimNextJob(type?): Job | null` —— 原子"pending → running"并写 `lease_expires_at`
- `updateHeartbeat(id)`
- `completeJob / failJob / requeueJob / reclaimExpiredJobs`
- `getJob / listJobs({ status?, type? })`
- `listJobEvents(jobId, afterId?)`

### `sources-repo.ts`

- `upsertSource / findByHash / linkPageToSource`

## 关键依赖与配置

- **依赖**：`better-sqlite3@11`、`drizzle-orm@0.38`、`drizzle-kit@0.29`（生成迁移用）。
- **PRAGMA**：`journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout=5000`。
- **FTS5**：`pages_fts(title, summary, body)` + 同步触发器（`pages_ai / pages_ad / pages_au`）。
- **环境**：`DATABASE_PATH`（默认 `./data/wiki.db`）。
- 迁移命令：`npm run db:generate` / `npm run db:migrate`（目前实际建表走 `client.ts::ensureTables`，迁移脚本可作为补充）。

## 数据模型

见 [根级 CLAUDE.md 数据模型章节](../CLAUDE.md#数据模型见-dbschemats)，核心表：

| 表 | 主键 | 关键约束 |
|----|------|---------|
| `pages` | `slug` | `content_hash` 必填，`tags` 存 JSON 字符串 |
| `page_aliases` | `(old_slug, new_slug)` | 复合主键 |
| `wiki_links` | `id`（自增） | 无唯一约束 → 一对多关系可重复 |
| `sources` | `id` | `content_hash` 用于去重 |
| `jobs` | `id` | `lease_expires_at` + `heartbeat_at` 驱动 worker 租约 |
| `job_events` | `id` | 顺序由 `created_at` 决定；SSE 用 `Last-Event-Id` 续播 |
| `operations` | `id` | Saga 状态机 (`pending / applied / rolled-back`) |

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
├── client.ts          # 单例连接 + ensureTables + FTS
├── schema.ts          # Drizzle schema
└── repos/
    ├── pages-repo.ts
    ├── jobs-repo.ts
    └── sources-repo.ts
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化 |

---

_生成时间：2026-04-22 00:25:29_
