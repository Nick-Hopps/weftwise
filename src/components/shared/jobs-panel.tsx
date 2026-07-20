'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight, Loader2, ListTodo, Square, Trash2, X } from 'lucide-react';
import { useJobStream } from '@/hooks/use-job-stream';
import type { JobStreamStatus } from '@/hooks/job-stream-logic';
import { apiFetch } from '@/lib/api-fetch';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';
import { latestToolName, stripLegacyToolActivityIcon } from '@/lib/tool-activity';
import { JobDetailDialog } from './job-detail-dialog';
import { ToolActivityIcon } from './tool-activity-icon';
import {
  jobTypeVerb,
  shouldRefreshPageForCompletedJob,
  summarizeJobsPanel,
  type TrackedJob,
} from './jobs-panel-state';
import { useI18n } from '@/components/i18n-provider';

export type { TrackedJob } from './jobs-panel-state';

function RowStatusIcon({ status, queueStatus }: { status: string; queueStatus: string }) {
  if (status === 'completed') return <Check className="h-3.5 w-3.5 text-success" />;
  if (status === 'failed') return <X className="h-3.5 w-3.5 text-danger" />;
  if (queueStatus === 'pending' && status === 'idle')
    return <ListTodo className="h-3.5 w-3.5 text-foreground-tertiary" />;
  return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />;
}

