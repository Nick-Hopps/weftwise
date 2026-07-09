# wiki_update 支持改标题 + 接入问答（Ask AI）工具集

日期：2026-07-09
状态：已批准待实施

## 背景与问题

现有 `wiki.update` 工具（`src/server/agents/tools/builtin/wiki-update.ts`）与其内核
`executePageUpdate`（`src/server/wiki/page-ops.ts`）只能替换页面正文（附带可选
summary/tags），**标题字段在内核里被硬编码为原值，完全不支持改标题**。同时
`ToolContext.updatePage` 目前**只有 fix runner 注入**（`fix-tools.ts`），问答
（Ask AI，`query-tools.ts`）工具集里已经有 `wiki.create`/`wiki.delete`/
`wiki.reenrich`，但没有 `wiki.update`——用户在对话里想让模型"帮我把这页标题改一下"
或"帮我重写这页正文"时，模型没有对应的写工具可用。

真正的"改标题联动重写引用"（同 subject 内以旧标题书写的 `[[旧标题]]` 一并改成新
标题）逻辑目前只存在于人工编辑 API `PUT /api/pages/[...slug]`
（`src/app/api/pages/[...slug]/route.ts`）里，从未接入 `page-ops.ts` 内核，
merge/split 走的 `repointLinksToPage`（按解析后 slug 重指）是另一套语义，不适用
于"同一页改名"场景。

## 目标

- `wiki_update` 工具（对应内核 `executePageUpdate`）同时支持改标题和改正文，
  改标题时自动联动重写本 subject 内引用该页的旧标题文本。
- 问答（Ask AI）工具循环获得 `wiki_update` 能力，让用户可以在对话里直接要求
  模型原地更新某页的标题和/或正文。
- fix 侧顺带获得改标题能力（同一内核，无需额外改动 fix 的调用逻辑）。

## 方案

### ① 内核扩展：`executePageUpdate`（`src/server/wiki/page-ops.ts`）

参数由 `{ slug, body, summary?, tags? }` 扩展为 `{ slug, title?, body, summary?,
tags? }`。

- `title` 未提供或等于原标题：行为不变，frontmatter.title 保持原值。
- `title` 提供且与原标题不同：
  - frontmatter.title 换成新标题；
  - 仿照 `PUT /api/pages/[...slug]` 现有逻辑（`route.ts:126-147`），取本 subject
    内指向该页的 backlinks（`pagesRepo.getBacklinks`，排除自引用），逐个用
    `relink.ts::rewriteBacklinkText(raw, oldTitle, newTitle, subjectSlug)` 重写
    引用文本，作为额外的 `update` changeset entry 一并进入同一个 Saga 事务
    （原页更新 + N 条引用页更新，一次 `createChangeset`/`validateChangeset`/
    `applyChangeset`，一个 git commit，失败整体回滚）。
- 返回值由 `{ updatedSlug }` 扩展为 `{ updatedSlug, referencesUpdated }`
  （无标题变化时 `referencesUpdated` 恒为 0），字段命名风格对齐
  `executePageMerge`/`executePageSplit` 已有的 `referencesRepointed`。
- 坏链铁律不变：改动后仍留 unresolved wikilink 一律拒绝落盘，不受本次改动影响。

### ② 工具 schema：`wiki-update.ts`

- `InputSchema` 新增 `title: z.string().trim().min(1).optional()`。
- `OutputSchema` 新增 `referencesUpdated: z.number().optional()`。
- `description` 改写为通用表述（现在同时服务 fix 与 query 两个调用场景，不再
  只提"fix the reported issues"），补一句：改标题会自动重写本 subject 内所有
  指向旧标题的引用。
- 不新增标题唯一性校验（见"已知限制"）。

### ③ `ToolContext.updatePage` 签名（`tool-context.ts`）

同步扩展入参 `title?`、返回值 `referencesUpdated?`。这是所有调用方（fix/query）
共用的接口，改一处即可。

### ④ fix 侧：`fix-tools.ts::buildFixToolContext`

`updatePage` 实现里把 `input.title` 原样透传给 `executePageUpdate` 即可；
`checkRewriteFidelity(doc.body, input.body, FIDELITY_PROFILES.fix)` 忠实度检查
逻辑不变（该检查只比较正文，不涉及标题，不受影响）。

### ⑤ 问答侧（新增）：`page-write.ts::updatePageInSubject` + `query-tools.ts`

`query-tools.ts` 现有的 `deletePage`/`createPage` 并不是直接调
`wiki/page-ops.ts` 内核，而是经过 `page-write.ts::deletePageInSubject`/
`createPageInSubject` 这层"对话路径包装"——写完后统一 `enqueueEmbedIndex`
触发向量索引回填。`updatePage` 必须遵循同一模式，否则问答改写的页面会漏掉
向量索引更新，语义检索读到过期内容。

新增 `page-write.ts::updatePageInSubject`：

```
export async function updatePageInSubject(
  subject: Subject,
  input: { slug: string; title?: string; body: string; summary?: string; tags?: string[] },
): Promise<{ updatedSlug: string; referencesUpdated: number }> {
  const doc = readPageInSubject(subject.slug, input.slug);
  if (!doc) throw new Error(`Page "${input.slug}" not found in this subject.`);
  const fidelity = checkRewriteFidelity(doc.body, input.body, FIDELITY_PROFILES.fix);
  if (!fidelity.ok) throw new Error(`Edit dropped too much content: ${fidelity.violations.join('; ')}`);
  const result = await executePageUpdate(crypto.randomUUID(), subject, input);
  enqueueEmbedIndex(subject.id);
  return result;
}
```

