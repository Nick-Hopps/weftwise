[根目录](../../CLAUDE.md) > [src](../) > **components**

# `src/components/` — React UI 组件

## 模块职责

承载前端**所有**视图组件。按"关注点"分目录，对应"The Triad"三联布局（左导航 / 中工作区 / 右上下文）。组件分为两类：

- **设计系统原语**（`ui/`）—— 低粒度、无业务知识，可在任何场景复用。
- **业务组件**（`wiki/ / chat/ / search/ / graph/ / layout/ / shared/`）—— 带具体交互与数据。

## 关键组件一览

### `layout/` — 应用骨架

| 文件 | 说明 |
|------|------|
| `shell.tsx` | 主 Shell，含 Header + Sidebar + 主内容 + 可伸缩 ContextPanel（`pointer` 事件实现拖拽宽度）|
| `header.tsx` | 顶栏：logo、`<SubjectSwitcher />`、面包屑、命令面板触发、dark mode toggle、context panel toggle |
| `sidebar.tsx` | 左侧目录树（按 `currentSubjectId` 过滤的 wiki pages + 最近访问） |
| `subject-switcher.tsx` | 🔀 cmdk + 自定义浮层；显示 subjects 列表；⌘O 唤起；切换时写 store + cookie + invalidate 8 个 query key + `router.refresh()`；"New subject…" 改调 openSubjectDialog（删 ?new=1），切换复用 useSwitchSubject |
| `context-panel.tsx` | 右侧上下文面板容器（Tabs: context / chat） |
| `context-panel-sheet.tsx` | 移动端抽屉版本（off-canvas） |
| `context-panel-context-tab.tsx` | "上下文"Tab：backlinks + frontmatter + mini-graph（queryKey 含 subjectId） |
| `context-panel-chat-tab.tsx` | "对话"Tab：内嵌 `chat-interface`，发问 body 含 subjectId |
| `settings-dialog.tsx` | 🔀 两栏式 Settings 弹窗容器（`max-w-3xl` + 固定高度）：持有 `GET/PUT /api/settings` query/mutation + `active` 分类 state（开窗重置 `appearance`）+ Esc/遮罩关闭；左 `<SettingsNav>` + 右 `<SettingsContent>` |
| `settings-nav.tsx` | 🆕 左侧分类导航栏（遍历 `SETTINGS_CATEGORIES`，选中高亮 `bg-accent-subtle`/`aria-current`，点击经 `onSelect` 切换） |
| `settings-content.tsx` | 右内容区：按 `active` 渲染 5 个 panel（Appearance/Language/Agents/Web search/About），复用 `settings-rows` 原语；服务端 `app_settings` 唯一真实源，不写 Zustand |
| `settings-categories.ts` | 🆕 分类元数据单一来源：`CategoryId` 类型 + `SETTINGS_CATEGORIES`(id/label/icon) + `DEFAULT_CATEGORY`，被 dialog/nav/content 共用避免循环依赖 |
| `settings-rows.tsx` | 行级原语：`SettingRow/NumberSettingRow/SelectSettingRow/TextSettingRow`（带本地暂存+校验） |

### `ui/` — 设计系统

无业务逻辑的原语，基于 `class-variance-authority` + Tailwind + CSS 变量：

- `button.tsx` / `icon-button.tsx`
- `input.tsx` / `kbd.tsx`
- `panel.tsx`（含 `SectionLabel`）
- `tag.tsx`（带 `tone` 变体）
- `separator.tsx`
- `tabs.tsx`

### `wiki/` — wiki 页面渲染

