# Subject 创建与管理体验改善 — 设计文档

> 日期：2026-06-28
> 范围：新建 subject 流程 + `(app)/subjects` 管理页 + 顶栏切换器联动。**不改任何后端接口与数据库。**

---

## 一、背景与问题

当前 subject 的创建与管理体验存在多处割裂，覆盖四类痛点（已与用户确认全部纳入范围）：

**创建流程**

- 从切换器点 "New subject…" 跳到 `/subjects?new=1`，靠 URL 参数展开一个内联面板（非弹窗），有页面跳转割裂感。
- slug 字段与 name 权重一样高，强迫用户先理解 slug 概念。
- 创建时无法选择增益强度（augmentation），只能事后在卡片上改。
- 创建后停留在管理页，不会自动切入新 subject 引导加内容。

**管理页交互**

- 卡片"重命名"要进编辑模式，但增益强度是直接 `onChange` 自动保存的 `<select>`——两套交互不一致。
- 删除用原生 `window.confirm`，禁用原因只藏在 hover `title` 里，发现性差。
- **点卡片无任何反应**——无法从管理页直接切换/进入某个 subject。

**文案 / i18n**

- 增益强度选项仍是中文（`off — 纯忠实层`），与项目近期持续英文化方向冲突。

**视觉与空态**

- 空态只有一行 "No subjects yet." 纯文字，无引导。

---

## 二、设计目标

1. 创建/编辑 subject 收敛为**一个可复用的全局弹窗**，从任何入口（切换器 / 管理页 / 空态）一致唤起，删掉 `?new=1` URL hack。
2. 管理页卡片**整卡可点 = 进入工作区**（切换 + 跳仪表盘）；编辑入口独立为卡片右上 gear 图标。
3. 创建后**自动切入新 subject 并跳仪表盘**，借既有空态 ingest hero 自然引导加内容。
4. 新增/改动文案**全英文**；增益强度改英文分段控件 + 说明。
5. 切换 subject 的逻辑抽成**共享 hook**，保证切换器与卡片行为完全一致。

**非目标（YAGNI）**

- 不抽取通用 `ui/Dialog` 原语去重构既有手写弹窗（避免无关重构；新弹窗沿用既有手写模式即可）。
- 不改 `POST /api/subjects`、`PATCH/DELETE /api/subjects/[id]` 与数据库 schema（现有接口已满足）。
- slug 不支持编辑后修改（与现有 PATCH 一致，仅 create 时可定制）。

---

## 三、现状关键事实（落地依据）

- **无共享 Dialog 原语**：`settings-dialog`、`job-detail-dialog` 等均手写同一套遮罩——
  `fixed inset-0 z-command flex ... bg-overlay/40 backdrop-blur-sm animate-fade-in` + 内层 `role="dialog" aria-modal="true"` 面板 + Esc 关闭 + 点遮罩关闭。新弹窗沿用此模式。
- **仪表盘空态已就绪**：`(app)/page.tsx` 在 `pageCount === 0` 时渲染 `DashboardHero` + `DashboardIngestHero`（导入资料主入口）。新 subject 切入后跳 `/` 即落到此空态。
- **切换逻辑现状**：`subject-switcher.tsx::handleSelect` = `setCurrentSubject({id,slug})`（同步 store + `wiki_subject` cookie）+ invalidate `INVALIDATE_KEYS`（8 个 query key）+ `router.refresh()`。这段需抽出复用。
- **现有接口足够**：
  - `POST /api/subjects` body `{ slug, name, description? }`，slug 冲突 409。
  - `PATCH /api/subjects/[id]` 支持 `name?` / `description?` / `augmentationLevel?`。
  - `DELETE /api/subjects/[id]`：非空 409（`not-empty`）、未知 404。
- **契约**：`AugmentationLevel = 'off' | 'light' | 'standard' | 'deep'`，`DEFAULT_AUGMENTATION_LEVEL = 'standard'`。

---

## 四、架构与组件

### 4.1 状态：`ui-store` 新增瞬态弹窗状态

仿 `settingsDialogOpen` 的做法，新增：

```ts
subjectDialog: { open: boolean; mode: 'create' | 'edit'; subjectId: string | null };
openSubjectDialog(args: { mode: 'create' } | { mode: 'edit'; subjectId: string }): void;
closeSubjectDialog(): void;
```

