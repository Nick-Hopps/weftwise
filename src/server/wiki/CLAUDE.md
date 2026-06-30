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
| `page-identity.ts` | `parseWikiPath(path) → { subjectSlug, slug } / wikiPathFor(subjectSlug, slug) / normalizeSlug / slugFromTitle / deriveUniqueSlug(title, existingSlugs) / GENERAL_SUBJECT_SLUG` | path ↔ (subject, slug) 互转；`deriveUniqueSlug` 为 create/split 共用的唯一 slug 派生（冲突自动加后缀）；保留 `slugFromWikiPath` shim 过渡（已无活跃调用方） |
| `indexer.ts` | `indexTouchedPages(subjectId, slugs) / rebuildSearchIndex` | 把解析结果写入 pages + wiki_links + FTS |
| `relink.ts` | `rewriteBacklinkText(raw, oldTitle, newTitle, subjectSlug)` / `repointLinksToPage(raw, fromSlug, toTitle, subjectSlug, titleResolver)` | 纯函数：前者改标题时按「target 文本==旧标题」重写同-subject `[[…]]`（④a）；后者按「解析后 target slug==fromSlug」重写（覆盖 title/slug-form），合并（④b）/拆分（④c）重指均复用。共用私有 `replaceTargetInToken` 保前缀/锚点/别名 |
| `split-plan.ts` | `planSplitPages(pages, existingSlugs, sourceSlug)` | 纯函数：把 LLM 拆分页清单整理为可落盘页——`normalizeSlug` 派生唯一 slug（冲突加后缀、排除 sourceSlug）+ 保证恰一 `isPrimary`（④c） |
| `page-ops.ts` | `executePageMerge(jobId, subject, {targetSlug, sourceSlug})` / `executePageSplit(jobId, subject, {sourceSlug, hint?})` / `executePageDelete(jobId, subject, slug)` / `executePageCreate(jobId, subject, {title, body?, tags?})` | merge/split/delete/create 执行内核（LLM 调用 + Saga 事务）；无 emit / 无 embed enqueue —— 调用方自持；供 `curate-service` 与 query 工具复用 |
| `curate-plan.ts` | `expandScopeWithNeighbors(seedSlugs, links, subjectId, metaSlugs)` / `createCurateGuard(opts: { seedSet, caps })` | 纯函数：scope 扩展（含邻居）；`createCurateGuard` 工具层硬护栏——caps 计数器（merge/split/delete/create 各≤5）+ seed 强制（auto，seedSet≠null 时 merge/split/delete 必须涉及至少一个 seed 页）+ auto 禁 create + 保护页（index/log）；`applyDecisionCaps`/`restrictToSeed` 已退休 |
| `revert.ts` | `buildRevertEntries(entries, fileAtPreHead, currentExists)` | 纯函数：给定原 Changeset entries + git preHead 文件快照 + 当前页面存在状态，构造 inverse changeset 条目（preHead 无→delete / 有+当前存在→update 旧内容 / 有+当前不存在→create 旧内容），供 POST /api/history/[id]/revert 执行前向 Saga 还原（⑥） |
| `history.ts` | `buildHistoryEntries(rows, commitBySha)` | 纯函数：合成 HistoryEntry[]（类型推断：jobType 优先否则全 delete→delete/否则 edit、受影响页列表、git 时间戳），供 GET /api/history 列表展示（⑥） |
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

已覆盖（`__tests__/`，vitest，11 文件）：`wikilinks`（解析 + `[[subject:page]]` 跨主题 + `resolveWikiLinkTarget`）、`wiki-transaction`（validate / rollback 幂等 / applyChangeset）、`frontmatter`（round-trip）、`relink`（改标题/重指引用重写）、`split-plan`、`curate-plan`、`revert`、`history`、`indexer-wakeup`（邻居唤醒）、`page-identity`（`deriveUniqueSlug` 唯一 slug 派生及冲突后缀）、`page-ops-create-delete`（`executePageCreate`/`executePageDelete` Saga 流程与守卫）。

