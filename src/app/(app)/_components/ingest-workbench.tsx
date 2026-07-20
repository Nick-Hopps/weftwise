'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  FileUp,
  GitCommitHorizontal,
  Layers,
  Link2,
  ListChecks,
  PenLine,
  ScanText,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import { useJobStream } from '@/hooks/use-job-stream';
import { apiFetch } from '@/lib/api-fetch';
import { takePendingIngestFile } from '@/lib/pending-ingest-file';
import { parseUrlLines } from '@/lib/url-list';
import { currentUrlAuthChallenge, jobResultRequiresUrlAuth } from '@/lib/ingest-auth';
import { useUIStore } from '@/stores/ui-store';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';
import {
  ingestTaskFromJob,
  mergeIngestTasks,
  pickInitialIngestTaskId,
  type IngestTask,
} from '@/lib/ingest-task-list';
import { IngestLiveView } from './ingest-live-view';
import { IngestAuthDialog } from './ingest-auth-dialog';
import { IngestTaskSwitcher } from './ingest-task-switcher';
import type { CheckpointProgress, Job } from '@/lib/contracts';
import { dispatchJobStarted } from '@/lib/job-started-event';
import { useI18n } from '@/components/i18n-provider';
import type { MessageKey } from '@/lib/i18n/messages';

/** The real ingest pipeline's six phases — shown as a "what happens" preview. */
const PIPELINE: ReadonlyArray<{ labelKey: MessageKey; Icon: LucideIcon }> = [
  { labelKey: 'jobs.phase.parse', Icon: ScanText },
  { labelKey: 'jobs.phase.plan', Icon: ListChecks },
  { labelKey: 'jobs.phase.write', Icon: PenLine },
  { labelKey: 'jobs.phase.enrich', Icon: Wand2 },
  { labelKey: 'jobs.phase.verify', Icon: ShieldCheck },
  { labelKey: 'jobs.phase.commit', Icon: GitCommitHorizontal },
];

const ACCEPT = '.md,.mdx,.txt,.html,.htm,.pdf';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function queuedTask(jobId: string, sourceName: string, order = 0): IngestTask {
  return {
    id: jobId,
    sourceName,
    queueStatus: 'pending',
    createdAt: new Date(Date.now() + order).toISOString(),
    checkpointProgress: null,
  };
}