- `page-renderer.tsx` —— 把 markdown + frontmatter + titleSlugMap → React（unified + rehype-pretty-code + Shiki）；标题行 `actions` 插槽（透传给 FrontmatterDisplay）+ `headerExtra` 插槽（渲染在 frontmatter 之后、正文之前，复用 article reading 宽度）
- `page-actions.tsx` —— 🆕 阅读页标题行右侧统一功能动作条 `PageActions`（Edit / Sources(N) toggle / Reshape 触发并排）+ `ReshapeStatus`（正文上方细状态行：Reshaping… / Adapted for you＋Show original 切换 / Couldn't reshape）；纯展示，状态由 `wiki-reading-view` 持有并下传
- `wiki-link.tsx` —— `[[target]]` / `[[subject:target]]` 的 client 组件，支持 hover peek；preview 缓存 key `${effectiveSubjectSlug}:${slug}` 防同名跨主题串显
- `wiki-page-elsewhere.tsx` —— 🆕 当目标 subject 没该 slug 但其他 subject 有时给出"也许在 X 中"提示，链接附 `?s=`
- `tag-link.tsx` —— 🆕 可点 tag chip（Link 包 Tag，prop 驱动 subjectSlug，链到 /tags/<tag>?s=）
- `frontmatter-display.tsx` —— 页头 meta 信息展示；标题行右侧 `actions` 插槽渲染统一动作条（Edit 已移入 `PageActions`，不再有内置 `editHref`/Edit 按钮）
- `page-skeleton.tsx` —— loading skeleton
- `page-editor.tsx` —— 🆕 在线编辑容器：根/loading/error **全高 flex 布局**（`flex flex-col h-full`，去掉旧 `max-w-content` 居中收窄）；拉 raw → md-editor → Save(PUT)/Cancel → 失效缓存 + router.refresh + 跳回读页；额外拉 `['pages',subjectId]` 经 `buildTitleSlugMap` 构建 titleSlugMap 传入预览；错误内联、dirty 守卫
- `md-editor.tsx` —— 🆕 `@uiw/react-md-editor` 的 `dynamic(ssr:false)` 封装；`height="100%"` 撑满父高，`components.preview` 接 `previewRenderer` 自定义预览，外层 wrapper 类名 `wiki-md-editor`（供 `globals.css` 工具栏/字号增强定位），data-color-mode 跟随 darkMode
- `editor-preview.tsx` —— 🆕 编辑器实时预览：复用 `PageRenderer`（**不传 title**→跳过 FrontmatterDisplay、仅正文），与阅读页同管线（wikilink/callout/mermaid/数学公式一致），`renderMarkdown` 的 `remarkFrontmatter` 自动剥离 `---` 块
- `retitle-notice.tsx` —— 🆕 阅读页一次性 banner：读 sessionStorage `wiki:retitle-notice`（编辑器改标题保存后写入），展示「已同步更新 N 处引用」5s 后消失；`page-editor` 保存 onSuccess 据 PUT 返回的 `referencesUpdated` 写入

### `chat/`

- `chat-interface.tsx` —— 对话主界面（消息流 + 输入框 + stream handling），发问 body 含 `subjectId`；`reset` 在 `subjectId === null` 时直接抛错（防误触发全量 reset），成功后 invalidate 8 个 query key；接入会话载入/保存/切换（`useEffect` 载历史 + `loadedConversationIdRef` 守卫防自身覆盖 + done 设 ref/id+invalidate）
- `conversation-switcher.tsx` —— 🆕 chat tab 顶部：当前会话标题下拉 + New + 重命名 + 删除，React Query `['conversations',subjectId]`
- `message-list.tsx`
- `save-to-wiki-button.tsx` —— 触发 `POST /api/query` with `save=true`，body 带 `subjectId`

### `search/`

- `command-palette.tsx` —— `cmd+k` 全局命令面板，双模式：`/go` FTS 导航、`/ask` LLM 问答；命令包含 `Switch subject` `Manage subjects`；fetch 自动带 subjectId

### `graph/`

- `mini-graph-view.tsx` —— 基于 cytoscape 的迷你图（仪表盘 + 上下文 Tab 共用）；外层 `<div key={currentSubjectId}>` 强制 cytoscape 重挂载，避免切换 subject 时闪烁

### `tags/`

- `tags-index-view.tsx` —— 🆕 标签索引（aggregateTags(/api/pages) → tag+count）
- `tag-pages-view.tsx` —— 🆕 单标签页列表（pagesWithTag）

