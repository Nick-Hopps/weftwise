# Subject 创建与管理体验改善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把新建 subject 流程与 `(app)/subjects` 管理页重做为一致、可发现、引导清晰的体验——统一创建/编辑弹窗、可点击进入的卡片、英文化文案、友好空态。

**Architecture:** 新增一个全局挂载、由 `ui-store` 瞬态状态驱动的统一弹窗 `<SubjectDialog />`（create/edit/delete 共用），任何入口经 `openSubjectDialog` 唤起；切换 subject 逻辑抽成共享 hook `useSwitchSubject`，被切换器与管理页卡片复用；管理页卡片整卡可点=进入工作区，gear 图标=打开编辑弹窗。**全程零后端/DB/接口/schema 改动**（创建时的非默认增益强度由前端在 POST 成功后补一次 PATCH 实现）。

**Tech Stack:** Next.js 15 App Router + React 19 + TypeScript 5、Zustand（persist）、TanStack React Query、Tailwind + class-variance-authority、lucide-react、vitest。

## Global Constraints

- **UI 文案一律英文**；代码注释用中文；git commit message 用中文一句话总结。
- **禁止** AI 署名 trailer（无 `Co-Authored-By: Claude` / "Generated with Claude Code"）。
- **不改任何后端**：`/api/*`、Drizzle schema、`contracts.ts` 均不动（增益常量放 `src/lib/augmentation.ts`）。
- 创建 subject 时若选了非默认增益强度，前端在 `POST /api/subjects` 成功后再补 `PATCH /api/subjects/[id]`（`POST` 不接受 `augmentationLevel`）。
- 弹窗瞬态状态 `subjectDialog` **不进** `ui-store` 的 `partialize`（与 `settingsDialogOpen` 一致，不持久化）；不新增 store 版本迁移。
- 复用既有手写弹窗模式（不抽通用 `Dialog` 原语）：遮罩 `fixed inset-0 z-command flex items-start justify-center pt-[12vh] bg-overlay/40 backdrop-blur-sm animate-fade-in` + 内层 `role="dialog" aria-modal="true"` `animate-slide-down`。
- 校验手段：`npx tsc --noEmit`（0 error）+ `npx vitest run`（保持绿）；**`npm run lint` 不可用，禁止使用**。
- 路径别名 `@/*` → `src/*`（tsc 与 vitest 均已配置）。

---

## File Structure

**新增**

- `src/lib/augmentation.ts` — 增益强度档位的英文展示元数据（纯数据 + label 取值函数，无 React，可单测）。
- `src/lib/__tests__/augmentation.test.ts` — 上述纯函数测试。
- `src/hooks/use-switch-subject.ts` — 共享"切换 subject"hook（含 `INVALIDATE_KEYS`）。
- `src/components/subjects/subjects-api.ts` — subjects 的 fetch 帮助函数（list/create/patch/delete），供弹窗与管理页共用。
- `src/components/subjects/augmentation-field.tsx` — 英文分段增益强度选择控件。
- `src/components/subjects/subject-dialog.tsx` — 统一创建/编辑/删除弹窗。

**改动**

- `src/stores/ui-store.ts` — 加瞬态 `subjectDialog` 状态 + `openSubjectDialog`/`closeSubjectDialog`。
- `src/components/layout/subject-switcher.tsx` — "New subject…" 改唤起弹窗；切换改用 `useSwitchSubject`；移除内联 `INVALIDATE_KEYS`。
- `src/components/providers.tsx` — 挂载 `<SubjectDialog />`。
- `src/app/(app)/subjects/page.tsx` — 整页重做（可点卡片 + gear + 空态；删除内联表单/select/window.confirm/`?new=1`）。
- 文档 changelog：根 `CLAUDE.md`、`src/app/CLAUDE.md`、`src/components/CLAUDE.md`。

---

## Task 1: 增益强度展示元数据（`lib/augmentation.ts`）+ 测试

**Files:**
- Create: `src/lib/augmentation.ts`
- Test: `src/lib/__tests__/augmentation.test.ts`

**Interfaces:**
- Consumes: `AugmentationLevel`、`AugmentationLevelSchema` from `@/lib/contracts`。
- Produces:
  - `interface AugmentationOption { value: AugmentationLevel; label: string; helper: string }`
  - `const AUGMENTATION_OPTIONS: AugmentationOption[]`（顺序 off/light/standard/deep）
  - `function augmentationLabel(level: AugmentationLevel): string`

- [ ] **Step 1: 写失败测试**

`src/lib/__tests__/augmentation.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { AugmentationLevelSchema } from '@/lib/contracts';
import { AUGMENTATION_OPTIONS, augmentationLabel } from '@/lib/augmentation';

describe('AUGMENTATION_OPTIONS', () => {
  it('覆盖契约里全部增益档位且不多不少', () => {
    const optionValues = [...AUGMENTATION_OPTIONS.map((o) => o.value)].sort();
    const schemaValues = [...AugmentationLevelSchema.options].sort();
    expect(optionValues).toEqual(schemaValues);
  });

  it('每档都有非空 label 与 helper', () => {
    for (const o of AUGMENTATION_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.helper.length).toBeGreaterThan(0);
    }
  });

  it('augmentationLabel 返回对应 label', () => {
    expect(augmentationLabel('standard')).toBe('Standard');
    expect(augmentationLabel('off')).toBe('Off');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/lib/__tests__/augmentation.test.ts`
