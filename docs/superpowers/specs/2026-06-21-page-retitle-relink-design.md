# 页面改标题 + 引用联动（Retitle & Relink）设计

> 日期：2026-06-21
> 状态：已确认，待写实现计划
> 关联：特性序列第 ④ 项「页面重组」拆分后的 ④a（④b 合并两页 / ④c 拆分一页 后续单独立项）

---

## 一、背景与动机

页面有两个独立的标识：

- **slug** = 身份标识：同时是 URL 路径（`/wiki/<slug>`，catch-all 逐字相等）、文件路径（`vault/wiki/<subject>/<slug>.md`）、DB 复合主键 `(subject_id, slug)`、graph 节点 id、所有 wikilink 最终解析的落点。
- **title** = 显示名（frontmatter `title:` + 冗余存 `pages.title`）+ 一种**动态别名**；**不出现在 URL 里**。

两者在建页时由 `normalizeSlug(title)` 派生一致，但**出生后互不同步**：特性②的编辑器改 frontmatter `title:`，不会动 slug / 文件 / URL。

wikilink 解析（`wikilinks.ts` + indexer 的 `titleMap`）：
```
target = titleMap.get(X) ?? titleMap.get(X.toLowerCase()) ?? normalizeSlug(X)
```
`titleMap` 是「当前所有页 title → slug」，每次重索引按当前标题重建。

**问题**：改标题后（slug 不变），散落在其它页正文里以旧标题书写的 `[[Old Title]]` 引用——
- **功能不断**：`titleMap` 没了 "Old Title" 会兜底 `normalizeSlug("Old Title")` = 原 slug，照样跳得到；
- **但显示文本停留在旧名**（陈旧）。

④a 补这层：改标题时，把这些引用的字面同步刷成新名。**纯展示一致性，零断链风险。**

---

## 二、范围（v1）

> **改页面标题（frontmatter `title:`）时，把本 subject 内正文中以旧标题书写的 `[[Old Title]]` 引用，在同一个 Saga 事务里重写为 `[[New Title]]`。slug / URL / 文件全程不动。入口在编辑器的保存流程。**

### 已定决策

1. **不动 slug**：改标题不改 slug、不移文件、不改 URL。改 slug（身份变更）的需求改动面太大，明确不在本期范围。
2. **读法 A（重写源码文本）**：把本 subject 内正文里以旧标题书写的 `[[Old Title]]` 字面重写为 `[[New Title]]`（保留 `|别名`、`#锚点`、subject 前缀）。这是 Obsidian 式「重命名联动」，是真正要做的活。
3. **入口在编辑器**：并入现有保存流程（`PUT /api/pages`），不另起 rename 端点、不在阅读页加独立弹窗。
4. **服务端检测 + 保存后提示**：编辑器不变，保存成功后用返回的 `referencesUpdated` 计数弹 toast 提示。不做保存前确认弹窗（标题是用户自己在 frontmatter 改的、纯展示一致性、零断链，自动联动符合直觉，且省掉客户端解析 frontmatter 标题的脆弱逻辑）。

### 重写规则（精确）

对每个 backlink 源页，重新抽取 wikilink（带 `position`），筛出解析到本页 slug 的那些，**仅当链接的 target 文本（`rawTitle`，去 subject 前缀 / `#锚点` / `|别名` 后）忽略大小写 == 旧标题，且链接指向本 subject（无前缀或前缀 == 本 subjectSlug）时**，把 target 文本重写为新标题：

| 原文 | 重写后 |
|------|--------|
| `[[Old Title]]` | `[[New Title]]` |
| `[[old title]]`（小写） | `[[New Title]]` |
| `[[Old Title\|看这里]]` | `[[New Title\|看这里]]`（别名保留） |
| `[[Old Title#用法]]` | `[[New Title#用法]]`（锚点保留） |
| `[[old-slug]]`（slug 形式，`rawTitle != 旧标题`） | **不动**（作者刻意显示 slug，且仍能跳） |
| `[[本subject:Old Title]]`（来自别的 subject 的跨主题引用） | **不动**（单事务约束；slug 没变仍能跳，仅显示陈旧） |

### 明确不做（YAGNI）

