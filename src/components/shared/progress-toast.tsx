'use client';
import { useEffect, useState } from 'react';
import { Check, ChevronRight, Loader2, X } from 'lucide-react';
import { useJobStream } from '@/hooks/use-job-stream';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';

interface ProgressToastProps {
  jobId: string | null;
  onClose?: () => void;
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') return <Check className="h-4 w-4 text-success" />;
  if (status === 'failed') return <X className="h-4 w-4 text-danger" />;
  return <Loader2 className="h-4 w-4 text-accent animate-spin" />;
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
    const nested = (e.data.data ?? {}) as Record<string, unknown>;
    const p = nested.file ?? nested.path ?? nested.filename ?? e.data.file ?? e.data.path ?? e.data.filename;
    if (typeof p === 'string' && !files.includes(p)) files.push(p);
  }
  return files;
}

export function ProgressToast({ jobId, onClose }: ProgressToastProps) {
  const { events, status, latestMessage } = useJobStream(jobId);
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    if (jobId) {
      setMounted(true);
      setCollapsed(false); // a new job is always shown expanded
      const t = setTimeout(() => setVisible(true), 10);
      return () => clearTimeout(t);
    }
    setVisible(false);
  }, [jobId]);

  const handleClose = () => {
    setVisible(false);
    setTimeout(() => {
      setMounted(false);
      onClose?.();
    }, 200);
  };

  if (!mounted || !jobId) return null;

  const jobType = detectJobType(events);
  const files = extractFiles(events);
  const isFinished = status === 'completed' || status === 'failed';

  const progressValue = (() => {
    if (status === 'completed' || status === 'failed') return 100;
    const pEvent = [...events].reverse().find((e) => typeof e.data.progress === 'number');
    if (pEvent) return pEvent.data.progress as number;
    return null;
  })();

  const statusBorder =
    status === 'failed'
      ? 'border-danger/40'
      : status === 'completed'
      ? 'border-success/40'
      : 'border-border';

  return (
    // Positioning container, anchored to the bottom-right corner. It's pointer-events-none
    // so the empty area it spans never blocks controls beneath it (e.g. the chat send button);
    // the card and handle each re-enable pointer events only while they're the active half.
    <div className="fixed bottom-4 right-0 z-sheet pointer-events-none">
      {/* Card: full progress view; rests at the bottom-right (mr-4) and slides off the
          right edge when collapsed. */}
      <div
        role="status"
        aria-live="polite"
        inert={collapsed}
        className={cn(
          'mr-4 w-80 rounded-lg border bg-surface shadow-lg transition-all duration-base ease-standard',
          statusBorder,
          collapsed
            ? 'pointer-events-none translate-x-[calc(100%+1rem)] opacity-0'
            : visible
            ? 'pointer-events-auto translate-x-0 opacity-100'
            : 'pointer-events-none translate-y-4 opacity-0',
        )}
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <StatusIcon status={status} />
          <span className="flex-1 text-sm font-medium text-foreground">
            {jobType}
            {status === 'completed' && ' — Done'}
            {status === 'failed' && ' — Failed'}
          </span>
          <IconButton size="sm" onClick={() => setCollapsed(true)} aria-label="Collapse progress">
            <ChevronRight />
          </IconButton>
          {isFinished && (
            <IconButton size="sm" onClick={handleClose} aria-label="Close">
              <X />
            </IconButton>
          )}
        </div>

        <div className="px-3 py-3 space-y-2">
          {latestMessage && (
            <p className="text-xs text-foreground-secondary line-clamp-2">{latestMessage}</p>
          )}

          {progressValue !== null ? (
            <div className="w-full h-1 rounded-full bg-subtle overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-slow',
                  status === 'failed' ? 'bg-danger' : 'bg-accent',
                )}
                style={{ width: `${progressValue}%` }}
              />
            </div>
          ) : (
            status === 'streaming' && (
              <div className="w-full h-1 rounded-full bg-subtle overflow-hidden">
                <div className="h-full w-1/3 rounded-full bg-accent animate-pulse" />
              </div>
            )
          )}

          {files.length > 0 && (
            <div className="max-h-20 overflow-y-auto space-y-0.5">
              {files.map((f, idx) => (
                <p key={idx} className="text-xs text-foreground-tertiary truncate font-mono">
                  {f}
                </p>
              ))}
            </div>
          )}

          {!isFinished && (
            <p className="text-xs text-foreground-tertiary">
              {events.length} event{events.length !== 1 ? 's' : ''} received
            </p>
          )}
        </div>
      </div>

      {/* Edge handle: a tab flush to the right edge, pinned to the top of the card's
          footprint (top-0) so its icon sits on the same horizontal line as the card's
          header icon — collapsing then reads as a horizontal retract, not a vertical jump.
          `!absolute` overrides the `position: relative` that `.tip` would otherwise apply. */}
      <button
        type="button"
        onClick={() => setCollapsed(false)}
        aria-label="Expand progress"
        data-tip="Expand progress"
        inert={!collapsed}
        className={cn(
          'tip tip-l !absolute right-0 top-0 flex flex-col items-center gap-1 rounded-l-lg border border-r-0 bg-surface px-1.5 py-2 shadow-lg focus-ring transition-all duration-base ease-standard',
          statusBorder,
          collapsed
            ? 'translate-x-0 opacity-100 pointer-events-auto'
            : 'translate-x-full opacity-0 pointer-events-none',
        )}
      >
        <StatusIcon status={status} />
        {progressValue !== null && (
          <span className="font-mono text-[10px] tabular-nums text-foreground-tertiary">
            {Math.round(progressValue)}%
          </span>
        )}
      </button>
    </div>
  );
}
