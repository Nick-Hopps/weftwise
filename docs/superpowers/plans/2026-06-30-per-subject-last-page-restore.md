# Per-subject 上次页面记忆与恢复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每个 subject 记住它"上次打开的页面"，切换到该 subject 时自动导航过去（没有记忆则回退仪表盘），消灭跨主题切换后的 Page not found。

**Architecture:** 纯前端。在 `useSwitchSubject` 切换边界做"记录离开页 + 恢复目标页"（规避持续监听 pathname 的竞态）；记忆存进 `ui-store.lastPageBySubject`（持久化，persist v5→v6）；判定与 `?s=` 拼接抽成 `lib/subject-nav.ts` 纯函数并单测。

**Tech Stack:** React 19 + Next.js 15 App Router（`useRouter`/`window.location`）、Zustand persist、TanStack Query、vitest。

## Global Constraints

- 仅记忆 `/wiki/*` 与 `/sources/*` 路由（`startsWith('/wiki/')` / `startsWith('/sources/')`）；裸 `/wiki`、`/sources` 及全局路由不记。
- 记录/恢复**只**在 `useSwitchSubject` 内；`setCurrentSubject` 与 `SubjectsBootstrap` 不得加此逻辑。
- 注释 / commit message 用中文（项目约定）。
- 零后端 / DB / API / 路由改动。
- 验证以 `npx tsc --noEmit`（exit 0）+ `npx vitest run`（新增用例全过）为权威；IDE 幻影诊断不作数。

---

### Task 1: `lib/subject-nav.ts` 纯函数（TDD）

**Files:**
- Create: `src/lib/subject-nav.ts`
- Test: `src/lib/__tests__/subject-nav.test.ts`

**Interfaces:**
- Consumes: 无（纯字符串处理）
- Produces:
  - `isRememberablePath(pathname: string): boolean`
  - `withSubjectParam(path: string, slug: string): string`（删除原有 `s`、其余 query 保留、`s=<slug>` 追加到末尾、保留 hash）

- [ ] **Step 1: 写失败测试**

`src/lib/__tests__/subject-nav.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { isRememberablePath, withSubjectParam } from '../subject-nav';

describe('isRememberablePath', () => {
  it('wiki / sources 子路径可记忆', () => {
    expect(isRememberablePath('/wiki/foo')).toBe(true);
    expect(isRememberablePath('/wiki/a/b')).toBe(true);
    expect(isRememberablePath('/sources/abc')).toBe(true);
  });

  it('裸前缀与全局路由不可记忆', () => {
    for (const p of ['/', '/wiki', '/sources', '/tags', '/tags/x', '/health', '/history', '/subjects', '/ingest', '']) {
      expect(isRememberablePath(p)).toBe(false);
    }
  });
});

describe('withSubjectParam', () => {
  it('无 query 时追加 s', () => {
    expect(withSubjectParam('/wiki/foo', 'frontend')).toBe('/wiki/foo?s=frontend');
  });

  it('丢弃旧 s、保留其余 query、s 追加到末尾', () => {
    expect(withSubjectParam('/wiki/foo?s=old&x=1', 'frontend')).toBe('/wiki/foo?x=1&s=frontend');
  });

  it('保留其他 query', () => {
    expect(withSubjectParam('/wiki/foo?x=1', 'b')).toBe('/wiki/foo?x=1&s=b');
  });

  it('保留 hash', () => {
    expect(withSubjectParam('/wiki/foo#sec', 'b')).toBe('/wiki/foo?s=b#sec');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/lib/__tests__/subject-nav.test.ts`
Expected: FAIL（`Cannot find module '../subject-nav'` 或导出未定义）

- [ ] **Step 3: 写最小实现**

`src/lib/subject-nav.ts`：

