# Settings 表单组件统一重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Settings 弹窗内所有设置项统一为「即时自动保存 + 语义匹配控件 + 设计系统原语 + 行级保存状态」。

**Architecture:** 新增 `ui/switch|segmented|select` 三个无业务原语；重写 `layout/settings-rows.tsx` 为 6 个即时保存行原语（行级 SaveIndicator 用「发起行本地标记」解决 panel 级共享 pending）；`settings-content.tsx` 七个 panel 全部换新控件并删 Save 按钮；数据流零改动（`GET/PUT /api/settings`、`/api/profile`，不写 Zustand）。

**Tech Stack:** React 19 + TypeScript 5 + Tailwind（CSS 变量 token）+ TanStack React Query + vitest。

## Global Constraints

- spec：`docs/superpowers/specs/2026-07-06-settings-form-redesign-design.md`
- 所有客户端组件顶部 `'use client'`；样式一律 `cn()`（`@/lib/cn`）+ CSS 变量 token（对齐 `ui/input.tsx`：`bg-input-bg border-input-border`、focus `border-accent ring-focus-ring/30`）。
- 不改 `/api/settings`、`/api/profile`、`settings-categories.ts`、弹窗容器布局。
- UI 文案英文；代码注释中文。
- 验证以 `npx tsc --noEmit` + `npx vitest run` 为权威（`npm run lint` 不可用）。
- commit message 中文一句话，结尾带 `Claude-Session: https://claude.ai/code/session_01YP5vkwnEB1JTHkj1oD9Nau`，禁止 AI 署名 trailer。

---

### Task 1: 设计系统原语 Switch / Segmented / Select

**Files:**
- Create: `src/components/ui/switch.tsx`
- Create: `src/components/ui/segmented.tsx`
- Create: `src/components/ui/select.tsx`
- Modify: `src/components/subjects/augmentation-field.tsx`（内部复用 Segmented，对外接口不变）

**Interfaces:**
- Produces: `Switch({ checked: boolean; onCheckedChange: (v: boolean) => void; disabled?: boolean; 'aria-label'?: string })`
- Produces: `Segmented<T extends string>({ value: T; options: { value: T; label: string; helper?: string }[]; onChange: (v: T) => void; disabled?: boolean; 'aria-label'?: string; columns?: number })`
- Produces: `Select`（`React.SelectHTMLAttributes<HTMLSelectElement>` 透传 + 统一样式，forwardRef）

- [ ] **Step 1: 写 `src/components/ui/switch.tsx`**

```tsx
'use client';

import { cn } from '@/lib/cn';

/** 无业务 Switch 开关原语（role="switch"），配色走 CSS 变量 token。*/
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full',
        'transition-colors duration-fast ease-standard',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring/30',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        checked ? 'bg-accent' : 'bg-border-strong',
      )}
    >
      <span
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-surface shadow-sm',
          'transition-transform duration-fast ease-standard',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
```

- [ ] **Step 2: 写 `src/components/ui/segmented.tsx`**

```tsx
'use client';

import { cn } from '@/lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  helper?: string;
}

/** 通用分段选择原语（radiogroup 语义），从 AugmentationField 的样式抽取。*/
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  'aria-label': ariaLabel,
  columns,
}: {
  value: T;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  'aria-label'?: string;
  /** 网格列数；缺省为单行 inline-flex。*/
  columns?: number;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(columns ? 'grid gap-2' : 'inline-flex gap-1.5')}
      style={columns ? { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } : undefined}
    >
      {options.map((opt) => {
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
              'flex flex-col items-start gap-0.5 rounded-md border text-left transition-colors focus-ring',
              opt.helper ? 'px-3 py-2' : 'px-2.5 py-1',
              'disabled:opacity-50 disabled:pointer-events-none',
              active
                ? 'border-accent bg-accent-subtle'
                : 'border-border bg-surface hover:bg-subtle hover:border-border-strong',
            )}
          >
            <span className="text-xs font-medium text-foreground">{opt.label}</span>
            {opt.helper && (
              <span className="text-[11px] text-foreground-tertiary">{opt.helper}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: 写 `src/components/ui/select.tsx`**

```tsx
'use client';

