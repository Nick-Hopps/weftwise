# 右下角任务进度窗口可收起到屏幕边缘 — 设计

> 日期：2026-06-23
> 状态：已设计，待实现

## 一、背景与问题

右下角的「job runner 窗口」是 `src/components/shared/progress-toast.tsx`（`ProgressToast`），固定在 `fixed bottom-4 right-4`，宽 `w-80`（320px）。它在 `GlobalJobTracker` 中**只挂载一次**，整个会话存活，`jobId` 变化时通过 `useEffect([jobId])` 切换可见性。

当前痛点：

- 卡片只有在任务**结束**（`status === 'completed' | 'failed'`，即 `isFinished`）时才显示关闭按钮（X）。任务**运行中**没有任何收起 / 关闭手段，长任务期间一直停在右下角，遮住界面、影响交互。
- 顶栏现已有 `IngestPill`（后台 ingest 进度 pill，点击进 `/ingest`），运行中右下角 toast 与之部分重复，更显多余。

目标：让该进度窗口支持**收起到屏幕右缘**，留一个小把手；点把手即可重新展开。避免遮挡，且不丢失进度可见性。

## 二、范围

- **改动文件**：仅 `src/components/shared/progress-toast.tsx`。
- **不涉及**：API、Zustand store、server、`GlobalJobTracker` 取数 / 自动清除逻辑、`IngestPill`。
- **适用对象**：toast 是通用组件（`detectJobType` 支持 ingest / lint / 其它），收起能力对所有经它展示的任务一视同仁。

## 三、形态（用户已选：贴右缘的小把手）

```
展开态（默认）                         收起态
┌──────────────────────┐
│ ⟳ Ingesting      › ✕ │                ┃⟳┃ ← 贴右缘竖向把手
│ Writing page 3/8…    │                ┃76┃   （状态图标叠百分比）
│ ▓▓▓▓▓▓▓░░░ 76%       │                ┃%┃
│ docs/foo.md          │
└──────────────────────┘
```

- **展开态**：沿用今天的卡片，**新增收起 chevron**（`ChevronRight`，lucide-react）置于头部。该 chevron **运行中与结束后都显示**（区别于今天只在结束时出现的 X）。结束态头部仍同时显示既有的关闭 X。
- **收起态**：卡片向右滑出屏幕（`translate-x-[calc(100%+1rem)] opacity-0`，复用现有 `transition-all duration-base ease-standard` 过渡），其位置由一个**贴右缘的窄竖向把手**占据：状态图标（运行中 `Loader2` 转圈 / 完成 `Check` / 失败 `X`，沿用 `StatusIcon` 语义与颜色 token）叠加百分比文本。把手是真实 `<button>`，点击展开。

## 四、状态与生命周期

- 新增**本地组件 state** `const [collapsed, setCollapsed] = useState(false)`。
  - 理由：`ProgressToast` 全会话只挂载一次，本地 state 天然在连续任务间存活；整页刷新回到展开态即可。**不引入 Zustand 迁移**（YAGNI）。
- 收起是**纯展示**行为：
  - 既有关闭（X，仅结束态）与 `GlobalJobTracker` 的 `onClose` → 自动清除流程**完全不变**。
  - 结束态且处于收起时，把手呈完成 / 失败着色；点击展开后即可看到关闭按钮。**不新增任何自动消失计时器**，行为可预测。
- **新 jobId 到达时重置** `collapsed = false`：在现有 `useEffect([jobId])` 内（`if (jobId) { … }` 分支）加 `setCollapsed(false)`，保证新任务默认可见，之后用户可再收起。

## 五、结构与实现要点

- 外层包一个 `fixed bottom-4 right-4 z-sheet` 的**定位容器**，内含两个兄弟：
  1. 现有卡片 `<div role="status" aria-live="polite">`（移除其自身的 `fixed bottom-4 right-4`，由容器定位；保留宽度/边框/圆角/阴影与状态边框色），按 `collapsed` 切换 `translate-x` / `opacity`。
  2. 把手 `<button>`，绝对定位于容器右缘，仅 `collapsed` 时可见 / 可交互（收起态用 `opacity-100 pointer-events-auto`，展开态 `opacity-0 pointer-events-none`，配合过渡）。
- **可访问性**：
  - chevron 与把手均为真实 `<button>`，带 `aria-label`（如「Collapse progress」/「Expand progress」）与 `focus-ring`。
  - `role="status"` / `aria-live="polite"` 保留在常驻容器（或卡片）上，收起时屏幕阅读器仍能收到更新播报。
- **样式**：颜色全部沿用既有 CSS 变量 token（`bg-surface`、`border`、`text-accent`、`text-success`、`text-danger`、`text-foreground-*`）；阴影、`z-sheet`、进出场过渡时长（`duration-base ease-standard`）不变。
- 复用既有 `StatusIcon`（把手内可直接渲染 `<StatusIcon status={status} />`）与 `progressValue` 计算（把手百分比文本取 `progressValue`，为 `null` 时不显示百分比或显示占位）。

## 六、验收标准

1. 任务运行中，头部出现收起 chevron；点击后卡片滑出右缘、仅留竖向把手；点把手卡片滑回。
2. 收起态把手正确反映状态：运行中转圈 + 百分比；完成显示 ✓；失败显示红色 ✕ 色。
3. 任务结束态：展开时仍可见关闭 X 并能正常关闭（沿用旧逻辑）；收起时把手着色正确，点开后能关闭。
4. 新任务开始（`jobId` 变化）时自动回到展开态。
5. 收起 / 展开均有平滑过渡，无布局抖动；不遮挡右下角以外区域。
6. 键盘可达：chevron 与把手可 Tab 聚焦、Enter/Space 触发，带可见 focus ring。
7. 不改动任何 API / store / `GlobalJobTracker` 行为；`npm run lint` 通过。

## 七、非目标（YAGNI）

- 不持久化收起偏好到 Zustand / 跨刷新记忆。
- 不做拖拽移动、不可吸附到其它边、不做多任务堆叠。
- 不改顶栏 `IngestPill`，不去重两个进度指示器（两者职责不同，本次只让 toast 可让位）。
- 收起态不新增自动消失 / 自动展开计时逻辑。
