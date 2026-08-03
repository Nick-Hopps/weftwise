# 实现计划：Ask AI 右缘 tooltip + 回答 web 来源

日期：2026-08-03
设计稿：`docs/specs/2026-08-03-ask-ai-web-sources-and-tooltip.md`
分支：`feat/ask-ai-web-sources-and-tooltip`（worktree `.claude/worktrees/feat+ask-ai-web-sources-and-tooltip`，基线 `dcc3e56b`）

按 TDD 推进：每个任务先写失败测试 → 确认以预期原因失败 → 最小实现转绿。**每完成一个任务提交一次。**

测试策略：核心新逻辑是两个纯函数（URL 规范化 + 答案 URL 与本轮搜索结果求交、References 段渲染），下沉到 `citation-extract.ts` / `query-service.ts` 单测。路由与 UI 属于接线层，靠既有 route 契约测试与真实环境验收覆盖，不为可测性额外拆结构。tooltip 是纯 CSS，靠真实浏览器验收（取渲染值比对，不凭目测）。

---

## T0 基线

跑一遍与本次相关的既有测试并记录数字，作为「未破坏既有行为」的对照。

**验证**：`npx vitest run src/server/services/__tests__/citation-extract.test.ts src/app/api/query/__tests__/route.test.ts src/server/services/__tests__/query-service-agentic.test.ts src/server/llm/prompts/__tests__/query-prompt.test.ts src/components/chat/__tests__/`

---

## T1 tooltip `tip-br` 变体

**问题**：保存按钮的居中气泡越过面板右内边缘，被 `<section>` 的 `overflow-hidden` 裁掉（spec 症状 1）。

**改动**：
- `src/app/globals.css`：在 `.tip.tip-l` 之后追加 `.tip.tip-br::after`（`left:auto; right:0; bottom:auto; top:calc(100% + 6px); transform:translateY(-4px)`）与 `.tip.tip-br:hover/:focus-visible::after { transform:none }`（**必须有**：共享 hover 规则会把 `transform` 改回 `translateX(-50%)`，漏掉这条气泡会横向偏出一半宽度）；同步更新文件头注释里的变体清单。
- `src/components/chat/save-to-wiki-button.tsx`：两个分支（saving 态 `:97`、idle 态 `:113`）的 `tip tip-b` → `tip tip-br`。

**验证**：`npm run build` 通不通只能证明编译；真实验收放到 T8（浏览器里取气泡与面板的 `getBoundingClientRect()` 比对 `right` 边界）。

---

## T2 契约与 union 拆分纯函数

**改动**：
- `src/lib/contracts.ts`：新增 `WebCitation { url: string; title: string }`、`AnswerCitation = WikiCitation | WebCitation`；`QueryResult` 增 `webCitations: WebCitation[]`；`ConversationMessage.citations` 类型放宽为 `AnswerCitation[] | null`。
- `src/lib/wiki-citation.ts`：新增 `isWebCitation(c): c is WebCitation`（判据 = 有非空字符串 `url`）与 `splitAnswerCitations(list): { wiki: WikiCitation[]; web: WebCitation[] }`。

**测试**（`src/lib/__tests__/wiki-citation.test.ts`，无则新建）：
- 存量形状（只有 `pageSlug/excerpt`）全部归 wiki（**存量兼容核心断言**）；
- 混合数组按字段正确拆分且各自保序；
- 脏数据（`null`、非对象、`url` 为空串、既无 `pageSlug` 又无 `url`）被丢弃，不进任一侧。

**验证**：`npx vitest run src/lib/__tests__/wiki-citation.test.ts`

---

## T3 `AccessedPages.webResults`：本轮搜索结果留痕

**问题**：`buildQueryToolContext` 的 `webSearch` 包装直接透传，服务端不知道模型看过哪些网页（spec 症状 2 断层 1）。

**改动**：
- `src/server/services/query-tools.ts`：`AccessedPages` 增 `webResults: Map<string, WebCitation>`（key = 规范化 URL）；`createAccessedPages()` 初始化；`webSearch` 包装在 `return` 前把每条结果记进 map（**首次写入优先**，同 URL 后续搜索不覆盖标题）。

**测试**（`src/server/services/__tests__/query-tools.test.ts`）：
- 调用注入的 `ctx.webSearch` 后 `accessed.webResults` 含全部结果、key 为规范化 URL；
- 同一 URL 在两次搜索里返回 → 只留一条，保留首次标题；
- 未调用 `webSearch` 时 `webResults` 为空（未配置联网检索的零回归）。

