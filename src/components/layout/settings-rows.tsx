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
