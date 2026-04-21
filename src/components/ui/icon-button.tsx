'use client';

import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

export const iconButtonVariants = cva(
  [
    'inline-flex items-center justify-center',
    'transition-colors duration-fast ease-standard',
    'disabled:pointer-events-none disabled:opacity-50',
    'focus-ring',
  ],
  {
    variants: {
      intent: {
        primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
        ghost:   'bg-transparent text-foreground-secondary hover:bg-subtle hover:text-foreground',
        outline: 'bg-surface text-foreground border border-border hover:bg-subtle',
      },
      size: {
        sm:   'h-6 w-6 rounded-sm [&>svg]:h-3 [&>svg]:w-3',
        base: 'h-8 w-8 rounded-md [&>svg]:h-4 [&>svg]:w-4',
        lg:   'h-10 w-10 rounded-md [&>svg]:h-5 [&>svg]:w-5',
      },
    },
    defaultVariants: {
      intent: 'ghost',
      size: 'base',
    },
  },
);

export type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof iconButtonVariants>;

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, intent, size, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(iconButtonVariants({ intent, size }), className)}
      {...props}
    />
  );
});
