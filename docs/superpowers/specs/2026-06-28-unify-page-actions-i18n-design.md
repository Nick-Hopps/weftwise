# 设计：统一阅读页功能菜单 + 阅读页英文化

> 日期：2026-06-28
> 范围：纯前端（wiki 阅读页 UI 重组 + 中文标签英文化），无 DB / 路由 / 后端改动。

## 一、问题

wiki 阅读页当前有三个页面级功能控件，散落在三处视觉位置：

1. **Sources (N)**：阅读视图最顶部一条独立全宽 toolbar（`wiki-reading-view.tsx` 的 `toolbar`），右对齐；点击进入「正文 / 来源」两栏分屏。
2. **按画像重塑（Reshape）**：正文上方的 `LensBar` 行，带多态状态（加载中 / 已重塑可切换 / 不可用）。
3. **Edit**：标题行右侧（`FrontmatterDisplay` 内置）。

三者分散，缺乏统一入口。且 Reshape / 反馈 / HTML 来源安全提示 / 改标题联动提示等文案仍为中文，与「阅读页以英文为主」的目标不符。

## 二、目标

1. 把 **Edit / Sources / Reshape** 统一为标题行右侧的一条**并排动作条**（用户已确认形态）。
2. 阅读页所有**用户可见标签**英文化（代码注释按项目约定保持中文）。

## 三、方案

### Part 1 — 统一动作条

新增纯展示组件 `src/components/wiki/page-actions.tsx`（`'use client'`），在标题行右侧并排渲染：

- **Edit**：`<Link href={editHref}>`，Pencil 图标。
- **Sources (N)**：toggle，FileStack 图标；仅 `sourceCount > 0` 渲染；分屏开启时显示 `Hide sources`。
- **Reshape**：Sparkles 图标，**只负责触发**重塑（沿用现有 `useLens` 逻辑，仅更换 UI 容器）。

**Reshape 状态行（`headerExtra`）**：触发后在 frontmatter 与正文之间渲染一条对齐正文宽度的细状态行，与已批准的 mockup 一致：

| 状态 | 呈现 |
|------|------|
| idle（未触发） | 不渲染状态行；动作条仅显示 `Reshape` 按钮 |
| loading | `⟳ Reshaping…`（spinner） |
| reshaped 可用 | `✨ Adapted for you` 指示 + `Show original` / `Show reshaped` 切换按钮 |
| 不可用（canonical / fallback / error） | `Couldn't reshape — showing original`（subtle） |

状态判定逻辑不变：`reshapeUsable = renderedMd != null && source !== 'canonical' && source !== 'fallback'`；`usingReshaped = lensRequested && reshapeUsable && !showOriginal`。

### 接线（低耦合）

- `FrontmatterDisplay`：新增 `actions?: ReactNode` 插槽，渲染在标题行右侧，**取代**内置 Edit 按钮。移除 `editHref` prop（Edit 移入 `PageActions`），保留 `subjectSlug`（TagLink 仍用）。
- `PageRenderer`：新增 `actions?: ReactNode`（透传给 `FrontmatterDisplay`）+ `headerExtra?: ReactNode`（渲染在 `FrontmatterDisplay` 之后、正文之前，复用 `<article>` 的 reading 宽度对齐）。**移除** `editHref`（已无其它调用方：`editor-preview` 不传 title/editHref）。
- `WikiReadingView`：持有全部状态，构建 `<PageActions/>` 传 `actions`、构建状态行传 `headerExtra`；**删除**旧顶部 Sources `toolbar` 与旧 `LensBar`。
- **分屏视图**：仍是 2 列网格，但移除顶部独立 toolbar（含 `Distilled page / Ingested sources` 列标题）；Sources 切换由左列动作条承担（`Hide sources`）。右列 `SourcesPane` 的 file-tab strip 已自证是来源，无需额外列标题。
  - 已知取舍：分屏模式下动作条位于左列可滚动区顶部，向下滚动会与正文一起滚走（`Hide sources` 需滚回顶部）。可接受，作为后续可选改进。

### Part 2 — 阅读页英文化

仅改用户可见标签，注释保持中文。

| 文件 | 中文 → 英文 |
|------|-------------|
| `wiki-reading-view.tsx`（LensBar 文案并入 PageActions / 状态行） | 原文（idle 不再单独显示）；按画像重塑 → `Reshape`；正在按你的画像调整… → `Reshaping…`；已按你的画像调整 → `Adapted for you`；看重塑版 → `Show reshaped`；看原文 → `Show original`；暂时无法按画像调整，已显示原文 → `Couldn't reshape — showing original` |
| `lens-feedback.tsx` | 这页的讲法对你合适吗？→ `Is this explanation a good fit?`；太难 → `Too hard`；太浅 → `Too easy`；已记录「{sent}」，将调整后续呈现 → `Logged "{sent}" — we'll tune future pages`（`sent` 改存英文 `too hard` / `too easy`） |
| `html-source-frame.tsx` | 检测到潜在危险脚本，已禁用页面交互 → `Potentially unsafe scripts detected — interactivity disabled`；我了解风险，仍然运行脚本 → `I understand the risk — run scripts anyway` |
| `page-editor.tsx`（写入 retitle banner 字符串，经 sessionStorage 在阅读页 `retitle-notice` 显示） | 已同步更新 N 处引用到新标题 → `Updated N reference(s) to the new title` |

**out of scope**（除非另行要求）：聊天、设置、`cognitive-lens-onboarding` 首启向导等其它页面的中文文案。

## 四、组件边界

- `PageActions`：输入 = `editHref`、`sourceCount`、`splitOn`、`onToggleSplit`、reshape 触发态与回调；输出 = 标题行动作条 JSX。无数据请求、无 hooks（除受控 props）。
- reshape 状态行：可作为 `PageActions` 同文件的子组件 `ReshapeStatus`，输入 = `requested`/`loading`/`reshapeUsable`/`showOriginal` + `onToggle`，输出 = 细状态行 JSX。
- `WikiReadingView` 继续作为状态容器（split / lens 状态、数据 fetch），仅改「如何摆放控件」，不改状态机。

## 五、测试与验证

- 组件无既有单测（项目现状）。以 `tsc --noEmit` 把关类型为权威；必要时 Playwright 手测：
  1. 普通阅读页：动作条三按钮就位，Edit 跳转、Sources 进分屏、Reshape 三态。
  2. 分屏视图：Sources 变 `Hide sources`，正文/来源两栏正常。
  3. 无来源页：动作条仅 Edit + Reshape（无 Sources）。
  4. 改标题保存后：阅读页 retitle banner 显示英文。
- 全文搜索确认阅读页相关组件无残留 CJK **标签**（注释除外）。

## 六、影响文件清单

- 新增：`src/components/wiki/page-actions.tsx`
- 改：`src/components/wiki/wiki-reading-view.tsx`、`frontmatter-display.tsx`、`page-renderer.tsx`、`lens-feedback.tsx`、`html-source-frame.tsx`、`page-editor.tsx`
- 文档：`src/components/CLAUDE.md` 变更记录追加一行；根 `CLAUDE.md` 变更记录追加一行。
