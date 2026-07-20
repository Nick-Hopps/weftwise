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
| `sidebar.tsx` | 左侧目录树（按 `currentSubjectId` 过滤的 wiki pages + 最近访问）；Sources 对 URL Source 展示 worker 已持久化的网页标题与描述，普通文件仍展示 filename |
| `subject-switcher.tsx` | 🔀 cmdk + 自定义浮层；显示 subjects 列表；⌘O 唤起；切换时写 store + cookie + invalidate 8 个 query key + `router.refresh()`；"New subject…" 改调 openSubjectDialog（删 ?new=1），切换复用 useSwitchSubject |
| `context-panel.tsx` | 右侧页面 Context 检查器（backlinks / frontmatter / mini-graph） |
| `context-panel-sheet.tsx` | Context 的移动端右侧抽屉版本 |
| `context-panel-context-tab.tsx` | Context 内容：backlinks + frontmatter + mini-graph（queryKey 含 subjectId） |
| `ask-ai-floating-panel.tsx` | Ask AI 响应式容器：桌面 fixed 悬浮拖动 + 右/下/右下 resize（含键盘微调与视口安全边界）；空白双击坐标作为候选左上角，选区保留附近定位，无锚点时复用末位置或居中；触发代次重建聊天实例；移动端 Bottom Sheet 下滑关闭 |
| `context-panel-chat-tab.tsx` | Ask AI 工作面 memo 边界：尺寸拖动时保持聊天子树稳定，内部复用 `chat-interface`，发问 body 含 subjectId |
| `settings-dialog.tsx` | 响应式 Settings 弹窗容器（桌面两栏、移动端上下布局）：持有 `GET/PUT /api/settings` query/mutation + `active` 分类 state（开窗重置 `general`）+ Esc/遮罩关闭；正文字号保存成功后即时同步根 CSS 变量 |
| `settings-nav.tsx` | 四个任务导向入口（General / Personalization / Automation / Usage）；桌面左侧导航，移动端横向导航，About 版本信息收进导航底部 |
| `settings-content.tsx` | 按一级入口组合设置 section：小标签 + 组描述 + `divide-y` 边框卡片；General 收纳语言与阅读（正文字号）两卡，Automation 同页收纳 Agents / Web search / Maintenance 三卡，Usage 为工具栏（时间 segmented + 项目 select）+ 表格卡片 |
| `settings-categories.ts` | 一级入口与 section 映射单一来源：`SETTINGS_CATEGORIES` + `SETTINGS_SECTIONS` + `DEFAULT_CATEGORY`，避免导航和内容漂移 |
| `settings-rows.tsx` | 即时保存行原语：SettingRow/SwitchRow/SegmentedRow/SelectRow/MultiSelectRow/NumberRow/TextRow/TextareaRow；行自持 `px-4 py-3` 供卡片 `divide-y` 分组，保存指示内联在行标签旁，textarea 行上下布局全宽；窄屏自动切换为上下布局 |

### `ui/` — 设计系统

无业务逻辑的原语，基于 `class-variance-authority` + Tailwind + CSS 变量：

- `button.tsx` / `icon-button.tsx`
- `input.tsx` / `kbd.tsx`
- `panel.tsx`（含 `SectionLabel`）
- `tag.tsx`（带 `tone` 变体）
- `separator.tsx`
- `tabs.tsx`
- `switch.tsx` / `segmented.tsx` / `select.tsx`
- `workspace-page.tsx` —— 知识运维页面共享骨架：统一 1080px 页面宽度、页头、无卡片指标带、sticky 工具栏与空/错状态；只承载视觉结构，不读取 Subject 或业务数据

### `wiki/` — wiki 页面渲染