**验证**：`npx vitest run src/server/services/__tests__/query-tools.test.ts`

---

## T4 `extractWebCitationsFromAnswer` 确定性解析（本任务的核心）

**改动**（`src/server/services/citation-extract.ts`）：
- 新增 `normalizeCitationUrl(raw): string | null`：trim → 去尾随标点（`.,;:!?)]}>"'` 与中文 `。，；：）》」`）→ 经 `new URL` 规范化（协议/host 小写、去掉末尾单个 `/`、丢弃 fragment）；非 http(s) 或解析失败返回 `null`。
- 新增 `extractWebCitationsFromAnswer(answer, accessed): WebCitation[]`：先抽 markdown 链接目标 `](…)`，再抽裸 `https?://…`；逐个规范化后与 `accessed.webResults` 求交；按首次出现顺序去重；**标题取 map 里服务端记录的值**（spec C3）。

**测试**（`src/server/services/__tests__/citation-extract.test.ts`）：
- markdown 链接命中 → 一条，标题为搜索结果标题**而非锚文本**（C3 核心断言）；
- 裸 URL 命中；
- 本轮未搜到过的 URL（幻觉）→ 丢弃（C2 反幻觉闸门核心断言）；
- 同一 URL 在答案里出现多次 → 一条，保序；
- 句末标点 / 括号包裹 / 末尾斜杠差异 / host 大小写差异仍能命中；
- 非 http(s)（`mailto:`、`javascript:`）不进结果；
- `webResults` 为空 → 恒空数组（未配置联网检索的零回归）。

**验证**：`npx vitest run src/server/services/__tests__/citation-extract.test.ts`

---

## T5 Prompt 纪律

**改动**（`src/server/llm/prompts/query-prompt.ts` 的「Web search」一节）：保留「wiki 优先」「web 是补充」「不得用 `[[…]]`」，把最后一条改成：用 markdown 链接 `[title](url)` 内联标注 web 依据，URL 必须与 `web_search` 返回的原样一致，并说明这些链接就是 web 来源的收集方式（照抄 wiki 引用那条「an uncited claim will show no source」的说话方式）。

**测试**（`src/server/llm/prompts/__tests__/query-prompt.test.ts`）：
- read/propose/image-insert 三种 mode 的 system prompt 都含新纪律关键片段（`](url)` 与「exact url」语义）；
- 仍含「不得用 wiki 引用格式标注 web 结果」这一条（防改写时把约束一起删掉）。

**验证**：`npx vitest run src/server/llm/prompts/__tests__/query-prompt.test.ts`

---

## T6 路由与持久化接线

**改动**：
- `src/app/api/query/route.ts`：流末 `const webCitations = extractWebCitationsFromAnswer(fullAnswer, accessed)`；`emit('citations', { citations, webCitations })`；`persistTurn` 写 `JSON.stringify([...citations, ...webCitations])`（spec C6）；`recordTurnEvidence` 入参保持只有 wiki 条目；提前返回的六处短路分支一并补 `webCitations: []`（保持事件形状恒定，客户端不必判 undefined）。
- `QueryBodySchema.citations` 之外新增可选 `webCitations: z.array(z.object({ url: z.string().url(), title: z.string() })).optional()`，两处 `save-to-wiki` enqueue 带上（缺省 `[]`）。
- `src/server/services/query-service.ts`：`runQuery` 返回 `webCitations`。

**测试**（`src/app/api/query/__tests__/route.test.ts`）：
- 流式分支：mock 的答案含一个命中 URL → `citations` 事件带 `webCitations` 一条，且 `appendMessage` 收到的 JSON 数组同时含 wiki 与 web 条目（**持久化不加迁移的核心断言**）；
- 短路分支（reset 确认）事件里 `webCitations` 为 `[]`；
- save-only 模式：body 带 `webCitations` → enqueue 的 job params 原样携带。

**验证**：`npx vitest run src/app/api/query/__tests__/route.test.ts src/server/services/__tests__/query-service-agentic.test.ts`

---

## T7 save-to-wiki References + 客户端渲染