Expected: FAIL —— 无法解析模块 `@/lib/augmentation`（Cannot find module）。

- [ ] **Step 3: 实现 `src/lib/augmentation.ts`**

```ts
import type { AugmentationLevel } from '@/lib/contracts';

export interface AugmentationOption {
  value: AugmentationLevel;
  label: string;
  helper: string;
}

/** 增益强度档位的英文展示元数据（UI 单一来源）。顺序即 UI 呈现顺序。*/
export const AUGMENTATION_OPTIONS: AugmentationOption[] = [
  { value: 'off', label: 'Off', helper: 'Faithful only' },
  { value: 'light', label: 'Light', helper: 'Light touch' },
  { value: 'standard', label: 'Standard', helper: 'Balanced (default)' },
  { value: 'deep', label: 'Deep', helper: 'Rich elaboration' },
];

const LABEL_BY_VALUE: Record<AugmentationLevel, string> = AUGMENTATION_OPTIONS.reduce(
  (acc, o) => {
    acc[o.value] = o.label;
    return acc;
  },
  {} as Record<AugmentationLevel, string>,
);

/** 取某档位的英文短标签（管理页卡片元信息行用）。*/
export function augmentationLabel(level: AugmentationLevel): string {
  return LABEL_BY_VALUE[level] ?? level;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/lib/__tests__/augmentation.test.ts`
Expected: PASS（3 tests）。

- [ ] **Step 5: 提交**

```bash
git add src/lib/augmentation.ts src/lib/__tests__/augmentation.test.ts
git commit -m "feat(subject-ux): 新增增益强度英文展示元数据与测试"
```

---

## Task 2: `ui-store` 增加弹窗瞬态状态

**Files:**
- Modify: `src/stores/ui-store.ts`

**Interfaces:**
- Produces（`UIState` 新增）：
  - `subjectDialog: { open: boolean; mode: 'create' | 'edit'; subjectId: string | null }`
  - `openSubjectDialog: (args: { mode: 'create' } | { mode: 'edit'; subjectId: string }) => void`
  - `closeSubjectDialog: () => void`

- [ ] **Step 1: 在 `UIState` 接口加字段**

在 `src/stores/ui-store.ts` 的 `interface UIState` 中，`settingsDialogOpen: boolean;` 行下方插入：

```ts
  /** 创建/编辑 subject 弹窗的瞬态状态（不持久化）。*/
  subjectDialog: { open: boolean; mode: 'create' | 'edit'; subjectId: string | null };
```

并在 `closeSettingsDialog: () => void;` 行下方插入两个 action 声明：

```ts
  openSubjectDialog: (args: { mode: 'create' } | { mode: 'edit'; subjectId: string }) => void;
  closeSubjectDialog: () => void;
```

- [ ] **Step 2: 在 store 初始 state 加默认值**

在 `create` 的初始对象里，`settingsDialogOpen: false,` 行下方插入：

```ts
      subjectDialog: { open: false, mode: 'create', subjectId: null },
```

- [ ] **Step 3: 实现两个 action**

在 `closeSettingsDialog: () => set({ settingsDialogOpen: false }),` 行下方插入：

```ts
      openSubjectDialog: (args) =>
        set({
          subjectDialog: {
            open: true,
            mode: args.mode,
            subjectId: args.mode === 'edit' ? args.subjectId : null,
          },
        }),
      closeSubjectDialog: () =>
        set((s) => ({ subjectDialog: { ...s.subjectDialog, open: false } })),
```

- [ ] **Step 4: 确认 `partialize` 未包含 `subjectDialog`**

检查 `partialize: (s) => ({ ... })`——其白名单当前为 `darkMode/contextPanelOpen/contextPanelTab/sidebarWidth/currentSubjectId/currentSubjectSlug/currentConversationId`。**不要**添加 `subjectDialog`（瞬态，不持久化，与 `settingsDialogOpen` 处理一致）。无需改 `version`/`migrate`。

- [ ] **Step 5: 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 error。

- [ ] **Step 6: 提交**

```bash
git add src/stores/ui-store.ts
git commit -m "feat(subject-ux): ui-store 增加 subject 弹窗瞬态状态"
```

---

## Task 3: `useSwitchSubject` hook + 改造切换器

**Files:**
- Create: `src/hooks/use-switch-subject.ts`
- Modify: `src/components/layout/subject-switcher.tsx`

**Interfaces:**
- Consumes: `useCurrentSubject` from `@/hooks/use-current-subject`、`useUIStore.openSubjectDialog`（Task 2）。
- Produces: `function useSwitchSubject(): (subject: { id: string; slug: string }, opts?: { navigateTo?: string }) => void`

- [ ] **Step 1: 实现 `src/hooks/use-switch-subject.ts`**