- `page-renderer.tsx` / `callout-icon.tsx` —— 把 markdown + frontmatter + titleSlugMap → React；callout 类型统一渲染 Lucide 语义图标并兼容历史标题 emoji；正文消费根变量 `--wiki-body-font-size`（默认 16px，相对行高 1.75），位图按原比例居中并受正文宽度与 `min(32rem, 70vh)` 高度双重约束；标题行 `actions` 与 `headerExtra` 插槽保持不变
- `page-actions.tsx` —— 阅读页统一图标动作条 + Reshape 状态行；生成态提供 Cancel，成功态提供 Refresh 与 Show original/reshaped，保存版 stale 时显示行内 Update available 提示；`wiki-reading-view` 按 Subject + slug 把用户最后选择的原文/重塑版本保存到浏览器 localStorage，未记录时仍优先已有重塑版本
- `reading-progress.tsx` —— 阅读页顶部细进度条；普通模式监听 `#main-content`，Sources 分栏模式监听左侧正文容器，尺寸变化时重新计算并限制在 0–100%
- `article-toc.tsx` —— 阅读页固定目录：宽内容区显示右侧 sticky 目录轨道，窄内容区收敛为 sticky 入口/浮层；跟踪普通主滚动区与 Sources 左栏的当前章节并复用稳定 heading anchors
- `html-source-frame.tsx` —— HTML/网页 Source 的 sandbox iframe：上传 HTML 仍加载同源 raw 路由；链接型 URL Source 直接加载远程地址并设置 `referrerPolicy=no-referrer`，始终不开放 `allow-same-origin`，默认禁用脚本，用户显式点击后只增加 `allow-scripts`
- `mermaid-diagram.tsx` / `mermaid-svg.tsx` / `mermaid-preview.tsx` / `mermaid-theme.ts` —— Mermaid 客户端渲染与主题配置；内联图与全屏预览复用同一 SVG 渲染器，预览支持 50%–200% 缩放、滚动、重置及 Escape/遮罩关闭；使用紧凑 flowchart 参数、浅/深色 palette，并监听根节点主题变化重绘 SVG；Diagram callout 的无卡片图解样式位于 `globals.css`
- `wiki-link.tsx` —— `[[target]]` / `[[subject:target]]` 的 client 组件，支持 hover peek；preview 缓存 key `${effectiveSubjectSlug}:${slug}` 防同名跨主题串显
- `wiki-page-elsewhere.tsx` —— 🆕 当目标 subject 没该 slug 但其他 subject 有时给出"也许在 X 中"提示，链接附 `?s=`
- `tag-link.tsx` —— 🆕 可点 tag chip（Link 包 Tag，prop 驱动 subjectSlug，链到 /tags/<tag>?s=）
- `frontmatter-display.tsx` —— 页头 meta 信息展示；标题行右侧 `actions` 插槽渲染统一动作条（Edit 已移入 `PageActions`，不再有内置 `editHref`/Edit 按钮）
- `page-skeleton.tsx` —— loading skeleton
- `page-editor.tsx` —— 🆕 在线编辑容器：根/loading/error **全高 flex 布局**（`flex flex-col h-full`，去掉旧 `max-w-content` 居中收窄）；拉 raw → md-editor → Save(PUT)/Cancel → 失效缓存 + router.refresh + 跳回读页；额外拉 `['pages',subjectId]` 经 `buildTitleSlugMap` 构建 titleSlugMap 传入预览；错误内联、dirty 守卫
- `md-editor.tsx` —— `@uiw/react-md-editor/nohighlight` 的 `dynamic(ssr:false)` 轻量封装；动态加载有全高 skeleton，默认 `preview="edit"` 且关闭全文 Prism 高亮，用户仍可用内置工具栏按需切换 Live / Preview；`height="100%"` 撑满父高，`components.preview` 接自定义预览，外层 wrapper 类名 `wiki-md-editor`（供 `globals.css` 工具栏/字号增强定位），data-color-mode 跟随 darkMode
- `editor-preview.tsx` / `deferred-editor-preview.tsx` —— 编辑器按需富预览：后者把连续输入合并为 400ms 停顿后的一次更新，再由前者复用 `PageRenderer`（**不传 title**→跳过 FrontmatterDisplay、仅正文），与阅读页同管线（wikilink/callout/mermaid/数学公式一致），避免逐键执行完整渲染
- `retitle-notice.tsx` —— 🆕 阅读页一次性 banner：读 sessionStorage `wiki:retitle-notice`（编辑器改标题保存后写入），展示「已同步更新 N 处引用」5s 后消失；`page-editor` 保存 onSuccess 据 PUT 返回的 `referencesUpdated` 写入
- `selection-ask-button.tsx` —— 正文选区末端浮出的「Ask AI」按钮：消费 `hooks/use-text-selection`（选区限定在阅读正文，并组合首尾完整顶层 Markdown 块 offset）；点击调 `ui-store.askAboutSelection`，结构化信箱保留 canonical/reshape、quote、section 和块范围；滚动/折叠/落在容器外自动隐藏

### `chat/`

