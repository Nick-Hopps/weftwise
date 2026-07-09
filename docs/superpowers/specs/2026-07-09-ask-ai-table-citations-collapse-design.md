# Ask AI 页支持 Markdown 表格 + 引用列表折叠

日期：2026-07-09
状态：已批准待实施

## 背景与问题

Ask AI 聊天回答与 Wiki 阅读页正文共用同一个渲染函数 `renderMarkdown()`
（`src/lib/markdown-client.ts`），该函数目前只接入了 `remark-parse`（纯
CommonMark），未接入 GFM 扩展——模型如果在回答里写 `| a | b |` 这类表格语法，
会被当成普通段落文本原样输出（字面量竖线），而 UI 层其实已经预置了
`table`/`th`/`td` 的 Tailwind 样式，处于"备而不用"状态。

另外，`src/components/chat/message-list.tsx` 里每条 assistant 消息末尾的
"Sources" 引用列表目前是纯堆叠渲染，没有折叠能力——引用一多，消息卡片会被拉得
很长。

## 目标

- Ask AI 回答（以及连带的 Wiki 阅读页正文）能正确渲染 Markdown 表格。
- 引用列表支持展开/折叠；超过 3 条时默认折叠，≤3 条默认展开，可反复切换。

## 方案

### ① Markdown 表格渲染（GFM）

- `package.json` 新增显式依赖 `remark-gfm`（当前只是 `@uiw/react-markdown-preview`
  的间接依赖，被 npm 提升到顶层 `node_modules`，未在 `package.json` 声明，
  换 lockfile 或该间接依赖升级时随时可能消失）。
- `src/lib/markdown-client.ts::renderMarkdown()` 的 remark 管线中，在
  `remarkParse`/`remarkFrontmatter` 之后、`createRemarkCallouts`/
  `createRemarkWikiLinks`/`createRemarkMermaid` 等自定义插件之前插入
  `.use(remarkGfm)`——顺序上确保 GFM 先于自定义插件解析出 table/delete/
  list 等 mdast 节点，避免自定义插件对文本节点的改写干扰 GFM 语法识别。
- 采用完整 `remark-gfm`（不做特性拆分）：表格、删除线 `~~text~~`、任务列表
  `- [ ]`、自动链接会一起打开。已与用户确认此范围可接受。
- 因为 `renderMarkdown()` 被 chat（`message-list.tsx`）与 Wiki 阅读页
  （`page-renderer.tsx`）共用，这次改动对两处同时生效，符合预期。
- 现有 `[&>table]`/`[&_th]`/`[&_td]` 等 Tailwind 类已就位，不需要新增样式。
- 补充测试：`src/lib/__tests__/markdown-client.test.ts` 新增表格渲染用例
  （验证 `| a | b |` 形式的 GFM 表格被解析为 `<table>` 结构）。

### ② 引用列表折叠

- 改动范围仅 `src/components/chat/message-list.tsx` 中渲染 `msg.citations`
  的那一段。
- 仿照 `src/components/layout/sidebar.tsx` 现有 "Sources" 分组折叠模式：
  标题栏文案改为 `Sources (N)` + `ChevronDown` 图标（折叠态图标旋转，与
  sidebar 一致），点击整体展开/收起，`aria-expanded` 语义与 sidebar 对齐。
- 每条消息独立维护本地折叠状态（组件内 `useState<boolean>`），互不影响，
  不做全局/跨消息共享状态。
- 初始态：`msg.citations.length > 3` → 折叠；`<= 3` → 展开。折叠能力对所有
  条数的引用列表始终可用（哪怕 ≤3 条，用户也能手动收起再展开），只是初始
  展开/折叠状态按条数阈值区分。
- 数据结构不变：`Citation` / `QueryResult.citations` /
  `ConversationMessage.citations` 三处 `{ pageSlug, excerpt }` 形状均不需要
  改动，本次是纯前端交互层改动。

## 影响范围

- 纯前端改动：`src/lib/markdown-client.ts`、`src/components/chat/message-list.tsx`、
  `package.json`（新增一个显式依赖）。
- 不涉及后端 / 数据库 / API / Saga 事务，不涉及 vault 或 git 提交语义。
- 表格渲染的改动是共享渲染函数级别的，副作用范围覆盖 Wiki 阅读页正文，
  已确认属于预期范围而非意外扩散。

## 测试计划

- `src/lib/__tests__/markdown-client.test.ts`：补表格渲染用例。
- 手动验证：在 Ask AI 里让模型给出含表格的回答，确认渲染为 `<table>`；
  构造 >3 条与 ≤3 条引用的两种场景，确认折叠默认态与切换行为符合预期。
