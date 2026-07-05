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