- `chat-interface.tsx` —— 对话主界面（统一功能区 + 消息流 + 输入框 + stream handling），发问 body 含 `subjectId`；选区引用场景同时发送带 Passage 的 `question`、未拼接的 `userQuestion` 与有界 `messageReferences`，供服务端统一分类并持久化用户引用；会话加载按 role 恢复 user references / assistant citations；客户端不再用自然语言正则识别重置/确认，而是消费 `reset-confirmation` SSE 并在 pending 状态下发送 `intentContext:'reset-confirmation'`，只有 pending + confirm 才调用 `/api/reset`；会话加载并行恢复 messages 与 pending actions，切换 subject/conversation 时取消旧请求；`answer-delta` 经动画帧批处理后才更新最后一条回答；消费 `pending-action` SSE 后按 actionId upsert，消费 `error` SSE 后把错误写入当前 assistant 消息而非留下空白 loading；批准 workflow 后通过 `job-started-event` 派发真实 job type/label
- `chat-toolbar.tsx` —— Ask AI 稳定功能区：当前会话选择 + New/Clear/Save 图标动作统一排列；无内容/生成中只禁用动作，不移除槽位
- `message-stream-batcher.ts` / `message-scroll.ts` —— 流式文本动画帧合并与消息贴底阈值纯逻辑；stop/unmount 会 cancel 未提交帧
- `reset-confirmation-state.ts` —— Chat 重置确认纯状态机：`idle/pending` + `requested/confirm/cancel/unclear` 转换；孤立 confirm 不产生 `shouldReset`，并集中派生 reset intent context
- `pending-action-card.tsx` / `pending-action-state.ts` —— 可访问审批卡片（页面变更/move/标签治理/History/工作流/选区配图）与 actionId 原位替换；配图卡显示完整 Markdown 块、prompt、alt、比例/风格，`applied` 只表示后台任务已启动；受影响页面默认只显示前 8 条
- `conversation-switcher.tsx` —— chat 工具区的当前会话标题下拉 + 重命名 + 删除，React Query `['conversations',subjectId]`；New 由统一工具区持有；菜单支持点击外部/Escape 关闭
- `chat-message.ts` —— Chat 内存消息纯契约与 role-aware 映射：新发送用户消息保留 references，历史 `ConversationMessage` 分别恢复 user references / assistant citations
- `message-list.tsx` —— 消息流渲染；工具活动经共享 `ToolActivityIcon` 渲染 Lucide 语义图标；用户消息正文上方最多展示一个可点击的“页面标题 · 章节/短摘要”胶囊；Assistant Sources 保持可折叠，消息行 memo 化且仅贴底时跟随流式回答
- `save-to-wiki-button.tsx` —— 统一工具区内的稳定图标动作 + 锚定标题输入浮层；触发 `POST /api/query` with `saveAsPage=true`，body 带 `subjectId`；回答变化时重置旧保存状态；只以服务端 `jobId` 启动任务追踪，不再从 title 提前猜测 slug（冲突后缀由 shared create planner 决定）

### `search/`

- `command-palette.tsx` —— `cmd+k` 全局命令面板，双模式：`/go` FTS 导航、`/ask` LLM 问答；命令包含 `Switch subject` `Manage subjects`；fetch 自动带 subjectId

### `graph/`

- `mini-graph-view.tsx` —— 基于 cytoscape 的迷你图（仪表盘 + 上下文 Tab 共用）；外层 `<div key={currentSubjectId}>` 强制 cytoscape 重挂载，避免切换 subject 时闪烁

### `tags/`

- `tags-index-view.tsx` —— 标签目录工作台：复用 `workspace-page` 的页头/指标带/sticky 工具栏/状态区；聚合当前 Subject 页面元数据，All 支持标签/页面搜索与三种排序；Review 显示待处理数量并切换到解释型清理队列；URL 保存 scope/search/sort，治理意图继续交给既有 PendingAction 审批
- `tag-review-queue.tsx` —— 无请求的 Review 展示层：按格式变体、非重复单次标签、未标记页面分区；格式变体使用 `Preview merge` 上抛源标签与推荐目标，未标记页面只导航、不复制 metadata 写入能力
- `tag-pages-view.tsx` —— 标签组合浏览：单标签页面列表扩展为摘要/更新时间/关联标签视图，相关标签可叠加为 `with` 条件并在 `Match all / Match any` 间切换；搜索、排序、组合条件同步到 URL
- `use-tag-search-params.ts` / `tags-route-fallback.tsx` —— 两个 Tags 路由共用的 URL 状态更新器与 Suspense 加载态
- `tag-governance-dialog.tsx` / `tag-governance-state.ts` —— Rename/Merge/Delete 意图表单与工作台审批恢复逻辑；表单只请求服务端预览，批准/拒绝复用 PendingActionCard 和通用审批 API

### `health/`

- `health-view.tsx` —— 🆕 知识库体检工作台；复用 `workspace-page` 的统一宽度、页头、五项摘要、sticky 工具栏和状态区；消费 `HealthSnapshot.remediations` 驱动逐条/批量动作；「整理/修复/研究」在 pending/running 时原位切为 Stop，刷新恢复出的 active job 同样可取消，成功后等待权威 SSE 终态释放 action gate，失败保留可重试入口；Fix/Curate 完成后仅刷新已物化 postcondition 的 Health 快照投影，不再自动入队 lint；Research job 完成后由 `result.runId` GET 持久化 run，按 candidate ID 批准/忽略并轮询 importing/legacy verifying，终态刷新 pages/lint-latest/active jobs
- `finding-row.tsx` —— 单条 finding 采用稳定的摘要/状态/动作三段布局，长描述限制两行，建议与 plan reason 按需展开；内部 status 映射为用户态文案（如 `awaiting-approval` → `Needs action`）；无 plan 时显示 `Plan unavailable`，不按 finding type 猜测动作；`review-source` 只导航
- `remediation-ui.ts` —— 客户端纯 helper：从服务端 actions 收集 finding IDs、同步 action gate、subject/generation origin 隔离、active job 严格解析与 hydration busy；恢复 remediation job 只恢复 workflow，不排队修后 lint；统一派生处置按钮的 idle/starting/running/cancelling 四态并解析通用 job cancel 响应（409 按已终态幂等收敛）；Fix 完成摘要只统计 `perFindingOutcomes`，不把 `writes` 解释为 finding 或页面数；同时严格解析 Research job locator/run view，并构造不含 URL 的批准 body
- `research-backlog-section.tsx` / `research-candidates-dialog.tsx` —— 通用 Research backlog 与候选批准；候选以稳定 ID 选择、score=3 默认勾选，只有 awaiting-approval 可操作，持久展示 importing/verifying/terminal 与 child delivery
- `postcondition-summary.ts` —— SSE 嵌套 report 运行时守卫与有界提示纯函数（最多三条、每条 180 字符）