import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/** 统一样式的原生 select 封装，token 与 ui/input.tsx 对齐。*/
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...props },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cn(
        'h-7 rounded-md px-2 text-xs',
        'bg-input-bg text-foreground',
        'border border-input-border',
        'transition-colors duration-fast ease-standard',
        'hover:border-border-strong',
        'focus:outline-none focus:border-accent focus:ring-2 focus:ring-focus-ring/30',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});
```

- [ ] **Step 4: 改写 `src/components/subjects/augmentation-field.tsx` 内部复用 Segmented（对外接口不变）**

```tsx
'use client';

import { AUGMENTATION_OPTIONS } from '@/lib/augmentation';
import type { AugmentationLevel } from '@/lib/contracts';
import { Segmented } from '@/components/ui/segmented';

/** 英文分段增益强度选择控件（2×2 网格），内部复用 ui/Segmented。*/
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
    <Segmented<AugmentationLevel>
      value={value}
      onChange={onChange}
      disabled={disabled}
      aria-label="Augmentation level"
      columns={2}
      options={AUGMENTATION_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        helper: o.helper,
      }))}
    />
  );
}
```

- [ ] **Step 5: 校验**

Run: `npx tsc --noEmit && npx vitest run src/lib/__tests__/augmentation.test.ts`
Expected: tsc 无输出退出码 0；vitest 全绿。

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/switch.tsx src/components/ui/segmented.tsx src/components/ui/select.tsx src/components/subjects/augmentation-field.tsx
git commit -m "feat(ui): 新增 Switch/Segmented/Select 设计系统原语，AugmentationField 复用 Segmented

Claude-Session: https://claude.ai/code/session_01YP5vkwnEB1JTHkj1oD9Nau"
```

---

### Task 2: 数字校验纯函数 + settings-rows 重写

**Files:**
- Create: `src/lib/settings-validation.ts`
- Create: `src/lib/__tests__/settings-validation.test.ts`
- Rewrite: `src/components/layout/settings-rows.tsx`

**Interfaces:**
- Consumes: Task 1 的 `Switch` / `Segmented` / `Select`，以及现有 `ui/input.tsx` 的 `Input` / `Textarea`。
- Produces（Task 3 依赖，全部从 `settings-rows.tsx` 导出）:
  - `SettingRow({ label, description?, children, className? })`（保留现有）
  - `interface RowSaveState { pending: boolean; error: unknown }`
  - `SwitchRow({ label, description?, checked: boolean, onSave: (v: boolean) => void, save?: RowSaveState })`
  - `SegmentedRow<T extends string>({ label, description?, value: T, options: { value: T; label: string }[], onSave: (v: T) => void, save?: RowSaveState })`
  - `SelectRow<T extends string>({ label, description?, value: T, options: { value: T; label: string }[], onSave: (v: T) => void, save?: RowSaveState, disabled?: boolean })`
  - `NumberRow({ label, description?, value: number, min: number, max: number, onSave: (v: number) => void, save?: RowSaveState })`
  - `TextRow({ label, description?, value: string, type?: 'text' | 'password', placeholder?: string, onSave: (v: string) => void, save?: RowSaveState })`
  - `TextareaRow({ label, description?, value: string, placeholder?: string, rows?: number, onSave: (v: string) => void, save?: RowSaveState })`
- Produces: `validateIntInRange(raw: string, min: number, max: number): number | null`（`src/lib/settings-validation.ts`）

- [ ] **Step 1: 写失败测试 `src/lib/__tests__/settings-validation.test.ts`**