function IngestTaskDetail({
  task,
  onBackground,
  onStartNew,
  onRemove,
  onStatusChange,
}: {
  task: IngestTask;
  onBackground: () => void;
  onStartNew: () => void;
  onRemove: (jobId: string) => void;
  onStatusChange: (jobId: string, status: IngestTask['queueStatus']) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [reconnectKey, setReconnectKey] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [terminating, setTerminating] = useState(false);
  const [checkpointProgress, setCheckpointProgress] = useState<CheckpointProgress | null>(
    task.checkpointProgress,
  );
  const [createdPages, setCreatedPages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [authDialogOpen, setAuthDialogOpen] = useState(false);
  const { events, status, latestMessage } = useJobStream(task.id, reconnectKey);
  const authChallenge = useMemo(() => currentUrlAuthChallenge(events), [events]);
  const isDone = status === 'completed';
  const hasEvents = events.length > 0;

  useEffect(() => {
    if (status === 'completed' || status === 'failed') {
      onStatusChange(task.id, status);
    } else if (status === 'streaming' && hasEvents) {
      onStatusChange(task.id, 'running');
    }
  }, [hasEvents, onStatusChange, status, task.id]);

  useEffect(() => {
    if (!isDone) return;
    queryClient.invalidateQueries({ queryKey: ['pages'] });
    queryClient.invalidateQueries({ queryKey: ['sources'] });
  }, [isDone, queryClient]);

  useEffect(() => {
    if (!isDone) return;
    const doneEvent = events.find((event) =>
      event.type === 'job:completed' || event.type === 'ingest:complete');
    const result = (doneEvent?.data?.data as { result?: { pagesCreated?: string[] } } | undefined)
      ?.result;
    if (result?.pagesCreated) setCreatedPages(result.pagesCreated);
  }, [isDone, events]);

  const handleRetry = useCallback(async () => {
    setRetrying(true);
    setError(null);
    try {
      const res = await apiFetch(`/api/jobs/${task.id}/retry`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || t('ingest.error.retryStatus', { status: res.status }));
      }
      setCheckpointProgress(null);
      onStatusChange(task.id, 'pending');
      setReconnectKey((key) => key + 1);
      dispatchJobStarted({
        jobId: task.id,
        type: 'ingest',
        label: task.sourceName,
        queueStatus: 'pending',
      });
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError));
    } finally {
      setRetrying(false);
    }
  }, [onStatusChange, t, task.id, task.sourceName]);

  const handleAuthenticated = useCallback(() => {
    setAuthDialogOpen(false);
    setCheckpointProgress(null);
    setError(null);
    onStatusChange(task.id, 'pending');
    setReconnectKey((key) => key + 1);
    dispatchJobStarted({
      jobId: task.id,
      type: 'ingest',
      label: task.sourceName,
      queueStatus: 'pending',
    });
  }, [onStatusChange, task.id, task.sourceName]);

  useEffect(() => {
    if (status !== 'failed') setAuthDialogOpen(false);
  }, [status]);

  const handleTerminate = useCallback(async () => {
    if (terminating) return;
    setTerminating(true);
    try {
      await apiFetch(`/api/jobs/${task.id}/cancel`, { method: 'POST' });
    } catch {
      // 即便请求失败也允许用户从工作台移除这个卡住的任务。
    } finally {
      setTerminating(false);
      onRemove(task.id);
    }
  }, [onRemove, task.id, terminating]);

  useEffect(() => {
    if (status !== 'failed') return;
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch(`/api/jobs/${task.id}`);
        if (!res.ok) return;
        const job = (await res.json()) as { checkpointProgress?: CheckpointProgress | null };
        if (!cancelled) setCheckpointProgress(job.checkpointProgress ?? null);
      } catch {
        // 续传进度只用于优化按钮文案。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status, task.id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && (
        <p role="alert" className="shrink-0 border-b border-danger-border/40 bg-danger-bg px-6 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      <div className="min-h-0 flex-1">
        <IngestLiveView
          inline
          jobId={task.id}
          sourceName={task.sourceName}
          status={status}
          events={events}
          latestMessage={latestMessage}
          createdPages={createdPages}
          onBackground={onBackground}
          onIngestAnother={onStartNew}
          onRetry={authChallenge ? () => setAuthDialogOpen(true) : handleRetry}
          retrying={authChallenge ? false : retrying}
          retryKind={authChallenge ? 'authenticate' : 'retry'}
          retryLabel={
            authChallenge
              ? t('ingest.auth.action')
              : checkpointProgress
                ? checkpointProgress.totalPages
                  ? t('ingest.resumeProgress', {
                      written: checkpointProgress.writerPages,
                      total: checkpointProgress.totalPages,
                    })
                  : t('ingest.resume')
                : t('common.retry')
          }
          onTerminate={handleTerminate}
          terminating={terminating}
          queued={task.queueStatus === 'pending' && !hasEvents}
        />
      </div>
      <IngestAuthDialog
        open={authDialogOpen}
        jobId={task.id}
        challenge={authChallenge}
        onClose={() => setAuthDialogOpen(false)}
        onAuthenticated={handleAuthenticated}
      />
    </div>
  );
}

/**
 * The dedicated ingest workspace (route `/ingest`). One surface that moves from
 * setup → live progress → completion. The job keeps running in the background
 * if the user navigates away; returning here reflects its current state.
 */