```ts
/** 该路径是否值得作为 subject 的"上次页面"记忆（subject 专属、跨主题会 404 的路由）。*/
export function isRememberablePath(pathname: string): boolean {
  return pathname.startsWith('/wiki/') || pathname.startsWith('/sources/');
}

/** 给路径合并 `?s=<slug>`：删除原有 s、保留其余 query 与 hash、s 追加到末尾。*/
export function withSubjectParam(path: string, slug: string): string {
  const [pathAndQuery, hash = ''] = path.split('#');
  const [pathname, query = ''] = pathAndQuery.split('?');
  const params = new URLSearchParams(query);
  params.delete('s');
  params.append('s', slug);
  return `${pathname}?${params.toString()}${hash ? `#${hash}` : ''}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/lib/__tests__/subject-nav.test.ts`
Expected: PASS（4 个 describe 块全过）

- [ ] **Step 5: 提交**

```bash
git add src/lib/subject-nav.ts src/lib/__tests__/subject-nav.test.ts
git commit -m "feat: 新增 subject-nav 纯函数（可记忆路径判定 + ?s= 拼接）"
```

---

### Task 2: `ui-store` 记忆状态 + persist v6（删死字段）

**Files:**
- Modify: `src/stores/ui-store.ts`

**Interfaces:**
- Consumes: 无
- Produces（供 Task 3 使用）：
  - state `lastPageBySubject: Record<string, string>`
  - action `rememberPage: (subjectId: string, path: string) => void`

> 本仓库无 store/persist 单测基建（既有 `__tests__` 均为纯函数）。本任务以 `npx tsc --noEmit` + 全量 `npx vitest run` 不回归为验证；迁移正确性在 Task 5 手动验证（v5 用户升级后 `lastPageBySubject` 为 `{}`，不报错）。

- [ ] **Step 1: 接口里删死字段、加新字段**

`UIState` 接口中：
- 删除 `activePageSlug: string | null;`
- 删除 `setActivePageSlug: (slug: string | null) => void;`
- 在 `currentConversationId` 附近新增：

```ts
  /** subjectId -> 该 subject 上次打开的可记忆路径（仅 pathname）。*/
  lastPageBySubject: Record<string, string>;
  /** 记录某 subject 的上次页面（调用方已用 isRememberablePath 判定）。*/
  rememberPage: (subjectId: string, path: string) => void;
```

- [ ] **Step 2: `LegacyPersistedState` 加字段**

在 `LegacyPersistedState` 接口末尾加：

```ts
  lastPageBySubject?: Record<string, string>;
```

- [ ] **Step 3: 迁移逻辑带出 `lastPageBySubject`，版本注释更新**

把顶部迁移注释改为含 v6：

```ts
// Persist migration: v1 → v2 → v3 → v4 → v5 → v6.
// v6: adds lastPageBySubject (per-subject 上次打开的页面，跨刷新恢复)。
```

在 `migratePersisted` 的 `if (version >= 4)` 分支返回对象里追加（读旧值，无则 `{}`）：

```ts
      lastPageBySubject: prev.lastPageBySubject ?? {},
```

> 更低版本分支（>=3 / >=2 / v1 fallback）无需显式补：zustand persist 默认 `merge` 会用初始 state 的 `{}` 补齐缺失键。

- [ ] **Step 4: 默认 state、action、partialize、version**

- 在 `create` 初始对象里：删 `activePageSlug: null,`；在 `currentConversationId: null,` 附近加 `lastPageBySubject: {},`。
- 删 action `setActivePageSlug: (slug) => set({ activePageSlug: slug }),`。
- 新增 action（放在 `setCurrentConversation` 附近）：

```ts
      rememberPage: (subjectId, path) =>
        set((s) => ({ lastPageBySubject: { ...s.lastPageBySubject, [subjectId]: path } })),
