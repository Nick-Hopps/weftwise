# Per-subject 上次页面记忆与恢复 — 设计

> 日期：2026-06-30　范围：纯前端　状态：待评审

## 一、背景与问题

切换 subject 走 `useSwitchSubject`，但当前实现有缺陷：

- **`SubjectSwitcher`（⌘O）切换时根本不导航**——只写 store/cookie + 失效查询 + `router.refresh()`。
  于是在 `/wiki/foo`（subject A 的页）时切到 subject B，URL 仍停在 `/wiki/foo`，而 B 里没有 `foo` →
  SSR 渲染出 **"Page not found"**（见 `src/app/(app)/wiki/[...slug]/page.tsx::notFound()` / `WikiPageElsewhere`）。
- `ui-store.activePageSlug` 字段定义了却**从未被写入**（死字段），无法用作"当前页"真相源。
- `subjects` 管理页卡片切换时固定跳 `/`（仪表盘），丢失"上次在该 subject 看到哪"。

**目标**：每个 subject 记住它"上次打开的页面"，切换到该 subject 时自动导航过去；
没有记忆则回退仪表盘。彻底消灭跨主题切换后的 Page not found。

## 二、关键决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 记忆范围 | **仅 `/wiki/*` 与 `/sources/*`** | 只有这类 subject 专属、跨主题会 404 的路由才是痛点；仪表盘 / tags / health / history 等全局路由永远存在，切过去不报错，不必记（停在其上也不覆盖已记的 wiki 页）|
| 记录时机 | **在切换边界记录**（`useSwitchSubject` 内），不另设持续监听 pathname 的 effect | 持续 effect 会在"subjectId 已变、URL 还没变"的瞬间把旧页错记到新 subject 名下（竞态）；边界记录天然规避 |
| 恢复时机 | 切换动作里计算目标并 `router.push` | 同时修掉"切换器压根不导航"的现有 bug |
| 持久化 | `ui-store` 新增 `lastPageBySubject` 映射，纳入 persist | 与现有 subject/会话状态一致，跨刷新可用；persist v5→v6 |
| SSR 定位稳健性 | 恢复 wiki/source 路径时补 `?s=<slug>` | 不依赖 cookie 写入与 SSR 渲染的时序，显式用 `?s=` 让 `resolveSubjectFromRequest` 定位 subject |
| 卡片行为 | 管理页卡片也跳上次页面 | "记住的页优先、`navigateTo` 作回退"，与 ⌘O 切换语义统一（Nick 确认）|

## 三、组件与数据流

### 3.1 `ui-store`（`src/stores/ui-store.ts`）

新增状态与 action：

```ts
/** subjectId -> 该 subject 上次打开的可记忆路径（仅 pathname，不含 query）。*/
lastPageBySubject: Record<string, string>;
/** 记录某 subject 的上次页面（仅当 path 可记忆时由调用方判定后调用）。*/
rememberPage: (subjectId: string, path: string) => void;
```

- `rememberPage` 实现：`set((s) => ({ lastPageBySubject: { ...s.lastPageBySubject, [subjectId]: path } }))`。
- `partialize` 增加 `lastPageBySubject`。
- persist `version` 5 → 6；`migratePersisted` 在 `version >= 6` 分支带出 `lastPageBySubject`，
  旧版本（含 v5）默认 `{}`。
- 顺手移除死字段 `activePageSlug` 及其 `setActivePageSlug`（全仓库无写入点，仅定义；用 grep 复核确认）。

> 不做 subject 删除时的 map 清理：已删 subject 无法再被切入，残留 key 永不再读，影响可忽略。

### 3.2 纯函数（`src/lib/subject-nav.ts`，新增 + vitest）

```ts
/** 该路径是否值得作为 subject 的"上次页面"记忆（subject 专属、跨主题会 404 的路由）。*/
export function isRememberablePath(pathname: string): boolean;
//   true  : '/wiki/foo', '/wiki/a/b', '/sources/abc'
//   false : '/', '/wiki', '/sources', '/tags', '/tags/x', '/health', '/history', '/subjects', '/ingest', ''

/** 给路径合并 ?s=<slug>，丢弃原有 s 参数、保留其余 query，保留 hash。*/
export function withSubjectParam(path: string, slug: string): string;
//   ('/wiki/foo', 'frontend')            -> '/wiki/foo?s=frontend'
//   ('/wiki/foo?s=old&x=1', 'frontend')  -> '/wiki/foo?x=1&s=frontend'
```

判定**只认带子路径的前缀**：`pathname.startsWith('/wiki/') || pathname.startsWith('/sources/')`。
裸 `/wiki`、`/sources`（无尾斜杠）→ false——本就没有这种真实页路由（catch-all 是 `/wiki/[...slug]`）。
（`/wiki/<slug>/edit` 也以 `/wiki/` 开头 → 会被记住，切回偶尔落到编辑页；视为可接受的小瑕疵，不特判。）

