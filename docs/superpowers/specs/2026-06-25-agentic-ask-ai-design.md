# Agentic Ask AI（工具循环检索）— 设计文档

> 日期：2026-06-25
> 主题：把 Ask AI（chat 问答）从「系统预先 top-5 检索后喂给模型」改造为「模型自驱工具循环检索」，让它能回答当前 subject 的宏观/总结类问题，并消灭"不存在文档"误报。

---

## 一、背景与目标

### 现状

`/api/query` 的问答链路（`src/app/api/query/route.ts` + `src/server/services/query-service.ts`）是**固定 top-N 检索式 RAG**：

1. `resolveSubjectFromRequest` 解析当前 subject。
2. `prepareQueryContext(question, subjectId, pageSlug)`：`hybridRankSlugs` 取 **top-5** 最相关页（FTS5 + 向量 RRF 合并），读全文。
3. `context.length === 0` → 直接 emit 兜底文案 `NO_QUERY_CONTEXT_ANSWER`（"No relevant content was found in this subject…"）。
4. 否则 `streamQueryAnswer`（`streamTextResponse`，**无 tools**）流式作答 → 事后 `generateQueryCitations`（`generateObject`）补引用。

### 问题

问答**从来不是"读整个 subject"，而是先检索、只喂命中页**。宏观/总结/关系类问题（"这个主题都讲了啥"、"总结一下"、"X 和 Y 什么关系"）天然命中不了少量精确检索，于是 subject 明明有内容却报"不存在文档"。这是经典 RAG 的全局/聚合问题召回盲区。

### 目标

让模型**自驱检索**：给它一组 subject-scoped 检索工具（列举 / 搜索 / 读取），由模型自己决定搜什么、读哪页、搜几轮，再作答。收益：

- **治宏观问题**：模型可 `list_pages` 拿到全 subject 地图回答总结/概览类问题。
- **提召回**：模型可发起**多次定向 `search_wiki`**（查询改写/扩展），优于单次固定 top-5。
- **省 token**：只读真正需要的页全文，而非每次塞 5 整页。
- **消灭误报**：只要 subject 有页，模型总能找到内容。

### 非目标（v1 明确不做）

- **跨 subject 问答**：工具全部闭包绑定当前 `subject.id`，主题隔离不变（命令面板 / wikilink 跨主题语义不受影响）。
- **不引入 MCP / 外部工具**：仅本地内置工具（MCP 已于 2026-06-24 作为死代码移除，不复活）。
- **不改 embedding / FTS 索引层**：工具复用现成 `hybridRankSlugs` / repos。
- **不做检索结果的人工审批 / dry-run**：模型直接作答。

### 前置约束（已由用户确认解除）

本项目此前**主动放弃 tool-calling agent**（packyapi openai-compatible 转译下工具死循环，reviewer/verifier 均改无 tools 结构化输出）。**用户确认 function-calling 问题已解决**，故本设计直接采用真·工具循环。即便如此，仍以 `maxSteps` 硬上限 + 工具调用日志作为防 runaway 的工程兜底。

---

## 二、关键架构决策

### 决策 1：真·工具循环（AI SDK `streamText` + `tools` + `maxSteps`）

用 Vercel AI SDK v4（已装 `ai@^4.0.0`）原生多步工具循环：`streamText({ model, tools, maxSteps })` 自动驱动「模型 call 工具 → 框架执行 execute → 结果回灌 → 重复直至模型产出最终文本」，最终答案经 `textStream` / `fullStream` 流式吐出。无需自建 loop，也**不复用 ingest 的 `agents/runtime/agent-loop`**（后者 `generateText` 非流式、绑 job/overlay 上下文，与流式 chat 不匹配）。

### 决策 2：三个 subject-scoped 工具（list + search + read 正交）

| 工具 | 入参 | 返回 | 用途 |
|------|------|------|------|
| `list_pages` | （无） | 全 subject 非 meta 页的 `{ slug, title, summary, tags }` | **宏观/概览**问题；超大 subject 截断 + `truncated` 标记 |
| `search_wiki` | `query: string`, `limit?: number` | `[{ slug, title, summary, snippet }]`（走 `hybridRankSlugs`） | 模型**多次定向检索**，提召回 |
| `read_page` | `slug: string` | `{ slug, title, body }` 全文（`readPageInSubject`） | 命中后**深读**取细节，供引用核查 |