```

- `partialize` 返回对象里追加：`lastPageBySubject: s.lastPageBySubject,`
- persist 选项 `version: 5` 改为 `version: 6`。

- [ ] **Step 5: 类型检查 + 全量测试不回归**

Run: `npx tsc --noEmit; echo EXIT=$?`
Expected: `EXIT=0`（确认无残留 `activePageSlug` / `setActivePageSlug` 引用——grep 已知仅 ui-store 自身引用）

Run: `npx vitest run`
Expected: 全过（无回归）

- [ ] **Step 6: 提交**

```bash
git add src/stores/ui-store.ts
git commit -m "feat: ui-store 加 lastPageBySubject 记忆（persist v6）并移除死字段 activePageSlug"
```

---

### Task 3: `useSwitchSubject` 记录 + 恢复 + no-op 守卫

**Files:**
- Modify: `src/hooks/use-switch-subject.ts`

**Interfaces:**
- Consumes:
  - `isRememberablePath` / `withSubjectParam`（Task 1）
  - `useUIStore.getState().lastPageBySubject` / `.rememberPage`（Task 2）
  - `useCurrentSubject()`（已有：`id` / `setCurrentSubject`）
- Produces: `useSwitchSubject()` 返回的回调签名不变 `(subject: { id; slug }, opts?: { navigateTo?: string }) => void`

> 同样无 hook 测试基建，以 `tsc` + Task 5 手动验证为准。

- [ ] **Step 1: 替换 hook 实现**

`src/hooks/use-switch-subject.ts` 全文替换为：

```ts
'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useUIStore } from '@/stores/ui-store';
import { isRememberablePath, withSubjectParam } from '@/lib/subject-nav';

/** 切换 subject 时需失效的 React Query key（按前缀子树失效）。*/
const INVALIDATE_KEYS = [
  'pages',
  'search',
  'graph',
  'jobs',
  'backlinks',
  'context',
  'frontmatter',
  'lens',
] as const;

/**
 * 统一的"切换到某 subject"动作：在切换边界记录离开页、写 store + cookie、
 * 失效相关查询、恢复目标 subject 的上次页面（无则回退 navigateTo / 仪表盘）、刷新 SSR。
 * 切换器与管理页卡片共用，保证行为一致。
 */
export function useSwitchSubject() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: currentSubjectId, setCurrentSubject } = useCurrentSubject();

  return useCallback(
    (subject: { id: string; slug: string }, opts?: { navigateTo?: string }) => {
      // 选中的就是当前 subject：不记录、不恢复记忆页；仅在显式 navigateTo 时导航
      // （⌘O 重选当前 subject → no-op 留在原页；管理页点 active 卡片 → 仍按 navigateTo 去仪表盘）。
      if (currentSubjectId === subject.id) {
        if (opts?.navigateTo) {
          router.push(opts.navigateTo);
          router.refresh();
        }
        return;
      }

      const { lastPageBySubject, rememberPage } = useUIStore.getState();

      // 1) 记录离开的 subject 的当前页（仅可记忆路径；从 live location 读，保证最新）。
      const fromPath = typeof window !== 'undefined' ? window.location.pathname : '';
      if (currentSubjectId && isRememberablePath(fromPath)) {
        rememberPage(currentSubjectId, fromPath);
      }

      // 2) 切换 store + cookie。
      setCurrentSubject({ id: subject.id, slug: subject.slug });

      // 3) 失效相关查询。
      for (const key of INVALIDATE_KEYS) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }

      // 4) 计算恢复目标并导航：记住的页优先（补 ?s= 让 SSR 显式定位），否则回退 navigateTo / 仪表盘。
      const remembered = lastPageBySubject[subject.id];
      const target = remembered
        ? withSubjectParam(remembered, subject.slug)
        : (opts?.navigateTo ?? '/');
      router.push(target);
      router.refresh();
    },
    [queryClient, router, currentSubjectId, setCurrentSubject],
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit; echo EXIT=$?`
Expected: `EXIT=0`

- [ ] **Step 3: 确认调用点无需改动**

只读检查（不改代码，确认假设成立）：

```bash
grep -n "switchSubject\|setOpen(false)" src/components/layout/subject-switcher.tsx
grep -n "switchSubject\|navigateTo" src/app/\(app\)/subjects/page.tsx src/components/subjects/subject-dialog.tsx
```

Expected：
- `subject-switcher.tsx`：`handleSelect` 内 `setOpen(false)` 已先于 `switchSubject` 调用 → no-op 时浮层照常关闭，**无需改动**。
- `subjects/page.tsx` 卡片传 `{ navigateTo: '/' }`、`subject-dialog.tsx` 新建后传 `{ navigateTo: '/' }` → 均经新逻辑正确处理，**无需改动**。

- [ ] **Step 4: 提交**

```bash
git add src/hooks/use-switch-subject.ts
git commit -m "feat: 切换 subject 记录离开页并恢复目标页（修切换器不导航的 Page not found）"
```

---

### Task 4: 文档同步

**Files:**
- Modify: `CLAUDE.md`（根 changelog）
- Modify: `src/lib/CLAUDE.md`（如存在 lib 文件清单则加 `subject-nav.ts`）
- Modify: `src/components/CLAUDE.md`（changelog 追加一行）

**Interfaces:** 无（纯文档）

- [ ] **Step 1: 根 `CLAUDE.md` 第九节 Changelog 末尾加一行**

```markdown
| 2026-06-30 | Per-subject 上次页面记忆 | 切换 subject 时在 `useSwitchSubject` 边界记录离开页（仅 `/wiki/*`、`/sources/*`）并恢复目标 subject 上次页面（无则回退仪表盘），修掉「⌘O 切换器不导航 → 跨主题 Page not found」；`ui-store` 加 `lastPageBySubject`（persist v5→v6）+ 删死字段 `activePageSlug`；新增纯函数 `lib/subject-nav.ts`（`isRememberablePath`/`withSubjectParam` + 单测）。纯前端零后端改动。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-30-per-subject-last-page-restore* |
```

- [ ] **Step 2: `src/lib/CLAUDE.md` 登记新文件**

在 lib 的文件清单/职责处加 `subject-nav.ts`（`isRememberablePath`/`withSubjectParam`：subject 切换的可记忆路径判定与 `?s=` 拼接）。若该文档结构不含逐文件清单，则在合适位置补一句即可。

- [ ] **Step 3: `src/components/CLAUDE.md` Changelog 追加一行**

```markdown
| 2026-06-30 | Per-subject 上次页面记忆 | `hooks/use-switch-subject` 改为切换边界「记录离开页 + 恢复目标页 + 选中当前 subject no-op」；消费 `lib/subject-nav` 与 `ui-store.lastPageBySubject`/`rememberPage`；`subject-switcher`/`subjects` 卡片/`subject-dialog` 调用点无需改动。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-30-per-subject-last-page-restore* |
```

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md src/lib/CLAUDE.md src/components/CLAUDE.md
git commit -m "docs: 同步 per-subject 上次页面记忆的模块文档与 changelog"
```