### `health/`

- `health-view.tsx` —— 🆕 知识库体检主视图；"Tidy structure" 按钮触发 `POST /api/curate`（全 subject agent 策展）+ `useJobStream` 追踪 `curate:*` 事件，展示策展进度；同时展示 lint findings 按严重度分组；"Fix issues" 按钮触发 `POST /api/fix`（`fix` job）+ `useJobStream` 追踪 `fix:*` 事件，job 完成后自动重跑 lint 闭环

### `history/`

- `operation-list.tsx` —— 🆕 操作时间线列表（rowid DESC，含类型/受影响页/时间，可点展开 diff）
- `operation-diff.tsx` —— 🆕 单次操作 unified diff 渲染（preHead → postHead）
- `revert-button.tsx` —— 🆕 回滚按钮 + 确认弹窗（前向 Saga 还原，**同步 POST 无 SSE/job**；确认文案告知覆盖式语义；成功后 invalidate `['history']`/`['pages']` + `router.refresh()`）

### `shared/`

- `global-job-tracker.tsx` —— 全局任务状态指示器（读队列中所有任务）
- `progress-toast.tsx` —— SSE 进度条 toast

> Settings 弹窗已迁到 `layout/`（两栏式：`settings-dialog` / `settings-nav` / `settings-content` / `settings-categories` / `settings-rows`），见上文 `layout/` 表。所有设置项走 `GET/PUT /api/settings`、服务端 `app_settings` 表唯一真实源、**不写 Zustand**（dark mode/sidebar width 两项仍来自 Zustand）。

### `providers.tsx`

客户端 providers：TanStack Query 的 `QueryClientProvider`、主题初始化、内置 `<SubjectsBootstrap />`（启动时按 `?s=` URL > 持久化 > general 兜底初始化 `currentSubject*`，并通过引用比较跳过重复 set 防循环）。

### `error-boundary.tsx`

React 错误边界，包裹 `(app)/layout.tsx` 主内容。

## 入口与启动

在 `src/app/(app)/layout.tsx` 通过 `<Shell>...</Shell>` 组装。根 `src/app/layout.tsx` 注入 `<Providers>`。

## 对外接口约定

- 所有可能用到客户端状态或事件的文件顶部 `'use client'`。
- 样式一律走 Tailwind + `cn()`（`@/lib/cn`）合并类名。颜色引用 CSS 变量（`bg-surface`、`text-foreground-secondary` 等），主题切换由 `useUIStore::darkMode` 驱动。
- 与后端通信：**仅使用** `@/lib/api-fetch`（会自动带 cookie / API key header）；客户端组件优先使用 `useApiFetch()` hook 自动注入 `?subjectId`；POST 由调用方在 body 中显式带 `subjectId`，**禁止** 手写 `fetch('/api/...')`。

## 关键依赖

- `@tanstack/react-query` —— 数据 fetching / caching
- `zustand` —— 轻量全局状态（`stores/ui-store`）
- `cmdk` —— 命令面板
- `cytoscape` —— 图可视化
- `@uiw/react-md-editor` + `@uiw/react-markdown-preview` —— 编辑 / 预览
- `lucide-react` —— 图标库

## 扩展指南

- **新增 UI 原语**：放 `ui/`，保持无业务依赖；用 `class-variance-authority` 管变体。
- **新增业务组件**：
  1. 按关注点放到对应目录（找不到就新增一个）；
  2. 优先组合 `ui/*` 原语；
  3. 数据请求用 React Query + `api-fetch`；
  4. 全局状态放 `stores/ui-store`（有持久化+迁移支持）。
- **新增 ContextPanel Tab**：
  1. 扩展 `useUIStore::ContextPanelTab` 联合类型 + 迁移函数；
  2. 新建 `context-panel-<name>-tab.tsx`；
  3. 在 `context-panel.tsx` 的 Tabs 里注册。

## 测试与质量

目前无组件测试。建议：

