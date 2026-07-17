'use client';

/**
 * 设置弹窗行级原语 —— 统一「标签+描述在左、控件在右」布局，全部即时自动保存。
 * 行级保存状态：panel 级 mutation 的 pending/error 经 RowSaveState 传入；
 * 每行本地记录「本行是否发起了最近一次保存」（touched），只有发起行显示
 * spinner/成功/错误，避免共享 pending 让全 panel 一起转圈。
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { Segmented } from '@/components/ui/segmented';
import { Select } from '@/components/ui/select';
import { Input, Textarea } from '@/components/ui/input';
import { validateIntInRange } from '@/lib/settings-validation';
import { cn } from '@/lib/cn';
import { isImeComposing } from '@/lib/keyboard';

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
    <div
      className={cn(
        'flex flex-col items-stretch justify-between gap-2 sm:flex-row sm:items-center sm:gap-5',
        className,
      )}
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="text-xs text-foreground-tertiary mt-0.5">{description}</div>
        )}
      </div>
      <div className="max-w-full shrink-0 self-start sm:self-auto">{children}</div>
    </div>
  );
}

/**
 * 行级保存状态 hook：调用方在发起保存时 markSaving()，
 * 据共享 pending 的下降沿派生 'saving' → 'saved'(1.5s) / 'error'。
 */
function useRowSaveStatus(save: RowSaveState | undefined) {
  // touched：本行发起了保存且尚未收到结果；settled：结果已回（成功标记 1.5s，失败则常驻错误直到下次发起）。
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

/** 控件旁的保存状态小标记：spinner / 成功标记（1.5s 淡出）。*/
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

export function MultiSelectRow<T extends string>(props: {
  label: string;
  description?: string;
  allLabel: string;
  value: 'all' | readonly T[];
  options: Array<{ value: T; label: string; description?: string }>;
  onSave: (value: 'all' | T[]) => void;
  save?: RowSaveState;
  loading?: boolean;
}) {
  const status = useRowSaveStatus(props.save);
  const [open, setOpen] = useState(false);
  const validValues = new Set(props.options.map((option) => option.value));
  const selected = props.value === 'all'
    ? new Set(props.options.map((option) => option.value))
    : new Set(props.value.filter((value) => validValues.has(value)));
  const disabled = status.saving || props.loading;
  const summary = props.value === 'all'
    ? props.allLabel
    : `${selected.size} project${selected.size === 1 ? '' : 's'}`;

  const commit = (value: 'all' | T[]) => {
    status.markSaving();
    props.onSave(value);
  };

  return (
    <div>
      <SettingRow label={props.label} description={props.description}>
        <div className="flex items-center gap-2">
          <SaveIndicator saving={status.saving} saved={status.saved} />
          <button
            type="button"
            aria-expanded={open}
            disabled={disabled}
            onClick={() => setOpen((current) => !current)}
            className={cn(
              'inline-flex h-7 min-w-32 items-center justify-between gap-2 rounded-md border border-input-border',
              'bg-input-bg px-2 text-xs text-foreground transition-colors',
              'hover:border-border-strong focus-ring disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            <span className="truncate">{summary}</span>
            <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-foreground-tertiary transition-transform', open && 'rotate-180')} />
          </button>
        </div>
      </SettingRow>

      {open && (
        <div className="mt-2 ml-auto max-h-48 w-full max-w-sm overflow-y-auto rounded-md border border-border bg-surface py-1">
          <label className="flex min-h-8 cursor-pointer items-center gap-2 px-2.5 text-xs text-foreground hover:bg-subtle">
            <input
              type="checkbox"
              checked={props.value === 'all'}
              disabled={disabled || props.options.length === 0}
              onChange={(event) => {
                if (event.target.checked) {
                  commit('all');
                } else {
                  commit(props.options.map((option) => option.value));
                }
              }}
              className="h-3.5 w-3.5 rounded border-input-border accent-accent"
            />
            <span className="font-medium">{props.allLabel}</span>
          </label>

          <div className="mx-2 border-t border-border" />
          {props.loading ? (
            <div className="px-2.5 py-3 text-xs text-foreground-tertiary">Loading projects…</div>
          ) : props.options.length === 0 ? (
            <div className="px-2.5 py-3 text-xs text-foreground-tertiary">No projects available</div>
          ) : (
            props.options.map((option) => {
              const checked = selected.has(option.value);
              const isLastSelected = props.value !== 'all' && checked && selected.size === 1;
              return (
                <label
                  key={option.value}
                  title={isLastSelected ? 'Select another project before removing this one' : undefined}
                  className={cn(
                    'flex min-h-9 items-center gap-2 px-2.5 text-xs hover:bg-subtle',
                    isLastSelected || disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || isLastSelected}
                    onChange={(event) => {
                      const next = props.options
                        .map((item) => item.value)
                        .filter((value) => value !== option.value && selected.has(value));
                      if (event.target.checked) next.push(option.value);
                      if (next.length > 0) commit(next);
                    }}
                    className="h-3.5 w-3.5 rounded border-input-border accent-accent"
                  />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-foreground">{option.label}</span>
                    {option.description && (
                      <span className="block truncate text-[11px] text-foreground-tertiary">{option.description}</span>
                    )}
                  </span>
                </label>
              );
            })
          )}
        </div>
      )}
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
              if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur();
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
              if (e.key === 'Enter' && !isImeComposing(e)) e.currentTarget.blur();
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