- 改 slug / 移动页面 / page_aliases / 读路径重定向（本期不动 slug）。
- 跨 subject 引用文本重写（changeset 单 subject 约束；slug 不变故功能不断）。
- 保存前「将更新 N 处」确认弹窗（除非后续明确要控制感）。
- 标题唯一性强校验 / 重名合并（titleMap 重名 last-write-wins 是既有行为，不在本期解决）。
- ④b 合并两页、④c 拆分一页（独立立项）。

---

## 三、架构与数据流

```
编辑器 Save → PUT /api/pages/<...slug>  { content }
  PUT:
    existing = pagesRepo.getPageBySlug(subject.id, slug)   // 旧标题 = existing.title
    newTitle = parseFrontmatter(content).data.title
    entries = [ update(本页 path, content) ]
    referencesUpdated = 0
    if refreshReferences(默认 true) && newTitle && newTitle !== existing.title:
      for bl of getBacklinks(subject.id, slug).filter(bl => bl.subjectId === subject.id):
        doc = readPageInSubject(subject.slug, bl.slug)
        sourceRaw = serializeWikiDocument(doc)   // 整文件 raw（含 frontmatter），见 §五
        rewritten = rewriteBacklinkText(sourceRaw, existing.title, newTitle, subject.slug)
        if rewritten !== sourceRaw:
          entries.push(update(bl path, rewritten)); referencesUpdated++
    validateChangeset(changeset)        // warning 不阻断
    applyChangeset(changeset)           // 一次提交；indexer 两遍按新 titleMap 重解析全部 touched 页
    return { ok, slug, subjectId, referencesUpdated }
```

关键点：

- 所有改动条目都在**当前 subject**、都是 `update`，满足 changeset 单 subject 约束，一次原子提交。
- `applyChangeset` 的 `collectTouchedSlugs` 会收集本页 + 全部被重写的源页；`indexTouchedPages` 第一遍 upsert（titleMap 纳入本页新标题），第二遍按新 titleMap 解析 `[[New Title]]` → 本 slug，wiki_links 边正确。
- validate 阶段 `[[New Title]]` 可能触发「unresolved wikilink」**warning**（DB 里本页标题尚未更新），warning 不阻断 apply。

---

## 四、纯函数契约

```ts
// src/server/wiki/relink.ts（新增）

/**
 * 重写一段「整文件 raw markdown」里指向旧标题的同-subject wikilink。
 * - 用 extractWikiLinks(raw, { currentSubjectSlug: subjectSlug }) 取 link + position。
 * - 仅当 link.rawTitle.trim().toLowerCase() === oldTitle.trim().toLowerCase()
 *   且（link.targetSubjectSlug 为空 或 === subjectSlug）时改写。
 * - 改写：把 [[...]] 内 target 文本段替换为 newTitle，保留 subject 前缀、#锚点、|别名。
 * - 按 position 从右往左替换，避免偏移串位。
 * - 无匹配返回原串（引用方据此判断是否产生 changeset 条目）。
 *
 * 注：extractWikiLinks 已对代码块做 mask，code fence / 行内 code 内的 [[...]] 不会被改。
 */
export function rewriteBacklinkText(
  raw: string,
  oldTitle: string,
  newTitle: string,
  subjectSlug: string,
): string;
```

> 约定：函数操作**整文件 raw**（frontmatter + 正文），因为回写 changeset 需要整文件内容；`extractWikiLinks` 对 frontmatter 区域不会误命中 `[[...]]`（frontmatter 是 YAML，正常不含 wikilink），且其 position 基于传入字符串绝对偏移，故传整文件即可。实现里以 `extractWikiLinks(raw, …)` 的 position 直接在 raw 上替换。

---