三件套覆盖：广度（list）+ 精确召回（search）+ 深度（read）。每个工具 `execute` 闭包绑定 `subjectId` / `subjectSlug`，只能命中本 subject repos，主题隔离 by construction。`sideEffect: none`（全只读）。

> `list_pages` 截断策略：按 `updatedAt` 倒序取上限 N（默认 200）条；超出则返回 `{ pages, truncated: true, total }`，prompt 告知模型"列表已截断，可用 search_wiki 补"。摘要缺失时回落空串。

### 决策 3：引用来自"模型实际访问过的页"

工具 `execute` 把访问到的 slug 累积进一个 per-request 收集器（`read_page` 记 slug→body 全文；`search_wiki`/`list_pages` 记 slug→meta）。答案流完后，对收集器里的页构造 `QueryContextPage[]`（read 过的有全文；只在搜索结果里出现、被引用却没读全文的，**按需补读全文**用于子串核查），复用现有 `generateQueryCitations`（保留 `[unverified]` 子串校验）。

> 与现状差异：现状的引用候选 = 预先检索的固定 5 页；新方案 = 模型本轮真正访问的页集合，引用更贴合答案。

### 决策 4：空 subject 守卫（省 token）

进工具循环前先查当前 subject 非 meta 页数；**为 0 直接 emit `NO_QUERY_CONTEXT_ANSWER`**（措辞改为引导 ingest），不调用模型。subject 有页时不再因检索未命中而误报——模型有 `list_pages` 总能找到内容。

### 决策 5：工具调用过程对 UI 透明

`fullStream` 区分 chunk 类型：`text-delta` → SSE `answer-delta`；`tool-call` → 新 SSE 事件 `tool-call`（含 `toolName` + 简化入参）。聊天 UI 在流式期间渲染"🔍 搜索：xxx / 📄 阅读：xxx / 🗂 列举页面"活动行，便于观察与调试。`tool-result` 不外发（避免泄漏大段正文到前端）。

### 决策 6：`maxSteps` 用模块常量，不开放设置（YAGNI）

`QUERY_MAX_STEPS = 6`（约束：≤6 步足够 list→search×N→read×N→answer）。作为防死循环兜底；如需调再升设置。

### 决策 7：`runQuery`（save-as-page 一次性）同步 agentic 化

非流式的 `runQuery`（saveAsPage 一次性 JSON 模式）改用 `generateText({ tools, maxSteps })` 同款工具集，保持行为一致、同样修复其宏观问题盲区。引用同样来自访问页集合。

### 决策 8：prompt 重构

- **新 system prompt**（`QUERY_AGENTIC_SYSTEM_PROMPT`）：说明三工具用法与策略（概览问题先 `list_pages`；具体问题 `search_wiki` + `read_page`；引用前必须 `read_page` 拿到原文；subject 隔离——只用工具返回的本 subject 内容、不臆造；按 `wikiLanguage` 作答）。
- **精简 user prompt**：不再内联 context 页（context 由工具提供），仅含问题 + 当前页 hint（"用户正在看 `<slug>`，相关时可先 read_page"）。历史走 `messages` 数组（`system` + `[...history, {role:'user', content}]`）而非拼进 prompt。
- 现有 `buildQueryUserPrompt`（内联 context 版）**保留**，仅供 `generateQueryCitations` 的事后引用步使用。

---

## 三、数据流（streaming 默认分支）