- Storybook 或 Playwright component test 覆盖 `ui/*` 原语的变体矩阵。
- Shell 中的拖拽 resize（pointer events + `clampPanelWidth`）边界。
- `use-job-stream` hook 的重连与 `Last-Event-Id` 续播。

## 相关文件清单

```
src/components/
├── providers.tsx
├── error-boundary.tsx
├── ui/           {button, icon-button, input, panel, tag, kbd, separator, tabs}
├── layout/       {shell, header, sidebar, subject-switcher, context-panel*, settings-dialog, settings-nav, settings-content, settings-categories, settings-rows}
├── wiki/         {page-renderer, page-actions, wiki-link, wiki-page-elsewhere, frontmatter-display, page-skeleton, page-editor, md-editor, tag-link, retitle-notice}
├── chat/         {chat-interface, conversation-switcher, message-list, save-to-wiki-button}
├── search/       {command-palette}
├── subjects/     {subject-dialog, augmentation-field, subjects-api}
├── tags/         {tags-index-view, tag-pages-view}
├── health/       {health-view}
├── history/      {operation-list, operation-diff, revert-button}
├── graph/        {mini-graph-view}
└── shared/       {global-job-tracker, progress-toast}
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化；对应最近一次 `refactor(ui): 统一设计系统与上下文面板` 后的结构 |
| 2026-04-25 | Subject：SubjectSwitcher (⌘O) / wiki-page-elsewhere / 各客户端组件接入 subjectId / wiki-link 缓存 key 加 subject |
| 2026-04-26 | wikiLanguage：`settings-dialog.tsx` 新增 "Wiki language" 行（React Query GET/PUT `/api/settings`，不写 Zustand）|
| 2026-04-27 | settings-dialog 新增 "Agents" section（5 个 agent runtime 配置控件：max steps / token budget / parallel sub-agents / MCP lifecycle / LLM selection mode）|
| 2026-06-22 | 新增 `history/` 目录（operation-list/operation-diff/revert-button 职责）；供 ⑥ 版本历史/diff |
| 2026-06-22 | 新增 `chat/conversation-switcher.tsx`；`chat-interface` 接入会话载入/保存/切换；`context-panel-chat-tab` 嵌入 switcher；供 ⑦ 对话持久化 + 多轮记忆 |
| 2026-06-22 | `layout/settings-rows.tsx` 加 `TextSettingRow`（password/允许空）；`settings-content.tsx` 加 "Web search" section（provider/apiKey/maxResults，走 /api/settings 不写 Zustand）；供 ⑨ verifier 联网核查搜索后端配置 |
| 2026-06-23 | Settings 弹窗改两栏式：新增 `settings-categories.ts`（5 类元数据单源）+ `settings-nav.tsx`（左导航）；`settings-dialog` 加宽 `max-w-3xl`+固定高度+`active` 分类 state；`settings-content` 拆为 5 个 panel 按分类切换；行级原语与 `/api/settings` 数据流不变；spec 见 docs/superpowers/specs/2026-06-23-settings-two-column-layout-design.md |
| 2026-06-23 | 删除 `wiki/{merge,split}-{button,dialog}.tsx`（4 个文件）；`frontmatter-display` 不再渲染 Merge/Split 按钮；新增 `health/health-view.tsx` 的 "Tidy structure" 入口（`POST /api/curate` + `useJobStream` 追踪 `curate:*`）；spec/plan 见 docs/superpowers/{specs,plans}/2026-06-23-agent-driven-page-curation* |
| 2026-06-24 | 在线 Markdown 编辑器重做：`page-editor` 改全高 flex + 拉 titleSlugMap；`md-editor` 加 `previewRenderer`(`components.preview`)/`height="100%"`/`wiki-md-editor` 类名；新增 `wiki/editor-preview.tsx`（复用 PageRenderer 仅正文预览）；`globals.css` 加 `.wiki-md-editor` 工具栏/字号增强；spec/plan 见 docs/superpowers/{specs,plans}/2026-06-24-markdown-editor-rework* |
| 2026-06-24 | `health/health-view.tsx` 加 "Fix issues" 按钮（`POST /api/fix` + `useJobStream` 追踪 `fix:*`，完成后自动重跑 lint）；`use-job-stream` 注册 `fix:*` 事件；spec/plan 见 docs/superpowers/{specs,plans}/2026-06-24-health-fix-findings* |
| 2026-06-24 | `settings-content.tsx` 的 "Agents" panel 移除 "MCP connection mode" 控件（MCP 功能整体移除，详见根 Changelog）；agent 配置控件由 5 个降为 4 个 |
| 2026-06-28 | 对话触发 Re-enrich：删除 `wiki/reenrich-button.tsx` 与 `wiki/reenrich-dialog.tsx`；`frontmatter-display` 不再渲染 Re-enrich 按钮；`chat/message-list.tsx` 导入 `toolActivityIcon/toolActivityVerb/summarizeToolArgs` 从 `@/lib/tool-activity`（不再内联）；chat UI 展示 `wiki.reenrich`（✨）工具活动 |
| 2026-06-27 | Cognitive Lens：`wiki/wiki-reading-view.tsx` 接入 `useLens`——**默认显示原文，`LensBar` 给「按画像重塑」按钮手动触发**（`lensRequested` 门控 enabled，不自动调 LLM；换页重置回原文）+ 重塑/原文切换 + 末尾 `LensFeedback`（太难/太浅→信号）；新增 `wiki/lens-feedback.tsx`；`layout/cognitive-lens-onboarding.tsx`（首次画像向导，挂在 `providers.tsx`）；`layout/settings-content.tsx` 加 `CognitiveLensPanel` + `settings-categories.ts` 加 `cognitive-lens` 分类；画像走 `/api/profile`、**不**写 Zustand。相关 hooks 见 `src/hooks/use-profile.ts`/`use-lens.ts` |
| 2026-06-28 | Job 详情弹窗：`shared/progress-toast.tsx` 加「查看详情/查看错误」入口（失败时红色）+ return 包 Fragment 渲染弹窗（透传 `events/status`，**不**新建第二条 SSE）；新增 `shared/job-detail-dialog.tsx`（全事件日志时间线 + 失败时 `GET /api/jobs/[id]` 取 `resultJson.error` 展全栈 + 一键复制；React Query `enabled: open && failed` + `staleTime:Infinity`；aria-id 按 jobId 派生）；消费 `lib/job-log.ts`（`eventLogLine`/`parseJobError`）纯函数。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-28-job-detail-dialog* |
| 2026-06-28 | 统一阅读页功能菜单 + 英文化：新增 `wiki/page-actions.tsx`（`PageActions` 动作条 + `ReshapeStatus` 状态行）；`frontmatter-display`/`page-renderer` 改用 `actions`/`headerExtra` 插槽并移除 `editHref`；`wiki-reading-view` 删除旧顶部 Sources toolbar 与 LensBar，三控件（Edit/Sources/Reshape）并排进标题行；`lens-feedback`/`html-source-frame`/`page-editor`(retitle banner) 文案英文化。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-28-unify-page-actions-i18n* |
| 2026-06-28 | Subject 体验重做：新增 `subjects/`（`subject-dialog` 统一创建/编辑/删除弹窗 + `augmentation-field` 英文分段控件 + `subjects-api` 共用 fetch）；新增 hook `use-switch-subject`（切换器+管理页卡片复用）；`providers.tsx` 挂载 `<SubjectDialog />`；ui-store 加瞬态 `subjectDialog`。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-28-subject-ux-improvement* |
| 2026-06-29 | Subject 级联删除：`subjects/subject-dialog.tsx` 的 `EditSubjectBody` 危险区改 `canDelete = !isActive && slug !== 'general'`（允许删非空 subject，级联清理由后端处理）；两步确认 armed 态加页数警告；禁删态区分 `general`（"can't be deleted"）/active（"switch first"）；409 入站引用经既有 `error` 行呈现。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-29-subject-cascade-delete* |

---

_生成时间：2026-04-22 00:25:29_
