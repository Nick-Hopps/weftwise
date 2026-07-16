import React, { type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function WorkspacePage({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'mx-auto w-full max-w-[1080px] space-y-7 px-5 py-8 sm:px-8 sm:py-10',
        className,
      )}
      {...props}
    />
  );
}

export function WorkspacePageHeader({
  icon,
  title,
  description,
  meta,
  actions,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
          {icon}
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-foreground-secondary">{description}</p>
        )}
      </div>
      {(meta || actions) && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 sm:justify-end">
          {meta && (
            <div className="text-xs tabular-nums text-foreground-tertiary">{meta}</div>
          )}
          {actions}
        </div>
      )}
    </header>
  );
}

export function WorkspaceSummary({
  className,
  ...props
}: HTMLAttributes<HTMLDListElement>) {
  return (
    <dl
      className={cn(
        'grid overflow-hidden border-y border-border-subtle bg-surface',
        className,
      )}
      {...props}
    />
  );
}

const METRIC_TONE = {
  neutral: 'text-foreground',
  accent: 'text-accent-strong',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
} as const;

export function WorkspaceMetric({
  label,
  value,
  detail,
  tone = 'neutral',
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  detail?: ReactNode;
  tone?: keyof typeof METRIC_TONE;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 px-4 py-3.5', className)}>
      <dt className="truncate text-xs font-medium text-foreground-tertiary">{label}</dt>
      <dd className={cn('mt-1 text-xl font-semibold tabular-nums', METRIC_TONE[tone])}>
        {value}
      </dd>
      {detail && <dd className="mt-1 text-xs text-foreground-tertiary">{detail}</dd>}
    </div>
  );
}

export function WorkspaceToolbar({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'sticky top-0 z-10 -mx-2 border-y border-border-subtle bg-canvas/95 px-2 py-3 backdrop-blur-sm',
        className,
      )}
      {...props}
    />
  );
}

export function WorkspaceState({
  icon,
  title,
  description,
  action,
  className,
  role = 'status',
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
  role?: 'status' | 'alert';
}) {
  return (
    <div
      role={role}
      className={cn(
        'flex min-h-48 flex-col items-center justify-center border-y border-border-subtle px-4 py-10 text-center',
        className,
      )}
    >
      {icon}
      <p className={cn('text-sm font-medium text-foreground', icon && 'mt-3')}>{title}</p>
      {description && (
        <p className="mt-1 max-w-md text-sm text-foreground-secondary">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