复用 `FIDELITY_PROFILES.fix`（正文不得缩水到原文 80% 以下、不得丢失原有
wikilink）——跟 fix 用同一档，不新增更宽松的 query 专属 profile（已与用户
确认）。校验/护栏逻辑内联在函数里（不单独抽成纯函数），风格对齐
`createPageInSubject`（标题必填校验也是内联），而不是 `deletePageInSubject`
借助的独立 `validateDeleteTarget`——因为后者存在的理由是 DELETE 路由与对话
工具两处复用同一套规则，update 目前只有对话工具这一个调用方，没有第二个
消费者需要复用。

`query-tools.ts::buildQueryToolContext` 的 `updatePage` 实现直接委托
`updatePageInSubject(subject, input)`。

`query-service.ts::BASE_QUERY_TOOL_NAMES` 追加 `'wiki.update'`。

### ⑥ Prompt：`query-prompt.ts::QUERY_AGENTIC_SYSTEM_PROMPT`

- `## Tools` 清单补一行 `wiki_update` 说明。
- 新增 `## Updating a page` 段落，规则对齐现有 `## Deleting a page`：
  1. 只在用户明确要求修改/重写/改名某页时使用，不主动发起；
  2. 识别目标页（"this page"/"here" 用当前页 slug；否则用 `wiki_list`/
     `wiki_search` 解析精确 slug；歧义时先问用户，不猜）；
  3. **必须先复述将要做的改动**（标题变化 + 正文变化的一句话摘要）**并等待
     用户在后续轮次明确同意后才能调用**——不能在提出确认的同一轮调用
     `wiki_update`（与 `wiki_delete` 的纪律完全一致，已与用户确认）；
  4. 执行后告知结果，包含 `referencesUpdated`（如 >0，说明有 N 处引用被自动
     更新）以及"可在 History 页回滚"的提示。

### ⑦ 展示层

`src/lib/tool-activity.ts` 的 `wiki_update` 图标（✏️）与 `summarizeToolArgs`
摘要（`slug`）已经就位，不需要改动。

## 影响范围

- `src/server/wiki/page-ops.ts`（`executePageUpdate` 签名+行为扩展）
- `src/server/agents/tools/builtin/wiki-update.ts`（schema + description）
- `src/server/agents/tools/tool-context.ts`（`ToolContext.updatePage` 签名）
- `src/server/services/fix-tools.ts`（透传 `title`，逻辑不变）
- `src/server/services/page-write.ts`（新增 `updatePageInSubject`：校验+忠实度
  护栏+内核调用+`enqueueEmbedIndex`）
- `src/server/services/query-tools.ts`（`updatePage` 委托 `updatePageInSubject`）
- `src/server/services/query-service.ts`（`BASE_QUERY_TOOL_NAMES` 加
  `'wiki.update'`）
- `src/server/llm/prompts/query-prompt.ts`（`QUERY_AGENTIC_SYSTEM_PROMPT` 补
  工具说明 + "Updating a page" 段落）
- 不涉及数据库 schema 改动、不涉及 curate/ingest（明确不在本次范围内）。
- `src/server/agents/CLAUDE.md`、`src/server/wiki/CLAUDE.md`、
  `src/server/services/CLAUDE.md`、根 `CLAUDE.md` 变更记录需要同步更新
  （`updatePage` 注入范围从"仅 fix runner"改为"fix + query runner"）。

## 已知限制（不在本次范围内修复）

改标题不做"新标题与本 subject 内其他页标题重名"的唯一性校验——`PUT
/api/pages/[...slug]` 现有的人工编辑路径本身也没有这个校验（`getTitleToSlugMap`
按标题做 Map，重名会导致后写入的标题在解析 `[[标题]]` 时静默覆盖前者的映射）。
本次改动保持与现有行为一致，不新增更严格的约束，也不修复这个既有缺口。

## 测试计划

- `src/server/wiki/__tests__/page-ops.test.ts`（或新增
  `page-ops-update-retitle.test.ts`）：
  - 改标题触发 relink，跨页引用文本被正确重写；
  - 标题不变时 `referencesUpdated` 恒为 0；
  - 自引用页不被重复处理；
  - 改标题后仍留坏链/unresolved wikilink 时整体拒绝落盘（原有铁律不受影响）。
- `src/server/services/__tests__/fix-tools.test.ts`：补 `title` 透传用例。
- `src/server/services/__tests__/page-write.test.ts`：新增 `updatePageInSubject`
  覆盖（成功改标题+正文 / 保真度护栏拦截 / page not found / 写后触发
  `enqueueEmbedIndex`）。
- `src/server/services/__tests__/query-tools.test.ts`：`updatePage` 正确委托
  `updatePageInSubject` 的接线用例。
- `src/server/services/__tests__/query-service*.test.ts`：`resolveQueryTools()`
  返回集合包含 `wiki.update`。
- 手动验证：在 Ask AI 对话里要求模型重写某页标题+正文，确认先出现确认提示、
  同意后才执行，且执行后本 subject 内引用该页旧标题的其他页面文本被自动更新。
