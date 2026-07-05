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
