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
| `page-identity.ts` | `parseWikiPath(path) → { subjectSlug, slug } / wikiPathFor(subjectSlug, slug) / normalizeSlug / assertCanonicalPageSlug / deriveUniqueSlug(title, existingSlugs) / GENERAL_SUBJECT_SLUG / META_PAGE_SLUGS` | path ↔ (subject, slug) 互转；任何路径拼接/读取前用 `assertCanonicalPageSlug` 拒绝 `..`、绝对路径与未规范化 slug；`deriveUniqueSlug` 为 create/split 共用的唯一 slug 派生（冲突自动加后缀）；`META_PAGE_SLUGS`=内置系统页（index/log）单一源 |
| `rewrite-fidelity.ts` 🆕 | `checkRewriteFidelity(original, revised, profile) / FIDELITY_PROFILES`（四档：`supplement`/`merge-update`/`fix`/`reshape`） | **统一保真护栏单一真实源**（T1.4）：长度/wikilink（复用 `wikilinks.ts::extractWikiLinks`，preserve/subset/none）/heading/frontmatter 四项检查，阈值集中在 `FIDELITY_PROFILES`；fix/reshape/supplement 三条既有护栏 + ingest merge-update（新增）共用同一实现，不再各写一份 |
| `indexer.ts` | `indexTouchedPages(subjectId, slugs) / rebuildSearchIndex` | 把解析结果写入 pages + wiki_links + FTS |
| `meta-pages.ts` 🆕 | `renderIndexPage(pages, opts) / renderLogPage(entries, opts) / parseLogEntries(existingLogMd) / buildIngestLogEntry(sources, pageCount) / resolveTemplateLang(wikiLanguage)` | **T2.1**：subject 系统元页（`index.md`/`log.md`）确定性渲染，取代原 `ingest-indexer` LLM 结构化输出——纯函数，零 LLM 调用。index 按每页第一个 tag 分组（无 tag 归 Uncategorized/未分类，永远排最后）、组内按标题排序，条目 `[[slug\|Title]] — summary`；log 保留最近 `MAX_LOG_ENTRIES=50` 条（新条目在前），既有条目由 `parseLogEntries` 解析既有正文 bullet 行还原。`resolveTemplateLang` 把自由文本 `wikiLanguage` 粗略二值化为 zh/en 模板（只影响分组标题/表头等固定文案，不影响页面 title/summary 本身的语言）。调用方 `ingest-service.ts::finalizeIngest` |
| `relink.ts` | `rewriteBacklinkText / repointLinksToPage / rewriteLinksForPageMove` | 纯函数：标题变更、合并/拆分与页面 move 共用 token 级重写，保留 subject 前缀、锚点和显示别名；move 只改当前 Subject 源文件 |
| `split-plan.ts` | `planSplitPages(pages, existingSlugs, sourceSlug)` | 纯函数：把 LLM 拆分页清单整理为可落盘页——`normalizeSlug` 派生唯一 slug（冲突加后缀、排除 sourceSlug）+ 保证恰一 `isPrimary`（④c） |
| `narrow-write.ts` | `normalizeMetadataPatch / prepareMetadataPatch / buildLinkEnsureEdit` | metadata/link 窄写纯内核：字段规范化、alias 身份冲突、唯一自然锚点、Markdown token 边界、link/unlink/retarget 与跨主题 target 形态校验；零 I/O、零 LLM |
| `page-ops.ts` | `executePageMerge/Split/Delete/Create/Update/Patch/MetadataPatch/LinkEnsure` + `applyPatchEdits` | 所有页面写入的 direct 执行内核（Saga）；无 emit / 无 embed enqueue，由调用方持有调度。metadata patch 逐字复用正文并把 title relink 放入同一 changeset；link ensure 只把确定性单 edit 委托 patch plan，唯一写对象是 source page |
| `page-operation-plan.ts` / `unified-diff.ts` | `planPageCreate/Update/Patch/Delete/MetadataPatch/LinkEnsure/Move` + `applyPlannedPageOperation` | direct 与审批共享的 plan/apply 层；move 规划 old delete + new create + backlink/source sidecar 更新；`expectedPreHead` 在 vault mutex 内、任何 fs/DB 写入前核对，避免批准陈旧预览覆盖并发提交 |
| `page-identity-migration.ts` | `collectPageIdentityMoves / migratePageIdentityCaches` | 按 changeset move marker 幂等迁移 page_sources、embedding、maturity、rendition 与 profile signal slug，供 apply/rollback/recovery/History revert 共用 |
| `curate-plan.ts` | `expandScopeWithNeighbors(seedSlugs, links, subjectId, metaSlugs)` / `createCurateGuard(opts: { seedSet, allowedSet, caps })` | 纯函数：scope 扩展（含邻居）；Guard 强制 allowedSet/seed/meta 边界，并分别限制 merge/split/delete/create/update；metadata/link 窄写共用 `canEditPage` 与独立 update cap |
| `revert.ts` | `buildRevertEntries(entries, fileAtPreHead, currentExists)` | 纯函数：给定原 Changeset entries + git preHead 文件快照 + 当前页面存在状态，构造 inverse changeset 条目（preHead 无→delete / 有+当前存在→update 旧内容 / 有+当前不存在→create 旧内容），供 History API 与 `services/history-tools.ts` 共用（⑥ / Phase 3B） |
| `history.ts` | `buildHistoryEntries(rows, commitBySha)` | 纯函数：合成 HistoryEntry[]（类型推断：jobType 优先否则全 delete→delete/否则 edit、受影响页列表、git 时间戳），供 History API 与 `history.list` 共用（⑥ / Phase 3B） |
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