```ts
import { describe, expect, it } from 'vitest';
import { validateIntInRange } from '../settings-validation';

describe('validateIntInRange', () => {
  it('接受范围内整数', () => {
    expect(validateIntInRange('25', 1, 200)).toBe(25);
    expect(validateIntInRange('1', 1, 200)).toBe(1);
    expect(validateIntInRange('200', 1, 200)).toBe(200);
  });
  it('拒绝越界值', () => {
    expect(validateIntInRange('0', 1, 200)).toBeNull();
    expect(validateIntInRange('201', 1, 200)).toBeNull();
  });
  it('拒绝非整数与非数字', () => {
    expect(validateIntInRange('2.5', 1, 200)).toBeNull();
    expect(validateIntInRange('abc', 1, 200)).toBeNull();
    expect(validateIntInRange('', 1, 200)).toBeNull();
    expect(validateIntInRange('  ', 1, 200)).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run src/lib/__tests__/settings-validation.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 `src/lib/settings-validation.ts`**

```ts
/** 设置表单数字校验：合法返回整数，否则 null（空串/空白/非整数/越界均不合法）。*/
export function validateIntInRange(raw: string, min: number, max: number): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}
```

- [ ] **Step 4: 运行确认通过**

Run: `npx vitest run src/lib/__tests__/settings-validation.test.ts`
Expected: PASS（3 用例）。

- [ ] **Step 5: 重写 `src/components/layout/settings-rows.tsx`（整文件替换）**

```tsx
'use client';

/**
 * 设置弹窗行级原语 —— 统一「标签+描述在左、控件在右」布局，全部即时自动保存。
 * 行级保存状态：panel 级 mutation 的 pending/error 经 RowSaveState 传入；
 * 每行本地记录「本行是否发起了最近一次保存」（touched），只有发起行显示
 * spinner/✓/错误，避免共享 pending 让全 panel 一起转圈。
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import { Input, Textarea } from '@/components/ui/input';
import { validateIntInRange } from '@/lib/settings-validation';
import { cn } from '@/lib/cn';

export interface RowSaveState {
  pending: boolean;
  error: unknown;
}

interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

export function SettingRow({ label, description, children, className }: SettingRowProps) {
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="text-xs text-foreground-tertiary mt-0.5">{description}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * 行级保存状态 hook：调用方在发起保存时 markSaving()，
 * 据共享 pending 的下降沿派生 'saving' → 'saved'(1.5s) / 'error'。
 */
function useRowSaveStatus(save: RowSaveState | undefined) {
  // touched：本行发起了保存且尚未收到结果；settled：结果已回（成功→✓ 1.5s，失败→常驻错误直到下次发起）。
  const [touched, setTouched] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [rowError, setRowError] = useState<unknown>(undefined);
  const wasPending = useRef(false);

  const pending = save?.pending ?? false;
  const error = save?.error;

  useEffect(() => {
    const fell = wasPending.current && !pending; // pending 下降沿 = 本次保存已结束
    wasPending.current = pending;
    if (!fell || !touched) return;
    setTouched(false);
    if (error) {
      setRowError(error);
      return;
    }
    setRowError(undefined);
    setShowSaved(true);
    const t = setTimeout(() => setShowSaved(false), 1500);
    return () => clearTimeout(t);
  }, [pending, error, touched]);

  return {
    markSaving: () => {
      setTouched(true);
      setRowError(undefined);
      setShowSaved(false);
    },
    saving: touched && pending,
    saved: showSaved,
    rowError,
  };
}