/** 单任务行：running 时持有自己的 SSE 订阅；终态后驻留，等待单条或批量清理。 */
function JobRow({
  job,
  onRemove,
  onStatusChange,
}: {
  job: TrackedJob;
  onRemove: (id: string) => void;
  onStatusChange: (id: string, status: JobStreamStatus) => void;
}) {
  const { t } = useI18n();
  // pending 行不建 SSE（浏览器每域 SSE 连接有限；轮询会在其转 running 后接上）
  const streamId = job.queueStatus === 'running' ? job.id : null;
  const { events, status, latestMessage } = useJobStream(streamId, job.reconnectKey);
  const [detailOpen, setDetailOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const queryClient = useQueryClient();
  const router = useRouter();
  const refreshedCompletion = useRef(false);

  const isCompleted = status === 'completed';
  const isFailed = status === 'failed';
  const wasCancelled = events.some((e) => e.type === 'job:cancelled');
  const latestTool = latestToolName(events);

  useEffect(() => {
    onStatusChange(job.id, status);
  }, [job.id, onStatusChange, status]);

  // 任一 job 完成 → 失效列表缓存（保持旧 GlobalJobTracker 语义）
  useEffect(() => {
    if (!isCompleted) {
      refreshedCompletion.current = false;
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['pages'] });
    queryClient.invalidateQueries({ queryKey: ['page-detail'] });
    if (job.type === 'ingest') {
      queryClient.invalidateQueries({ queryKey: ['sources'] });
    }
    if (
      shouldRefreshPageForCompletedJob(job.type, status)
      && !refreshedCompletion.current
    ) {
      refreshedCompletion.current = true;
      router.refresh();
    }
  }, [isCompleted, job.type, queryClient, router, status]);

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
            <span className="text-foreground-secondary">{t(jobTypeVerb(job.type))}</span>{' '}
            <span className="font-mono">{job.label}</span>
          </span>
          {status === 'streaming' && (
            <IconButton
              size="sm"
              onClick={handleCancel}
              disabled={cancelling}
              aria-label={t('jobs.stop')}
              className="tip tip-l"
              data-tip={t('jobs.stop')}
            >
              <Square />
            </IconButton>
          )}
          {(isCompleted || isFailed) && (
            <IconButton size="sm" onClick={() => onRemove(job.id)} aria-label={t('jobs.dismiss')}>
              <X />
            </IconButton>
          )}
        </div>
        <p className="flex items-center gap-1.5 truncate pl-[22px] text-xs text-foreground-tertiary">
          {latestTool && <ToolActivityIcon tool={latestTool} className="h-3 w-3 shrink-0" />}
          <span className="truncate">
          {job.queueStatus === 'pending' && status === 'idle'
            ? t('jobs.queued')
            : isFailed
              ? wasCancelled
                ? t('jobs.cancelled')
                : (latestTool ? stripLegacyToolActivityIcon(latestMessage) : latestMessage) || t('jobs.failed')
              : (latestTool ? stripLegacyToolActivityIcon(latestMessage) : latestMessage) || '…'}
          </span>
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
            {isFailed && !wasCancelled ? t('jobs.viewError') : t('jobs.viewDetails')}
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
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [visible, setVisible] = useState(false);
  const [statuses, setStatuses] = useState<Record<string, JobStreamStatus>>({});

  const handleStatusChange = useCallback((id: string, status: JobStreamStatus) => {
    setStatuses((current) => current[id] === status ? current : { ...current, [id]: status });
  }, []);

  useEffect(() => {
    const jobIds = new Set(jobs.map((job) => job.id));
    setStatuses((current) => {
      const entries = Object.entries(current).filter(([id]) => jobIds.has(id));
      return entries.length === Object.keys(current).length
        ? current
        : Object.fromEntries(entries) as Record<string, JobStreamStatus>;
    });
  }, [jobs]);

  useEffect(() => {
    if (jobs.length > 0) {
      const t = setTimeout(() => setVisible(true), 10);
      return () => clearTimeout(t);
    }
    setVisible(false);
  }, [jobs.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const summary = useMemo(() => summarizeJobsPanel(jobs, statuses), [jobs, statuses]);
  const finishedCount = summary.completedCount + summary.failedCount;
  const summaryText = [
    summary.runningCount > 0 && t('jobs.runningCount', { count: summary.runningCount }),
    summary.pendingCount > 0 && t('jobs.queuedCount', { count: summary.pendingCount }),
    finishedCount > 0 && t('jobs.finishedCount', { count: finishedCount }),
  ].filter(Boolean).join(' · ');

  const handleClearFinished = () => {
    for (const id of summary.finishedJobIds) onRemove(id);
  };

  if (jobs.length === 0) return null;

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
            {t('jobs.tasks')}
            <span className="ml-1.5 font-mono text-xs text-foreground-tertiary">
              {summaryText}
            </span>
          </span>
          {finishedCount > 0 && (
            <IconButton
              size="sm"
              onClick={handleClearFinished}
              aria-label={t('jobs.clearFinished')}
              className="tip tip-l"
              data-tip={t('jobs.clearFinished')}
            >
              <Trash2 />
            </IconButton>
          )}
          <IconButton
            size="sm"
            onClick={() => setCollapsed(true)}
            aria-label={t('jobs.collapseTasks')}
            className="tip tip-l"
            data-tip={t('jobs.collapseTasks')}
          >
            <ChevronRight />
          </IconButton>
        </div>
        <ul className="max-h-72 divide-y divide-border-subtle overflow-y-auto">
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              onRemove={onRemove}
              onStatusChange={handleStatusChange}
            />
          ))}
        </ul>
      </div>

      {/* 折叠后的边缘把手（贴右缘，展示任务总数） */}
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label={t('jobs.expandTasks')}
        data-tip={t('jobs.expandTasks')}
        inert={!collapsed}
        className={cn(
          'tip tip-l !absolute right-0 top-0 flex flex-col items-center gap-1 rounded-l-lg border border-r-0 border-border bg-surface px-1.5 py-2 shadow-lg focus-ring transition-all duration-base ease-standard',
          collapsed
            ? 'translate-x-0 opacity-100 pointer-events-auto'
            : 'translate-x-full opacity-0 pointer-events-none',
        )}
      >
        {summary.collapsedStatus === 'processing' ? (
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        ) : summary.collapsedStatus === 'completed' ? (
          <Check className="h-4 w-4 text-success" />
        ) : (
          <X className="h-4 w-4 text-danger" />
        )}
        <span className="font-mono text-[10px] tabular-nums text-foreground-tertiary">
          {jobs.length}
        </span>
      </button>
    </div>
  );
}