已覆盖（`__tests__/`，vitest，27 文件）：wikilink 解析与跨主题解析、Saga validate/apply/rollback/recovery、frontmatter round-trip、relink/split/meta pages、page identity 与 canonical slug、create/update/patch/delete/move、统一 diff/陈旧 HEAD、Curate Guard、metadata/link 纯窄写与 plan/apply。move 集成测试覆盖 alias/旧 URL 解析、当前与跨 Subject 链接、source sidecar、全部 slug 派生缓存及反向回滚。

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
├── rewrite-fidelity.ts   # 🆕 统一保真护栏（四档 profile，T1.4）
├── indexer.ts            # 写入 pages + FTS
├── relink.ts             # 改标题/重指引用 重写（纯函数）
├── split-plan.ts         # 拆分页 slug 派生 + 恰一主页（纯函数）
├── narrow-write.ts       # metadata/link 窄写纯函数与确定性 edit
├── page-operation-plan.ts # create/update/patch/delete/metadata/link/move 共用 plan/apply
├── page-identity-migration.ts # move 派生缓存正反向迁移
├── unified-diff.ts       # 审批预览统一 diff
├── page-ops.ts           # 页面写入 direct 内核（无 emit/enqueue）
├── curate-plan.ts        # scope + Guard（caps/seed/allowedSet/update/保护页）
├── revert.ts             # 还原 changeset 条目派生（纯函数，⑥）
├── history.ts            # 合成 HistoryEntry 时间线（纯函数，⑥）
└── rebuild.ts            # vault → DB 全量重建
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-07-14 | 页面身份迁移 Phase 3D：新增 move plan、alias 解析、当前 Subject backlink 与 source sidecar 同 commit 更新；Saga 按 marker 迁移 slug 派生缓存并重建索引，rollback/recovery/History revert 支持反向身份迁移 |
| 2026-07-14 | History 工具 Phase 3B：既有 `history.ts/revert.ts` 纯函数由共享 `services/history-tools.ts` 复用；回滚预览以当前 HEAD 生成 inverse diff，批准 apply 使用 `expectedPreHead` 与 vault mutex 拒绝陈旧计划 |
| 2026-07-13 | Wiki 窄写 Phase 2B：新增 metadata patch 与 link ensure 纯函数、共享 plan/apply/direct 内核；metadata 正文逐字保留且 title relink 同 changeset，link 只写 source page；canonical slug 在任何 HEAD/读取前阻断路径穿越，Curate Guard 增加 allowedSet 内 update cap |
| 2026-07-11 | Wiki 审批闭环 Phase 1B：新增 page-operation-plan/unified-diff 预览层，页面 create/update/patch/delete 统一 plan→apply；`applyChangeset` 支持 expectedPreHead 并在 vault 锁内、首次写入前拒绝陈旧预览 |
| 2026-07-10 | Curate allowedSet 硬边界：createCurateGuard 新增 allowedSet/isAllowed；merge 两端、split、manual delete 均受 scope 限制，Auto delete/create 固定拒绝；services/curate-tools 的 read/search/list 同步过滤 allowedSet，compile policy 再以同一集合包装上下文 |
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
| 2026-07-06 | T1.4 统一保真护栏：新增 `rewrite-fidelity.ts::checkRewriteFidelity` + `FIDELITY_PROFILES`（四档 `supplement`/`merge-update`/`fix`/`reshape`），wikilink 提取复用 `wikilinks.ts::extractWikiLinks`；fix/reshape/re-enrich supplement 三条既有护栏改调此模块（退役各自独立实现）；ingest merge-update（orchestrator 写更新页）首次接入长度/链接/heading 护栏 |
| 2026-07-09 | `page-ops.ts::executePageUpdate` 支持改标题：新增 `title?` 参数，标题变化时取本 subject 内 backlinks 逐个用 `relink.ts::rewriteBacklinkText` 重写引用文本（排除自引用），随原页更新一并进同一个 Saga 事务；返回值新增 `referencesUpdated`（无标题变化恒为 0）。供 fix 与新接入的问答（Ask AI）`wiki_update` 工具复用 |
| 2026-07-10 | 新增 `page-ops.ts::executePagePatch(jobId, subject, {slug, edits})` + 纯函数 `applyPatchEdits(body, edits)`（仿 Claude Code Edit 工具语义：逐组 old_string/new_string 必须在当前正文中精确唯一出现，任一组失败整批不落盘）；`executePagePatch` 拼出完整新正文后委托 `executePageUpdate`，继承 Saga/坏链拒绝/单 commit，只动 body。供对话式 `wiki.patch`（fix + query 两个 runner）复用；相较整页 `wiki.update`，局部替换风险面更小，故服务层包装 `patchPageInSubject` **不接忠实度护栏** |

---

_生成时间：2026-04-22 00:25:29_