仍待补充：

- `parseFrontmatter` / `serializeFrontmatter` 的边界（emoji / code fence / windows 行尾）。
- `resolveWikiLinkTarget` 对重名 page、大小写的更多分支。

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
├── relink.ts             # 改标题/重指引用 重写（纯函数）
├── split-plan.ts         # 拆分页 slug 派生 + 恰一主页（纯函数）
├── page-ops.ts           # 🆕 merge/split 执行内核（无 emit/enqueue，供 curate 复用）
├── curate-plan.ts        # 策展纯函数：expandScopeWithNeighbors + createCurateGuard（caps+seed+auto禁create+保护页）
├── revert.ts             # 还原 changeset 条目派生（纯函数，⑥）
├── history.ts            # 合成 HistoryEntry 时间线（纯函数，⑥）
└── rebuild.ts            # vault → DB 全量重建
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化 |
| 2026-04-25 | Subject：Saga 全链路注入 subjectId / `[[subject:page]]` 语法 / 跨主题校验 / commit message `[subject:<slug>]` 前缀 |
| 2026-06-22 | 新增 `relink.ts::rewriteBacklinkText`（改标题→重写同-subject backlink 文本）；接入 `PUT /api/pages` 同事务联动（④a）|
| 2026-06-22 | `relink.ts` 增 `repointLinksToPage`（按解析后 target slug 匹配，覆盖 title/slug-form），供 `merge-service` 合并时把指向被删页的引用重链到存活页（④b）|
| 2026-06-22 | 新增 `split-plan.ts::planSplitPages`（拆分页 slug 派生 + 兜底恰一主页）；`split-service` 拆分时复用 `repointLinksToPage` 把指向被删页的引用重指主页（④c）|
| 2026-06-22 | 新增 `revert.ts::buildRevertEntries`（回滚 inverse 条目纯函数）+ `history.ts::buildHistoryEntries`（operations 行+git 时间合成时间线条目）；供 ⑥ 版本历史/回滚 |
| 2026-06-22 | `wiki-transaction::SourceLinkOps` 升级为多源：`{ links: Array<{ sourceId; pageSlugs }>; extraStagePaths?: string[]; linkPageSource; updateSourcePageLinks; onWarning? }`；`applyChangeset` stage `affectedPaths ∪ extraStagePaths`、遍历 `links` 写 page_sources（事务内）+ `updateSourcePageLinks`（事务后各自 try/catch）；向后兼容（空 links+paths→sourceOps undefined）。供 ⑨ 把核查引用网页随同一 ingest commit 导入为 source |
| 2026-06-23 | 新增 `page-ops.ts`（`executePageMerge` / `executePageSplit`，merge/split 执行内核，无 emit/enqueue）；新增 `curate-plan.ts`（`expandScopeWithNeighbors` / `applyDecisionCaps` / `restrictToSeed` 三个纯函数）；relink.ts 与 split-plan.ts 保留不变，由 page-ops 内部调用 |
| 2026-06-24 | 文档：测试与质量小节更新为实际覆盖（9 文件） |
| 2026-06-30 | `page-ops.ts` 新增 `executePageDelete`/`executePageCreate`（对话工具内核，无 emit/enqueue，Saga 事务）；`page-identity.ts` 新增 `deriveUniqueSlug(title, existingSlugs)`（create/split 共用唯一 slug 派生，冲突自动加后缀）；新增 `page-identity`/`page-ops-create-delete` 单测覆盖 |
| 2026-06-30 | `curate-plan.ts` 重构：新增 `createCurateGuard({ seedSet, caps })` 工具层硬护栏（caps≤5×4 + seed 强制 + auto 禁 create + 保护页），退休 `applyDecisionCaps`/`restrictToSeed`（原结构化流水线护栏，已由 guard 取代） |

---

_生成时间：2026-04-22 00:25:29_