```ts
'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useCurrentSubject } from '@/hooks/use-current-subject';

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
 * 统一的"切换到某 subject"动作：写 store + cookie（经 setCurrentSubject）、
 * 失效相关查询、可选导航、刷新 SSR。切换器与管理页卡片共用，保证行为一致。
 */
export function useSwitchSubject() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setCurrentSubject } = useCurrentSubject();

  return useCallback(
    (subject: { id: string; slug: string }, opts?: { navigateTo?: string }) => {
      setCurrentSubject({ id: subject.id, slug: subject.slug });
      for (const key of INVALIDATE_KEYS) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
      if (opts?.navigateTo) {
        router.push(opts.navigateTo);
      }
      // 服务端组件（仪表盘 / wiki 页）按 cookie + ?s= 读取激活 subject，刷新当前路由让其重渲染。
      router.refresh();
    },
    [queryClient, router, setCurrentSubject],
  );
}
```

- [ ] **Step 2: 改造 `subject-switcher.tsx`——切换逻辑复用 hook，New subject 改唤起弹窗**

在 `subject-switcher.tsx` 中做以下替换。

(a) 顶部 import：移除不再需要的内联常量、补 hook 与 store。把现有的

```ts
import { apiFetch } from '@/lib/api-fetch';
import type { SubjectListEntry } from '@/lib/contracts';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Kbd } from '@/components/ui/kbd';
```

改为（保留 `apiFetch`/类型/`Kbd`/`Separator`/`cn` 原有 import 不动，**新增**两行）：

```ts
import { useSwitchSubject } from '@/hooks/use-switch-subject';
import { useUIStore } from '@/stores/ui-store';
```

(b) 删除模块顶部的 `INVALIDATE_KEYS` 常量块（已移入 hook）：

```ts
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
```

(c) 组件内：把

```ts
  const router = useRouter();
  const queryClient = useQueryClient();
  const { id: currentSubjectId, slug: currentSubjectSlug, setCurrentSubject } =
    useCurrentSubject();
```

改为：

```ts
  const router = useRouter();
  const switchSubject = useSwitchSubject();
  const openSubjectDialog = useUIStore((s) => s.openSubjectDialog);
  const { id: currentSubjectId, slug: currentSubjectSlug } = useCurrentSubject();
```

（`useQueryClient` import 此文件中若已无其它用处，一并从 import 行移除；`setCurrentSubject` 不再直接用。）

(d) 把整个 `handleSelect` 替换为：

```ts
  const handleSelect = useCallback(
    (subject: SubjectListEntry) => {
      setOpen(false);
      switchSubject({ id: subject.id, slug: subject.slug });
    },
    [switchSubject],
  );
```

(e) 把 "New subject…" 的 `Command.Item` 的 `onSelect` 由

```ts
                onSelect={() => {
                  setOpen(false);
                  router.push('/subjects?new=1');
                }}
```

改为：

```ts
                onSelect={() => {
                  setOpen(false);
                  openSubjectDialog({ mode: 'create' });
                }}
```

（"Manage subjects" 项保持 `router.push('/subjects')` 不变。）

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 error（若报 `useQueryClient`/`setCurrentSubject` 未使用，确认已按 (c) 清理 import 与解构）。

- [ ] **Step 4: 提交**

```bash
git add src/hooks/use-switch-subject.ts src/components/layout/subject-switcher.tsx
git commit -m "feat(subject-ux): 抽出 useSwitchSubject hook 并改造切换器唤起弹窗"
```

---

## Task 4: subjects API 帮助函数 + 增益强度控件

**Files:**
- Create: `src/components/subjects/subjects-api.ts`
- Create: `src/components/subjects/augmentation-field.tsx`

**Interfaces:**
- Consumes: `apiFetch`、`AUGMENTATION_OPTIONS`（Task 1）、`DEFAULT_AUGMENTATION_LEVEL`/`AugmentationLevel`/`SubjectListEntry` from contracts。
- Produces:
  - `subjects-api.ts`：`fetchSubjects()`、`createSubject(payload: CreateSubjectPayload)`、`patchSubject(payload: PatchSubjectPayload)`、`deleteSubject(id)`；类型 `CreateSubjectPayload`/`PatchSubjectPayload`。
  - `augmentation-field.tsx`：`<AugmentationField value onChange disabled? />`。

- [ ] **Step 1: 实现 `src/components/subjects/subjects-api.ts`**

```ts
import { apiFetch } from '@/lib/api-fetch';
import {
  DEFAULT_AUGMENTATION_LEVEL,
  type AugmentationLevel,
  type SubjectListEntry,
} from '@/lib/contracts';

export interface CreateSubjectPayload {
  slug: string;
  name: string;
  description: string;
  augmentationLevel: AugmentationLevel;
}

export interface PatchSubjectPayload {
  id: string;
  name?: string;
  description?: string;
  augmentationLevel?: AugmentationLevel;
}

export async function fetchSubjects(): Promise<SubjectListEntry[]> {
  const res = await apiFetch('/api/subjects');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 统一解析后端 `{ error }`，回落到 HTTP 状态码。*/
async function readError(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `HTTP ${res.status}`;
}

export async function patchSubject(payload: PatchSubjectPayload): Promise<SubjectListEntry> {
  const { id, ...body } = payload;
  const res = await apiFetch(`/api/subjects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json();
}

