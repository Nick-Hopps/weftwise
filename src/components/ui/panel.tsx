'use client';

import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

export const panelVariants = cva(
  'bg-surface border-border overflow-hidden',
  {
    variants: {
      tone: {
        plain:    'border',
        elevated: 'border shadow-sm',
        flat:     'border-0',
      },
      radius: {
        md: 'rounded-md',
        lg: 'rounded-lg',
      },
      padding: {
        none: 'p-0',
        sm:   'p-3',
        md:   'p-4',
        lg:   'p-6',
      },
    },
    defaultVariants: {
      tone: 'plain',
      radius: 'lg',
      padding: 'none',
    },
  },
);

export type PanelProps = React.HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof panelVariants>;

export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { className, tone, radius, padding, ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(panelVariants({ tone, radius, padding }), className)}
      {...props}
    />
  );
});

export function PanelHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 px-4 py-2.5 border-b border-border',
        className,
      )}
      {...props}
    />
  );
}

export function PanelBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-4', className)} {...props} />;
}

export function PanelTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn('text-sm font-semibold text-foreground tracking-tight', className)}
      {...props}
    />
  );
}

export function SectionLabel({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn(
        'text-xs font-medium text-foreground-tertiary uppercase tracking-wider',
        className,
      )}
      {...props}
    />
  );
}
