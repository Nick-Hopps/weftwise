'use client';

/**
 * 设置对话框内的行级原语 —— 通用"标签 + 控件"布局，
 * 含数字输入行与下拉选择行（带本地暂存与校验）。
 */

import { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

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
          <div className="text-xs text-foreground-tertiary mt-0.5 truncate">{description}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function NumberSettingRow(props: {
  label: string;
  description?: string;
  value: number;
  min: number;
  max: number;
  onSave: (v: number) => void;
  pending: boolean;
}) {
  const inputId = useId();
  const [draft, setDraft] = useState<string>(String(props.value));
  useEffect(() => {
    setDraft(String(props.value));
  }, [props.value]);
  const parsed = Number(draft);
  const valid =
    Number.isFinite(parsed) &&
    Number.isInteger(parsed) &&
    parsed >= props.min &&
    parsed <= props.max;
  const canSave = valid && !props.pending && parsed !== props.value;
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <label htmlFor={inputId} className="text-sm text-foreground">{props.label}</label>
        {props.description && (
          <div className="text-xs text-foreground-tertiary mt-0.5">{props.description}</div>
        )}
      </div>
      <input
        id={inputId}
        type="number"
        value={draft}
        min={props.min}
        max={props.max}
        onChange={(e) => setDraft(e.target.value)}
        className={cn(
          'h-7 rounded-md border border-input-border bg-input-bg px-2 text-xs text-foreground',
          'transition-colors duration-fast ease-standard',
          'hover:border-border-strong',
          'focus:outline-none focus:border-accent focus:ring-2 focus:ring-focus-ring/30',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'w-24 text-right',
        )}
        disabled={props.pending}
      />
      <Button
        intent="outline"
        size="sm"
        disabled={!canSave}
        onClick={() => props.onSave(parsed)}
      >
        {props.pending ? 'Saving…' : 'Save'}
      </Button>
    </div>
  );
}

export function SelectSettingRow<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  pending: boolean;
}) {
  const selectId = useId();
  return (
    <div className="flex items-center gap-2">
      <label htmlFor={selectId} className="flex-1 text-sm text-foreground">{props.label}</label>
      <select
        id={selectId}
        value={props.value}
        disabled={props.pending}
        onChange={(e) => props.onChange(e.target.value as T)}
        className={cn(
          'h-7 rounded-md border border-input-border bg-input-bg px-2 text-xs text-foreground',
          'transition-colors duration-fast ease-standard',
          'hover:border-border-strong',
          'focus:outline-none focus:border-accent focus:ring-2 focus:ring-focus-ring/30',
          'disabled:opacity-50 disabled:cursor-not-allowed',
        )}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
