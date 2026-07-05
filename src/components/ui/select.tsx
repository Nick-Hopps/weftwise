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
