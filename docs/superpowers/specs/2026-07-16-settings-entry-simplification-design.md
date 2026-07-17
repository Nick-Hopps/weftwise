# 设置入口精简与体验优化设计

日期：2026-07-16
状态：已确认

## 背景

当前 Settings 弹窗把 Appearance、Language、Cognitive Lens、Agents、Web search、Maintenance、Usage、About 共 8 项并列为一级入口。分类粒度不一致：Language 与 About 内容很少，Agents、Web search、Maintenance 又都属于高级运行配置。用户需要先理解产品内部模块，才能判断应进入哪个入口。

## 目标与成功标准

- 一级入口由 8 个压缩为 4 个，并按用户任务命名。
- 默认页覆盖最常用的外观与内容语言设置。
- 高级自动化配置集中收纳，但不折叠或隐藏现有能力。
- About 不再占用一级入口，版本信息移到导航底部。
- 桌面端保持稳定两栏；移动端不再保留狭窄侧栏，改为顶部横向分类导航。
- 所有设置的数据源、即时保存、校验和错误反馈保持不变。

## 方案对比

### 方案 A：只调整现有 8 项的排序与样式

改动最小，但没有减少入口数量，也没有修复分类粒度不一致。用户仍需在多个单项入口之间跳转。

### 方案 B：4 个任务分组 + 组内分区（推荐）

一级入口调整为 General、Personalization、Automation、Usage；原有 panel 作为组内 section 呈现。入口减少一半，现有能力完整保留，改动集中在客户端信息架构与布局。

### 方案 C：单页设置 + 搜索

入口最少，但需要新增搜索、锚点与结果定位机制；当前设置总量不足以支撑这套复杂度，移动端长页面也更难扫描。

采用方案 B。

## 信息架构

| 一级入口 | 组内分区 | 原分类 |
|---|---|---|
| General | Appearance、Content language | Appearance、Language |
| Personalization | Cognitive Lens | Cognitive Lens |
| Automation | Agent behavior、Web grounding、Periodic maintenance | Agents、Web search、Maintenance |
| Usage | LLM usage | Usage |

About 从内容 panel 移到导航底部，仅展示 `weftwise` 与版本号。

## 视觉与交互

### 视觉命题

像系统偏好设置一样克制、清晰、可快速扫描：低噪声表面、清楚的分区标题、少量强调色，不使用设置卡片网格。

### 内容计划

- 顶栏：Settings 标题与关闭按钮。
- 导航：4 个一级入口；桌面为左侧竖向列表，移动端为标题下方横向列表。
- 内容：当前入口标题、简短范围说明、一个或多个由分隔线组织的 section。
- 辅助信息：桌面导航底部显示产品名和版本；移动端显示在 General 页末尾。

### 交互命题

- 分类切换时内容做短距离淡入，不移动弹窗外框。
- 即时保存继续使用现有 spinner / check / error 行级反馈。
- 移动端分类导航可横向滚动，活动项始终以底线和强调色识别。

## 组件设计

### `settings-categories.ts`

- `CategoryId` 改为 `general | personalization | automation | usage`。
- 分类元数据增加简短 `description`。
- 导出 `SETTINGS_SECTIONS`，显式定义每个一级入口包含的 section，作为导航与内容映射的单一来源。

### `settings-nav.tsx`

- 桌面端：宽度约 200px 的竖向导航，活动项使用低对比背景和强调色。
- 移动端：`md` 以下切换为横向 tab list，隐藏图标说明和底部版本块。
- 底部显示应用名与版本，不再提供 About 入口。

### `settings-content.tsx`

- 用 section 标题与分隔线组合原有 panel，不使用嵌套卡片。
- General 同页展示 Appearance 与 Content language。
- Automation 同页展示 Agent behavior、Web grounding、Periodic maintenance。
- Personalization 与 Usage 各保留一个聚焦 section。
- 移动端 General 页末尾补充应用版本。

### `settings-dialog.tsx`

- 桌面端适度加宽，为 Automation 的分段控件和说明留出空间。
- 移动端使用近全屏高度，主体改为纵向结构，避免左侧栏挤压内容。
- 数据请求和 mutation 所有权保持不变。

## 非目标

- 不修改 `/api/settings`、`/api/profile` 或数据库结构。
- 不改变任何设置项的默认值、范围或保存语义。
- 不增加设置搜索、恢复默认值总按钮或新的设置项。
- 不重做 Settings 之外的 Subject 设置入口。

## 验收

- 导航只显示 General、Personalization、Automation、Usage 四项。
- 打开弹窗默认进入 General；外观和语言无需切换入口即可操作。
- Automation 同页完整显示 Agents、Web search、Maintenance 的所有原有控件。
- About 不再是入口，版本信息仍可见。
- 375px 宽度下无横向页面溢出，分类可用、内容可滚动、控件不遮挡。
- 明暗主题下层级与对比正常。
- 定向测试、全量测试、TypeScript、lint、build 通过。
