[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **wiki**

# `src/server/wiki/` — Vault 事务核心（Saga）

## 模块职责

把"LLM 产生的计划"落地为**可回滚**的 vault 变更，同时保持 SQLite 索引与 git 历史一致。是整个应用的**写入咽喉**，任何改 vault 的代码都必须经过这里。

## 入口与启动

没有单独进程入口；被 `services/*` handler 调用。典型顺序：

```
createChangeset(jobId, entries)
       │
       ▼
validateChangeset(changeset)              ← 不通过则直接 throw
       │
       ▼
(acquireVaultLock + getVaultHead)         ← preHead 写入 operations
       │
       ▼
writeVaultFiles / deleteVaultFile         ← 文件系统
       │
       ▼
db.transaction:
  pagesRepo.upsert/delete
  wikiLinks 重建
  pages_fts 同步
       │
       ▼
commitVaultChanges(jobId, message)        ← git add + commit，记录 postHead
       │
       ▼
operations.status = 'applied'             ← 释放 lock
```

失败任何一步：`rollbackChangeset(changeset)` 会 `restoreToHead(preHead)` 强制回滚 git，并清掉 SQLite 中对应变更。

## 对外接口

| 文件 | 导出 | 用途 |
|------|------|------|
| `wiki-transaction.ts` | `createChangeset / validateChangeset / applyChangeset / rollbackChangeset` | Saga 状态机主控 |
| `wiki-store.ts` | `readPageBySlug / readAllPages / writeVaultFiles / deleteVaultFile` | 纯文件系统封装 |
| `markdown.ts` | `parseWikiDocument / serializeWikiDocument`、类型 `WikiDocument` | 组合 frontmatter + wikilinks |
| `frontmatter.ts` | `parseFrontmatter / serializeFrontmatter / validateFrontmatter`、类型 `WikiFrontmatter` | gray-matter 封装 |
| `wikilinks.ts` | `extractWikiLinks / resolveWikiLinkTarget / normalizeWikiLink`、类型 `ExtractedLink / TitleResolver` | **全应用 wikilink 单一真实源** |
| `page-identity.ts` | `slugFromWikiPath / wikiPathFromSlug / normalizeSlug / slugFromTitle` | slug ↔ 路径 互转 |
| `indexer.ts` | `indexTouchedPages / rebuildSearchIndex` | 把解析结果写入 pages + wiki_links + FTS |
| `rebuild.ts` | `rebuildFromVault` | 灾难恢复：从 vault 纯文本全量重建 DB |
| `vault-mutex.ts` | `acquireVaultLock / releaseVaultLock` | 单进程 in-memory mutex（因为 worker 单实例运行） |

## 数据契约（`WikiFrontmatter`）

必须字段：`title / created / updated / tags / sources`。
校验失败的 page 不能通过 `validateChangeset`。

## 关键依赖与配置

- `gray-matter` —— YAML frontmatter parsing。
- `simple-git` —— 通过 `git/git-service.ts` 被调用，而非这里直接用。
- `unified` / `remark` —— `wikilinks.ts` / `markdown-client.ts` 使用，用于链接定位。

## 扩展指南

- **新增 frontmatter 字段**：
  1. 更新 `frontmatter.ts` 的 `WikiFrontmatter` 接口与 `validateFrontmatter`；
  2. 同步 `src/lib/contracts.ts::WikiPage`（如需持久化）；
  3. 更新 `indexer.ts::indexTouchedPages` 写入新列。
- **新增 wikilink 语法**：必须**只改** `wikilinks.ts`，不要在前端/lint/LLM 校验复刻。
- **Saga 变更**：任何修改都要保证幂等 —— `rollbackChangeset` 可以被安全地调用多次。

## 测试与质量

当前零测试。强烈建议优先覆盖：

- `parseFrontmatter` / `serializeFrontmatter` round-trip（尤其带 emoji / code fence / windows 行尾）
- `extractWikiLinks` 对 Obsidian 语法：`[[Target]]` / `[[Target|Alias]]` / `[[Target#Section]]`
- `resolveWikiLinkTarget` 对 alias、重名 page、大小写的行为
- `rollbackChangeset` 的幂等：连续两次调用不会爆炸

## 常见问题 (FAQ)

- **SQLite 事务成功但 git commit 失败？**
  Saga 顺序是"先文件 → 先 DB → 最后 git"。git commit 失败触发 rollback：
  - `restoreToHead(preHead)` 强制回滚工作目录；
  - DB 事务已提交 → 需要用 `operations.changeset_json` 反向应用。
  这一路径由 `rollbackChangeset` 负责。
- **为什么读页面要同时支持 titleResolver？**
  为了把 `[[Title With Spaces]]` 这类别名解析到实际 slug —— 这是 `wikilinks.ts` 的职责。

## 相关文件清单

```
src/server/wiki/
├── wiki-transaction.ts   # Saga 主控
├── wiki-store.ts         # fs 读写
├── vault-mutex.ts        # 内存锁
├── markdown.ts           # WikiDocument 组合
├── frontmatter.ts        # gray-matter 封装
├── wikilinks.ts          # ★ 单一真实源
├── page-identity.ts      # slug ↔ path
├── indexer.ts            # 写入 pages + FTS
└── rebuild.ts            # vault → DB 全量重建
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化 |

---

_生成时间：2026-04-22 00:25:29_