---

### Task 5: 端到端手动验证

**Files:** 无（验证）

**Interfaces:** 无

- [ ] **Step 1: 全量自动化校验**

Run: `npx tsc --noEmit; echo EXIT=$?` → `EXIT=0`
Run: `npx vitest run` → 全过（含新 `subject-nav` 用例）

- [ ] **Step 2: 起 dev 跑手动场景**（仅 Next.js，无需 worker，不触发 LLM/ingest，不污染 vault）

Run: `npm run dev`，浏览器按下列场景核对：

1. 在 subject A 打开某 `/wiki/foo`，按 ⌘O 切到一个空 subject B → 落 `/`（仪表盘），**不再** Page not found。
2. 在 B 打开 `/wiki/bar`，切回 A → 落 A 上次页（`/wiki/foo`，URL 带 `?s=<A.slug>`）；再切回 B → 落 `/wiki/bar`。
3. 在 `/tags` 时切到 A → A 落其上次记住的 wiki 页（`/tags` 未被记成 A 的页）。
4. 管理页（`/subjects`）点有内容 subject 卡片 → 跳其上次页面；点新建的空 subject 卡片 → 落 `/`。
5. 刷新浏览器后重复 2，记忆仍在（persist 生效）。

- [ ] **Step 3: 复查主仓库工作树无泄漏**

```bash
git -C /Users/nickhopps/Documents/playground/agentic-wiki status -sb
```

Expected：除既有的 `M src/stores/ui-store.ts`（CONTEXT_PANEL_WIDTH 用户改动，非本需求）与 `?? IDEAS.md` 外，无本需求文件意外落到主仓库（本需求改动应只在 worktree 分支）。
