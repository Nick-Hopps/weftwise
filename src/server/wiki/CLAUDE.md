[根目录](../../../CLAUDE.md) > [src](../../) > [server](../) > **wiki**

# `src/server/wiki/` — Vault 事务核心（Saga）

## 模块职责

把"LLM 产生的计划"落地为**可回滚**的 vault 变更，同时保持 SQLite 索引与 git 历史一致。是整个应用的**写入咽喉**，任何改 vault 的代码都必须经过这里。

## 入口与启动

没有单独进程入口；被 `services/*` handler 调用。典型顺序：

```
createChangeset(jobId, subject, entries)        ← 必须传 Subject（id+slug）
       │
       ▼
validateChangeset(changeset)                    ← subject-scoped knownSlugs/titleMap
       │                                           跨主题 [[s:p]] 单独校验对方 subject
       ▼
(acquireVaultLock + getVaultHead)               ← preHead + subject_id 写入 operations
       │
       ▼
writeVaultFiles / deleteVaultFile               ← 文件系统：vault/wiki/<subject>/...
       │
       ▼
db.transaction:
  pagesRepo.upsert/delete (传 subjectId)
  wikiLinks 重建（含 target_subject_id）
  pages_fts 同步
       │
       ▼
commitVaultChanges(jobId, "[subject:<slug>] ...")
       │
       ▼
operations.status = 'applied'                   ← 释放 lock
```

失败任何一步：`rollbackChangeset(changeset)` 会 `restoreToHead(preHead)` 强制回滚 git，并清掉 SQLite 中对应变更，**仅** reindex 本 subject。

## 对外接口

| 文件 | 导出 | 用途 |
|------|------|------|
| `wiki-transaction.ts` | `createChangeset(jobId, subject, entries) / validateChangeset / applyChangeset / rollbackChangeset` | Saga 状态机主控；`Changeset` 含 `subjectId/subjectSlug` |
| `wiki-store.ts` | `readPageBySlug(subjectSlug, slug) / readAllPages / writeVaultFiles / deleteVaultFile / scanWikiPages(subjectSlug?)` | 纯文件系统封装；vault/wiki/<subject>/ |
| `markdown.ts` | `parseWikiDocument / serializeWikiDocument`、类型 `WikiDocument` | 组合 frontmatter + wikilinks，透传 currentSubjectSlug |
| `frontmatter.ts` | `parseFrontmatter / serializeFrontmatter / validateFrontmatter`、类型 `WikiFrontmatter` | gray-matter 封装 |
| `wikilinks.ts` | `extractWikiLinks(md, { currentSubjectSlug, titleResolver }) / resolveWikiLinkTarget / normalizeWikiLink`、类型 `ExtractedLink`（含 `targetSubjectSlug` / `rawTitle`） / `TitleResolver` | **全应用 wikilink 单一真实源** + `[[subject:page]]` 跨主题语法 |
| `page-identity.ts` | `parseWikiPath(path) → { subjectSlug, slug } / wikiPathFor(subjectSlug, slug) / normalizeSlug / slugFromTitle / GENERAL_SUBJECT_SLUG` | path ↔ (subject, slug) 互转；保留 `slugFromWikiPath` shim 过渡（已无活跃调用方） |
| `indexer.ts` | `indexTouchedPages(subjectId, slugs) / rebuildSearchIndex` | 把解析结果写入 pages + wiki_links + FTS |
| `rebuild.ts` | `rebuildFromVault` | 灾难恢复：遍历 vault/wiki/<subject>/ 全量重建 DB |
| `vault-mutex.ts` | `acquireVaultLock / releaseVaultLock` | 单进程 in-memory mutex（因为 worker 单实例运行） |

## 数据契约（`WikiFrontmatter`）

必须字段：`title / created / updated / tags / sources`。
校验失败的 page 不能通过 `validateChangeset`。

## Wikilink 语法（唯一真实源）

| 语法 | 含义 |
|------|------|
| `[[Target]]` | 本 subject 内的页（按 title 解析回 slug） |
| `[[target-slug]]` | 本 subject 内的页（直接 slug） |
| `[[Target#Heading]]` | 本 subject 内带 anchor |
| `[[Target\|Alias]]` | 本 subject + 渲染别名 |
| `[[other-subject:Page]]` | 跨主题：明确目标 subject + 该 subject 内的 title 或 slug |
| `[[other-subject:page-slug\|Alias]]` | 跨主题 + 别名 |

> 解析顺序：`splitFirst(rawInner, ':')` → 若前缀符合 slug 正则 `^[a-z0-9][a-z0-9-]*$` 视为 subject 前缀；否则按本 subject 解析。`extractWikiLinks` 兼容旧 `(md, resolver)` 与新 `(md, options)` 双签名。

## 关键依赖与配置

- `gray-matter` —— YAML frontmatter parsing。
- `simple-git` —— 通过 `git/git-service.ts` 被调用，而非这里直接用。
- `unified` / `remark` —— `wikilinks.ts` / `markdown-client.ts` 使用，用于链接定位。

## 扩展指南

- **新增 frontmatter 字段**：
  1. 更新 `frontmatter.ts` 的 `WikiFrontmatter` 接口与 `validateFrontmatter`；
  2. 同步 `src/lib/contracts.ts::WikiPage`（如需持久化）；
  3. 更新 `indexer.ts::indexTouchedPages` 写入新列。
- **新增 wikilink 语法**：必须**只改** `wikilinks.ts`，并在 `src/lib/markdown-client.ts` 镜像渲染规则；不要在前端业务组件 / lint / LLM 校验复刻。
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
| 2026-04-25 | Subject：Saga 全链路注入 subjectId / `[[subject:page]]` 语法 / 跨主题校验 / commit message `[subject:<slug>]` 前缀 |

---

_生成时间：2026-04-22 00:25:29_
