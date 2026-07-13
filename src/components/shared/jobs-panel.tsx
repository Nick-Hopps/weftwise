'use client';

import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Loader2, ListTodo, Square, X } from 'lucide-react';
import { useJobStream } from '@/hooks/use-job-stream';
import { apiFetch } from '@/lib/api-fetch';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';
import { JobDetailDialog } from './job-detail-dialog';

export interface TrackedJob {
  id: string;
  type: string;
  /** 一行可读摘要：文件名 / URL / slug，兜底 job 类型名。 */
  label: string;
  /** 轮询到的队列状态：running 才建 SSE（浏览器 SSE 连接数有限）。 */
  queueStatus: 'running' | 'pending';
  /** bump 以强制重新订阅（retry 同 id 场景）。 */
  reconnectKey: number;
}

function jobTypeVerb(type: string): string {
  switch (type) {
    case 'ingest':
      return 'Ingesting';
    case 'lint':
      return 'Linting';
    case 'curate':
      return 'Curating';
    case 'fix':
      return 'Fixing';
    case 're-enrich':
      return 'Enriching';
    case 'embed-index':
      return 'Indexing';
    case 'research':
      return 'Researching';
    case 'research-import':
      return 'Importing research';
    default:
      return 'Processing';
  }
}

function RowStatusIcon({ status, queueStatus }: { status: string; queueStatus: string }) {
  if (status === 'completed') return <Check className="h-3.5 w-3.5 text-success" />;
  if (status === 'failed') return <X className="h-3.5 w-3.5 text-danger" />;
  if (queueStatus === 'pending' && status === 'idle')
    return <ListTodo className="h-3.5 w-3.5 text-foreground-tertiary" />;
  return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />;
}

/** 单任务行：running 时持有自己的 SSE 订阅；终态后驻留（completed 定时移除）。 */
function JobRow({ job, onRemove }: { job: TrackedJob; onRemove: (id: string) => void }) {
  // pending 行不建 SSE（浏览器每域 SSE 连接有限；轮询会在其转 running 后接上）
  const streamId = job.queueStatus === 'running' ? job.id : null;
  const { events, status, latestMessage } = useJobStream(streamId, job.reconnectKey);
  const [detailOpen, setDetailOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const queryClient = useQueryClient();

  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';
  const wasCancelled = events.some((e) => e.type === 'job:cancelled');

  // 任一 job 完成 → 失效列表缓存（保持旧 GlobalJobTracker 语义）
  useEffect(() => {
    if (!isCompleted) return;
    queryClient.invalidateQueries({ queryKey: ['pages'] });
    queryClient.invalidateQueries({ queryKey: ['page-detail'] });
  }, [isCompleted, queryClient]);

  const handleCancel = async () => {
    if (cancelling) return;
    setCancelling(true);
    try {
      await apiFetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' });
    } catch {
      // 结果由 SSE 终态事件反映
    } finally {
      setCancelling(false);
    }
  };

  return (
    <>
      <li className="flex flex-col gap-1 px-3 py-2">
        <div className="flex items-center gap-2">
          <RowStatusIcon status={status} queueStatus={job.queueStatus} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            <span className="text-foreground-secondary">{jobTypeVerb(job.type)}</span>{' '}
            <span className="font-mono">{job.label}</span>
          </span>
          {status === 'streaming' && (
            <IconButton
              size="sm"
              onClick={handleCancel}
              disabled={cancelling}
              aria-label="Stop job"
              className="tip tip-l"
              data-tip="Stop job"
            >
              <Square />
            </IconButton>
          )}
          {(isCompleted || isFailed) && (
            <IconButton size="sm" onClick={() => onRemove(job.id)} aria-label="Dismiss">
              <X />
            </IconButton>
          )}
        </div>
        <p className="truncate pl-[22px] text-xs text-foreground-tertiary">
          {job.queueStatus === 'pending' && status === 'idle'
            ? 'Queued'
            : isFailed
              ? wasCancelled
                ? 'Cancelled'
                : latestMessage || 'Failed'
              : latestMessage || '…'}
        </p>
        {(isFailed || events.length > 0) && (
          <button
            type="button"
            onClick={() => setDetailOpen(true)}
            className={cn(
              'self-start pl-[22px] text-xs font-medium focus-ring',
              isFailed && !wasCancelled ? 'text-danger' : 'text-accent',
            )}
          >
            {isFailed && !wasCancelled ? 'View error →' : 'View details →'}
          </button>
        )}
      </li>
      <JobDetailDialog
        jobId={job.id}
        events={events}
        status={status}
        open={detailOpen}
        onClose={() => setDetailOpen(false)}
      />
    </>
  );
}

/**
 * 右下角聚合任务面板：列出所有 running/pending job，各行独立 SSE 进度。
 * 单行时视觉接近旧 ProgressToast；可整体折叠为边缘把手。
 */
export function JobsPanel({
  jobs,
  onRemove,
}: {
  jobs: TrackedJob[];
  onRemove: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (jobs.length > 0) {
      const t = setTimeout(() => setVisible(true), 10);
      return () => clearTimeout(t);
    }
    setVisible(false);
  }, [jobs.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  if (jobs.length === 0) return null;

  const runningCount = jobs.filter((j) => j.queueStatus === 'running').length;

  return (
    <div className="fixed bottom-4 right-0 z-sheet pointer-events-none">
      <div
        role="status"
        aria-live="polite"
        inert={collapsed}
        className={cn(
          'mr-4 w-80 rounded-lg border border-border bg-surface shadow-lg transition-all duration-base ease-standard',
          collapsed
            ? 'pointer-events-none translate-x-[calc(100%+1rem)] opacity-0'
            : visible
              ? 'pointer-events-auto translate-x-0 opacity-100'
              : 'pointer-events-none translate-y-4 opacity-0',
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="flex-1 text-sm font-medium text-foreground">
            Tasks
            <span className="ml-1.5 font-mono text-xs text-foreground-tertiary">
              {runningCount} running · {jobs.length - runningCount} queued/done
            </span>
          </span>
          <IconButton
            size="sm"
            onClick={() => setCollapsed(true)}
            aria-label="Collapse tasks"
            className="tip tip-l"
            data-tip="Collapse"
          >
            <ChevronRight />
          </IconButton>
        </div>
        <ul className="max-h-72 divide-y divide-border-subtle overflow-y-auto">
          {jobs.map((job) => (
            <JobRow key={job.id} job={job} onRemove={onRemove} />
          ))}
        </ul>
      </div>

      {/* 折叠后的边缘把手（贴右缘，展示 running 计数） */}
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="Expand tasks"
        data-tip="Expand tasks"
        inert={!collapsed}
        className={cn(
          'tip tip-l !absolute right-0 top-0 flex flex-col items-center gap-1 rounded-l-lg border border-r-0 border-border bg-surface px-1.5 py-2 shadow-lg focus-ring transition-all duration-base ease-standard',
          collapsed
            ? 'translate-x-0 opacity-100 pointer-events-auto'
            : 'translate-x-full opacity-0 pointer-events-none',
        )}
      >
        {runningCount > 0 ? (
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        ) : (
          <Check className="h-4 w-4 text-success" />
        )}
        <span className="font-mono text-[10px] tabular-nums text-foreground-tertiary">
          {jobs.length}
        </span>
      </button>
    </div>
  );
}
