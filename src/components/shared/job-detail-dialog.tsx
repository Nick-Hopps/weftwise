'use client';

/**
 * JobDetailDialog —— job 详情弹窗：上半部展示当前任务全部事件日志（时间线，
 * error 行红色高亮），失败时下半部经 GET /api/jobs/[id] 取 resultJson.error
 * 展示完整错误（message + 可折叠技术细节 + 一键复制）。
 *
 * 关键约束：本组件不自建 useJobStream —— events/status 由 ProgressToast 透传，
 * 避免对同一 jobId 新开第二条 EventSource。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';
import type { Job } from '@/lib/contracts';
import type { JobStreamEvent, JobStreamStatus } from '@/hooks/use-job-stream';
import { eventLogLine, parseJobError } from '@/lib/job-log';

interface JobDetailDialogProps {
  jobId: string;
  events: JobStreamEvent[];
  status: JobStreamStatus;
  open: boolean;
  onClose: () => void;
}

/** 与 progress-toast 的 detectJobType 保持一致的类型识别（本地实现，避免跨组件依赖）。 */
function jobTitle(events: JobStreamEvent[]): string {
  for (const e of events) {
    if (e.type.startsWith('ingest')) return 'Ingesting';
    if (e.type.startsWith('lint')) return 'Linting';
  }
  return 'Processing';
}

export function JobDetailDialog({ jobId, events, status, open, onClose }: JobDetailDialogProps) {
  const logRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [copied, setCopied] = useState(false);
  const [errorExpanded, setErrorExpanded] = useState(true);

  const lines = useMemo(() => events.map(eventLogLine), [events]);

  // 失败时拉权威完整错误（resultJson.error）。SSE 实时 job:failed 只带摘要。
  const jobQuery = useQuery<Job>({
    queryKey: ['job', jobId],
    queryFn: async () => {
      const res = await apiFetch(`/api/jobs/${jobId}`);
      if (!res.ok) throw new Error(`GET /api/jobs/${jobId} → ${res.status}`);
      return (await res.json()) as Job;
    },
    enabled: open && status === 'failed',
  });

  const jobError = parseJobError(jobQuery.data?.resultJson);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // 新日志到达时自动滚到底（仅当用户当前已在底部，避免打断手动上滚）
  useEffect(() => {
    if (!open) return;
    const el = logRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, open]);

  if (!open) return null;

  const handleScroll = () => {
    const el = logRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const copyError = async () => {
    if (!jobError) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(jobError, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 剪贴板不可用（非安全上下文）时静默 */
    }
  };

  const title = jobTitle(events);

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-command flex items-start justify-center pt-[12vh] bg-overlay/40 backdrop-blur-sm animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={`job-detail-title-${jobId}`}
        className="flex h-[70vh] max-h-[640px] w-full max-w-2xl mx-4 flex-col bg-surface rounded-lg shadow-lg border border-border overflow-hidden animate-slide-down"
      >
        <div className="flex items-center justify-between h-12 shrink-0 px-4 border-b border-border">
          <h2 id={`job-detail-title-${jobId}`} className="text-sm font-semibold text-foreground">
            {title}
            {status === 'completed' && ' — Done'}
            {status === 'failed' && ' — Failed'}
          </h2>
          <IconButton size="sm" onClick={onClose} aria-label="Close">
            <X />
          </IconButton>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {/* 日志区 */}
          <div className="px-4 py-2 text-xs font-medium text-foreground-secondary border-b border-border">
            日志 · {lines.length}
          </div>
          <div
            ref={logRef}
            onScroll={handleScroll}
            className="min-h-0 flex-1 overflow-y-auto px-4 py-2 space-y-0.5 font-mono text-xs"
          >
            {lines.length === 0 ? (
              <p className="text-foreground-tertiary">暂无日志</p>
            ) : (
              lines.map((line, idx) => (
                <div
                  key={idx}
                  className={cn(
                    'flex gap-2 whitespace-pre-wrap break-words',
                    line.isError ? 'text-danger' : 'text-foreground-secondary',
                  )}
                >
                  {line.time && (
                    <span className="shrink-0 text-foreground-tertiary tabular-nums">{line.time}</span>
                  )}
                  <span>{line.text}</span>
                </div>
              ))
            )}
          </div>

          {/* 错误区（仅失败时） */}
          {status === 'failed' && (
            <div className="shrink-0 border-t border-border bg-danger/5 max-h-[45%] overflow-y-auto">
              <div className="flex items-center justify-between px-4 py-2">
                <span className="text-xs font-medium text-danger">错误</span>
                {jobError && (
                  <IconButton size="sm" onClick={copyError} aria-label="复制错误">
                    {copied ? <Check /> : <Copy />}
                  </IconButton>
                )}
              </div>
              <div className="px-4 pb-3 space-y-2">
                {jobQuery.isLoading && <p className="text-xs text-foreground-tertiary">加载错误详情…</p>}
                {jobError ? (
                  <>
                    <p className="text-sm font-medium text-foreground whitespace-pre-wrap break-words">
                      {jobError.message}
                    </p>
                    <button
                      type="button"
                      onClick={() => setErrorExpanded((v) => !v)}
                      className="flex items-center gap-1 text-xs text-foreground-secondary focus-ring"
                    >
                      {errorExpanded ? (
                        <ChevronDown className="h-3 w-3" />
                      ) : (
                        <ChevronRight className="h-3 w-3" />
                      )}
                      技术细节
                    </button>
                    {errorExpanded && (
                      <div className="space-y-2 font-mono text-xs text-foreground-tertiary">
                        {jobError.stack && <pre className="whitespace-pre-wrap break-words">{jobError.stack}</pre>}
                        {jobError.cause && (
                          <pre className="whitespace-pre-wrap break-words">cause: {jobError.cause}</pre>
                        )}
                        {jobError.responseText && (
                          <pre className="whitespace-pre-wrap break-words">response: {jobError.responseText}</pre>
                        )}
                        {jobError.finishReason && (
                          <pre className="whitespace-pre-wrap break-words">finishReason: {jobError.finishReason}</pre>
                        )}
                        {jobError.usage != null && (
                          <pre className="whitespace-pre-wrap break-words">usage: {JSON.stringify(jobError.usage)}</pre>
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  !jobQuery.isLoading && (
                    <p className="text-sm text-foreground-secondary whitespace-pre-wrap break-words">
                      {lines.filter((l) => l.isError).slice(-1)[0]?.text ?? '任务失败，无更多错误信息。'}
                    </p>
                  )
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
