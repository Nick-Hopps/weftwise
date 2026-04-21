'use client';

import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-md px-3 py-1.5 text-sm',
        'bg-input-bg text-foreground placeholder:text-input-placeholder',
        'border border-input-border',
        'transition-colors duration-fast ease-standard',
        'hover:border-border-strong',
        'focus:outline-none focus:border-accent focus:ring-2 focus:ring-focus-ring/30',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        className,
      )}
      {...props}
    />
  );
});

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, rows = 3, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        'w-full rounded-md px-3 py-2 text-sm leading-5',
        'bg-input-bg text-foreground placeholder:text-input-placeholder',
        'border border-input-border',
        'transition-colors duration-fast ease-standard',
        'hover:border-border-strong',
        'focus:outline-none focus:border-accent focus:ring-2 focus:ring-focus-ring/30',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        'resize-y',
        className,
      )}
      {...props}
    />
  );
});