```
POST /api/query
  → requireAuth / requireCsrf
  → resolveSubjectFromRequest
  → 会话确定（跨 subject 静默新会话，逻辑不变）
  → 载末 8 条历史
  → [守卫] 当前 subject 非 meta 页数 == 0
        → emit answer-delta(NO_QUERY_CONTEXT_ANSWER) + citations([]) + 落库 + done
  → 否则进 SSE 流：
       buildQueryTools(subjectId, subjectSlug, collector)   // 3 个工具 + 收集器
       streamAgenticQuery({ question, subject, history, currentPageSlug, signal })
         → streamTextWithTools('query', { system, messages, tools, maxSteps, signal })
         → for await (chunk of result.fullStream):
              'text-delta'  → fullAnswer += ; emit answer-delta
              'tool-call'   → emit tool-call { toolName, args 摘要 }
              'error'       → emit error
       → 答案流完：从 collector 构造 context → generateQueryCitations → emit citations
       → 落库（user + assistant turn）→ emit done { subjectId, conversationId }
```

---

## 四、组件与接口

### 4.1 `src/server/llm/provider-registry.ts`（改）

新增两个工具版变体，复用 `resolveTask('query')` 路由与超时/abort 合并逻辑：

```ts
export function streamTextWithTools(
  task: LLMTask,
  opts: {
    system: string;
    messages: CoreMessage[];           // [...history, {role:'user', content}]
    tools: Record<string, CoreTool>;
    maxSteps: number;
    abortSignal?: AbortSignal;
    overrides?: LLMRouteOverride;
  },
): ReturnType<typeof streamText>;

export async function generateTextWithTools(
  task: LLMTask,
  opts: { system; messages; tools; maxSteps; overrides? },
): Promise<{ text: string }>;          // 包 ai.generateText
```

### 4.2 `src/server/services/query-tools.ts`（新）

```ts
export interface AccessedPages {
  meta: Map<string, { title: string; summary: string }>;   // search/list 命中
  bodies: Map<string, { title: string; body: string }>;    // read_page 全文
}

export function createAccessedPages(): AccessedPages;

export function buildQueryTools(
  subject: Subject,
  accessed: AccessedPages,
): Record<string, CoreTool>;            // { list_pages, search_wiki, read_page }

// 答案流完后：把 accessed 转成引用步需要的 context（按需补读未读页全文）
export function accessedToContext(
  subject: Subject,
  accessed: AccessedPages,
): QueryContextPage[];
```

工具实现要点：
- `list_pages`：`pagesRepo.getAllPages(subjectId)` 过滤 meta、按 `updatedAt` 倒序、截断 N，写入 `accessed.meta`。
- `search_wiki`：`hybridRankSlugs(subjectId, query, limit)` → 取页 meta + 截断 snippet，写 `accessed.meta`。
- `read_page`：`pagesRepo.getPageBySlug` + `readPageInSubject` → 写 `accessed.bodies`；页不存在返回 `{ error: 'not found' }`。

### 4.3 `src/server/services/query-service.ts`（改）

- 新增 `streamAgenticQuery({ question, subject, history, currentPageSlug, abortSignal })` → 构造 tools/collector，调 `streamTextWithTools`，返回 `{ stream, accessed }`。
- `generateQueryCitations` 签名不变（仍吃 `QueryContextPage[]`），调用方改传 `accessedToContext(...)`。
- `runQuery` 改用 `generateTextWithTools` + 同款工具集；引用来自 accessed。
- `prepareQueryContext` 不再用于流式主路径；保留导出（仍被引用步/测试间接需要的 `QueryContextPage` 类型），或在确认无引用后删除（实现时定）。
- 空 subject 守卫的页数查询：复用 `pagesRepo.getAllPages(subjectId)` 过滤 meta 计数（或新增轻量 count helper）。

### 4.4 `src/server/llm/prompts/query-prompt.ts`（改）

- 新增 `QUERY_AGENTIC_SYSTEM_PROMPT`（工具版 system，含工具策略 + subject 隔离 + 语言指令注入点）。
- 新增 `buildAgenticUserContent(question, ctx, { currentPageSlug })`（精简 user 文本）。
- 保留 `QUERY_SYSTEM_PROMPT` / `buildQueryUserPrompt`（引用步复用）。

### 4.5 `src/app/api/query/route.ts`（改）

- streaming 分支：加空 subject 守卫；用 `streamAgenticQuery` 替换 `prepareQueryContext` + `streamQueryAnswer`；消费 `fullStream` 分发 `answer-delta` / `tool-call`；答案完后 `accessedToContext` → `generateQueryCitations` → emit `citations`；其余（落库 / done / abort / error）不变。
- saveAsPage 一次性分支：`runQuery` 内部已 agentic 化，route 无需改。

