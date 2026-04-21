'use client';

import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/cn';

export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'font-medium select-none',
    'transition-colors duration-fast ease-standard',
    'disabled:pointer-events-none disabled:opacity-50',
    'focus-ring',
  ],
  {
    variants: {
      intent: {
        primary:
          'bg-accent text-accent-fg shadow-xs hover:bg-accent-hover active:bg-accent-active',
        secondary:
          'bg-subtle text-foreground hover:bg-border',
        ghost:
          'bg-transparent text-foreground-secondary hover:bg-subtle hover:text-foreground',
        outline:
          'bg-surface text-foreground border border-border hover:bg-subtle hover:border-border-strong',
        danger:
          'bg-danger text-accent-fg hover:bg-danger-border',
      },
      size: {
        sm:   'h-6 px-2 text-xs rounded-sm',
        base: 'h-8 px-3 text-sm rounded-md',
        lg:   'h-10 px-4 text-base rounded-md',
      },
    },
    defaultVariants: {
      intent: 'primary',
      size: 'base',
    },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    loading?: boolean;
  };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, intent, size, loading, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(buttonVariants({ intent, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
      {children}
    </button>
  );
});
