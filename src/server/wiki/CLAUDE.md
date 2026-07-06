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
commitVaultChanges(jobId, "[subject:<slug>] ... [cs:<changesetId>]")
       │
       ▼
operations.status = 'applied'                   ← 释放 lock
```

失败任何一步：`rollbackChangeset(changeset)` 会 `restoreToHead(preHead)` 强制回滚 git，并清掉 SQLite 中对应变更，**仅** reindex 本 subject。

**崩溃恢复（roll-forward）**：git commit 与 `operations.status='applied'` 落库之间不是原子的——进程若恰好在两步之间崩溃，operation 会停在 `pending`，但变更其实已经提交成功。commit message 末尾的 `[cs:<changesetId>]` 标记就是给这种情况用的：worker 启动时（`worker-entry.ts`）对每条 pending operation 调用 `recovery.ts::recoverPendingOperation(changeset)`，在 `preHead..HEAD` 提交范围内查找标记（`git-service::findCommitWithMarker`；并发调度下本 changeset 的提交可能已被后续提交盖过，不能只看 HEAD）三分支判定——① 范围内找到标记提交→**前滚**（postHead=**该提交**哈希 + `applied` + 幂等 `indexTouchedPages`，不碰 git）；② 没找到且 HEAD===preHead→常规 `rollbackChangeset`；③ 没找到且 HEAD!==preHead（本 commit 未落地但之后已有别的提交）→**不做** `restoreToHead`（会连累后续提交），只标 `rolled-back` 终态并记录告警，交人工核查。

## 对外接口

| 文件 | 导出 | 用途 |
|------|------|------|
| `wiki-transaction.ts` | `createChangeset(jobId, subject, entries) / validateChangeset / applyChangeset / rollbackChangeset` | Saga 状态机主控；`Changeset` 含 `subjectId/subjectSlug` |
| `wiki-store.ts` | `readPageBySlug(subjectSlug, slug) / readPageInSubject / readRawSource / writeVaultFiles / deleteVaultFile / scanWikiPages(subjectSlug?)` | 纯文件系统封装；vault/wiki/<subject>/ |
| `markdown.ts` | `parseWikiDocument / serializeWikiDocument`、类型 `WikiDocument` | 组合 frontmatter + wikilinks，透传 currentSubjectSlug |
| `frontmatter.ts` | `parseFrontmatter / serializeFrontmatter / validateFrontmatter`、类型 `WikiFrontmatter` | gray-matter 封装 |
| `wikilinks.ts` | `extractWikiLinks(md, { currentSubjectSlug, titleResolver }) / resolveWikiLinkTarget / normalizeWikiLink`、类型 `ExtractedLink`（含 `targetSubjectSlug` / `rawTitle`） / `TitleResolver` | **全应用 wikilink 单一真实源** + `[[subject:page]]` 跨主题语法 |
| `page-identity.ts` | `parseWikiPath(path) → { subjectSlug, slug } / wikiPathFor(subjectSlug, slug) / normalizeSlug / slugFromTitle / deriveUniqueSlug(title, existingSlugs) / GENERAL_SUBJECT_SLUG / META_PAGE_SLUGS` | path ↔ (subject, slug) 互转；`deriveUniqueSlug` 为 create/split 共用的唯一 slug 派生（冲突自动加后缀）；`META_PAGE_SLUGS`=内置系统页（index/log）**单一源**，indexer/lint/reenrich/curate/page-write 六处共用，杜绝漂移；保留 `slugFromWikiPath` shim 过渡（已无活跃调用方） |
| `indexer.ts` | `indexTouchedPages(subjectId, slugs) / rebuildSearchIndex` | 把解析结果写入 pages + wiki_links + FTS |
| `relink.ts` | `rewriteBacklinkText(raw, oldTitle, newTitle, subjectSlug)` / `repointLinksToPage(raw, fromSlug, toTitle, subjectSlug, titleResolver)` | 纯函数：前者改标题时按「target 文本==旧标题」重写同-subject `[[…]]`（④a）；后者按「解析后 target slug==fromSlug」重写（覆盖 title/slug-form），合并（④b）/拆分（④c）重指均复用。共用私有 `replaceTargetInToken` 保前缀/锚点/别名 |
| `split-plan.ts` | `planSplitPages(pages, existingSlugs, sourceSlug)` | 纯函数：把 LLM 拆分页清单整理为可落盘页——`normalizeSlug` 派生唯一 slug（冲突加后缀、排除 sourceSlug）+ 保证恰一 `isPrimary`（④c） |
| `page-ops.ts` | `executePageMerge(jobId, subject, {targetSlug, sourceSlug})` / `executePageSplit(jobId, subject, {sourceSlug, hint?})` / `executePageDelete(jobId, subject, slug)` / `executePageCreate(jobId, subject, {title, body?, tags?})` / `executePageUpdate(jobId, subject, {slug, body, summary?, tags?})` | merge/split/delete/create/update 执行内核（LLM 调用 + Saga 事务）；无 emit / 无 embed enqueue —— 调用方自持；供 `curate-service` 与 query 工具复用。update 保留标题/系统 frontmatter、替换正文、坏链与残留 unresolved-wikilink 一律拒绝落盘 |
| `curate-plan.ts` | `expandScopeWithNeighbors(seedSlugs, links, subjectId, metaSlugs)` / `createCurateGuard(opts: { seedSet, caps })` | 纯函数：scope 扩展（含邻居）；`createCurateGuard` 工具层硬护栏——caps 计数器（merge/split/delete/create 各≤5）+ seed 强制（auto，seedSet≠null 时 merge/split/delete 必须涉及至少一个 seed 页）+ auto 禁 create + 保护页（共用 `META_PAGE_SLUGS`=index/log 单一源）；`applyDecisionCaps`/`restrictToSeed` 已退休 |
| `revert.ts` | `buildRevertEntries(entries, fileAtPreHead, currentExists)` | 纯函数：给定原 Changeset entries + git preHead 文件快照 + 当前页面存在状态，构造 inverse changeset 条目（preHead 无→delete / 有+当前存在→update 旧内容 / 有+当前不存在→create 旧内容），供 POST /api/history/[id]/revert 执行前向 Saga 还原（⑥） |
| `history.ts` | `buildHistoryEntries(rows, commitBySha)` | 纯函数：合成 HistoryEntry[]（类型推断：jobType 优先否则全 delete→delete/否则 edit、受影响页列表、git 时间戳），供 GET /api/history 列表展示（⑥） |
| `rebuild.ts` | `rebuildFromVault` | 灾难恢复：遍历 vault/wiki/<subject>/ 全量重建 DB |
| `vault-mutex.ts` | `acquireVaultLock(tuning?)` | 进程内互斥队列 + **跨进程文件锁**（vault 同级 `.vault.lock`，O_EXCL 原子创建）；持锁期间 30s 心跳刷新锁文件 mtime（`unref()` 定时器，release 时 try/finally 清理），stale 判定收紧为双条件——mtime 距今 > 3×心跳间隔 **且**（持锁进程不存活 **或** mtime 距今 > 硬上限 30min），避免长任务（>10min）被误判悬挂夺锁；写路径分散在 Next.js 与 worker 两进程，仅内存锁不够。`tuning` 参数仅供测试注入更短的常量 |
| `recovery.ts` | `recoverPendingOperation(changeset): Promise<'rolled-forward' \| 'rolled-back' \| 'orphaned'>` | 崩溃恢复三分支判定（见上文"崩溃恢复"）；被 `worker-entry.ts` 启动时对每条 pending operation 调用，取代旧的"pending 一律回滚" |

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

已覆盖（`__tests__/`，vitest，12 文件）：`wikilinks`（解析 + `[[subject:page]]` 跨主题 + `resolveWikiLinkTarget`）、`wiki-transaction`（validate / rollback 幂等 / applyChangeset）、`frontmatter`（round-trip）、`relink`（改标题/重指引用重写）、`split-plan`、`curate-plan`、`revert`、`history`、`indexer-wakeup`（邻居唤醒）、`page-identity`（`deriveUniqueSlug` 唯一 slug 派生及冲突后缀）、`page-ops-create-delete`（`executePageCreate`/`executePageDelete` Saga 流程与守卫）、`recovery`（`recoverPendingOperation` 前滚/回滚/孤儿三分支，真实临时 vault+SQLite）。

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
├── vault-mutex.ts        # 进程内队列 + 跨进程文件锁
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
| 2026-06-30 | `page-identity.ts` 新增 `META_PAGE_SLUGS`（内置系统页 index/log 单一源）；`indexer`/`curate-plan` 及 services 层（`lint-deterministic`/`reenrich-enqueue`/`curate-service`/`page-write`）原本各持的 `['index','log']` 副本（`META_SLUGS`/`GUARD_META`/`ORPHAN_EXCLUDE_SLUGS`/`PROTECTED_SYSTEM_PAGES`）统一引用此常量；`expandScopeWithNeighbors` 形参 `metaSlugs` 收紧为 `ReadonlySet<string>`（curate follow-up B）|
| 2026-06-30 | `page-ops.ts` 新增 `executePageUpdate(jobId, subject, {slug, body, summary?, tags?})`（update 内核：保留 title/created、替换正文、覆盖 tags/summary、坏链与残留 unresolved-wikilink 一律抛错不落盘）；新增 `page-ops-update` 单测（Spec 3）|
| 2026-07-06 | Saga 提交点原子性（roll-forward 恢复，T1.1）| `commitVaultChanges` message 追加 `[cs:<changesetId>]` 确定性标记；`git-service.ts` 新增 `findCommitWithMarker(marker, sinceSha?)`（在 `sinceSha..HEAD` 范围内查找标记提交——并发调度下本 changeset 的提交可能已被后续提交盖过，不能只看 HEAD）；新增 `recovery.ts::recoverPendingOperation(changeset)` 三分支恢复（范围内找到标记提交→前滚，postHead=该提交哈希+applied+幂等重索引；没找到且 HEAD===preHead→常规 `rollbackChangeset`；没找到且 HEAD!==preHead→**不** `restoreToHead`（避免冲掉后续提交），只标 `rolled-back` 终态+告警）；`worker-entry.ts` 启动扫描 pending operations 改调此函数（原先一律 `rollbackChangeset` 会把已提交成功的变更连同崩溃时序问题一起静默回退丢数据）；`wiki-transaction.ts` 导出 `collectTouchedSlugs` 供恢复模块复用；新增 `recovery.test.ts`（真实临时 vault git 仓库 + 真实临时 SQLite，覆盖三分支 + 并发盖过场景）|
| 2026-07-06 | 回滚补偿完整化：page_sources / sidecar（T1.2）| `sourcesRepo.linkPageSource` 改为返回 `boolean`（本次是否真正新插入，命中已存在的 `(subject,page,source)` 行返回 `false`）；新增 `sourcesRepo.unlinkPageSource(subjectId,pageSlug,sourceId)`（单行删除，供回滚补偿）；`SourceLinkOps` 加可选 `unlinkPageSource`；`applyChangeset` 在事务内收集本次真正新插入的 `insertedSourceLinks` 清单，失败时把清单+`unlinkPageSource` 一并传给 `rollbackChangeset(changeset, compensation)`——只删本次新插入的行，预先存在的行（重复 ingest 场景）不受影响；`sourceOps.updateSourcePageLinks`（sidecar `.llm-wiki/sources/<subject>/*.json`）调用时机从"索引事务后、git commit 前"挪到"git commit 成功 + `operations.applied` 落库之后"——commit 已代表 page_sources 生效，sidecar 只是旁路缓存，失败不该牵连已提交的 changeset；顺序调整后 commit 前从不触碰 sidecar 文件，天然无需回滚补偿。已知限制：`recovery.ts` 分支②（commit 从未发生）复用 `rollbackChangeset(changeset)` 时不传 compensation（崩溃恢复重建的 `Changeset` 不携带 insertedSourceLinks 清单）——若进程恰好在 `linkPageSource` 事务提交后、git commit 前崩溃，重启回滚不会清理这批 page_sources 行，可由后续 rebuild/lint 兜底；此窗口极窄且不在本任务范围|

---

_生成时间：2026-04-22 00:25:29_
