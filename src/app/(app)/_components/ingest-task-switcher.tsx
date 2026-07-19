'use client';

import React from 'react';
import { Check, Clock3, Loader2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { IngestTask } from '@/lib/ingest-task-list';
import { useI18n } from '@/components/i18n-provider';
import type { MessageKey } from '@/lib/i18n/messages';

const STATUS_LABEL: Record<IngestTask['queueStatus'], MessageKey> = {
  pending: 'ingest.status.pending',
  running: 'ingest.status.running',
  completed: 'ingest.status.completed',
  failed: 'ingest.status.failed',
};

function TaskStatusIcon({ status }: { status: IngestTask['queueStatus'] }) {
  if (status === 'completed') return <Check className="h-3.5 w-3.5 text-success" aria-hidden />;
  if (status === 'failed') return <X className="h-3.5 w-3.5 text-danger" aria-hidden />;
  if (status === 'running') {
    return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden />;
  }
  return <Clock3 className="h-3.5 w-3.5 text-foreground-tertiary" aria-hidden />;
}

export function IngestTaskSwitcher({
  tasks,
  selectedId,
  onSelect,
  error,
  children,
}: {
  tasks: readonly IngestTask[];
  selectedId: string;
  onSelect: (jobId: string) => void;
  error?: string | null;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const handleTaskKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let nextIndex = index;
    if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tasks.length) % tasks.length;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % tasks.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = tasks.length - 1;
    onSelect(tasks[nextIndex].id);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
      '[role="tab"]',
    );
    buttons?.[nextIndex]?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="shrink-0 border-b border-border bg-surface px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <div className="shrink-0">
            <p className="text-sm font-semibold text-foreground">{t('ingest.tasks')}</p>
            <p className="font-mono text-[11px] text-foreground-tertiary">
              {tasks.length} {tasks.length === 1 ? 'source' : 'sources'}
            </p>
          </div>
          <div
            role="tablist"
            aria-label={t('ingest.tasks')}
            className="flex h-auto min-w-0 flex-1 justify-start gap-1 overflow-x-auto bg-transparent p-0"
          >
            {tasks.map((task) => (
              <button
                key={task.id}
                type="button"
                role="tab"
                aria-selected={task.id === selectedId}
                tabIndex={task.id === selectedId ? 0 : -1}
                onClick={() => onSelect(task.id)}
                onKeyDown={(event) => handleTaskKeyDown(event, tasks.indexOf(task))}
                className={cn(
                  'flex h-10 max-w-[240px] shrink-0 items-center justify-start gap-2 rounded-sm border px-3 text-left transition-colors duration-fast ease-standard focus-ring',
                  task.id === selectedId
                    ? 'border-border bg-surface text-foreground shadow-xs'
                    : 'border-transparent bg-subtle text-foreground-secondary hover:text-foreground',
                  task.queueStatus === 'failed' && 'border-danger-border/60',
                )}
              >
                <TaskStatusIcon status={task.queueStatus} />
                <span className="flex min-w-0 flex-col items-start leading-tight">
                  <span className="max-w-[180px] truncate font-mono text-xs">{task.sourceName}</span>
                  <span
                    className={cn(
                      'text-[10px] font-normal text-foreground-tertiary',
                      task.queueStatus === 'failed' && 'text-danger',
                    )}
                  >
                    {t(STATUS_LABEL[task.queueStatus])}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
        {error && (
          <p role="alert" className="mt-2 text-xs leading-relaxed text-danger">
            {error}
          </p>
        )}
      </div>
      <div role="tabpanel" className="flex min-h-0 flex-1">
        {children}
      </div>
    </div>
  );
}