- **不纳入持久化**：在 store 的 `partialize` 中排除（确认 `settingsDialogOpen` 当前是否被持久化，与之保持一致；瞬态弹窗状态不应跨刷新保留）。
- 不新增 store 版本迁移（仅瞬态字段，默认值 `{ open:false, mode:'create', subjectId:null }`）。

### 4.2 共享 hook：`hooks/use-switch-subject.ts`（🆕）

抽出切换逻辑，签名：

```ts
function useSwitchSubject(): (
  subject: { id: string; slug: string },
  opts?: { navigateTo?: string }
) => void;
```

- 内部：`setCurrentSubject` + 遍历 invalidate keys（从 switcher 移出的 `INVALIDATE_KEYS` 常量，放到此 hook 或 `lib`）+ `router.refresh()`；若传 `navigateTo` 则 `router.push(navigateTo)`。
- `subject-switcher.tsx::handleSelect` 改为调用此 hook（行为不变，无 `navigateTo`）。
- 管理页卡片点击调用此 hook 并传 `navigateTo: '/'`。

### 4.3 统一弹窗：`components/subjects/subject-dialog.tsx`（🆕）

- 全局挂载一次（在 `(app)/layout.tsx` 的 Shell 内，与 SettingsDialog 同级），由 `ui-store.subjectDialog` 驱动。
- `mode === 'create'`：空表单。
- `mode === 'edit'`：用 `subjectId` 从 `['subjects']` 查询缓存或 `GET /api/subjects/[id]` 预填（优先用列表缓存，避免额外请求）。

**表单字段**

| 字段 | create | edit | 说明 |
|------|--------|------|------|
| Name | 可编辑（autofocus） | 可编辑 | 实时派生 slug（仅 create 且 slug 未被手动改过时）|
| Slug | 渐进式：默认只读预览 `URL: <slug>` + `› Customize slug` 折叠；展开后可编辑 + `[[slug:page]]` 提示 | **只读展示**（不可改）| 复用 `normalizeSubjectSlug`（`lib/slug.ts`）|
| Description | 可选 textarea | 可选 textarea | |
| Augmentation | 英文分段控件，默认 `standard` | 同左，预填当前值 | 见 4.4 |

**提交行为**

- create：`POST /api/subjects` → 成功后 `invalidate(['subjects'])` → `useSwitchSubject(newSubject, { navigateTo: '/' })` → `closeSubjectDialog()`。
- edit：`PATCH /api/subjects/[id]`（仅发送变更字段）→ 成功后 `invalidate(['subjects'])` → 若编辑的是当前 active subject，可选 `router.refresh()` → 关弹窗。

**删除（仅 edit 模式，弹窗底部 "Danger zone"）**

- 不可删时**显式文字**说明原因（不再只靠 hover）：
  - active：`This subject is currently active. Switch to another subject before deleting.`
  - 非空：`This subject has {n} pages. Empty it first.`（按钮 disabled）
- 可删时**内联两步确认**（点 `Delete subject` → 变 `Click again to confirm`，再点才删；可加短暂 timeout 自动复位），替换 `window.confirm`。
- 删除成功：`invalidate(['subjects'])` + 关弹窗。

**错误处理**

- create slug 冲突 409 / 其他 4xx → 解析 `{ error }` 弹窗内联红字。
- delete 409（竞态：期间被加页）→ 同样内联提示。

### 4.4 增益强度控件：`components/subjects/augmentation-field.tsx`（🆕，或内联于 dialog）

英文分段/单选控件，4 档 + 一句英文说明：

| value | label | 说明（helper）|
|-------|-------|--------------|
| `off` | Off | Faithful only — no elaboration |
| `light` | Light | Light touch |
| `standard` | Standard | Balanced (default) |
| `deep` | Deep | Rich elaboration |

- label/helper 映射集中定义（可放此文件内导出常量，供 dialog 复用；若别处需要再上移到 `lib`）。
- 受控组件，props `{ value, onChange, disabled? }`。

### 4.5 管理页重做：`app/(app)/subjects/page.tsx`