## 五、新增 / 改动文件

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/server/wiki/relink.ts` | 新增 | 纯函数 `rewriteBacklinkText` —— TDD 目标 |
| `src/server/wiki/__tests__/relink.test.ts` | 新增 | `rewriteBacklinkText` 单测 |
| `src/app/api/pages/[...slug]/route.ts` | 改动 | PUT：检测标题变化 → 收集同 subject backlink 源页 → `rewriteBacklinkText` → 追加 `update` 条目到同一 changeset；返回 `referencesUpdated`；schema 加可选 `refreshReferences`（默认 true） |
| `src/components/wiki/page-editor.tsx` | 改动 | 保存成功后读 `referencesUpdated`，>0 时弹 toast「已保存 — 同步更新了 N 处引用」；mutation 返回值透传计数 |

### 源页整文件 raw 的获取

PUT 内重写源页需要源页的**整文件 raw**（含 frontmatter）。`readPageInSubject(subject.slug, bl.slug)` 返回 `WikiDocument`（frontmatter + body + links）；用 `serializeWikiDocument(doc)` 还原整文件 raw，再交给 `rewriteBacklinkText`。`serializeWikiDocument` 已是 round-trip 单一真相（特性②的 GET 已用它产 `raw` 字段）。

---

## 六、UI 行为

- 编辑器布局、加载、dirty 守卫、Cancel **均不变**。
- 保存成功后：若 `referencesUpdated > 0`，弹一个轻量成功提示（toast / 内联 banner，复用项目现有提示风格）：`已保存 — 同步更新了 N 处引用到新标题`；`=0` 时保持现有「跳回阅读页」行为，无额外提示。
- 跳回阅读页后，被改名页标题与各引用页的链接文本都已是新名（router.refresh + 缓存失效已就绪）。

---

## 七、边界处理

- **标题没变** 或 **没有同 subject backlink** → changeset 退化为单条 `update`，行为与今天完全一致。
- **跨主题 backlink**（来自别的 subject）→ 不改（slug 没变仍可跳，仅显示陈旧）。
- **自定义 slug**（slug ≠ normalizeSlug(title)）→ 仍正确：`titleMap[新标题] = 本 slug`，`[[New Title]]` 解析到本页。
- **code fence / 行内 code 内的 `[[...]]`** → `extractWikiLinks` 已 mask，不会被改。
- **同一源页多处引用、混合 title-form 与 slug-form** → 只改 title-form（`rawTitle == 旧标题`）的那几处，slug-form 原样。
- **新标题解析告警** → validate 的 unresolved warning 不阻断；apply 后两遍索引修正。
- **新标题为空 / 解析失败** → 不触发重写（`newTitle` falsy 时跳过联动），按普通保存处理。

---

## 八、测试（node-only，无 RTL）

1. **`rewriteBacklinkText` 纯函数**（`src/server/wiki/__tests__/relink.test.ts`）
   - title-form `[[Old Title]]` → `[[New Title]]`；
   - 小写 `[[old title]]` → `[[New Title]]`；
   - 别名 `[[Old Title|看这里]]` → `[[New Title|看这里]]`（别名保留）；
   - 锚点 `[[Old Title#用法]]` → `[[New Title#用法]]`（锚点保留）；
   - slug-form `[[old-slug]]`（rawTitle≠旧标题）原样不动；
   - 跨主题前缀 `[[other:Old Title]]`（targetSubjectSlug≠本 subject）不动；
   - 同段多处混合：title-form 改、slug-form 不改，多处替换不串位（右起替换验证）；
   - code fence 内 `[[Old Title]]` 不改；
   - 无匹配 / 空串 → 返回原串。
2. PUT 行为与编辑器 toast：tsc + dev 验收（项目无 DOM / 集成测试环境）。

---

## 九、不变量与依赖

- **不改 DB schema、不改 slug / 文件路径 / URL、不动 page_aliases。**
- 复用 `extractWikiLinks`（唯一 wikilink 真实源），**不复刻**链接解析；复用 `serializeWikiDocument`（round-trip 真相）。
- 写操作走现有同步 Saga 路径（`createChangeset → validateChangeset → applyChangeset`），全部条目同一 subject、同一事务、失败自动 rollback。
- PUT 顶部已有 `requireAuth` + `requireCsrf` + `resolveSubjectFromRequest`，沿用。
- 客户端只用 `useApiFetch()`；POST/PUT body 显式带 `subjectId`（编辑器已如此）。
- 门禁 = `npx tsc --noEmit` + `npx vitest run`；`npm run lint` 在 BASE 即坏，非门禁。
- commit message 中文、一句话；禁止任何 AI 署名 trailer / 脚注。
