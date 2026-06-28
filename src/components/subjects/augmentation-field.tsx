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