- **删除**：内联 `CreateSubjectForm`、卡片内联编辑表单、卡片内 augmentation `<select>`、`window.confirm`、`?new=1` 的 `useEffect`、`useSearchParams`/`Suspense` 相关样板（若仅为 `?new=1` 而存在）。
- 头部：标题 + 说明 + `New subject` 按钮 → `openSubjectDialog({ mode:'create' })`。
- 卡片（整卡可点 = 进入）：
  - 语义：整卡为可点元素（`button`/带 `role`），点击 → `switchSubject(subject, { navigateTo:'/' })`。
  - 第一行：图标 + name + `Active` 徽标（当前 subject）+ 右上 gear `IconButton`（`stopPropagation` → `openSubjectDialog({ mode:'edit', subjectId })`）。
  - 元信息：`{n} pages · {augmentationLabel}` + mono slug。
  - 当前 active 卡片视觉强调（沿用 `tone="elevated"` + `border-accent/40`）。
- 空态：图标 + 文案块 + `Create your first subject` CTA（开弹窗），替换裸 "No subjects yet."。
- 仍用 React Query `['subjects']`（`fetchSubjects`）。

### 4.6 切换器：`components/layout/subject-switcher.tsx`

- "New subject…" 改为 `openSubjectDialog({ mode:'create' })`（不再 `router.push('/subjects?new=1')`），关闭浮层。
- "Manage subjects" 仍 `router.push('/subjects')`。
- `handleSelect` 改用 `useSwitchSubject`（行为不变）。
- 其余结构（⌘O、列表、过滤）不动。

---

## 五、数据流（创建路径示例）

```
用户在切换器/管理页/空态点 New subject
  → openSubjectDialog({mode:'create'})          (ui-store 瞬态)
  → <SubjectDialog> 渲染 create 表单
  → 提交 → POST /api/subjects {slug,name,description}
      ├─ 201 → invalidate(['subjects'])
      │        → switchSubject(new, {navigateTo:'/'})   (store+cookie+invalidate+refresh+push '/')
      │        → closeSubjectDialog()
      │        → 落到仪表盘空态 → DashboardIngestHero 引导加内容
      └─ 409/4xx → 弹窗内联红字
```

---

## 六、文件清单

**新增**

- `src/hooks/use-switch-subject.ts`
- `src/components/subjects/subject-dialog.tsx`
- `src/components/subjects/augmentation-field.tsx`

**改动**

- `src/stores/ui-store.ts`（瞬态 `subjectDialog` 状态 + actions；确认 partialize 排除）
- `src/components/layout/subject-switcher.tsx`（New subject 改唤起弹窗；切换复用 hook）
- `src/app/(app)/subjects/page.tsx`（整页重做）
- `src/app/(app)/layout.tsx`（挂载 `<SubjectDialog />`）

**不改**：所有 `/api/*`、数据库 schema、`contracts.ts`（除非需要导出增益 label 常量——优先放组件层）。

---

## 七、边界与错误处理

| 场景 | 处理 |
|------|------|
| create slug 冲突 (409) | 弹窗内联红字（`body.error`）|
| create 缺 name/slug | 前端校验拦截 + 提示 |
| 删除当前 active subject | 按钮 disabled + 显式文字 |
| 删除非空 subject (409) | 按钮 disabled + 显式 `{n} pages` 文字；竞态 409 内联提示 |
| edit 当前 active 后名称变化 | invalidate + `router.refresh()` 让顶栏/SSR 同步 |
| 弹窗关闭 | Esc / 点遮罩 / Cancel；关闭即重置本地表单 state |

---

## 八、测试与验证

- 项目**无组件测试基建**，UI 不强制单测。
- 若 `augmentation-field` 的 label/helper 映射抽为纯导出常量，可加 1 个轻量 vitest 断言映射完整性（4 档齐全）。
- 主验证手段（依据项目 memory）：
  - `npx tsc --noEmit`（类型基线，当前 0 error）。
  - `npx vitest run`（保持 636 passing 不回归）。
  - Playwright 手动走查：创建→自动切入→落空态；卡片点击进入；gear→编辑→保存；删除两步确认 + 禁用态文字；切换器 New 唤起弹窗（无 `?new=1`）。
- 注意：`npm run lint` 不可用（next lint 已弃用），不纳入校验。

---

## 九、回滚与提交

- 单一 feature 分支 `feat/subject-ux-improve`（已建 worktree）。
- 纯前端改动，无 DB 迁移/接口变更，可整体 revert。
- 完成后回合 `main` 并清理 worktree（按项目开发约定）。
