# Ask AI 内联引用 + 确定性解析（去二次 LLM 引用调用）

日期：2026-07-07
状态：已批准待实施

## 背景与问题

Ask AI 问答目前分两步：agentic 工具循环流式产出答案后，再跑一次完整的
`generateStructuredOutput`（`generateQueryCitations`）生成引用列表。该二次调用的
prompt 会塞入工具循环访问过的每一页正文（每页最多 8000 字符）+ 完整草稿答案 +
会话历史。大库下模型读的页多，二次调用输入极其臃肿——答案流完之后用户还要
干等引用，体验极差；且"对着 draft 重新猜引用"本身有漂移风险（需要
`[unverified]` 前缀机制兜底）。

## 目标

- 引用随答案流即时可得，二次全量 LLM 调用归零。
- 引用严格来自模型真正 `wiki_read` 过的页面，excerpt 出自页面原文（天然 verified）。
- `coverageSufficient` → research backlog（T3.2）语义保留，但移出用户等待路径。

## 方案总览

模型在回答正文中**内联 `[[slug]]` wikilink** 标注依据（prompt 纪律）；流结束后
用**确定性纯函数**解析答案提取引用并抽取 excerpt，零额外 LLM 调用。coverage
判定拆成独立的异步小调用。

### 1. Prompt 层（`src/server/llm/prompts/query-prompt.ts`）

- `QUERY_AGENTIC_SYSTEM_PROMPT` 的 "Answer format" 一节改为内联引用纪律：
  - 每个基于 wiki 内容的陈述后紧跟 `[[slug]]`（使用 `wiki_read` 读过的页的精确 slug）；
  - 只引用真正读过的页；web 结果照旧禁止使用 wiki 引用格式（既有纪律不变）。
- 退役：`QueryCitationsSchema`（pick 派生）、`generateQueryCitations`。
- 新增：`CoverageSchema = QueryResponseSchema.pick({ coverageSufficient, suggestedResearchQuestion })`
  及配套小 prompt builder（输入只有用户问题 + 最终答案，不含页面正文与历史）。

### 2. 确定性解析（新模块 `src/server/services/citation-extract.ts`，纯函数）

- `extractCitationsFromAnswer(answer, accessed, subjectSlug): { pageSlug, excerpt }[]`
  - 用现成 `wiki/wikilinks.ts::extractWikiLinks` 解析答案全文；
    `titleResolver` 以 `accessed.meta`（slug→title）反查兜底，模型写
    `[[Title]]` 形式也能解析到 slug。
  - 目标 slug 与 `accessed.bodies`（真正 read 过的页）求交集：幻觉链接、
    仅 search 命中未 read 的页直接丢弃；按 slug 去重（取答案中首次出现的锚点）。
  - 跨主题前缀链接（`[[other-subject:page]]`）不属于本 subject 引用，丢弃。
- `pickExcerpt(anchorText, pageBody): string`
  - 锚点 = 答案中该 wikilink 所在句/段（向前取到句界，含 wikilink 前后文）；
  - 页面正文按句切分，词重叠打分（大小写/空白归一化），取最高分位置的
    连续 1–3 句作 excerpt；零命中时回落页面首段截断。
- excerpt 出自页面原文，`[unverified]` 前缀机制随二次调用一并退役。

### 3. 调用点改造

- `src/app/api/query/route.ts`（流式分支）：流结束 → 同步调
  `extractCitationsFromAnswer`（微秒级）→ 立即 `emit('citations')` →
  `persistTurn`。用户感知的引用延迟归零。
- `query-service.ts::runQuery`（非流式分支）同改。
- 答案正文中的 `[[slug]]` **保留不剥离**：chat 渲染层已支持 wikilink，
  正文引用即点即达；citations 列表照旧在消息尾部渲染。
- 对外契约 `{ pageSlug, excerpt }[]` 不变；`save-to-wiki`、会话落库、
  前端 `Citation` 类型零改动。

### 4. Coverage 判定异步化

- citations 已发给前端、答案已落库之后，fire-and-forget（`void (async …)`
  + catch 记日志）一个极小结构化调用：`generateStructuredOutput('query',
  CoverageSchema, …)`，输入仅 问题 + 最终答案。
- `coverageSufficient === false` 时经现成 `recordCoverageGap` 写
  `research_backlog`；失败只 `console.error`，不影响任何响应。
- 空库短路路径（`NO_QUERY_CONTEXT_ANSWER`）的 backlog 写入行为不变。

## 不做什么（YAGNI）

- 不做流式引用标记剥离（方案 B 已否决）。
- 不改 `QueryResponseSchema` 的对外 citations 契约与 UI 展示结构。
- 不为 coverage 判定新增 task key（沿用 `query` 路由；后续如需独立路由再拆）。

## 风险与取舍

- 内联引用遵守率依赖 prompt（换供应商可能漏标）→ citations 变少，但不出错、
  不变慢；个人 wiki 场景可接受。
- "提及即引用"：无法区分依据性引用与顺带提及——接受（提及的页也确实被读过）。
- coverage 异步调用只看问题+答案，不看页面全文，判定粒度略降——接受
  （backlog 本就是 best-effort 信号）。

## 测试

- `citation-extract` 纯函数单测：wikilink 解析、bodies 交集过滤、Title 形式
  兜底、跨主题链接丢弃、去重、excerpt 打分与回落边界。
- 更新 `query-service-agentic.test.ts`：删除 `generateQueryCitations` 相关
  用例，新增确定性路径 + coverage 异步分支（含失败不影响响应）用例。
