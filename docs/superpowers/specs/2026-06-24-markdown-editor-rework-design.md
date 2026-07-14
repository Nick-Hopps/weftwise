# 在线 Markdown 编辑器重做 — 设计

> 日期：2026-06-24
> 状态：已完成（2026-06-24）
> 实现证据：`9916ce2`（全高布局与阅读页渲染管线）、`3db8b42`（标题映射）、`4e16677`（工具栏与字号）、`eebc4cd`（文档收口）

## 一、背景与问题

阅读页的 Edit 入口进入 `(app)/wiki/edit/[...slug]`，由 `src/components/wiki/page-editor.tsx` 承载，内部用 `src/components/wiki/md-editor.tsx`（`@uiw/react-md-editor` 的 `dynamic(ssr:false)` 封装）编辑整文件 raw markdown。当前实现有三个体验问题：

1. **尺寸太小**：`page-editor.tsx` 把编辑器裹在 `max-w-content mx-auto px-6 py-6`（居中收窄），且 `md-editor.tsx` 写死 `height={520}`。结果编辑器又窄又矮，两侧大量留白。
2. **预览与实际页面不一致**：编辑器走 `@uiw/react-md-editor` 自带的 `@uiw/react-markdown-preview`（原版 react-markdown），**完全没接**项目的渲染管线：
   - 没有 wikilink / callout / mermaid / 数学公式渲染；
   - 不识别 YAML frontmatter，把 `---` 块当**纯文本**直接显示；
   - 排版（字号/间距/颜色）与阅读页不同。
   而真实阅读页走 `src/lib/markdown-client.ts::renderMarkdown` + `page-renderer.tsx` 的 `proseClassName`，且会把 frontmatter 拆出来交给 `FrontmatterDisplay` 渲染成卡片。
3. **工具栏太小**：`@uiw/react-md-editor` 默认工具栏按钮/图标尺寸偏小，可用性差。

## 二、目标与决策

- **目标 1 — 全宽全高分屏**：编辑器占满主内容区（横向铺满、纵向撑满视口），左右约 50/50 编辑 + 预览。
- **目标 2 — 预览仅正文一致**：预览正文与阅读页**逐像素一致**（wikilink/callout/mermaid/数学公式/排版），但**不渲染 frontmatter 头部卡片**，预览从正文开始。
- **目标 3 — 工具栏增大**：放大工具栏按钮与图标，提升可用性。

> 经与用户确认：布局取「全宽全高分屏」；预览一致性取「仅正文一致」（不渲染 frontmatter 头部）。

## 三、关键技术事实（已核实）

- `@uiw/react-md-editor` 的 `MDEditorProps.components.preview?: (source, state, dispatch) => JSX.Element` 可**完全替换**预览面板，且在 `preview="live"` 下生效。（见 `node_modules/@uiw/react-md-editor/lib/Types.d.ts:107`）
- `MDEditorProps.height` 接受 `CSSProperties['height']`，可传 `"100%"`（注意：百分比高度下内置 Dragbar 失效，可接受）。
- `renderMarkdown`（`src/lib/markdown-client.ts`）的管线包含 `remarkFrontmatter(['yaml'])`，会把 frontmatter 解析成 yaml 节点且**不产出 hast 输出**，因此 `---` 块会被**自动从渲染结果剥离**——这正是自带预览（不带 remarkFrontmatter）显示成纯文本、而本管线不会的根因。
- `PageRenderer`（`src/components/wiki/page-renderer.tsx`）仅在传入 `title` 时才渲染 `FrontmatterDisplay`（`{title && <FrontmatterDisplay .../>}`）。因此**不传 `title`** 即可只渲染正文。
- 阅读页（`src/app/(app)/wiki/[...slug]/page.tsx`）的 `titleSlugMap` 构建逻辑：遍历 `pagesRepo.getAllPages(subjectId)`，写入 `map[title]=slug` 与 `map[title.toLowerCase()]=slug`。客户端可用 `GET /api/pages` 等价复刻。
- 布局高度链：`Shell` 为 `flex flex-col h-screen` → 行容器 `flex flex-1` → `main` 为 `flex-1 overflow-y-auto`，因此 `main` 有确定高度。编辑页根容器用 `h-full flex flex-col` 即可撑满。`ErrorBoundary` 透传 children，不破坏高度链。
- 数学公式 CSS（KaTeX）已随阅读页全局加载（阅读页数学渲染为既有功能），预览复用同一管线即可，无需额外引入。

## 四、改动清单

