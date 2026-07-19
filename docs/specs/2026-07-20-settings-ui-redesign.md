# 设置界面视觉重设计

日期：2026-07-20
状态：已定稿
关联 plan：`docs/plans/2026-07-20-settings-ui-redesign.md`

## 背景与现状问题

2026-07-16 将设置一级入口从 8 项收敛为 General / Personalization / Automation / Usage 四组后，信息架构已合理，但内容区的**视觉组织**没有跟上，整体观感依然混乱。逐分类截图诊断如下：

1. **标题层级颠倒**。内容区有三层标题：分类页头（`text-base`）→ section 标题（`text-xs`）→ 行标签（`text-sm`）。section 标题比它管辖的行标签还小，视觉上读不出「组」的存在；General 页「通用 → 界面 → 界面语言」三层文案高度重复。
2. **行与组没有边界**。section 之间仅靠一条 `border-t` 细线区分，行之间靠 `space-y-4` 漂浮排列。General 页只有 2 行却拆 2 个 section，大片留白；Automation 页 15 行连续滚动，扫读时无法定位。
3. **控件区参差**。数字框 `w-24`、密码框 `w-44`、textarea `w-60`、select / segmented 自适应，右缘对齐但左缘错落；保存指示器（spinner/✓）固定占位在**控件左侧**，未保存时表现为一块无意义的空隙。
4. **Usage 页控件语义分裂**。项目筛选复用「设置行」原语（带 label + description，看起来像一个会持久化的设置项），时间窗口却是裸 `Segmented`，两个筛选器不像一组；「用量 → LLM 用量 → 项目」同样三层冗余。表格无容器，总计行与数据行区分弱。

## 目标

- 一眼能读出「分类 → 组 → 行」三层结构，扫读可定位。
- 四个分类的密度观感均衡：General 不空旷，Automation 不糊成一屏。
- 控件、保存状态、错误提示的位置全部规范化。
- 不改变信息架构（四个一级入口不动）、不改变数据流（行级即时保存、`/api/settings` 契约、不写 Zustand）。

## 非目标

- 不新增/删除任何设置项，不改 API。
- 不把弹窗改成独立页面。
- 不做设置搜索（YAGNI，条目总量 < 30）。

## 方案对比

### 方案 A：卡片分组 + 层级修正（推荐）

保持四分类导航，重构内容区为「section 小标签 + 边框卡片」模式（Vercel / Linear 设置页的成熟范式）：

- 每个 section = uppercase 小标签（复用全站 `SectionLabel` 原语风格）+ 可选描述 + `rounded-lg border` 卡片；卡片内行由 `divide-y` 分隔，行 `px-4 py-3`。
- 行标签 `text-sm font-medium` 成为卡片内最强元素，层级恢复为：页头 > 行标签 > section 标签（标签性质，不参与竞争）。
- 保存指示器移到**行标签右侧**行内显示，控件区不再预留占位。
- 控件宽度规范：数字框 `w-24`、文本/密码框 `w-56`、select `min-w-36`；textarea 改为行内上下布局全宽。
- General 合并「界面 + 内容语言」为单一「语言」section（一卡两行），消除 2 行拆 2 组的空旷。
- Usage 的筛选收敛为表格卡片上方的一行工具栏（时间 segmented 在左、项目 select 在右），表格进卡片、表头加底色、总计行强调。

**取舍**：改动集中在 `settings-rows.tsx` / `settings-content.tsx`，风险低；卡片模式与站内 `Panel` 原语一致，不引入新设计语言。缺点是纵向空间略增（卡片 padding），Automation 页滚动变长一点——但扫读定位能力换这点滚动是值得的。

### 方案 B：Automation 拆二级导航

把 Automation 下三个 section 拆回独立入口或组内 tab。**否**：7-16 刚把 8 项收敛为 4 项，拆回去是粒度回摆；且 General/Usage 的混乱与导航粒度无关，治标不治本。

### 方案 C：弹窗改独立设置页（单页滚动 + 锚点）

信息容量大，但改动面大（路由、面包屑、移动端），且当前条目量撑不起一个页面。**否**，YAGNI。

**结论：方案 A。**

## 方案 A 详细设计

### Section 骨架（settings-content）

```tsx
<section>
  <SectionLabel>智能体行为</SectionLabel>        // text-xs uppercase tracking-wider tertiary
  <p>…可选组描述…</p>                             // text-xs tertiary，仅需要时
  <div className="rounded-lg border border-border bg-surface divide-y divide-border">
    <Row … /> <Row … /> …
  </div>
</section>
```

- section 之间 `space-y-6`；分类页头保留（`text-base font-semibold` + 描述），但 General 页头描述与组描述不再重复语言字样。
- 组级说明文字（如联网依据的用途说明、认知透镜的机制说明）从卡片内第一行移到 section 标签下方，卡片里只放可操作行。

### 行原语（settings-rows）

- `SettingRow`：改为 `px-4 py-3`（padding 由行自持，卡片容器 `divide-y` 分隔）；label 行内追加 `SaveIndicator`（spinner / ✓ 1.5s 淡出），控件区删除占位 `w-4`。
- 错误文案仍在行内下方（红色 `text-xs`），归属明确。
- `NumberRow w-24` / `TextRow w-56` / `SelectRow min-w-36`：右缘对齐、左缘按控件类型统一。
- `TextareaRow`：改为上下布局——label + 描述在上，textarea `w-full` 在下（背景自由文本需要宽度）。
- `MultiSelectRow` 弹出列表样式不变，仅对齐新行 padding。

### 各分类布局

| 分类 | Section（卡片） | 备注 |
|------|----------------|------|
| 通用 | 语言（界面语言 + Wiki 内容语言） | 两个 section 合一；`SETTINGS_SECTIONS.general` 收敛为 `['language']` |
| 个性化 | 认知透镜（4 个 segmented 行 + 背景 textarea 行） | 机制说明移到组描述 |
| 自动化 | 智能体行为（6 行）／联网依据（3 行）／定期维护（5 行） | 联网说明移到组描述；「提供方 Tavily」静态行与 API key 合并展示（provider 作为 API key 行描述的一部分，减一行） |
| 用量 | 工具栏（时间 segmented + 项目 select）+ 表格卡片 | 项目筛选不再用 SelectRow 设置行原语；表头 `bg-subtle`，总计行 `border-t bg-subtle/50`；保留数据保留说明脚注 |

### i18n

- 新增：`settings.section.language`（通用·语言）、各组描述 key（认知透镜/联网依据描述迁移复用现有 key，不新增语义）。
- 删除：`settings.section.appearance` / `settings.section.contentLanguage`（合并后不再使用）。
- `settings.web.provider*` 相关文案并入 API key 行描述。

### 测试影响

- `settings-categories.test.ts`：`SETTINGS_SECTIONS.general` 变更需同步。
- `settings-content.test.ts`：断言 Interface language / Wiki language 仍成立；补一条「Usage 项目筛选不渲染设置行描述」或卡片结构断言。
- `settings-validation` / repos 不受影响。

## 成功标准

- tsc + vitest 全绿。
- Playwright 逐分类截图：三层层级清晰、卡片分组可辨、控件右缘统一、保存指示不再在控件左侧留洞。
- 中英两个 locale 下文案完整无缺 key。
