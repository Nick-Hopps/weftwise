# History 页两栏布局 — 设计

日期：2026-07-10

## 需求

History 页（`(app)/history`）从「单列列表 + 点行内联展开 diff」改为两栏布局：左栏为操作记录列表，右栏展示选中记录的 diff 与回滚按钮。

## 范围

纯前端改动，只重构 `src/components/history/operation-list.tsx`；`OperationDiff`、`RevertButton`、`/api/history*` 路由、后端逻辑一律不动。

## 设计

### 布局（宽屏，`md` 及以上）

- 页面容器改全高两栏 flex（去掉现有 `max-w-4xl` 居中收窄）：
  - **左栏**：固定宽 `w-80`，独立滚动（`overflow-y-auto`）。头部保留现有标题/说明，下方为记录列表。
  - **右栏**：`flex-1`，独立滚动，展示选中记录详情。
- 左栏行为紧凑按钮：类型 Tag + 受影响页 slug（截断，最多 5 个 + `+N`）+ 时间 + 「已回滚」标记。选中行高亮 `bg-accent-subtle` + `aria-current="true"`（仿 `settings-nav.tsx` 选中模式）。
- 右栏结构：
  1. 摘要头：类型 Tag、时间、全部受影响页列表、回滚状态；
  2. `<OperationDiff operationId={selected.id} />`；
  3. `<RevertButton entry={selected} />`。

### 选中状态

- 本地 `useState<string | null>(null)` 存选中 operation id；初始 `null` → 右栏空态提示 "Select an operation to view its diff"。
- 回滚成功后（RevertButton 内部已 invalidate `['history']`）选中 id 保留，条目刷新为「已回滚」态。
- 若选中 id 在刷新后不存在于列表（如被 GC），右栏回落空态。

### 响应式（`md` 以下）

- 退化为现有单列内联展开交互：同一份 query 数据渲染两套结构——
  - `<div className="hidden md:flex">` 两栏版；
  - `<ul className="md:hidden">` 现有 `Row`（内联展开 `OperationDiff` + `RevertButton`）。
- 数据 query（React Query `['history', subjectId]`）保持一份。

### 不做

- URL 参数同步选中项；
- 键盘导航；
- diff 渲染逻辑改动；
- 后端/API 改动。

## 测试

- 组件无既有测试，本次不新增（纯布局重排，逻辑复用既有组件）；
- 验证方式：`tsc --noEmit` + Playwright 手动走查（宽屏两栏选中/空态/回滚，窄屏内联展开）。
