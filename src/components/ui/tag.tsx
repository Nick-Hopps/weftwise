'use client';

import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

export const tagVariants = cva(
  'inline-flex items-center gap-1 font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'bg-subtle text-foreground-secondary',
        accent:  'bg-accent-subtle text-accent-strong',
        success: 'bg-success-bg text-success',
        warning: 'bg-warning-bg text-warning',
        danger:  'bg-danger-bg text-danger',
      },
      size: {
        sm:   'text-xs h-5 px-1.5 rounded-sm',
        base: 'text-xs h-6 px-2 rounded-sm',
      },
    },
    defaultVariants: {
      tone: 'neutral',
      size: 'sm',
    },
  },
);

export type TagProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof tagVariants>;

export const Tag = forwardRef<HTMLSpanElement, TagProps>(function Tag(
  { className, tone, size, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(tagVariants({ tone, size }), className)}
      {...props}
    />
  );
});
