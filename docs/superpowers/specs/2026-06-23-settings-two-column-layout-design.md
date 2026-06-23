# 设置界面两栏式重构 — 设计

> 把单列堆叠的 Settings 弹窗重做成「左分类导航 + 右详情内容」的两栏布局。

日期：2026-06-23
状态：设计已确认

---

## 一、背景与目标

当前 `SettingsDialog` 是一个 `max-w-md` 单列模态，所有分组（Appearance / Sidebar width / Wiki language / Agents / Web search / 版本页脚）竖向堆叠，靠 `<Separator />` 分隔。随着设置项增多，单列已显拥挤，且没有「分类」概念。

**目标**：重做为两栏式 ——
- 左侧：分类导航栏，列出各配置模块。
- 右侧：当前选中分类的详情内容。
- 点击左侧菜单项，右侧内容随之切换；弹窗整体尺寸固定不跳动。

**非目标**：
- 不改任何后端 / API（仍 `GET/PUT /api/settings`）。
- 不改设置项本身的语义、取值范围、保存逻辑。
- 不引入新的设置项。
- 不改 Appearance 两项（dark mode / sidebar width）继续来自 Zustand 的现状。
- 不做组件测试（与项目现状一致——本仓库 UI 组件无测试）。

---

## 二、承载形态

保持**居中模态弹窗**（不改成独立路由页）：

- 宽度 `max-w-md` → `max-w-3xl`（约 768px）。
- 固定高度（`h-[70vh] max-h-[560px]` 量级），右内容区 `overflow-y-auto` 独立滚动 —— 切换分类时弹窗外框不变形、不跳动。
- 顶部标题栏（`Settings` + 关闭按钮）保留。
- 标题栏之下为 `flex` 行：
  - 左 `SettingsNav`：`border-r`，固定宽 ~180px。
  - 右内容区：`flex-1`，可滚动。
- Esc 关闭、点击遮罩关闭逻辑保留。

---

## 三、分类划分（5 类）

| id | 标签 (label) | 图标 (lucide) | 右侧内容 | 数据源 |
|----|------|------|----------|--------|
| `appearance` | Appearance | `Palette` | Dark mode 切换 + Sidebar width 重置 | Zustand |
| `language` | Language | `Languages` | Wiki language 选择 + 保存 | `/api/settings` |
| `agents` | Agents | `Bot` | max steps / token budget / parallel sub-agents / MCP lifecycle / LLM selection | `/api/settings` |
| `web-search` | Web search | `Globe` | provider / API key / max results | `/api/settings` |
| `about` | About | `Info` | App 名称 + 版本号 | 常量 |

左导航项：图标 + 标签的竖向按钮列表；选中项高亮（`bg-surface-hover` + accent 文字 / 左侧 accent 条），未选中项 hover 态。

---

## 四、组件结构

沿用现有 `src/components/layout/` 目录与 `settings-rows.tsx` 原语。

### 新增

1. **`settings-categories.ts`** — 分类元数据单一来源
   - 导出 `CategoryId` 联合类型（`'appearance' | 'language' | 'agents' | 'web-search' | 'about'`）。
   - 导出 `SETTINGS_CATEGORIES: { id: CategoryId; label: string; icon: LucideIcon }[]`。
   - 由 dialog（默认选中）、nav（渲染列表）、content（分类标题）共用，避免三者循环依赖与漂移。

2. **`settings-nav.tsx`** — 左侧导航栏
   - props：`active: CategoryId`、`onSelect: (id: CategoryId) => void`。
   - 遍历 `SETTINGS_CATEGORIES` 渲染按钮列表；标注 `aria-current` / 选中高亮。

### 改造

3. **`settings-dialog.tsx`**
   - 容器加宽（`max-w-3xl`）+ 固定高度 + 两栏 `flex`。
   - 新增本地 state `const [active, setActive] = useState<CategoryId>('appearance')`；弹窗每次打开（`isOpen` 变 true）重置为 `'appearance'`。
   - 渲染 `<SettingsNav active onSelect />` + `<SettingsContent active ... />`。
   - 现有 query / mutation 持有逻辑（`settingsQuery` / `saveLanguage` / `savePartial` / `languageDraft`）**不变**，仍通过 props 注入 content。

4. **`settings-content.tsx`**
   - 拆成 5 个小 panel 组件（`AppearancePanel` / `LanguagePanel` / `AgentsPanel` / `WebSearchPanel` / `AboutPanel`），各自只取所需 props。
   - 顶层按 `active` 渲染对应 panel；panel 上方渲染该分类标题（取自 `SETTINGS_CATEGORIES`）。
   - panel 内部完全复用 `settings-rows.tsx` 的 `SettingRow / NumberSettingRow / SelectSettingRow / TextSettingRow` 与现有 `WIKI_LANGUAGE_PRESETS` / 语言选项构造逻辑。

### 不动

5. **`settings-rows.tsx`** — 行级原语零改动。

---

## 五、不变的约束（沿用项目规范）

- 服务端 `app_settings` 表是设置的唯一真实源；**不写 Zustand**。
- Appearance 的 dark mode / sidebar width 仍读写 Zustand（保持现状）。
- 客户端通信仍走 `apiFetch` / React Query；样式走 Tailwind + `cn()` + CSS 变量。
- `'use client'` 顶部声明保留。

---

## 六、验收

- 打开 Settings：默认停在 Appearance，左导航 5 项可见。
- 逐项点击左导航：右侧内容切换到对应分类；弹窗外框尺寸不变。
- 各设置项保存行为与改造前一致（dark mode 即时切换；语言/agents/web-search 走 PUT 后乐观更新）。
- `npm run lint` 与 `npx tsc --noEmit`（或 `next build`）通过。
- 暗黑模式下样式正常。