export function IngestWorkbench() {
  const { t } = useI18n();
  const router = useRouter();
  const { slug: subjectSlug } = useCurrentSubject();

  const [mode, setMode] = useState<'file' | 'text' | 'url'>('file');
  const [urlInput, setUrlInput] = useState('');
  const [urlResults, setUrlResults] = useState<
    Array<{ url: string; jobId?: string; sourceId?: string; error?: string }> | null
  >(null);
  const [tasks, setTasks] = useState<IngestTask[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [fileResults, setFileResults] = useState<
    Array<{ filename: string; jobId?: string; error?: string }> | null
  >(null);
  const [textInput, setTextInput] = useState('');
  const [filenameInput, setFilenameInput] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setTasks([]);
    setSelectedTaskId(null);
    setError(null);
    setSelectedFiles([]);
    setFileResults(null);
    setTextInput('');
    setFilenameInput('');
    setUrlInput('');
    setUrlResults(null);
    setMode('file');
    if (fileRef.current) fileRef.current.value = '';
  }, []);

  const handleTaskStatusChange = useCallback(
    (jobId: string, queueStatus: IngestTask['queueStatus']) => {
      setTasks((current) => {
        let changed = false;
        const next = current.map((task) => {
          if (task.id !== jobId || task.queueStatus === queueStatus) return task;
          changed = true;
          return { ...task, queueStatus };
        });
        return changed ? next : current;
      });
    },
    [],
  );

  const handleRemoveTask = useCallback(
    (jobId: string) => {
      const removedIndex = tasks.findIndex((task) => task.id === jobId);
      const next = tasks.filter((task) => task.id !== jobId);
      setTasks(next);
      if (selectedTaskId === jobId) {
        setSelectedTaskId(
          next[Math.min(Math.max(removedIndex, 0), next.length - 1)]?.id ?? null,
        );
      }
    },
    [selectedTaskId, tasks],
  );

  // A file handed off from the dashboard "Choose a file" hero takes precedence:
  // start its upload immediately and watch it live here. The ref guard keeps
  // this idempotent under React StrictMode's double-invoked effects (dev), and
  // signals the restore effect below to stand down so it can't clobber the new
  // job's id with a previously failed one.
  const handoffStarted = useRef(false);
  useEffect(() => {
    if (handoffStarted.current) return;
    const handoff = takePendingIngestFile();
    if (!handoff) return;
    handoffStarted.current = true;
    setSelectedFiles([handoff]);
    void startUpload(handoff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 首次进入时恢复当前 Subject 的全部活跃任务与可续传失败任务；并发槽位占满时
  // pending 任务同样必须进入切换列表。
  useEffect(() => {
    if (handoffStarted.current) return;
    let cancelled = false;
    (async () => {
      const subjectId = useUIStore.getState().currentSubjectId;
      if (!subjectId) return;
      try {
        const query = (status: Job['status']) =>
          apiFetch(
            `/api/jobs?status=${status}&type=ingest&subjectId=${encodeURIComponent(subjectId)}`,
          );
        const [runningRes, pendingRes, failedRes] = await Promise.all([
          query('running'),
          query('pending'),
          query('failed'),
        ]);
        const readJobs = async (response: Response) =>
          response.ok
            ? ((await response.json()) as Array<
                Job & { checkpointProgress: CheckpointProgress | null }
              >)
            : [];
        const [running, pending, failed] = await Promise.all([
          readJobs(runningRes),
          readJobs(pendingRes),
          readJobs(failedRes),
        ]);
        const restored = mergeIngestTasks(
          [],
          [
            ...running,
            ...pending,
            ...failed.filter((job) =>
              job.checkpointProgress || jobResultRequiresUrlAuth(job.resultJson)),
          ].map(
            ingestTaskFromJob,
          ),
        );
        if (restored.length === 0) return;
        if (cancelled) return;
        setTasks(restored);
        setSelectedTaskId(pickInitialIngestTaskId(restored));
      } catch {
        /* silent */
      }
    })();
    return () => {
      cancelled = true;
    };
    // Restore is attempted once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startUpload = useCallback(async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const subjectId = useUIStore.getState().currentSubjectId;
      const formData = new FormData();
      formData.append('file', file);
      if (subjectId) formData.append('subjectId', subjectId);
      const res = await apiFetch('/api/ingest', { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || t('ingest.error.uploadStatus', { status: res.status }));
      }
      const data = await res.json();
      const task = queuedTask(data.jobId, file.name);
      setTasks([task]);
      setSelectedTaskId(task.id);
      dispatchJobStarted({
        jobId: data.jobId,
        type: 'ingest',
        label: file.name,
        queueStatus: 'pending',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, [t]);

  const handleStart = async () => {
    if (mode === 'file') {
      if (selectedFiles.length === 0) {
        fileRef.current?.click();
        return;
      }
      if (selectedFiles.length === 1) {
        await startUpload(selectedFiles[0]);
        return;
      }
      // 批量：逐个上传（每文件独立 job），逐条归集结果，留在本页展示结果面板
      setError(null);
      setFileResults(null);
      setUploading(true);
      const subjectId = useUIStore.getState().currentSubjectId;
      const results: Array<{ filename: string; jobId?: string; error?: string }> = [];
      for (const file of selectedFiles) {
        try {
          const formData = new FormData();
          formData.append('file', file);
          if (subjectId) formData.append('subjectId', subjectId);
          const res = await apiFetch('/api/ingest', { method: 'POST', body: formData });
          if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || t('ingest.error.uploadStatus', { status: res.status }));
          }
          const data = await res.json();
          results.push({ filename: file.name, jobId: data.jobId });
          dispatchJobStarted({
            jobId: data.jobId,
            type: 'ingest',
            label: file.name,
            queueStatus: 'pending',
          });
        } catch (err) {
          results.push({
            filename: file.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      setFileResults(results);
      setSelectedFiles([]);
      if (fileRef.current) fileRef.current.value = '';
      setUploading(false);
      const queued = results.flatMap((result, index) =>
        result.jobId ? [queuedTask(result.jobId, result.filename, index)] : [],
      );
      if (queued.length > 0) {
        setTasks(queued);
        setSelectedTaskId(queued[0].id);
        const failures = results.filter((result) => result.error);
        if (failures.length > 0) {
          setError(t(
            failures.length === 1
              ? 'ingest.error.fileQueue.one'
              : 'ingest.error.fileQueue.many',
            {
              count: failures.length,
              details: failures
                .map((result) => `${result.filename} — ${result.error}`)
                .join('; '),
            },
          ));
        }
      }
      return;
    }
    if (mode === 'url') {
      const { urls, invalid } = parseUrlLines(urlInput);
      if (invalid.length > 0) {
        setError(t('ingest.error.invalidUrls', { urls: invalid.join(', ') }));
        return;
      }
      if (urls.length === 0) {
        setError(t('ingest.error.urlRequired'));
        return;
      }
      setError(null);
      setUrlResults(null);
      setUploading(true);
      try {
        const subjectId = useUIStore.getState().currentSubjectId;
        const res = await apiFetch('/api/ingest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(subjectId ? { urls, subjectId } : { urls }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok && res.status !== 422) {
          throw new Error(data.error || t('ingest.error.submitStatus', { status: res.status }));
        }
        const results = (data.results ?? []) as Array<{ url: string; jobId?: string; error?: string }>;
        const queued = results.flatMap((result, index) =>
          result.jobId ? [queuedTask(result.jobId, result.url, index)] : [],
        );
        // 通知全局任务面板追踪每个后台 job。
        for (const task of queued) {
          dispatchJobStarted({
            jobId: task.id,
            type: 'ingest',
            label: task.sourceName,
            queueStatus: 'pending',
          });
        }
        if (queued.length > 0) {
          setTasks(queued);
          setSelectedTaskId(queued[0].id);
          const failures = results.filter((result) => result.error);
          if (failures.length > 0) {
            setError(t(
              failures.length === 1
                ? 'ingest.error.urlQueue.one'
                : 'ingest.error.urlQueue.many',
              {
                count: failures.length,
                details: failures
                  .map((result) => `${result.url} — ${result.error}`)
                  .join('; '),
              },
            ));
          }
        } else {
          setUrlResults(results);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
      return;
    }
    // Text mode
    if (!textInput.trim()) {
      setError(t('ingest.error.textRequired'));
      return;
    }
    setError(null);
    setUploading(true);
    const filename = filenameInput.trim() || `note-${Date.now()}.md`;
    try {
      const subjectId = useUIStore.getState().currentSubjectId;
      const res = await apiFetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          subjectId ? { text: textInput, filename, subjectId } : { text: textInput, filename },
        ),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || t('ingest.error.submitStatus', { status: res.status }));
      }
      const data = await res.json();
      const task = queuedTask(data.jobId, filename);
      setTasks([task]);
      setSelectedTaskId(task.id);
      dispatchJobStarted({
        jobId: data.jobId,
        type: 'ingest',
        label: filename,
        queueStatus: 'pending',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      setMode('file');
      setSelectedFiles(files);
      setError(null);
    }
  }, []);

  // ── Live / done / failed: the unified progress surface ──────────────────────
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  if (selectedTask) {
    return (
      <IngestTaskSwitcher
        tasks={tasks}
        selectedId={selectedTask.id}
        onSelect={setSelectedTaskId}
        error={error}
      >
        <IngestTaskDetail
          key={selectedTask.id}
          task={selectedTask}
          onBackground={() => router.push('/')}
          onStartNew={reset}
          onRemove={handleRemoveTask}
          onStatusChange={handleTaskStatusChange}
        />
      </IngestTaskSwitcher>
    );
  }

  // ── Setup ───────────────────────────────────────────────────────────────────
  const canStart =
    mode === 'file'
      ? selectedFiles.length > 0
      : mode === 'url'
        ? !!urlInput.trim()
        : !!textInput.trim();

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6 pb-16 pt-12">
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPT}
          multiple
          className="sr-only"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) {
              setSelectedFiles(files);
              setError(null);
            }
          }}
        />

        {/* header */}
        <header className="flex flex-col gap-2">
          <div className="flex items-center gap-2.5">
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-accent/12 text-accent">
              <UploadCloud className="h-[18px] w-[18px]" aria-hidden />
            </span>
            <h1 className="text-[22px] font-semibold tracking-tight text-foreground">{t('ingest.title')}</h1>
          </div>
          <p className="max-w-[560px] text-sm leading-relaxed text-foreground-secondary">
            {t('ingest.description')}
          </p>
        </header>

        {/* card */}
        <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-sm">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold text-foreground">{t('ingest.new')}</span>
            <Tabs value={mode} onValueChange={(v) => setMode(v as 'file' | 'text' | 'url')}>
              <TabsList>
                <TabsTrigger value="file">{t('ingest.file')}</TabsTrigger>
                <TabsTrigger value="text">{t('ingest.text')}</TabsTrigger>
                <TabsTrigger value="url">{t('ingest.url')}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="flex flex-col gap-4 p-4">
            {mode === 'file' ? (
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragging(true);
                }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                className={cn(
                  'flex w-full flex-col items-center gap-2 rounded-lg border-[1.5px] border-dashed px-4 py-8 text-center transition-colors duration-fast ease-standard focus-ring',
                  isDragging
                    ? 'border-accent bg-accent/[0.04]'
                    : selectedFiles.length > 0
                      ? 'border-accent/60 bg-accent/[0.04]'
                      : 'border-border-strong bg-canvas hover:border-accent hover:bg-accent/[0.04]',
                )}
              >
                {selectedFiles.length > 0 ? (
                  <>
                    <span className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                      <FileUp className="h-5 w-5 text-accent" aria-hidden />
                      <span className="font-mono">
                        {selectedFiles.length === 1
                          ? selectedFiles[0].name
                          : t('ingest.filesSelected', { count: selectedFiles.length })}
                      </span>
                    </span>
                    <span className="font-mono text-xs text-foreground-tertiary">
                      {t('ingest.chooseAgain', { size: formatBytes(selectedFiles.reduce((sum, f) => sum + f.size, 0)) })}
                    </span>
                  </>
                ) : (
                  <>
                    <FileUp className="h-6 w-6 text-foreground-tertiary" aria-hidden />
                    <span className="text-sm font-medium text-foreground">
                      {t('ingest.drop')}
                    </span>
                    <span className="font-mono text-xs text-foreground-tertiary">
                      {t('ingest.fileLimits')}
                    </span>
                  </>
                )}
              </button>
            ) : mode === 'url' ? (
              <div className="flex flex-col gap-3">
                <Textarea
                  rows={7}
                  autoFocus
                  placeholder={t('ingest.urlPlaceholder')}
                  value={urlInput}
                  onChange={(e) => setUrlInput(e.target.value)}
                  aria-label={t('ingest.urlsLabel')}
                />
                <span className="font-mono text-xs text-foreground-tertiary">
                  {t('ingest.urlLimits')}
                </span>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <Input
                  type="text"
                  placeholder={t('ingest.filenamePlaceholder')}
                  value={filenameInput}
                  onChange={(e) => setFilenameInput(e.target.value)}
                  aria-label={t('ingest.filenameLabel')}
                />
                <Textarea
                  rows={7}
                  autoFocus
                  placeholder={t('ingest.textPlaceholder')}
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                />
              </div>
            )}

            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}

            {urlResults && (
              <div className="flex flex-col gap-1.5 rounded-md border border-border bg-canvas p-3">
                <span className="text-xs font-semibold text-foreground">
                  {t('ingest.urlsQueued', { queued: urlResults.filter((r) => r.jobId).length, total: urlResults.length })}
                </span>
                <ul className="flex flex-col gap-1">
                  {urlResults.map((r) => (
                    <li key={r.url} className="flex items-start gap-2 text-xs">
                      <Link2
                        className={cn('mt-0.5 h-3 w-3 shrink-0', r.jobId ? 'text-accent' : 'text-danger')}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="break-all font-mono text-foreground-secondary">{r.url}</span>
                        {r.error && <span className="text-danger"> — {r.error}</span>}
                        {r.jobId && (
                          <span className="text-foreground-tertiary"> — {t('ingest.queuedSuffix')}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                <span className="text-xs text-foreground-tertiary">
                  {t('ingest.backgroundToast')}
                </span>
              </div>
            )}

            {fileResults && (
              <div className="flex flex-col gap-1.5 rounded-md border border-border bg-canvas p-3">
                <span className="text-xs font-semibold text-foreground">
                  {t('ingest.fileQueueSummary', {
                    queued: fileResults.filter((r) => r.jobId).length,
                    total: fileResults.length,
                  })}
                </span>
                <ul className="flex flex-col gap-1">
                  {fileResults.map((r) => (
                    <li key={r.filename} className="flex items-start gap-2 text-xs">
                      <FileUp
                        className={cn('mt-0.5 h-3 w-3 shrink-0', r.jobId ? 'text-accent' : 'text-danger')}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="break-all font-mono text-foreground-secondary">{r.filename}</span>
                        {r.error && <span className="text-danger"> — {r.error}</span>}
                        {r.jobId && (
                          <span className="text-foreground-tertiary"> — {t('ingest.queuedSuffix')}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
                <span className="text-xs text-foreground-tertiary">
                  {t('ingest.backgroundPanel')}
                </span>
              </div>
            )}

            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="flex items-center gap-1.5 text-xs text-foreground-tertiary">
                <Layers className="h-3.5 w-3.5" /> {t('ingest.filingInto')}{' '}
                <span className="font-mono text-foreground-secondary">{subjectSlug}</span>
              </span>
              <Button
                intent="primary"
                size="lg"
                onClick={() => handleStart()}
                loading={uploading}
                disabled={uploading || !canStart}
              >
                <Sparkles className="h-3.5 w-3.5" /> {t('ingest.start')}
              </Button>
            </div>
          </div>
        </div>

        {/* pipeline preview */}
        <div className="flex flex-wrap gap-2">
          {PIPELINE.map(({ labelKey, Icon }) => (
            <span
              key={labelKey}
              className="flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface px-2.5 py-1 text-xs text-foreground-tertiary"
            >
              <Icon className="h-3 w-3" aria-hidden /> {t(labelKey)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