export async function createSubject(payload: CreateSubjectPayload): Promise<SubjectListEntry> {
  const res = await apiFetch('/api/subjects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // POST /api/subjects 仅接受 slug/name/description。
    body: JSON.stringify({
      slug: payload.slug,
      name: payload.name,
      description: payload.description,
    }),
  });
  if (!res.ok) throw new Error(await readError(res));
  const subject = (await res.json()) as SubjectListEntry;
  // 非默认增益强度：补一次 PATCH（避免改后端 POST schema）。
  if (payload.augmentationLevel !== DEFAULT_AUGMENTATION_LEVEL) {
    return patchSubject({ id: subject.id, augmentationLevel: payload.augmentationLevel });
  }
  return subject;
}

export async function deleteSubject(id: string): Promise<void> {
  const res = await apiFetch(`/api/subjects/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(await readError(res));
}
```

- [ ] **Step 2: 实现 `src/components/subjects/augmentation-field.tsx`**

```tsx
'use client';

import { AUGMENTATION_OPTIONS } from '@/lib/augmentation';
import type { AugmentationLevel } from '@/lib/contracts';
import { cn } from '@/lib/cn';

/** 英文分段增益强度选择控件（2×2 网格，radiogroup 语义）。*/
export function AugmentationField({
  value,
  onChange,
  disabled,
}: {
  value: AugmentationLevel;
  onChange: (next: AugmentationLevel) => void;
  disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label="Augmentation level" className="grid grid-cols-2 gap-2">
      {AUGMENTATION_OPTIONS.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              'flex flex-col items-start gap-0.5 rounded-md border px-3 py-2 text-left transition-colors focus-ring',
              'disabled:opacity-50 disabled:pointer-events-none',
              active
                ? 'border-accent bg-accent-subtle'
                : 'border-border bg-surface hover:bg-subtle hover:border-border-strong',
            )}
          >
            <span className="text-xs font-medium text-foreground">{opt.label}</span>
            <span className="text-[11px] text-foreground-tertiary">{opt.helper}</span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 error。

- [ ] **Step 4: 提交**

```bash
git add src/components/subjects/subjects-api.ts src/components/subjects/augmentation-field.tsx
git commit -m "feat(subject-ux): 新增 subjects API 帮助函数与增益强度控件"
```

---

## Task 5: 统一弹窗 `SubjectDialog` + 全局挂载

**Files:**
- Create: `src/components/subjects/subject-dialog.tsx`
- Modify: `src/components/providers.tsx`

**Interfaces:**
- Consumes: `useUIStore`（`subjectDialog`/`closeSubjectDialog`，Task 2）、`useSwitchSubject`（Task 3）、`useCurrentSubject`、`fetchSubjects`/`createSubject`/`patchSubject`/`deleteSubject`（Task 4）、`AugmentationField`（Task 4）、`normalizeSubjectSlug`、`DEFAULT_AUGMENTATION_LEVEL`/`AugmentationLevel`。
- Produces: `export function SubjectDialog()`（无 props，全局单例）。

- [ ] **Step 1: 实现 `src/components/subjects/subject-dialog.tsx`**

```tsx
'use client';

/**
 * SubjectDialog —— 创建/编辑 subject 的统一弹窗（含删除）。
 * 由 ui-store 的瞬态 subjectDialog 状态驱动，全局挂载一次（providers.tsx）。
 * 任何入口（切换器/管理页/空态）经 openSubjectDialog 唤起，已删掉 ?new=1 跳转。
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Trash2, ChevronRight } from 'lucide-react';
import { normalizeSubjectSlug } from '@/lib/slug';
import { DEFAULT_AUGMENTATION_LEVEL, type AugmentationLevel } from '@/lib/contracts';
import { useUIStore } from '@/stores/ui-store';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useSwitchSubject } from '@/hooks/use-switch-subject';
import {
  fetchSubjects,
  createSubject,
  patchSubject,
  deleteSubject,
} from '@/components/subjects/subjects-api';
import { AugmentationField } from '@/components/subjects/augmentation-field';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';

const SUBJECTS_QUERY_KEY = ['subjects'] as const;

export function SubjectDialog() {
  const dialog = useUIStore((s) => s.subjectDialog);
  const close = useUIStore((s) => s.closeSubjectDialog);

  useEffect(() => {
    if (!dialog.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog.open, close]);

  if (!dialog.open) return null;

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="fixed inset-0 z-command flex items-start justify-center pt-[12vh] bg-overlay/40 backdrop-blur-sm animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="subject-dialog-title"
        className="w-full max-w-md mx-4 flex flex-col bg-surface rounded-lg shadow-lg border border-border overflow-hidden animate-slide-down"
      >
        {dialog.mode === 'create' ? (
          <CreateSubjectBody onClose={close} />
        ) : (
          <EditSubjectBody subjectId={dialog.subjectId} onClose={close} />
        )}
      </div>
    </div>
  );
}

function DialogHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between h-12 shrink-0 px-4 border-b border-border">
      <h2 id="subject-dialog-title" className="text-sm font-semibold text-foreground">
        {title}
      </h2>
      <IconButton size="sm" onClick={onClose} aria-label="Close">
        <X />
      </IconButton>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-foreground-secondary mb-1">
        {label}
        {hint && <span className="ml-1 font-normal text-foreground-tertiary">({hint})</span>}
      </label>
      {children}
    </div>
  );
}

function CreateSubjectBody({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const switchSubject = useSwitchSubject();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [augmentation, setAugmentation] = useState<AugmentationLevel>(DEFAULT_AUGMENTATION_LEVEL);
  const [error, setError] = useState<string | null>(null);

  const effectiveSlug = slug || normalizeSubjectSlug(name);

  const mutation = useMutation({
    mutationFn: createSubject,
    onSuccess: (subject) => {
      queryClient.invalidateQueries({ queryKey: SUBJECTS_QUERY_KEY });
      onClose();
      // 创建后自动切入新 subject 并落到仪表盘（空态 ingest hero 引导加内容）。
      switchSubject({ id: subject.id, slug: subject.slug }, { navigateTo: '/' });
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!effectiveSlug) {
      setError('Could not derive a URL slug from the name — customize it below.');
      setCustomizeOpen(true);
      return;
    }
    mutation.mutate({
      slug: effectiveSlug,
      name: name.trim(),
      description: description.trim(),
      augmentationLevel: augmentation,
    });
  };

  return (
    <>
      <DialogHeader title="New subject" onClose={onClose} />
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        <Field label="Name">
          <Input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(normalizeSubjectSlug(e.target.value));
            }}
            placeholder="e.g. Frontend Architecture"
          />
        </Field>

        <div>
          <p className="text-xs text-foreground-secondary">
            URL: <code className="font-mono text-foreground">{effectiveSlug || 'subject'}</code>
          </p>
          {!customizeOpen ? (
            <button
              type="button"
              onClick={() => setCustomizeOpen(true)}
              className="mt-1 inline-flex items-center gap-1 rounded text-[11px] text-foreground-tertiary hover:text-foreground focus-ring"
            >
              <ChevronRight className="h-3 w-3" />
              Customize slug
            </button>
          ) : (
            <div className="mt-2">
              <Input
                value={slug}
                onChange={(e) => {
                  setSlug(normalizeSubjectSlug(e.target.value));
                  setSlugTouched(true);
                }}
                placeholder="frontend-architecture"
                className="font-mono text-xs"
                aria-label="Slug"
              />
              <p className="mt-1 text-[11px] text-foreground-tertiary">
                Used in URLs and cross-subject links:{' '}
                <code className="font-mono">[[{effectiveSlug || 'subject'}:page]]</code>
              </p>
            </div>
          )}
        </div>

        <Field label="Description" hint="optional">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>

        <Field label="Augmentation">
          <AugmentationField
            value={augmentation}
            onChange={setAugmentation}
            disabled={mutation.isPending}
          />
        </Field>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button intent="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button intent="primary" type="submit" loading={mutation.isPending}>
            Create
          </Button>
        </div>
      </form>
    </>
  );
}

function EditSubjectBody({
  subjectId,
  onClose,
}: {
  subjectId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { id: currentSubjectId } = useCurrentSubject();

  const { data: subjects = [] } = useQuery({
    queryKey: SUBJECTS_QUERY_KEY,
    queryFn: fetchSubjects,
    staleTime: 10_000,
  });
  const subject = useMemo(
    () => subjects.find((s) => s.id === subjectId),
    [subjects, subjectId],
  );

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [augmentation, setAugmentation] = useState<AugmentationLevel>(DEFAULT_AUGMENTATION_LEVEL);
  const [error, setError] = useState<string | null>(null);
  const [confirmArmed, setConfirmArmed] = useState(false);

  // 载入/切换目标 subject 时回填表单。
  useEffect(() => {
    if (subject) {
      setName(subject.name);
      setDescription(subject.description ?? '');
      setAugmentation(subject.augmentationLevel);
      setError(null);
      setConfirmArmed(false);
    }
  }, [subject?.id, subject?.name, subject?.description, subject?.augmentationLevel]);

  const patchMutation = useMutation({
    mutationFn: patchSubject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SUBJECTS_QUERY_KEY });
      if (subjectId === currentSubjectId) router.refresh();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSubject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SUBJECTS_QUERY_KEY });
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message);
      setConfirmArmed(false);
    },
  });

  if (!subject) {
    return (
      <>
        <DialogHeader title="Subject settings" onClose={onClose} />
        <div className="p-4 text-sm text-foreground-tertiary">Loading…</div>
      </>
    );
  }

  const isActive = subject.id === currentSubjectId;
  const canDelete = subject.pageCount === 0 && !isActive;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    patchMutation.mutate({
      id: subject.id,
      name: name.trim(),
      description: description.trim(),
      augmentationLevel: augmentation,
    });
  };

  return (
    <>
      <DialogHeader title="Subject settings" onClose={onClose} />
      <form onSubmit={handleSubmit} className="p-4 space-y-4">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Slug">
          <code className="block rounded-md bg-subtle px-2 py-1.5 font-mono text-xs text-foreground-secondary">
            {subject.slug}
          </code>
          <p className="mt-1 text-[11px] text-foreground-tertiary">
            The slug can&apos;t be changed after creation.
          </p>
        </Field>

        <Field label="Description" hint="optional">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>

        <Field label="Augmentation">
          <AugmentationField
            value={augmentation}
            onChange={setAugmentation}
            disabled={patchMutation.isPending}
          />
        </Field>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button intent="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button intent="primary" type="submit" loading={patchMutation.isPending}>
            Save
          </Button>
        </div>
      </form>

      <div className="border-t border-border bg-subtle/40 px-4 py-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-foreground-tertiary">
          Danger zone
        </p>
        {canDelete ? (
          <Button
            intent={confirmArmed ? 'danger' : 'outline'}
            size="sm"
            type="button"
            loading={deleteMutation.isPending}
            onClick={() => {
              if (!confirmArmed) {
                setConfirmArmed(true);
                return;
              }
              deleteMutation.mutate(subject.id);
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {confirmArmed ? 'Click again to confirm' : 'Delete subject'}
          </Button>
        ) : (
          <p className="text-xs text-foreground-tertiary">
            {isActive
              ? 'This subject is currently active. Switch to another subject before deleting.'
              : `This subject has ${subject.pageCount} ${
                  subject.pageCount === 1 ? 'page' : 'pages'
                }. Empty it first.`}
          </p>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 2: 在 `providers.tsx` 挂载 `<SubjectDialog />`**

在 `src/components/providers.tsx` 顶部 import 区，`SettingsDialog` import 行下方加：

```ts
import { SubjectDialog } from '@/components/subjects/subject-dialog';
```

在 JSX 中 `<SettingsDialog />` 行下方加：

```tsx
      <SubjectDialog />
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 error。

- [ ] **Step 4: 手动验证（开发服务器）**

Run: `npm run dev`（另开终端）。
Expected：
1. 顶栏 ⌘O → 切换器 → "New subject…" → 弹出 "New subject" 弹窗（无 URL 变 `?new=1`）。
2. 输入 Name "Test Subject" → URL 自动显示 `test-subject`；点 "Customize slug" 展开可改。
3. 选 Augmentation = Deep → Create → 自动切到新 subject + 跳到仪表盘空态。
4. Esc / 点遮罩 / Cancel 均能关闭弹窗。

- [ ] **Step 5: 提交**

```bash
git add src/components/subjects/subject-dialog.tsx src/components/providers.tsx
git commit -m "feat(subject-ux): 新增统一创建/编辑/删除弹窗并全局挂载"
```

---

## Task 6: 重做管理页 `(app)/subjects/page.tsx`

**Files:**
- Modify (整文件替换): `src/app/(app)/subjects/page.tsx`

**Interfaces:**
- Consumes: `useUIStore.openSubjectDialog`（Task 2）、`useSwitchSubject`（Task 3）、`fetchSubjects`（Task 4）、`augmentationLabel`（Task 1）、`useCurrentSubject`。
- Produces: 默认导出 `SubjectsPage`（无内联创建/编辑表单、无 `window.confirm`、无 `?new=1`）。

- [ ] **Step 1: 用以下内容整体替换 `src/app/(app)/subjects/page.tsx`**

```tsx
'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Layers, Plus, Settings } from 'lucide-react';
import type { SubjectListEntry } from '@/lib/contracts';
import { useUIStore } from '@/stores/ui-store';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useSwitchSubject } from '@/hooks/use-switch-subject';
import { fetchSubjects } from '@/components/subjects/subjects-api';
import { augmentationLabel } from '@/lib/augmentation';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Tag } from '@/components/ui/tag';
import { cn } from '@/lib/cn';

const SUBJECTS_QUERY_KEY = ['subjects'] as const;

export default function SubjectsPage() {
  const { id: currentSubjectId } = useCurrentSubject();
  const openSubjectDialog = useUIStore((s) => s.openSubjectDialog);
  const switchSubject = useSwitchSubject();

  const { data: subjects = [], isLoading } = useQuery({
    queryKey: SUBJECTS_QUERY_KEY,
    queryFn: fetchSubjects,
    staleTime: 10_000,
  });

  const sortedSubjects = useMemo(
    () => [...subjects].sort((a, b) => a.name.localeCompare(b.name)),
    [subjects],
  );

  return (
    <div className="max-w-content mx-auto w-full space-y-6 px-6 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <Layers className="h-5 w-5 text-foreground-tertiary" />
            Subjects
          </h1>
          <p className="mt-1 text-sm text-foreground-secondary">
            Each subject is an isolated workspace with its own pages, sources, and graph.
          </p>
        </div>
        <Button intent="primary" onClick={() => openSubjectDialog({ mode: 'create' })}>
          <Plus className="h-3.5 w-3.5" />
          New subject
        </Button>
      </header>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-md border border-border bg-subtle" />
          ))}
        </div>
      ) : sortedSubjects.length === 0 ? (
        <EmptyState onCreate={() => openSubjectDialog({ mode: 'create' })} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sortedSubjects.map((subject) => (
            <li key={subject.id}>
              <SubjectCard
                subject={subject}
                isActive={subject.id === currentSubjectId}
                onOpen={() =>
                  switchSubject({ id: subject.id, slug: subject.slug }, { navigateTo: '/' })
                }
                onSettings={() => openSubjectDialog({ mode: 'edit', subjectId: subject.id })}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-surface px-6 py-14 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-subtle">
        <Layers className="h-6 w-6 text-foreground-tertiary" />
      </div>
      <h2 className="text-sm font-semibold text-foreground">No subjects yet</h2>
      <p className="mt-1 max-w-sm text-sm text-foreground-secondary">
        A subject is an isolated workspace for one area of knowledge. Create your first one to start
        adding content.
      </p>
      <Button intent="primary" className="mt-4" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5" />
        Create your first subject
      </Button>
    </div>
  );
}

function SubjectCard({
  subject,
  isActive,
  onOpen,
  onSettings,
}: {
  subject: SubjectListEntry;
  isActive: boolean;
  onOpen: () => void;
  onSettings: () => void;
}) {
  return (
    <div
      className={cn(
        'group relative h-full rounded-md border transition-colors',
        isActive
          ? 'border-accent/40 bg-accent-subtle/30'
          : 'border-border bg-surface hover:border-border-strong hover:bg-subtle',
      )}
    >
      {/* gear：编辑入口，浮于卡片之上，阻止冒泡到主体按钮。*/}
      <IconButton
        size="sm"
        aria-label={`Settings for ${subject.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onSettings();
        }}
        className="absolute right-2 top-2 z-10 text-foreground-tertiary"
      >
        <Settings />
      </IconButton>

      {/* 主体可点：切换并进入该工作区。*/}
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full w-full flex-col gap-2 rounded-md p-4 pr-10 text-left focus-ring"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Layers className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary" />
          <span className="truncate text-sm font-semibold text-foreground">{subject.name}</span>
          {isActive && (
            <Tag tone="accent" size="sm">
              Active
            </Tag>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-foreground-tertiary">
          <span className="tabular-nums">
            {subject.pageCount} {subject.pageCount === 1 ? 'page' : 'pages'}
          </span>
          <span>·</span>
          <span>{augmentationLabel(subject.augmentationLevel)}</span>
        </div>

        <code className="truncate font-mono text-xs text-foreground-secondary">{subject.slug}</code>

        {subject.description && (
          <p className="line-clamp-2 text-sm text-foreground-secondary">{subject.description}</p>
        )}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 0 error。

- [ ] **Step 3: 手动验证**

开发服务器下访问 `/subjects`：
1. 点卡片主体 → 切到该 subject 并跳仪表盘。
2. 点卡片右上 gear → 打开 "Subject settings" 弹窗（不会触发卡片进入）。
3. 编辑名称/描述/增益 → Save → 卡片更新。
4. 编辑 active subject → Danger zone 显示 "currently active..."，删除按钮不出现。
5. 编辑非空非 active subject → Danger zone 显示 "This subject has N pages..."。
6. 编辑空且非 active subject → "Delete subject" → 变 "Click again to confirm" → 再点删除成功。
7. 头部 "New subject" → 创建弹窗。

- [ ] **Step 4: 提交**

```bash
git add "src/app/(app)/subjects/page.tsx"
git commit -m "feat(subject-ux): 重做 subject 管理页为可点卡片+gear+空态"
```

---

## Task 7: 文档 changelog + 全量验证

**Files:**
- Modify: `CLAUDE.md`、`src/app/CLAUDE.md`、`src/components/CLAUDE.md`

**Interfaces:** 无（仅文档与验证）。

- [ ] **Step 1: 根 `CLAUDE.md` 变更记录追加一行**

在"九、变更记录"表末尾追加（紧跟 `2026-06-28 | 统一阅读页功能菜单 + 英文化` 行之后）：

```markdown
| 2026-06-28 | Subject 创建/管理体验重做 | 新建/编辑收敛为全局统一弹窗 `SubjectDialog`（ui-store 瞬态状态驱动，任意入口 `openSubjectDialog` 唤起，删 `?new=1` 跳转，create 后自动切入+落仪表盘空态）；管理页卡片整卡可点=进入工作区、gear=编辑弹窗；切换逻辑抽 `useSwitchSubject` hook 复用于切换器+卡片；增益强度英文化（`lib/augmentation.ts` 单源 + `AugmentationField` 分段控件）；删除改弹窗内两步确认+禁用态显式文案；纯前端零后端/DB 改动（create 非默认增益经 POST 后补 PATCH）。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-28-subject-ux-improvement* |
```

- [ ] **Step 2: `src/app/CLAUDE.md` 更新 subjects 页描述**

把 `(app)/subjects/page.tsx` 那一行的描述改为：

```markdown
| `(app)/subjects/page.tsx` | 🔀 Subject 管理页：可点卡片网格（点主体=切换并进入工作区，右上 gear=打开统一编辑弹窗）+ 友好空态；创建/编辑/删除收敛到全局 `SubjectDialog`（不再有内联表单/`window.confirm`/`?new=1`）|
```

并在该文件"变更记录"表末尾追加：

```markdown
| 2026-06-28 | Subject 体验重做：`(app)/subjects/page.tsx` 改可点卡片+gear+空态；创建/编辑/删除迁到全局 `SubjectDialog`（`src/components/subjects/`），切换器 "New subject…" 改唤起弹窗（删 `?new=1`）。零 API 改动 |
```

- [ ] **Step 3: `src/components/CLAUDE.md` 登记新组件**

在 `layout/` 表里 `subject-switcher.tsx` 行的描述末尾补：`；"New subject…" 改调 openSubjectDialog（删 ?new=1），切换复用 useSwitchSubject`。

并在"相关文件清单"的目录树中新增一行（`tags/` 行附近，按字母序）：

```
├── subjects/     {subject-dialog, augmentation-field, subjects-api}
```

并在"变更记录"表末尾追加：

```markdown
| 2026-06-28 | Subject 体验重做：新增 `subjects/`（`subject-dialog` 统一创建/编辑/删除弹窗 + `augmentation-field` 英文分段控件 + `subjects-api` 共用 fetch）；新增 hook `use-switch-subject`（切换器+管理页卡片复用）；`providers.tsx` 挂载 `<SubjectDialog />`；ui-store 加瞬态 `subjectDialog`。spec/plan 见 docs/superpowers/{specs,plans}/2026-06-28-subject-ux-improvement* |
```

- [ ] **Step 4: 全量类型检查**

Run: `npx tsc --noEmit`
Expected: 0 error。

- [ ] **Step 5: 全量测试**

Run: `npx vitest run`
Expected: 全绿（≥ 636 + 3 新增 = 639 passing），0 失败。

- [ ] **Step 6: 端到端手动走查清单（开发服务器）**

确认下列全部通过：
- [ ] 切换器 "New subject…" 唤起弹窗，URL 不含 `?new=1`。
- [ ] 创建（默认增益）→ 自动切入 + 落仪表盘空态（DashboardIngestHero 可见）。
- [ ] 创建（选 Deep 增益）→ 新 subject 的卡片元信息显示 `Deep`（验证 POST 后补 PATCH 生效）。
- [ ] 管理页点卡片主体 → 进入工作区；点 gear → 编辑弹窗（互不串触）。
- [ ] 编辑保存后卡片实时更新；编辑 active subject 后顶栏名称同步。
- [ ] 删除：active / 非空 → 显式禁用文案；空且非 active → 两步确认删除成功。
- [ ] 增益控件四档全英文、无中文残留。
- [ ] 暗色模式下弹窗/卡片对比正常。

- [ ] **Step 7: 提交**

```bash
git add CLAUDE.md src/app/CLAUDE.md src/components/CLAUDE.md
git commit -m "docs(subject-ux): 更新根/app/components 变更记录"
```

---

## Self-Review（已完成，记录备查）

**1. Spec coverage**

| Spec 要求 | 对应 Task |
|---|---|
| 统一全局弹窗 + 删 `?new=1` | Task 2（状态）/ Task 5（弹窗）/ Task 3（切换器改 New 入口）|
| slug 渐进式（默认只读预览 + Customize 折叠）| Task 5 `CreateSubjectBody` |
| 创建时选增益（英文）| Task 1（数据）/ Task 4（控件）/ Task 5（接入，POST 后补 PATCH）|
| 创建后自动切入 + 跳仪表盘 | Task 5（`switchSubject(..., { navigateTo:'/' })`）|
| 卡片整卡可点=进入 + gear=编辑 | Task 6 |
| 切换逻辑共享 hook | Task 3 |
| 删除两步确认 + 显式禁用文案 | Task 5 `EditSubjectBody` Danger zone |
| 增益英文化 | Task 1 / Task 4 |
| 友好空态 + CTA | Task 6 `EmptyState` |
| 边界：slug 冲突 409 / 删除 409 / active 不可删 | Task 4（`readError`）/ Task 5 |
| 测试与文档 | Task 1（vitest）/ Task 7 |

无遗漏。

**2. Placeholder scan**：全部 step 含完整代码/命令/预期，无 TBD/TODO/"add error handling" 之类占位。

**3. Type consistency**：
- `useSwitchSubject(): (subject:{id,slug}, opts?:{navigateTo?}) => void` —— Task 3 定义，Task 5/6 一致调用。
- `subjectDialog`/`openSubjectDialog`/`closeSubjectDialog` —— Task 2 定义，Task 3/5/6 一致使用（`openSubjectDialog({mode:'create'})` 与 `{mode:'edit',subjectId}`）。
- `CreateSubjectPayload`（含 `augmentationLevel`）/`PatchSubjectPayload`/`fetchSubjects/createSubject/patchSubject/deleteSubject` —— Task 4 定义，Task 5/6 一致使用。
- `AUGMENTATION_OPTIONS`/`augmentationLabel` —— Task 1 定义，Task 4/6 一致使用。
- `<AugmentationField value onChange disabled? />` —— Task 4 定义，Task 5 一致使用。
- `SUBJECTS_QUERY_KEY = ['subjects']` —— Task 5/6 各自局部定义，值一致（与现有切换器 `['subjects']` 一致）。

一致，无签名漂移。