**改动**：
- `src/server/services/query-service.ts`：抽纯函数 `buildReferencesSection(citations, webCitations, subjectSlug): string`（wiki 行沿用 `citationWikiLink`，web 行 `- [标题](url)`，两侧皆空则返回空串）；`saveQueryAsPage` 增 `webCitations` 参数并改调它；`runSaveToWikiJob` 的 params 解析加 `webCitations?: WebCitation[]`（`?? []`，兼容在途旧 job）。
- `src/components/chat/chat-message.ts`：`ChatMessage.webCitations?`；历史消息经 `splitAnswerCitations` 恢复。
- `src/components/chat/chat-interface.tsx`：SSE `citations` 事件同时接两个数组。
- `src/components/chat/message-list.tsx`：`MessageCitations` 接 `webCitations`，计数与「≤3 默认展开」按总数判断；web 行渲染 `<a target="_blank" rel="noopener noreferrer">`（Globe 图标 + 标题 + `new URL(url).hostname`）。
- `src/components/chat/save-to-wiki-button.tsx`：props 与请求 body 带 `webCitations`。
- i18n：无新增 key（行内只有标题与域名）。

**测试**（`src/server/services/__tests__/query-service-*.test.ts`）：
- 只有 wiki 引用 → References 段与改动前逐字节一致（**零回归核心断言**）；
- 只有 web / 两者混合 → 段落含 `[[slug]]` 行与 `- [标题](url)` 行，顺序 wiki 在前；
- 两侧皆空 → 无 References 段。

**验证**：`npx vitest run src/server/services/__tests__/` + `npx tsc --noEmit`

---

## T8 真实环境验收

1. `npm run dev`（worktree 独立端口，不占用 main 的 3000）+ worker，浏览器打开 Ask AI 面板：
   - **tooltip**：hover 保存按钮，用 `getBoundingClientRect()` 取气泡与面板 `<section>` 的 `right`，断言气泡完全落在面板内（取精确值比对，不凭目测）；截图留证。
   - **web 来源**：确认联网检索已配置（Settings → Automation → Web search）；问一个当前 Subject 明确没有的问题，观察 `web_search` 工具活动出现，回答完成后 Sources 区含网页条目、点击新标签页打开；再刷新页面确认恢复。
   - 若该环境未配置联网检索：明确记录「未配置」并改为验证零回归（Sources 只有 wiki 条目、行为与 main 一致），**不**声称 web 路径已验收。
2. 该回答「保存到 Wiki」，读生成页面的 raw 确认 References 两类行都在。
3. `npx vitest run` 全量 + `npx tsc --noEmit`，记录文件/用例数与退出码。

---

## T9 文档同步

- `src/components/CLAUDE.md`：`chat/` 小节的 `message-list` / `save-to-wiki-button` / `chat-message` 描述与 Changelog；`layout/ask-ai-floating-panel` 不变但 tooltip 变体值得在 Changelog 记一句（含「z-index 修不了 overflow 裁剪」这条判断依据）。
- `src/server/services/CLAUDE.md`：`query-service` / `query-tools` / `citation-extract` 的 web 来源链路与 Changelog。
- `src/app/CLAUDE.md`：`/api/query` 的 `citations` SSE 事件与 body 契约变化。
- `src/server/agents/CLAUDE.md`：`web.search` 一行补「结果由 query 侧留痕供 web 引用求交」。
- 根 `AGENTS.md` / `CHANGELOG.md` 按既有惯例追加。
- `docs:` 与 `feat:` 提交成对。

---

## 实际执行补记（2026-08-03）

- **T2 拆分**：`QueryResult.webCitations` 与 `ConversationMessage.citations` 的类型收紧会波及 T6/T7 的接线点，为保证每个提交都能编译，这两处分别下沉到 T6 / T7 完成。
- **T4 落点调整**：`normalizeCitationUrl` 放进 `lib/wiki-citation.ts` 而非 `citation-extract.ts` —— 记录侧（`query-tools`）与解析侧（`citation-extract`）必须共用同一把尺子，放服务端会让 `query-tools` 反向依赖 `citation-extract`。
- **T8 追加一次修复（非计划内）**：真实验收发现搜索结果带跟踪参数时真实来源被误杀，补 `origin+pathname` 回退并固化 4 条回归用例，单独提交 `d5faf0cf`。
- **T8 实测数据**：tooltip 气泡右缘 849 / 面板右缘 860（在内 11px），对照居中变体越界 22.3px；真实问答 2 次 `web_search` → 2 条网页来源，UI「来源 2」渲染并可新标签页打开；`saveQueryAsPage` 真实落页（vault `6ee2e2d`）References 两类行齐备、frontmatter `sources` 为 `[]`，验收产物已删除（`4454edd`）。
- **未覆盖**：`save-to-wiki` **job 队列**这一段没有端到端跑（主 checkout 的 worker 与本 worktree 共用同一个 DB，会抢任务并以主分支代码执行），改为在本分支代码里直接调用 `saveQueryAsPage` 走真实 Saga + git commit 验证；job params 透传由路由契约测试覆盖。