| 文件 | 改动 |
|------|------|
| `src/components/wiki/page-editor.tsx` | 根容器改全高布局；新增 `titleSlugMap` 拉取；把预览渲染器与 `titleSlugMap`/`slug` 传给 `MdEditor`；loading/error 骨架改全高版 |
| `src/components/wiki/md-editor.tsx` | `height={520}` → `height="100%"`，外层 `h-full`；新增 `previewRenderer?` prop 接到 `components.preview`；wrapper 加类名 `wiki-md-editor` |
| `src/components/wiki/editor-preview.tsx`（新增） | 预览渲染组件：`(source, titleSlugMap, slug) → <PageRenderer content={source} slug={slug} titleSlugMap={titleSlugMap} />`（不传 `title`） |
| `src/app/globals.css` | `.wiki-md-editor` 作用域内放大工具栏（内边距/高度/按钮命中区/SVG 图标 ~12px→~18px）+ 适度调大编辑区 textarea 字号/行高 |

## 五、详细设计

### ① 全宽全高分屏

- `page-editor.tsx` 根容器：`max-w-content mx-auto px-6 py-6 w-full space-y-4` → `flex flex-col h-full`（撑满 `main`，去掉居中收窄）。
- 顶部 `Editing / Cancel / Save` 工具条改为 `shrink-0` 的细横条（带下边框、左右内边距），不再用大块 `space-y`。
- 错误条（`errorText`）保留，置于工具条下方、`shrink-0`。
- 编辑区容器 `flex-1 min-h-0 overflow-hidden`，内嵌 `MdEditor`。
- `md-editor.tsx`：`height` 默认改 `"100%"`，外层包裹 `<div className="wiki-md-editor h-full" data-color-mode=...>`，让 MDEditor 撑满父高，左右默认约 50/50。
- loading/error 状态骨架同步改成全高版本（撑满 `h-full`，不再 `max-w-content`）。

### ② 预览仅正文一致

新增 `editor-preview.tsx`：

```tsx
'use client';
import PageRenderer from './page-renderer';

export function EditorPreview({
  source, titleSlugMap, slug,
}: { source: string; titleSlugMap?: Record<string, string>; slug: string }) {
  // 不传 title → PageRenderer 跳过 FrontmatterDisplay，仅渲染正文。
  // renderMarkdown 的 remarkFrontmatter 会自动剥离 `---` frontmatter 块。
  return <PageRenderer content={source} slug={slug} titleSlugMap={titleSlugMap} />;
}
```

- `md-editor.tsx` 新增 `previewRenderer?: (source: string) => React.ReactNode`，接到 `components={{ preview: (source) => previewRenderer(source) }}`；保持 `preview="live"` 实时分屏。
- `page-editor.tsx` 用 React Query `['pages', subjectId]` 拉 `GET /api/pages`，构建 `titleSlugMap`（`{title→slug, title.toLowerCase()→slug}`），并把 `(source) => <EditorPreview source={source} titleSlugMap=… slug=… />` 作为 `previewRenderer` 传入。
  - `titleSlugMap` 查询独立于已有的 `['page-detail', subjectId, slug]`，`enabled: !!subjectId`；缺失时优雅降级（wikilink 走 `normalizeSlug` 兜底，仍渲染为链接）。

### ③ 工具栏增大

- `md-editor.tsx` wrapper 加类名 `wiki-md-editor`。
- `globals.css` 作用域 CSS（示意，最终值实现时微调）：
  - `.wiki-md-editor .w-md-editor-toolbar`：增大内边距与高度；
  - `.wiki-md-editor .w-md-editor-toolbar ul > li > button`：增大命中区与圆角；
  - `.wiki-md-editor .w-md-editor-toolbar svg`：图标尺寸 ~12px → ~18px；
  - `.wiki-md-editor .w-md-editor-text-input, .wiki-md-editor textarea`：适度调大字号/行高。
  - 暗色模式继续走已有 `data-color-mode`（由 `useUIStore.darkMode` 驱动），不另写颜色覆盖。

## 六、已知取舍 / 不做（YAGNI）

- **滚动联动**：自定义预览后，MDEditor 内置的左右滚动逐行同步不再生效（两侧仍可各自滚动）。视觉一致优先，符合需求；后续如需再补。
- **实时预览防抖**：每次按键同步执行 `renderMarkdown` 的 `processSync`（与既有阅读页/自带预览同量级），暂不加防抖；大文档若出现卡顿再作为后续优化。
- **不渲染 frontmatter 头部卡片**：按"仅正文一致"决策，预览不复刻 `FrontmatterDisplay`。

## 七、验证

- `tsc --noEmit` 通过（项目 `npm run lint` 不可用，以 tsc 为准）。
- 手动（Playwright/浏览器）核对：
  1. 编辑页编辑器横向铺满主内容区、纵向撑满视口；
  2. 预览面板正文与同一页阅读页逐项一致（wikilink 可点、callout 配色、mermaid 出图、数学公式排版、标题/列表/代码块样式），且 frontmatter `---` 块不出现在预览中；
  3. 工具栏按钮/图标明显增大、可正常点击；
  4. 明暗主题切换下编辑器与预览均正确。
