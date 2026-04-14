'use client';
import { useEffect, useState } from 'react';
import { useJobStream } from '@/hooks/use-job-stream';

interface ProgressToastProps {
  jobId: string | null;
  onClose?: () => void;
}

function statusIcon(status: string) {
  if (status === 'completed') {
    return (
      <svg
        className="w-4 h-4 text-emerald-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4.5 12.75l6 6 9-13.5"
        />
      </svg>
    );
  }
  if (status === 'failed') {
    return (
      <svg
        className="w-4 h-4 text-red-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2.5}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M6 18L18 6M6 6l12 12"
        />
      </svg>
    );
  }
  // streaming / idle
  return (
    <svg
      className="w-4 h-4 text-blue-500 animate-spin"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

function detectJobType(events: { type: string }[]): string {
  for (const e of events) {
    if (e.type.startsWith('ingest')) return 'Ingesting';
    if (e.type.startsWith('lint')) return 'Linting';
  }
  return 'Processing';
}

function extractFiles(events: { type: string; data: Record<string, unknown> }[]): string[] {
  const files: string[] = [];
  for (const e of events) {
    // Server wraps payload as { message, data: {...}, createdAt }
    const nested = (e.data.data ?? {}) as Record<string, unknown>;
    const p = nested.file ?? nested.path ?? nested.filename ?? e.data.file ?? e.data.path ?? e.data.filename;
    if (typeof p === 'string' && !files.includes(p)) {
      files.push(p);
    }
  }
  return files;
}

export function ProgressToast({ jobId, onClose }: ProgressToastProps) {
  const { events, status, latestMessage } = useJobStream(jobId);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);

  // Slide-in animation
  useEffect(() => {
    if (jobId) {
      setMounted(true);
      const t = setTimeout(() => setVisible(true), 10);
      return () => clearTimeout(t);
    } else {
      setVisible(false);
    }
  }, [jobId]);

  const handleClose = () => {
    setVisible(false);
    setTimeout(() => {
      setMounted(false);
      onClose?.();
    }, 300);
  };

  if (!mounted || !jobId) return null;

  const jobType = detectJobType(events);
  const files = extractFiles(events);
  const isFinished = status === 'completed' || status === 'failed';

  // Progress value: simple approximation from events count
  // (real progress would come from data.progress field)
  const progressValue = (() => {
    if (status === 'completed') return 100;
    if (status === 'failed') return 100;
    const pEvent = [...events]
      .reverse()
      .find((e) => typeof e.data.progress === 'number');
    if (pEvent) return pEvent.data.progress as number;
    return null;
  })();

  return (
    <div
      className={`fixed bottom-4 right-4 z-50 w-80 rounded-xl shadow-xl border transition-all duration-300 ${
        visible
          ? 'translate-y-0 opacity-100'
          : 'translate-y-8 opacity-0'
      } ${
        status === 'failed'
          ? 'border-red-200 dark:border-red-800 bg-white dark:bg-zinc-900'
          : status === 'completed'
          ? 'border-emerald-200 dark:border-emerald-800 bg-white dark:bg-zinc-900'
          : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900'
      }`}
      role="status"
      aria-live="polite"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
        {statusIcon(status)}
        <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-slate-100">
          {jobType}
          {status === 'completed' && ' — Done'}
          {status === 'failed' && ' — Failed'}
        </span>
        {isFinished && (
          <button
            onClick={handleClose}
            className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
            aria-label="Close"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Body */}
      <div className="px-4 py-3 space-y-2">
        {/* Latest message */}
        {latestMessage && (
          <p className="text-xs text-zinc-600 dark:text-zinc-400 line-clamp-2">
            {latestMessage}
          </p>
        )}

        {/* Progress bar */}
        {progressValue !== null ? (
          <div className="w-full h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-500 ${
                status === 'failed' ? 'bg-red-500' : 'bg-blue-500'
              }`}
              style={{ width: `${progressValue}%` }}
            />
          </div>
        ) : (
          status === 'streaming' && (
            <div className="w-full h-1.5 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
              <div className="h-full w-1/3 rounded-full bg-blue-500 animate-pulse" />
            </div>
          )
        )}

        {/* File list */}
        {files.length > 0 && (
          <div className="max-h-20 overflow-y-auto space-y-0.5">
            {files.map((f, idx) => (
              <p
                key={idx}
                className="text-xs text-zinc-500 dark:text-zinc-500 truncate font-mono"
              >
                {f}
              </p>
            ))}
          </div>
        )}

        {/* Event count */}
        {!isFinished && (
          <p className="text-xs text-zinc-400 dark:text-zinc-600">
            {events.length} event{events.length !== 1 ? 's' : ''} received
          </p>
        )}
      </div>
    </div>
  );
}