**Plan-driven 与只读边界**：Health UI 只渲染 `HealthSnapshot.remediations[finding.id].actions`，批量 Fix/Tidy/Research 也从这些 actions 收集稳定 ID，并提交当前 `data.jobId` 作为 `lintJobId`；客户端不维护 finding-type 白名单或备用动作。All Subjects 请求服务端 read-only plans，前端不挂执行/删除回调，保持纯查看。orphan 不提供删除；orphan-source 的 Delete Source 独立于通用 action，保留 armed → 确认的二次点击、来源 in-flight 守卫及专用 DELETE API；404 按已删除幂等收敛，409/500 在工作区显示可操作错误。

**刷新恢复与 subject 隔离**：当前 subject 以 React Query 严格按 `pending → running` 顺序读取 active jobs，避免 claim 窗口遗漏；首次成功 hydrate 前四类 action 安全禁用。合法 Fix/Curate/Research 按 job type 恢复，Re-ingest 还要求严格 context。每个 workflow 按 `createdAt + id` 选最新 job；queued plan 是 active 列表短暂缺失时的兜底，awaiting-approval Research plan 也可恢复已完成 discovery job，再由其 `runId` 读取持久化审批事实。

所有异步请求都捕获 `{ generation, subjectId, scope }` origin；切换 subject/scope 同步作废旧响应、候选 view 和批准幂等键。manual/backlog/remediation Research 共用同步 action gate。批准请求只发 candidate IDs/version/idempotency key；同 selection 的不确定结果保留同一 key 并 GET run 对账，不盲目换 selection 重发。普通关闭只隐藏弹窗，显式 Dismiss 才改变 run。importing/verifying 每 2 秒刷新，终态同时失效 pages、active-jobs 与 lint-latest。

### `history/`

- `operation-list.tsx` —— 操作时间线（rowid DESC）：复用 `workspace-page` 页头与指标带；宽屏在标准内容区内呈现 320px 记录栏 + DetailPane，内容高度随记录自然展开，默认选中最新记录；md 以下退化为分隔列表内联展开；数据 query 一份两套渲染
- `operation-diff.tsx` —— 🆕 单次操作 unified diff 渲染（preHead → postHead）
- `revert-button.tsx` —— 🆕 回滚按钮 + 确认弹窗（前向 Saga 还原，**同步 POST 无 SSE/job**；确认文案告知覆盖式语义；成功后 invalidate `['history']`/`['pages']` + `router.refresh()`）

### `shared/`

- `global-job-tracker.tsx` —— 🆕 全局任务状态指示器：轮询 running+pending 聚合追踪（不再是单任务 toast 挂载点），queued 行离开 active 列表时切入 SSE 终态恢复，托管 `JobsPanel`
- `jobs-panel.tsx` / `jobs-panel-state.ts` —— 🆕 聚合任务面板（多行、独立 SSE、折叠把手）及纯状态逻辑：active pending 行不建连接；消失的 pending 行转为 streamable 并回放终态；Ingest 完成后额外失效 Sources cache 以刷新网页标题/描述；`image-insert` 显示 `Illustrating`，成功后失效页面缓存并 `router.refresh()`
- `progress-toast.tsx` / `tool-activity-icon.tsx` —— SSE 进度表面与共享 Lucide 工具图标适配；任务摘要和详情日志消费事件 `data.tool`，历史 emoji 只在展示层兼容清理

> Settings 弹窗已迁到 `layout/`（两栏式：`settings-dialog` / `settings-nav` / `settings-content` / `settings-categories` / `settings-rows`），见上文 `layout/` 表。设置项走各自服务端接口，持久化配置不写 Zustand；主题切换与侧栏拖拽保留在应用骨架中，不再作为 General 设置项展示。

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
  1. Context 检查器新增内容时，优先扩展 `context-panel-context-tab.tsx`；
  2. Ask AI 的容器交互放在 `ask-ai-floating-panel.tsx`，对话能力继续复用 `chat/*`；
  3. 全局打开/关闭与位置状态放在 `ui-store.ts`，不要镜像到组件局部状态。

## 测试与质量