### 3.3 `useSwitchSubject`（`src/hooks/use-switch-subject.ts`）

签名不变：`(subject: { id; slug }, opts?: { navigateTo?: string }) => void`。改后逻辑：

```
callback(subject, opts):
  state = useUIStore.getState()           // 取最新，避免闭包陈旧
  fromId = currentSubjectId

  // 0) 早退：选中的就是当前 subject → no-op（别把人从当前页弹走）
  if (fromId === subject.id) return

  // 1) 记录离开的 subject 的当前页（仅可记忆路径）
  const fromPath = window.location.pathname   // live，最新
  if (fromId && isRememberablePath(fromPath)) state.rememberPage(fromId, fromPath)

  // 2) 切换 store + cookie（沿用 setCurrentSubject）
  setCurrentSubject({ id: subject.id, slug: subject.slug })

  // 3) 失效 8 个 query key（沿用 INVALIDATE_KEYS）

  // 4) 计算恢复目标并导航
  const remembered = state.lastPageBySubject[subject.id]
  const target = remembered
    ? withSubjectParam(remembered, subject.slug)
    : (opts?.navigateTo ?? '/')
  router.push(target)
  router.refresh()
```

- 读 store 用 `useUIStore.getState()`（而非订阅快照），保证记录与读取都是最新值、且不让 `lastPageBySubject` 进入 `useCallback` 依赖。
- `currentSubjectId` 仍来自 `useCurrentSubject()`（已订阅），作为"离开的 subject"。

### 3.4 调用点

| 文件 | 改动 |
|------|------|
| `src/components/layout/subject-switcher.tsx` | `handleSelect` 不变（已调 `switchSubject({id,slug})`）；no-op 守卫在 hook 内统一处理，选中当前 subject 时仅关闭浮层 |
| `src/app/(app)/subjects/page.tsx` | 卡片仍传 `{ navigateTo: '/' }`；hook 内"记忆优先" → 有记忆跳记忆页、无则回 `/`（满足卡片也跳上次页面）|
| `src/components/subjects/subject-dialog.tsx` | 新建后 `switchSubject(..., { navigateTo: '/' })` 不变；新 subject 无记忆 → 回退 `/`（仪表盘，正确）|

## 四、不变的部分 / 边界

- **`SubjectsBootstrap`（`providers.tsx`）不动**：它用 `setCurrentSubject` 直接初始化（非 `useSwitchSubject`），
  初次加载 / 深链时 URL 本就正确，**不触发**记录或恢复。
- `setCurrentSubject` 自身**不**加记录/恢复逻辑（被 bootstrap 复用，加了会误触发）。
- 恢复目标可能是一个**之后被删除**的页面 slug → 仍可能 Page not found。这属于固有边界
  （记忆是乐观的"上次位置"），不在本次范围处理；用户可正常导航离开。

## 五、测试

- **`src/lib/__tests__/subject-nav.test.ts`**（vitest，纯函数）：
  - `isRememberablePath`：`/wiki/x`、`/wiki/a/b`、`/sources/x` → true；`/`、`/wiki`、`/sources`、`/tags`、`/health`、`/subjects`、空串 → false。
  - `withSubjectParam`：无 query、含旧 `s`、含其他 query、含 hash 各一例。
- `useSwitchSubject` 的集成行为（记录/恢复/no-op/竞态）**无现成组件测试基建**，
  沿用项目现状以 `tsc --noEmit` + 手动（Playwright/dev）验证：
  1. A 看 `/wiki/foo` → ⌘O 切 B（B 空）→ 落 `/`，**不**再 Page not found；
  2. B 里打开 `/wiki/bar` → 切回 A → 落 A 上次页；再切回 B → 落 `/wiki/bar`；
  3. 管理页点已有内容的卡片 → 跳其上次页面；点新建的空 subject → 落 `/`；
  4. 在 `/tags` 时切 subject → 不把 `/tags` 记成该 subject 的页（已记的 wiki 页不被覆盖）。

## 六、影响面

纯前端，**零**后端 / DB / API / 路由改动。改动文件：

- `src/stores/ui-store.ts`（state + action + persist v6 + 删死字段）
- `src/hooks/use-switch-subject.ts`（记录 + 恢复 + no-op 守卫）
- `src/lib/subject-nav.ts`（新增纯函数）+ `src/lib/__tests__/subject-nav.test.ts`（新增测试）
- `src/components/layout/subject-switcher.tsx`（如需配合 no-op 守卫做关闭浮层的微调）
- 文档：`src/stores`/`src/lib`/`src/components` 模块 `CLAUDE.md` 与根 changelog