### 4.6 `src/components/chat/chat-interface.tsx`（改）

- SSE 解析新增 `tool-call` 分支：把工具活动累积到当前 in-flight assistant message 的 `activity: { tool, label }[]`。
- 渲染：流式期间在答案上方显示活动行（🔍/📄/🗂 + 简短标签）；答案开始/完成后保留为可折叠的"检索过程"。
- `done` / `citations` / `error` 行为不变。

---

## 五、错误处理与降级

- **工具 execute 抛错**：捕获并返回 `{ error: string }` 给模型（而非中断流），模型可换查询重试；不污染答案。
- **`maxSteps` 撞顶仍未作答**：AI SDK 返回当前已生成文本（可能为空）；route 在 `fullAnswer` 为空时回落 `NO_QUERY_CONTEXT_ANSWER`，并 emit 一条 `error`/提示，避免空答案落库。
- **abort（用户取消）**：沿用 `request.signal` 合并到 `streamTextWithTools` 的 abortSignal；`closeStream` 行为不变。
- **引用步失败**：沿用现状 `catch → citations = []`。
- **未配置 embedding**：`hybridRankSlugs` 已优雅降级纯 FTS，工具层无需特判。

---

## 六、测试策略（vitest）

1. `query-tools.test.ts`（核心）：
   - `list_pages` 只返回本 subject 非 meta 页、按 updatedAt 倒序、截断 + `truncated` 标记。
   - `search_wiki` 走 hybridRankSlugs（mock）、写 `accessed.meta`、snippet 截断。
   - `read_page` 命中写 `accessed.bodies`；不存在返回 error；**跨 subject slug 取不到**（隔离）。
   - `accessedToContext`：read 过的用全文；只搜索未读的按需补读；去重。
2. `query-service` 空 subject 守卫：0 非 meta 页 → 不调模型、返回 NO_CONTENT。
3. prompt 快照：`QUERY_AGENTIC_SYSTEM_PROMPT` 含工具与隔离指令；`buildAgenticUserContent` 含当前页 hint。
4. （可选）route 层：mock `streamTextWithTools` 的 fullStream，断言 `tool-call` / `answer-delta` / `citations` / `done` 事件序列与落库。

> provider-registry 的 `streamTextWithTools` 直连 AI SDK，不单测其内部（与现有 `streamTextResponse` 一致，无测试）。

---

## 七、影响文件清单

| 文件 | 改动 |
|------|------|
| `src/server/llm/provider-registry.ts` | +`streamTextWithTools` / +`generateTextWithTools` |
| `src/server/services/query-tools.ts` | **新**：3 工具 + AccessedPages + accessedToContext |
| `src/server/services/query-service.ts` | +`streamAgenticQuery`；`runQuery` agentic 化；引用改用 accessed；空 subject 守卫 |
| `src/server/llm/prompts/query-prompt.ts` | +`QUERY_AGENTIC_SYSTEM_PROMPT` / +`buildAgenticUserContent`（保留旧导出） |
| `src/app/api/query/route.ts` | 接工具循环 + `tool-call` SSE + 空 subject 守卫 |
| `src/components/chat/chat-interface.tsx` | 渲染 `tool-call` 工具活动 |
| `__tests__/`（query-tools / query-service / prompts） | 新增用例 |
| 根 `CLAUDE.md` + `src/server/services/CLAUDE.md` + `src/server/llm/CLAUDE.md` | changelog + 模块文档更新（用户要求） |

---

## 八、文档更新（实现完成后）

- 根 `CLAUDE.md`「九、变更记录」加一行（2026-06-25：Agentic Ask AI 工具循环）。
- `src/server/services/CLAUDE.md`：query-service 小节补 agentic 流程 + query-tools 三工具。
- `src/server/llm/CLAUDE.md`：补 `streamTextWithTools` / `generateTextWithTools` + 工具版 query。
- 视情况更新「六、测试策略」的文件/用例统计。
```