目前 Health 有纯 helper / 服务端 plan 渲染测试，并覆盖 Research candidate ID 默认选择、批准/忽略分离及各 run 状态/delivery 展示；其余组件建议：

- Storybook 或 Playwright component test 覆盖 `ui/*` 原语的变体矩阵。
- Shell 中的拖拽 resize（pointer events + `clampPanelWidth`）边界。
- `use-job-stream` hook 的重连与 `Last-Event-Id` 续播。

## 相关文件清单

```
src/components/
├── providers.tsx
├── error-boundary.tsx
├── ui/           {button, icon-button, input, panel, tag, kbd, separator, tabs, switch, segmented, select, workspace-page}
├── layout/       {shell, header, sidebar, subject-switcher, context-panel*, ask-ai-floating-panel, settings-dialog, settings-nav, settings-content, settings-categories, settings-rows}
├── wiki/         {page-renderer, page-actions, reading-progress, wiki-link, wiki-page-elsewhere, frontmatter-display, page-skeleton, page-editor, md-editor, tag-link, retitle-notice, selection-ask-button}
├── chat/         {chat-interface, chat-toolbar, chat-message, reset-confirmation-state, conversation-switcher, message-list, message-scroll, message-stream-batcher, save-to-wiki-button}
├── search/       {command-palette}
├── subjects/     {subject-dialog, augmentation-field, subjects-api}
├── tags/         {tags-index-view, tag-review-queue, tag-pages-view, tag-governance-dialog, tag-governance-state}
├── health/       {health-view, finding-row, remediation-ui, research-backlog-section, research-candidates-dialog, postcondition-summary}
├── history/      {operation-list, operation-diff, revert-button}
├── graph/        {mini-graph-view}
└── shared/       {global-job-tracker, jobs-panel, progress-toast}
```

## 变更记录 (Changelog)

