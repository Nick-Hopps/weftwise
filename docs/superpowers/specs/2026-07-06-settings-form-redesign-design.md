# Settings 表单组件统一重设计 — 设计文档

日期：2026-07-06
状态：已确认（Nick 三项决策：全部即时自动保存 / Switch+分段控件 / 范围仅 Settings 弹窗）

## 背景与问题

Settings 弹窗（两栏式，7 个 panel）的表单控件当前不统一：

1. **样式碎片化**：`settings-rows.tsx` 三个行原语各自内联 select/input 样式；`CognitiveLensPanel` 又手写另一套 `border-border bg-canvas` 的 select/textarea；同一弹窗内至少三种视觉风格。
2. **交互模型不一致**：数字/文本行逐行 Save 按钮，下拉即时保存，Cognitive Lens 面板底部整体 Save——三种保存模式并存。
3. **控件形态不当**：布尔项（Auto-curate、Periodic maintenance）用 on/off 下拉模拟开关；3 档枚举（阅读水平等）用下拉而非分段控件。
4. **错误提示重复**：每个 panel 底部各自复制一段 `savePartial.isError` 展示。

## 目标

Settings 弹窗内所有设置项：即时自动保存、无 Save 按钮、控件形态与语义匹配、样式收敛到设计系统原语、错误反馈下沉到行级。

## 非目标

- 不改弹窗容器 / 两栏导航 / `settings-categories`。
- 不改 `/api/settings`、`/api/profile` 数据流与「`app_settings` 服务端唯一真实源、不写 Zustand」原则。
- 不动 SubjectDialog、Cognitive Lens onboarding 等其他表单（后续可逐步迁移到新原语）。

## 设计

### 1. 新增设计系统原语（`src/components/ui/`）

均无业务知识，Tailwind + CSS 变量 + `cn()`：

- **`switch.tsx`** — `Switch({ checked, onCheckedChange, disabled, 'aria-label' })`。`<button role="switch" aria-checked>`，轨道+滑块，选中 `bg-accent`，未选 `bg-border-strong`，focus ring 与现有 input 一致，disabled 半透明。
- **`segmented.tsx`** — `Segmented<T extends string>({ value, options: {value,label}[], onChange, disabled })`。从 `subjects/augmentation-field.tsx` 的分段样式抽取为通用原语（`radiogroup`/`radio` aria 语义）；`AugmentationField` 改为内部复用 `Segmented`，对外接口不变。
- **`select.tsx`** — `Select` 统一样式的原生 `<select>` 封装，token 与 `ui/input.tsx` 对齐（`h-7 border-input-border bg-input-bg` + hover/focus/disabled 态），支持 `className` 覆盖宽度。

### 2. 重构 `layout/settings-rows.tsx`

统一布局骨架 `SettingRow`（标签+可选描述在左、控件在右、`items-start` 可选）保留；新行原语全部即时保存：

- **`SwitchRow`** — 布尔项；切换即调 `onSave(boolean)`。
- **`SegmentedRow<T>`** — ≤4 项枚举；点击即保存。
- **`SelectRow<T>`** — 长枚举；change 即保存。
- **`NumberRow`** — 本地 draft；**blur 或 Enter 提交**；min/max/整数校验，非法值红框 + 不提交，blur 后回滚到服务端值。
- **`TextRow`** — 同 NumberRow 交互，支持 `type: 'text' | 'password'` 与 placeholder；值未变不提交。
- **`TextareaRow`** — 多行文本（Cognitive Lens background），blur 提交，样式与 input 同 token。

**行级保存状态**：每行右侧（控件旁）渲染状态标记——mutation pending 时小 spinner、成功后 ✓ 短暂显示（~1.5s 后淡出）、失败时行下方红色 `role="alert"` 错误文本。实现为行原语内部的 `SaveIndicator` 小组件，状态经 props `{ pending, error }` 传入（由 panel 层的 mutation 提供）；「成功短显 ✓」由行内 effect 监听 pending 从 true→false 且无 error 触发。删除旧的 `NumberSettingRow/TextSettingRow/SelectSettingRow`（及其 Save 按钮）。

注意：`savePartial` 是 panel 级单一 mutation，pending 为全 panel 共享——为避免改一行全 panel 转 spinner，行原语在本地记录「本行是否发起了最近一次保存」（onSave 时置位、pending 结束后消费），只有发起行显示状态。

### 3. Panel 层改造（`layout/settings-content.tsx`）

- **Appearance**：Dark mode 改 `SwitchRow`（写 Zustand，无 pending）；Sidebar width 保留 Reset 按钮行。
- **Language**：`SelectRow` 即时保存；保留「自定义已存值补入选项」逻辑；删 Save 按钮。
- **Cognitive Lens**：四个偏好改 `SegmentedRow`（3 档）；Background 改 `TextareaRow` blur 保存；删底部整体 Save；每次变更即 `useUpdateProfile().mutate`（合并当前 prefs+bg 整体提交，与现有 PUT 语义一致）。
- **Agents**：max steps / token budget / parallel sub-agents 改 `NumberRow`；LLM selection mode 改 `SegmentedRow`（2 项）；Auto-curate 改 `SwitchRow`。
- **Web search**：Provider 目前仅 Tavily——改为 `SettingRow` 只读展示文本 "Tavily"（未来多供应商时再换回 SelectRow）；API key 改 `TextRow`（password，blur 保存，空=禁用）；Max results 改 `NumberRow`。
- **Maintenance**：Periodic maintenance 改 `SwitchRow`（描述文案承载原下拉里的说明）；Status 只读行不变；两个数字项改 `NumberRow`。
- **About**：不变。
- 删除各 panel 底部重复的 `savePartial.isError` 段落（错误已行级化）。

### 4. 错误与竞态处理

- 保存失败：行级红色错误 + 控件回滚到服务端最新值（React Query mutation onError 后 settings query 仍是旧值，受控控件自然回显）。
- 数字非法输入：不发请求，红框提示 `Must be an integer between {min} and {max}`，blur 回滚。
- 快速连续切换（如连点 Switch）：沿用现有 mutation 顺序提交即可，PUT 幂等、以最后一次为准，不做防抖。

## 测试与验证

- `tsc --noEmit` 通过。
- vitest：如抽出可测纯逻辑（数字校验函数）补少量单测；现有测试全绿。
- Playwright 手动走查：7 个 panel 明/暗主题、Switch/分段/数字 blur 保存、非法数字回滚、断网失败提示。

## 涉及文件

新增：`ui/switch.tsx`、`ui/segmented.tsx`、`ui/select.tsx`
重写：`layout/settings-rows.tsx`
修改：`layout/settings-content.tsx`、`subjects/augmentation-field.tsx`（内部复用 Segmented）
文档：`src/components/CLAUDE.md` 同步
