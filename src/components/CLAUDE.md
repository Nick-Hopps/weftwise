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
| `subject-switcher.tsx` | 🆕 cmdk + 自定义浮层；显示 subjects 列表；⌘O 唤起；切换时写 store + cookie + invalidate 8 个 query key + `router.refresh()` |
| `context-panel.tsx` | 右侧上下文面板容器（Tabs: context / chat） |
| `context-panel-sheet.tsx` | 移动端抽屉版本（off-canvas） |
| `context-panel-context-tab.tsx` | "上下文"Tab：backlinks + frontmatter + mini-graph（queryKey 含 subjectId） |
| `context-panel-chat-tab.tsx` | "对话"Tab：内嵌 `chat-interface`，发问 body 含 subjectId |

### `ui/` — 设计系统

无业务逻辑的原语，基于 `class-variance-authority` + Tailwind + CSS 变量：

- `button.tsx` / `icon-button.tsx`
- `input.tsx` / `kbd.tsx`
- `panel.tsx`（含 `SectionLabel`）
- `tag.tsx`（带 `tone` 变体）
- `separator.tsx`
- `tabs.tsx`

### `wiki/` — wiki 页面渲染

- `page-renderer.tsx` —— 把 markdown + frontmatter + titleSlugMap → React（unified + rehype-pretty-code + Shiki）
- `wiki-link.tsx` —— `[[target]]` / `[[subject:target]]` 的 client 组件，支持 hover peek；preview 缓存 key `${effectiveSubjectSlug}:${slug}` 防同名跨主题串显
- `wiki-page-elsewhere.tsx` —— 🆕 当目标 subject 没该 slug 但其他 subject 有时给出"也许在 X 中"提示，链接附 `?s=`
- `frontmatter-display.tsx` —— 页头 meta 信息展示
- `page-skeleton.tsx` —— loading skeleton

### `chat/`

- `chat-interface.tsx` —— 对话主界面（消息流 + 输入框 + stream handling），发问 body 含 `subjectId`；`reset` 在 `subjectId === null` 时直接抛错（防误触发全量 reset），成功后 invalidate 8 个 query key
- `message-list.tsx`
- `save-to-wiki-button.tsx` —— 触发 `POST /api/query` with `save=true`，body 带 `subjectId`

### `search/`

- `command-palette.tsx` —— `cmd+k` 全局命令面板，双模式：`/go` FTS 导航、`/ask` LLM 问答；命令包含 `Switch subject` `Manage subjects`；fetch 自动带 subjectId

### `graph/`

- `mini-graph-view.tsx` —— 基于 cytoscape 的迷你图（仪表盘 + 上下文 Tab 共用）；外层 `<div key={currentSubjectId}>` 强制 cytoscape 重挂载，避免切换 subject 时闪烁

### `shared/`

- `global-job-tracker.tsx` —— 全局任务状态指示器（读队列中所有任务）
- `progress-toast.tsx` —— SSE 进度条 toast
- `settings-dialog.tsx` 现包含 "Wiki language" 行：通过 `useQuery(['app-settings'])` 读 `GET /api/settings`，本地 `useState` 暂存 input，`useMutation` 发 `PUT /api/settings`。**不**写 Zustand —— 服务端 `app_settings` 表是唯一真实源。

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
├── layout/       {shell, header, sidebar, subject-switcher, context-panel*}
├── wiki/         {page-renderer, wiki-link, wiki-page-elsewhere, frontmatter-display, page-skeleton}
├── chat/         {chat-interface, message-list, save-to-wiki-button}
├── search/       {command-palette}
├── graph/        {mini-graph-view}
└── shared/       {global-job-tracker, progress-toast}
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-04-22 | 初始化；对应最近一次 `refactor(ui): 统一设计系统与上下文面板` 后的结构 |
| 2026-04-25 | Subject：SubjectSwitcher (⌘O) / wiki-page-elsewhere / 各客户端组件接入 subjectId / wiki-link 缓存 key 加 subject |
| 2026-04-26 | wikiLanguage：`settings-dialog.tsx` 新增 "Wiki language" 行（React Query GET/PUT `/api/settings`，不写 Zustand）|

---

_生成时间：2026-04-22 00:25:29_