| 日期 | 变更 |
|------|------|
| 2026-07-20 | Health「整理/修复/研究」三个处置按钮支持手动停止：运行态原位切换 Square + Stop，pending/running 与刷新恢复 job 复用通用 cancel API；请求失败可见且可重试，成功等待 `job:cancelled` SSE 清理，不把主动取消 Research 误报为普通失败。spec/plan 见 `docs/{specs,plans}/2026-07-20-health-actions-manual-cancel.md` |
| 2026-07-20 | Ingest URL 登录态恢复：`use-job-stream` 注册 `ingest:auth-required`；工作台把无 checkpoint 的认证失败 job 纳入刷新恢复，失败主操作切为 Sign in；新增 `ingest-auth-dialog`，打开精确 origin 登录页并提交默认遮蔽的 Cookie/可选 Authorization，成功后复用同一 job SSE。spec/plan 见 docs/{specs,plans}/2026-07-20-url-authenticated-ingest.md |
| 2026-07-20 | URL Source 预览改为直接加载原网页：左侧 Sources 列表展示已持久化的网页标题+描述；source 独立页与 Wiki Sources 分栏复用远程 sandbox iframe，显示 Web/Open original，默认禁用脚本且永不开放同源权限；上传 HTML 继续走本地 raw+CSP 预览 |
| 2026-07-20 | Settings Maintenance 状态行新增到期页面预览：`Pages due now` 计数 >0 时显示 View/Hide 切换，展开行 footer 懒加载 `GET /api/maintenance/due-pages`（React Query `['maintenance-due-pages']`，10s stale）渲染有界列表——标题（孤儿行回退 slug）+ 项目名 + 相对到期时间，条目 Link 到 `/wiki/<slug>?s=` 并关闭弹窗，超上限提示剩余条数。spec/plan 见 `docs/{specs,plans}/2026-07-20-maintenance-due-pages-preview.md` |
| 2026-07-20 | `MultiSelectRow`（Maintenance scope 项目选择器）重做：面板从行内 footer 展开改为 portal + fixed 悬浮层（卡片 overflow-hidden/内容区滚动下不被裁切），锚定触发按钮右缘、滚动跟随、底部空间不足自动向上翻转；摘要单选时直接显示项目名；sr-only checkbox + 自定义勾选标记，All 行带半选态与 n/m 计数；最后一个选中项仅弱化勾选标记不再整行置灰；点外/Escape 关闭且 Escape 截停冒泡不误关 Settings 弹窗 |
| 2026-07-20 | Wiki 图谱布局间距自适应：`graph-layout.ts` 的固定 `LAYOUT_COMPACT` 改为 `computeLayoutPreset(nodeCount, edgeCount)`，按结点数（40→120）或平均度（6→16）线性加大理想边长/斥力并降低重力（封顶 130/11000/0.18），高密度小图与大图不再挤在聚合根附近；小而稀疏的图参数不变 |
| 2026-07-20 | 设置界面卡片分组重构：section 改「小标签 + 组描述 + 边框卡片 divide-y」修正标题层级；General 界面/内容语言合并单卡；保存指示器移到行标签旁不再在控件侧占位；控件宽度规范化（text w-56 / select min-w-36）、textarea 全宽；Usage 筛选收敛为工具栏 + 表格卡片；删「提供方」静态行并入 API key 描述。spec/plan 见 `docs/{specs,plans}/2026-07-20-settings-ui-redesign.md` |
| 2026-07-20 | 全站正常操作主色从纬线朱切换为经线靛：主按钮、开关、选中态、焦点环、进度与图谱激活态统一使用 warp；纬线朱仅保留品牌识别，danger 红色独占删除、失败与错误语义 |
| 2026-07-20 | 阅读页按 Subject + slug 记忆原文/重塑展示偏好；Mermaid Diagram 增加可缩放全屏预览；Settings Usage 增加项目筛选并明确历史未归因用量仅计入全部项目 |
| 2026-07-20 | 阅读页正文图片选择器从无效的直接子节点匹配改为真实 Markdown 后代匹配；图片保持原比例居中，并限制最大正文宽度与可视高度，避免大图打断阅读 |
| 2026-07-18 | Ask AI、Tasks 摘要与任务详情日志统一使用 `ToolActivityIcon` 的 Lucide 语义图标；正文 callout 按类型注入 `CalloutIcon`，历史 Markdown 的标题 emoji 在渲染期清理，普通正文 emoji 不受影响 |
| 2026-07-17 | Ask AI 桌面工作面支持右/下/右下受控 resize 与键盘微调；会话选择、New/Clear/Save 合并为稳定功能区；流式 delta 按动画帧合并，消息仅在贴底时跟随并按行 memo，修复滚动争用与表格高频重排 |
| 2026-07-17 | Ask AI 外部触发新增代次边界，每次打开进入新空白会话；双击点直接作为候选左上角，Header 等无锚点入口首次居中、其后复用末位置；用户消息引用在发送与历史恢复后显示单个“页面标题 · 章节/短摘要”胶囊，不展开完整选中文字 |
| 2026-07-17 | 标志 v2 小尺寸优化：`shared/weftwise-mark.tsx` 织纹改「三经 + 正弦波纬」（幅 6/周期 20/笔画 3.6，穿 1 压 2 穿 3）——直纬在 16-24px 读作四竖一横，波形自身即传达编织；favicon/apple-icon/OG/docs/brand SVG 同步重生成 |
| 2026-07-17 | Chat 删除 Wiki 重置与 yes/no 正则；普通消息统一交给 `/api/query` 结构化分类，重置确认通过专用 SSE + 纯状态机接线，仅 pending + confirm 执行现有 `/api/reset` |
| 2026-07-17 | 全站主题色切换 weftwise：`wiki-link.tsx` 正文 wikilink 改挂新 `link` 色族（warp 经线靛，hover 加深）；`page-renderer.tsx` callout-quiz 边框与图标改 `--brand-warp`；`mermaid-theme.ts` secondary 家族 violet → warp、暗色底对齐新暗面；tailwind 新增 `link` 色族映射；mermaid 测试基准色同步。plan 见 docs/plans/2026-07-17-brand-theme-colors.md |
| 2026-07-17 | Ask AI 选区信箱贯通 canonical/reshape 与顶层块 offset；配图审批卡展示视觉请求详情，`image-insert` 任务显示 Illustrating，成功终态全局刷新阅读页 |
| 2026-07-17 | Chat 发问新增 `userQuestion` 原始输入，与包含 Passage 的 `question` 分离，避免选区正文干扰服务端 LLM 意图分类 |
| 2026-07-17 | 品牌落地 weftwise（织识）：新增 `shared/weftwise-mark.tsx`（织纹标志，走 `--brand-warp`/`--brand-weft` token 自动亮暗）；Header 换 weftwise lockup（Space Grotesk wordmark + 「织识」lg 起显示），替换旧网络图形与旧品牌名；Settings About 两处文案改 `weftwise 织识`。plan 见 docs/plans/2026-07-17-brand-weftwise.md |
| 2026-07-16 | Wiki 阅读页面包屑安全解码中文 slug，并将 Edit / Sources / Reshape 收敛为带 tooltip 的纯图标按钮 |
| 2026-07-17 | Wiki 正文增加自适应固定目录：宽内容区常驻右侧章节轨道，窄内容区使用粘性入口；普通阅读与 Sources 分栏共享当前章节跟踪和稳定标题锚点 |
| 2026-07-17 | 阅读页 Reshape 状态扩为 loading/refreshing/ready：保存版可随时查看，Refresh 保留旧内容直至原子替换，生成与刷新均可 Cancel |
| 2026-07-17 | 阅读页消费 Lens `stale` 协议：canonical 或画像变化后，旧保存版继续可读并在原状态行显示 `Update available`，不增加卡片或弹窗 |
| 2026-07-17 | 阅读页进入时静默 GET Lens 保存版：命中 saved 立即默认展示，未命中保持 canonical/idle 且不自动触发生成；页面或 Subject 切换会中止旧读取防止串显 |
| 2026-07-16 | Tasks 面板恢复 queued 快速终态：pending 行仍不提前占用 SSE；若下一次 active 轮询发现任务已离开 pending/running，则转入 SSE 回放并保留 completed/failed 终态与错误详情，不再静默消失 |
| 2026-07-16 | Ask AI 从 Context 固定侧栏迁为召唤式工作面：桌面正文空白双击/Header/⌘J 打开 fixed 悬浮面板并支持安全区拖动；正文选区以末端锚点携带引用；移动端退化为 Bottom Sheet 并支持下滑关闭；Context 面板收敛为纯页面检查器。 |
| 2026-07-16 | Health、Tags 与 History 统一为 1080px 知识运维工作区：新增 `workspace-page` 页头/指标带/sticky 工具栏/状态原语；Health 与 Tags 收敛列表边界和状态层级；History 将主从浏览收进标准页面框架并默认选中最新记录，移动端保持行内详情 |
| 2026-07-16 | Settings 一级入口由 8 项精简为 General / Personalization / Automation / Usage 四组，原模块改为组内 section；About 移到导航底部；弹窗与设置行增加移动端横向导航和上下布局 |
| 2026-07-16 | Tags Review 升级为解释型清理队列：显示动态待处理数，分开呈现格式变体/非重复单次标签/未标记页面；格式变体可直接打开预填 Merge 的既有治理弹窗，Review 搜索覆盖三个分区，All 目录保持原有排序 |
| 2026-07-16 | Tags Review 接入服务端治理审批：列表行省略号打开 Rename/Merge/Delete 表单，创建预览后在主工作区展示可恢复的 PendingActionCard；批准终态刷新 pages/history/search/graph，重复工作台审批由服务端 action 恢复 |
| 2026-07-16 | Tags 升级为标签工作台：默认列表取代词云，增加覆盖率/单次标签/格式变体统计、标签与关联页面搜索、三种排序和 Review 视图；详情页支持相关标签组合筛选、AND/OR、页面摘要/时间/其他标签，并将所有筛选状态写入 URL |
| 2026-07-16 | 重设计 Mermaid 图表：新增浅/深色 `base` 主题、紧凑节点/曲线参数、主节点与边标签层级；主题切换自动重绘；Diagram callout 改为无灰底的上下分隔图解区并压低图注层级 |
| 2026-07-16 | 整体布局与阅读体验优化：移动导航默认关闭；桌面侧栏/上下文面板改为 264/400px；首页统计与最近页面去卡片化；阅读页收窄至 780px、合并重复 H1、压缩元数据、增加滚动进度并修复窄屏工具提示导致的横向溢出 |
| 2026-07-16 | 全局任务启动事件携带真实 type/label/queueStatus：顶部 Ingest 胶囊与 dashboard hero 只响应 ingest；re-enrich/research/save-to-wiki 进入 Tasks 面板且先显示 Queued，不再伪装成 ingest 后跳空工作台 |
| 2026-07-16 | Chat 显示 `/api/query` 的 SSE error 终态，模型超时、工具失败或 workflow 预览失败不再留下空白 assistant/loading 假象 |
| 2026-07-16 | Maintenance 新增项目范围多选：支持 `All projects` 或若干 Subject，复用 `['subjects']` 缓存并即时保存；范围变化后刷新到期页统计；`settings-rows` 新增带 All 语义的 `MultiSelectRow` |
| 2026-07-15 | 聚合任务面板新增一键清理 completed/failed 任务；父面板汇总行级 SSE 终态，折叠后按处理中、全部成功或包含失败显示对应图标 |
| 2026-07-15 | Health Fix/Tidy/Research 终态改为直接刷新服务端快照投影：Tidy/Fix 完成任务内验证、Research provenance 到达验证终态后移除关联 finding，真实 fixed/failed/skipped 结果保留在近期摘要；手动 Run check 才触发 discovery |
| 2026-07-15 | Health 自动复检改为 verification：Fix/Curate 终态携带 baseline/remediation ID，刷新恢复与 lint rerun queue 均保留该上下文；手动 Run check 仍为 discovery，避免零写 Curate 后同一 vault 的 findings 随模型漂移增长 |
| 2026-07-15 | Health 修复结果纠偏：完成提示改按 `perFindingOutcomes` 统计 fixed/failed/skipped，不再展示或解释 `writes`；明确后续全库检查可能发现新问题，不再把写入次数误报为修复数量 |
| 2026-07-15 | Health 工作台视觉重构：范围与重跑收敛到页头，新增无卡片摘要带、sticky 类型筛选/批量动作工具栏；finding 改为紧凑摘要行与可展开详情，内部审批枚举改为用户态状态文案，Research backlog 同步统一列表层级 |
| 2026-07-14 | 页面身份迁移 Phase 3D：PendingAction 卡片区分页面 move 并提示旧 slug alias 兼容；tool activity 仅展示 `slug → newSlug`，不暴露 sidecar 内容 |
| 2026-07-14 | Workflow 控制 Phase 3C：PendingAction 卡片区分 workflow start/cancel/research 二次审批；tool activity 使用 Planning/Checking 语义并只展示 slug/topic/jobId；cancel 批准不派发 job-started |
| 2026-07-14 | History 工具 Phase 3B：Chat PendingAction 卡片区分 History 回滚提案；批准后沿用 page-change 缓存失效，刷新 pages/search/graph/history |
| 2026-07-14 | 跨 Subject 只读 Phase 3A：Ask AI 引用列表显示 `subject:slug` 并通过 `?s=` 跳到精确 Subject；旧无 subjectSlug 引用保持原路径 |
| 2026-07-14 | Query Save-to-Wiki Phase 2D：保存按钮保留既有显式用户动作与 job 追踪，删除未被消费的 `onSaved(normalizeSlug(title))` 提前回调，避免同名页采用数字后缀时向客户端传播错误 slug |
| 2026-07-14 | Research 批准溯源 Phase 2C：候选弹窗改用持久化 `ResearchRunView` 与 candidate ID，批准 body 无 URL；普通关闭/显式忽略分离；Health 从 job `runId` 恢复 run、稳定幂等批准、轮询导入/验证并在终态失效 pages/lint/active jobs，subject/scope 切换清理旧 view 与 key |
| 2026-07-12 | Health 修复闭环 Phase 2A：UI 改为服务端 plan 驱动，稳定 ID 批量动作与统一 remediation API；All Subjects 只读、orphan-source 删除二次确认不变；补 active jobs 刷新恢复、hydration 安全门、subject/generation 隔离及终态 lint 闭环 |
| 2026-07-12 | Phase 1C：Health 展示 Fix / Curate 后置校验三态；`use-job-stream` 注册四个 verify 事件；新增 `postcondition-summary` 纯函数与测试，Fix 自动 lint 刷新行为不变 |
| 2026-07-11 | Wiki 审批闭环 Phase 1B：Chat 接入 pending-action SSE、会话刷新恢复、批准/拒绝 API 与可访问 diff 卡片；actionId upsert 防重，reset 口头确认状态与 Wiki 审批状态彻底分离 |
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
| 2026-06-30 | 选中正文文本悬浮追问：新增 `wiki/selection-ask-button.tsx` + `hooks/use-text-selection` + `lib/selection-text`；`ui-store` 加瞬态信箱 `pendingChatReference` + `askAboutSelection`/`consumePendingChatReference`；`chat-interface` embedded 变体消费信箱 pin 为引用 + 聚焦（并加 `prevPageSlugRef` 守卫防 StrictMode 双挂载清引用）；`wiki-reading-view` 两分支各包正文容器 ref 挂按钮。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-30-selection-ask-floating-button* |
| 2026-06-30 | Per-subject 上次页面记忆：`hooks/use-switch-subject` 改为切换边界「记录离开页 + 恢复目标页 + 选中当前 subject no-op」；消费 `lib/subject-nav` 与 `ui-store.lastPageBySubject`/`rememberPage`；`subject-switcher`/`subjects` 卡片/`subject-dialog` 调用点无需改动。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-30-per-subject-last-page-restore* |
| 2026-07-06 | Ingest 多任务支持：`global-job-tracker.tsx` 改为轮询 running+pending 聚合追踪；新增 `shared/jobs-panel.tsx`（聚合任务面板：多行、每 running 行独立 SSE、pending 行不建连接、completed 5s 自动移除、failed 常驻，行级详情复用 `JobDetailDialog`）；`progress-toast.tsx` 保留组件但不再被 tracker 直接挂载。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-06-ingest-multi-task* |
| 2026-07-06 | Settings 表单统一重设计 | 新增 `ui/{switch,segmented,select}` 原语（AugmentationField 复用 Segmented）；`settings-rows` 重写为 6 个即时保存行原语（blur/Enter 提交 + 行级 spinner/✓/错误）；七个 panel 换 Switch/分段控件、删全部 Save 按钮；`settings-dialog` 去 languageDraft。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-06-settings-form-redesign* |
| 2026-07-09 | Ask AI 表格渲染 + 引用列表折叠 | `chat/message-list.tsx` 新增 `MessageCitations` 组件（引用列表支持展开/折叠，仿 `layout/sidebar.tsx` "Sources" 分组模式，>3 条默认折叠、≤3 条默认展开，各消息独立维护本地状态）；`MarkdownText` 消费的 `renderMarkdown()`（`lib/markdown-client.ts`）接入 `remark-gfm` 后同步获得表格渲染能力。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-09-ask-ai-table-citations-collapse* |
| 2026-07-10 | History 页两栏布局：`operation-list.tsx` 重构为宽屏两栏（本地 selectedId state，选中高亮仿 settings-nav）+ 窄屏保留内联展开；`OperationDiff`/`RevertButton`/API 不动。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-10-history-two-column* |

---

_生成时间：2026-04-22 00:25:29_