/** 控件旁的保存状态小标记：spinner / ✓（1.5s 淡出）。*/
function SaveIndicator({ saving, saved }: { saving: boolean; saved: boolean }) {
  return (
    <span className="inline-flex w-4 justify-center" aria-hidden={!saving && !saved}>
      {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-foreground-tertiary" />}
      {!saving && saved && <Check className="h-3.5 w-3.5 text-success" />}
    </span>
  );
}

/** 行下方红色错误文案。*/
function RowError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-1 text-xs text-danger">
      Failed to save: {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

export function SwitchRow(props: {
  label: string;
  description?: string;
  checked: boolean;
  onSave: (v: boolean) => void;
  save?: RowSaveState;
}) {
  const status = useRowSaveStatus(props.save);
  return (
    <div>
      <SettingRow label={props.label} description={props.description}>
        <div className="flex items-center gap-2">
          <SaveIndicator saving={status.saving} saved={status.saved} />
          <Switch
            checked={props.checked}
            aria-label={props.label}
            disabled={status.saving}
            onCheckedChange={(v) => {
              status.markSaving();
              props.onSave(v);
            }}
          />
        </div>
      </SettingRow>
      <RowError error={status.rowError} />
    </div>
  );
}

export function SegmentedRow<T extends string>(props: {
  label: string;
  description?: string;
  value: T;
  options: { value: T; label: string }[];
  onSave: (v: T) => void;
  save?: RowSaveState;
}) {
  const status = useRowSaveStatus(props.save);
  return (
    <div>
      <SettingRow label={props.label} description={props.description}>
        <div className="flex items-center gap-2">
          <SaveIndicator saving={status.saving} saved={status.saved} />
          <Segmented<T>
            value={props.value}
            options={props.options}
            aria-label={props.label}
            disabled={status.saving}
            onChange={(v) => {
              if (v === props.value) return;
              status.markSaving();
              props.onSave(v);
            }}
          />
        </div>
      </SettingRow>
      <RowError error={status.rowError} />
    </div>
  );
}

export function SelectRow<T extends string>(props: {
  label: string;
  description?: string;
  value: T;
  options: { value: T; label: string }[];
  onSave: (v: T) => void;
  save?: RowSaveState;
  disabled?: boolean;
}) {
  const selectId = useId();
  const status = useRowSaveStatus(props.save);
  return (
    <div>
      <SettingRow label={props.label} description={props.description}>
        <div className="flex items-center gap-2">
          <SaveIndicator saving={status.saving} saved={status.saved} />
          <Select
            id={selectId}
            value={props.value}
            aria-label={props.label}
            disabled={props.disabled || status.saving}
            onChange={(e) => {
              const v = e.target.value as T;
              if (v === props.value) return;
              status.markSaving();
              props.onSave(v);
            }}
          >
            {props.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      </SettingRow>
      <RowError error={status.rowError} />
    </div>
  );
}

export function NumberRow(props: {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  onSave: (v: number) => void;
  save?: RowSaveState;
}) {
  const status = useRowSaveStatus(props.save);
  const [draft, setDraft] = useState(String(props.value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    setDraft(String(props.value));
    setInvalid(false);
  }, [props.value]);

  const commit = () => {
    const parsed = validateIntInRange(draft, props.min, props.max);
    if (parsed === null) {
      // 非法：不提交，回滚到服务端值。
      setDraft(String(props.value));
      setInvalid(false);
      return;
    }
    if (parsed === props.value) return;
    status.markSaving();
    props.onSave(parsed);
  };

  return (
    <div>
      <SettingRow label={props.label} description={props.description}>
        <div className="flex items-center gap-2">
          <SaveIndicator saving={status.saving} saved={status.saved} />
          <Input
            type="number"
            value={draft}
            min={props.min}
            max={props.max}
            disabled={status.saving}
            aria-label={props.label}
            aria-invalid={invalid}
            onChange={(e) => {
              setDraft(e.target.value);
              setInvalid(validateIntInRange(e.target.value, props.min, props.max) === null);
            }}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className={cn('h-7 w-24 px-2 text-xs text-right', invalid && 'border-danger')}
          />
        </div>
      </SettingRow>
      {invalid && (
        <p className="mt-1 text-xs text-danger text-right">
          Must be an integer between {props.min} and {props.max}
        </p>
      )}
      <RowError error={status.rowError} />
    </div>
  );
}

export function TextRow(props: {
  label: string;
  description?: string;
  value: string;
  type?: 'text' | 'password';
  placeholder?: string;
  onSave: (v: string) => void;
  save?: RowSaveState;
}) {
  const status = useRowSaveStatus(props.save);
  const [draft, setDraft] = useState(props.value);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);

  const commit = () => {
    if (draft === props.value) return;
    status.markSaving();
    props.onSave(draft);
  };

  return (
    <div>
      <SettingRow label={props.label} description={props.description}>
        <div className="flex items-center gap-2">
          <SaveIndicator saving={status.saving} saved={status.saved} />
          <Input
            type={props.type ?? 'text'}
            value={draft}
            placeholder={props.placeholder}
            disabled={status.saving}
            aria-label={props.label}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            className="h-7 w-44 px-2 text-xs"
          />
        </div>
      </SettingRow>
      <RowError error={status.rowError} />
    </div>
  );
}

export function TextareaRow(props: {
  label: string;
  description?: string;
  value: string;
  placeholder?: string;
  rows?: number;
  onSave: (v: string) => void;
  save?: RowSaveState;
}) {
  const status = useRowSaveStatus(props.save);
  const [draft, setDraft] = useState(props.value);
  useEffect(() => {
    setDraft(props.value);
  }, [props.value]);

  const commit = () => {
    if (draft === props.value) return;
    status.markSaving();
    props.onSave(draft);
  };

  return (
    <div>
      <SettingRow label={props.label} description={props.description} className="items-start">
        <div className="flex items-start gap-2">
          <span className="mt-2 inline-flex">
            <SaveIndicator saving={status.saving} saved={status.saved} />
          </span>
          <Textarea
            value={draft}
            rows={props.rows ?? 3}
            placeholder={props.placeholder}
            disabled={status.saving}
            aria-label={props.label}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            className="w-60 p-2 text-sm"
          />
        </div>
      </SettingRow>
      <RowError error={status.rowError} />
    </div>
  );
}
```

注意：`text-success` token 若项目 Tailwind 主题未定义，改用 `text-accent`（实施时以 `grep -r "text-success" src tailwind.config*` 结果为准）。

- [ ] **Step 6: 校验（此时 settings-content 仍引用旧导出，会编译失败——本步只跑 vitest；tsc 放到 Task 3 末尾）**

Run: `npx vitest run src/lib/__tests__/settings-validation.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/lib/settings-validation.ts src/lib/__tests__/settings-validation.test.ts src/components/layout/settings-rows.tsx
git commit -m "refactor(settings): 行级原语重写为即时保存（Switch/Segmented/Select/Number/Text/Textarea 六行原语 + 行级保存状态）

Claude-Session: https://claude.ai/code/session_01YP5vkwnEB1JTHkj1oD9Nau"
```

---

### Task 3: Panel 层改造 + dialog 精简

**Files:**
- Modify: `src/components/layout/settings-content.tsx`（七个 panel 换新控件）
- Modify: `src/components/layout/settings-dialog.tsx`（删 `languageDraft`/`setLanguageDraft` state 与 props；`saveLanguage` mutation 保留，`onSuccess` 里删 `setLanguageDraft` 行）

**Interfaces:**
- Consumes: Task 2 全部行原语与 `RowSaveState`。
- Produces: `SettingsContentProps` 变为 `{ active, darkMode, toggleDarkMode, sidebarWidth, resetSidebarWidth, settings, settingsLoading, saveLanguage, savePartial }`（去掉 languageDraft 二项；`SaveLanguageMutation`/`SavePartialMutation` 接口不变，直接当 `RowSaveState` 用——`{ pending: m.isPending, error: m.isError ? m.error : undefined }`）。

- [ ] **Step 1: 改 `settings-dialog.tsx`**

删除：`const [languageDraft, setLanguageDraft] = useState('')`、同步 `languageDraft` 的 `useEffect`、`saveLanguage.onSuccess` 中的 `setLanguageDraft(data.wikiLanguage)` 行、传给 `SettingsContent` 的 `languageDraft`/`setLanguageDraft` 两个 props。其余不动。

- [ ] **Step 2: 改写 `settings-content.tsx` 各 panel**

顶部工具函数与 props（替换 `SettingsContentProps` 及新增 helper）：

```tsx
import {
  SettingRow,
  SwitchRow,
  SegmentedRow,
  SelectRow,
  NumberRow,
  TextRow,
  TextareaRow,
  type RowSaveState,
} from './settings-rows';

/** mutation → RowSaveState 适配。*/
function toSave(m: { isPending: boolean; isError: boolean; error: unknown }): RowSaveState {
  return { pending: m.isPending, error: m.isError ? m.error : undefined };
}
```

`SettingsContentProps` 删 `languageDraft`/`setLanguageDraft`。

**AppearancePanel**（Dark mode 改 Switch，Sidebar width 保留 Reset 按钮）：

```tsx
function AppearancePanel({ darkMode, toggleDarkMode, sidebarWidth, resetSidebarWidth }: Pick<
  SettingsContentProps,
  'darkMode' | 'toggleDarkMode' | 'sidebarWidth' | 'resetSidebarWidth'
>) {
  return (
    <div className="space-y-4">
      <SwitchRow
        label="Dark mode"
        description="Toggle between light and dark theme"
        checked={darkMode}
        onSave={() => toggleDarkMode()}
      />
      <SettingRow
        label="Sidebar width"
        description={`${Math.round(sidebarWidth)}px (default ${SIDEBAR_WIDTH_DEFAULT}px)`}
      >
        <Button
          intent="outline"
          size="sm"
          onClick={resetSidebarWidth}
          disabled={Math.round(sidebarWidth) === SIDEBAR_WIDTH_DEFAULT}
          className="gap-1.5"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </Button>
      </SettingRow>
    </div>
  );
}
```

（`Moon`/`Sun` import 删除。）

**LanguagePanel**（即时保存，删 Save 按钮与 draft）：

```tsx
function LanguagePanel({
  settings,
  settingsLoading,
  saveLanguage,
}: Pick<SettingsContentProps, 'settings' | 'settingsLoading' | 'saveLanguage'>) {
  const savedLanguage = settings?.wikiLanguage ?? '';
  const presetValues = new Set<string>(WIKI_LANGUAGE_PRESETS.map((p) => p.value));
  const languageOptions: { value: string; label: string }[] = WIKI_LANGUAGE_PRESETS.map((p) => ({
    value: p.value,
    label: p.label,
  }));
  if (savedLanguage && !presetValues.has(savedLanguage)) {
    languageOptions.unshift({ value: savedLanguage, label: `${savedLanguage} (custom)` });
  }
  return (
    <div className="space-y-4">
      <SelectRow
        label="Wiki language"
        description="Language LLM uses for new wiki content (slugs and wikilinks stay verbatim)"
        value={savedLanguage}
        options={languageOptions}
        disabled={settingsLoading}
        onSave={(v) => saveLanguage.mutate(v)}
        save={toSave(saveLanguage)}
      />
    </div>
  );
}
```

**CognitiveLensPanel**（四偏好改 SegmentedRow、background 改 TextareaRow、删整体 Save；每次变更整体提交 `{ backgroundSummary, stylePrefs }`，与现有 PUT 语义一致）：

```tsx
function CognitiveLensPanel() {
  const { data, isLoading } = useProfile();
  const update = useUpdateProfile();

  if (isLoading || !data) {
    return <p className="text-xs text-foreground-tertiary">Loading…</p>;
  }
  const profile = data.profile;
  const save = toSave(update);

  const savePrefs = (patch: Partial<StylePrefs>) =>
    update.mutate({
      backgroundSummary: profile.backgroundSummary,
      stylePrefs: { ...profile.stylePrefs, ...patch },
    });

  return (
    <div className="space-y-4">
      <p className="text-xs text-foreground-tertiary">
        Adapts how each page is explained to your background and preferences (rephrasing only — facts
        never change, and the original is always one click away; it also fine-tunes itself from your
        “too hard / too shallow” feedback).
      </p>

      {LENS_KEYS.map((key) => (
        <SegmentedRow
          key={key}
          label={LENS_LABELS[key]}
          value={profile.stylePrefs[key]}
          options={LENS_OPTIONS[key].map(([value, label]) => ({ value, label }))}
          onSave={(v) => savePrefs({ [key]: v } as Partial<StylePrefs>)}
          save={save}
        />
      ))}

      <TextareaRow
        label="Background"
        description="Your background and goals (free text)"
        value={profile.backgroundSummary}
        placeholder="e.g. Backend engineer, comfortable with distributed systems but new to machine learning"
        onSave={(v) => update.mutate({ backgroundSummary: v, stylePrefs: profile.stylePrefs })}
        save={save}
      />
    </div>
  );
}
```

（原 `bg`/`prefs` 本地 state、同步 effect、`dirty`、底部 Save 全删。`SegmentedRow` 泛型按 `StylePrefs[key]` 的字符串 union 推导；若 `LENS_OPTIONS` 的 `[string, string][]` 类型推不出 union，把 `LENS_OPTIONS` 值改为 `as const` 或在 map 处 `value: value as StylePrefs[typeof key]`。前提：`useUpdateProfile` 的 onSuccess 会写回/失效 profile query——实施时确认 `src/hooks/use-profile.ts`，若无失效逻辑则乐观依赖 PUT 返回值 setQueryData，不改 hook 之外行为。）

**AgentsPanel**：

```tsx
function AgentsPanel({ settings, savePartial }: Pick<SettingsContentProps, 'settings' | 'savePartial'>) {
  const save = toSave(savePartial);
  return (
    <div className="space-y-4">
      <NumberRow
        label="Max steps per agent"
        value={settings?.agentMaxSteps ?? 25}
        min={1}
        max={200}
        onSave={(v) => savePartial.mutate({ agentMaxSteps: v })}
        save={save}
      />
      <NumberRow
        label="Total token budget per task"
        description="Default 500k handles sources up to ~200k tokens; raise to 1-1.5M for book-sized files"
        value={settings?.agentMaxTokensPerJob ?? 500_000}
        min={10_000}
        max={5_000_000}
        onSave={(v) => savePartial.mutate({ agentMaxTokensPerJob: v })}
        save={save}
      />
      <NumberRow
        label="Parallel sub-agents"
        value={settings?.agentMaxParallelSubAgents ?? 3}
        min={1}
        max={10}
        onSave={(v) => savePartial.mutate({ agentMaxParallelSubAgents: v })}
        save={save}
      />
      <SegmentedRow
        label="LLM selection mode"
        value={settings?.agentTaskRouterMode ?? 'frontmatter-override'}
        options={[
          { value: 'task-router-only', label: 'Task router only' },
          { value: 'frontmatter-override', label: 'Frontmatter override' },
        ]}
        onSave={(v) =>
          savePartial.mutate({
            agentTaskRouterMode: v as 'task-router-only' | 'frontmatter-override',
          })
        }
        save={save}
      />
      <SwitchRow
        label="Auto-curate after ingest"
        description="Automatically tidy touched pages after each ingest"
        checked={settings?.agentAutoCurate ?? true}
        onSave={(v) => savePartial.mutate({ agentAutoCurate: v })}
        save={save}
      />
    </div>
  );
}
```

（panel 底部 `savePartial.isError` 段删除；下同。）

**WebSearchPanel**（Provider 改只读展示）：

```tsx
function WebSearchPanel({ settings, savePartial }: Pick<SettingsContentProps, 'settings' | 'savePartial'>) {
  const save = toSave(savePartial);
  return (
    <div className="space-y-4">
      <p className="text-xs text-foreground-tertiary">
        Used by the ingest verifier to fact-check augmentation callouts and import cited pages as
        sources. Leave the API key empty to disable (verifier falls back to self-check).
      </p>
      <SettingRow label="Provider" description="Only Tavily is supported for now">
        <span className="text-xs text-foreground-secondary">Tavily</span>
      </SettingRow>
      <TextRow
        label="API key"
        description="Stored in app settings; empty disables web grounding"
        type="password"
        placeholder="tvly-…"
        value={settings?.webSearchApiKey ?? ''}
        onSave={(v) => savePartial.mutate({ webSearchApiKey: v })}
        save={save}
      />
      <NumberRow
        label="Max results per query"
        value={settings?.webSearchMaxResults ?? 5}
        min={1}
        max={10}
        onSave={(v) => savePartial.mutate({ webSearchMaxResults: v })}
        save={save}
      />
    </div>
  );
}
```

**MaintenancePanel**（statusQuery/formatSweepTime/Status 行保持不变，其余三项换控件）：

```tsx
      <SwitchRow
        label="Periodic maintenance"
        description="Revisit & deepen pages over time (off by default)"
        checked={settings?.maintenanceEnabled ?? false}
        onSave={(v) => savePartial.mutate({ maintenanceEnabled: v })}
        save={save}
      />
      {/* Status 只读行原样保留 */}
      <NumberRow
        label="Sweep interval (hours)"
        value={settings?.maintenanceSweepIntervalHours ?? 24}
        min={1}
        max={168}
        onSave={(v) => savePartial.mutate({ maintenanceSweepIntervalHours: v })}
        save={save}
      />
      <NumberRow
        label="Max pages per sweep"
        description="Caps re-enrich jobs enqueued each cycle (cost guardrail)"
        value={settings?.maintenanceMaxPagesPerSweep ?? 5}
        min={1}
        max={50}
        onSave={(v) => savePartial.mutate({ maintenanceMaxPagesPerSweep: v })}
        save={save}
      />
```

**AboutPanel** 不变。清理未用 import（`Button` 若仍被 Appearance 用则保留；`cn`、旧 `NumberSettingRow` 等删）。

- [ ] **Step 3: 校验**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 通过；vitest 全绿（821+ 用例）。

- [ ] **Step 4: Playwright 走查（dev server 需在跑；若无则 `npm run dev` 后从 http://localhost:3000 进入）**

用 Playwright MCP 打开应用 → 打开 Settings 弹窗，逐 panel 检查：
1. Appearance：Dark mode Switch 切换即生效；截图明/暗两态。
2. Language：换语言即保存，控件旁短暂 ✓。
3. Cognitive Lens：分段控件点击即保存；Background blur 保存。
4. Agents：数字改后 blur 保存；输入 `0`（越界）出现红框与提示，blur 回滚原值不发请求；Switch/分段即时保存。
5. Web search：Provider 只读；API key blur 保存。
6. Maintenance：Switch + 两个数字项。
Expected: 无控制台报错，各行状态标记正常。

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/settings-content.tsx src/components/layout/settings-dialog.tsx
git commit -m "refactor(settings): 七个 panel 全部换即时保存控件（Switch/分段/Select），删逐行与整体 Save 按钮

Claude-Session: https://claude.ai/code/session_01YP5vkwnEB1JTHkj1oD9Nau"
```

---

### Task 4: 文档同步

**Files:**
- Modify: `src/components/CLAUDE.md`（`ui/` 清单加 switch/segmented/select；`settings-rows` 描述更新；Changelog 加一行）
- Modify: `CLAUDE.md`（根 Changelog 加一行）

**Interfaces:** 无代码接口。

- [ ] **Step 1: 更新 `src/components/CLAUDE.md`**

`ui/` 设计系统列表加 `switch.tsx` / `segmented.tsx` / `select.tsx`；`layout/` 表中 `settings-rows.tsx` 描述改为「即时保存行原语：SettingRow/SwitchRow/SegmentedRow/SelectRow/NumberRow/TextRow/TextareaRow（行级保存状态）」；文件清单 `ui/` 行同步；Changelog 表尾加：

```
| 2026-07-06 | Settings 表单统一重设计：新增 `ui/{switch,segmented,select}` 原语（AugmentationField 复用 Segmented）；`settings-rows` 重写为 6 个即时保存行原语（blur/Enter 提交 + 行级 spinner/✓/错误）；七个 panel 换 Switch/分段控件、删全部 Save 按钮；`settings-dialog` 去 languageDraft。spec/plan 见 docs/superpowers/{specs,plans}/2026-07-06-settings-form-redesign* |
```

- [ ] **Step 2: 根 `CLAUDE.md` Changelog 表尾加对应一行（同上摘要）。**

- [ ] **Step 3: Commit**

```bash
git add src/components/CLAUDE.md CLAUDE.md
git commit -m "docs: 同步 Settings 表单统一重设计到 CLAUDE.md

Claude-Session: https://claude.ai/code/session_01YP5vkwnEB1JTHkj1oD9Nau"
```
