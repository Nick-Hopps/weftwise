'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { FileUp, UploadCloud } from 'lucide-react';
import { useJobStream } from '@/hooks/use-job-stream';
import { apiFetch } from '@/lib/api-fetch';
import { useUIStore } from '@/stores/ui-store';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Panel, PanelHeader, PanelTitle, SectionLabel } from '@/components/ui/panel';
import { Tag } from '@/components/ui/tag';
import { cn } from '@/lib/cn';

type Mode = 'file' | 'text';

interface DashboardIngestPanelProps {
  /** compact: tighter drop zone, fewer textarea rows, smaller event log */
  compact?: boolean;
}

export function DashboardIngestPanel({ compact = false }: DashboardIngestPanelProps = {}) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('file');
  const [jobId, setJobId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [textInput, setTextInput] = useState('');
  const [filenameInput, setFilenameInput] = useState('');
  const [createdPages, setCreatedPages] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  const { events, status } = useJobStream(jobId);

  // 聚合 agent 各 run 的输入 token 与缓存命中（DeepSeek/OpenAI 自动前缀缓存），让缓存收益在页面可见。
  // 取 agent:step 的 final 步（每 run 一次，不会重复计）。
  const cacheStats = useMemo(() => {
    let cacheHit = 0;
    let promptIn = 0;
    for (const e of events) {
      if (e.type !== 'agent:step') continue;
      const d = e.data as { kind?: string; tokensIn?: number; cacheHitTokens?: number };
      if (d.kind !== 'final') continue;
      if (typeof d.tokensIn === 'number') promptIn += d.tokensIn;
      if (typeof d.cacheHitTokens === 'number') cacheHit += d.cacheHitTokens;
    }
    const pct = promptIn > 0 ? Math.round((cacheHit / promptIn) * 100) : 0;
    return { cacheHit, promptIn, pct };
  }, [events]);

  const isProcessing = jobId !== null && status === 'streaming';
  const isDone = status === 'completed';
  const isFailed = status === 'failed';

  useEffect(() => {
    if (!isDone) return;
    queryClient.invalidateQueries({ queryKey: ['pages'] });
  }, [isDone, queryClient]);

  useEffect(() => {
    if (!isDone) return;
    const doneEvent = events.find((e) => e.type === 'ingest:complete');
    const data = doneEvent?.data as { result?: { pagesCreated?: string[] } } | undefined;
    if (data?.result?.pagesCreated) setCreatedPages(data.result.pagesCreated);
  }, [isDone, events]);

  const reset = () => {
    setJobId(null);
    setError(null);
    setCreatedPages([]);
    setTextInput('');
    setFilenameInput('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const uploadFile = useCallback(async (file: File) => {
    setError(null);
    setCreatedPages([]);
    setUploading(true);
    try {
      const subjectId = useUIStore.getState().currentSubjectId;
      const formData = new FormData();
      formData.append('file', file);
      if (subjectId) formData.append('subjectId', subjectId);
      const res = await apiFetch('/api/ingest', { method: 'POST', body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Upload failed (${res.status})`);
      }
      const data = await res.json();
      setJobId(data.jobId);
      window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: data.jobId } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, []);

  const handleFileSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) {
      setError('Please select a file');
      return;
    }
    uploadFile(file);
  };

  const handleTextSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setCreatedPages([]);
    if (!textInput.trim()) {
      setError('Please enter some text');
      return;
    }
    setUploading(true);
    try {
      const subjectId = useUIStore.getState().currentSubjectId;
      const filename = filenameInput.trim() || `note-${Date.now()}.md`;
      const res = await apiFetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          subjectId ? { text: textInput, filename, subjectId } : { text: textInput, filename },
        ),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Submit failed (${res.status})`);
      }
      const data = await res.json();
      setJobId(data.jobId);
      window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: data.jobId } }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) uploadFile(file);
    },
    [uploadFile],
  );

  const disableSubmit = uploading || isProcessing;

  return (
    <Panel tone="elevated" radius="lg" padding="none" aria-labelledby="ingest-panel-heading">
      <PanelHeader className={compact ? 'py-2' : 'py-3'}>
        <div className="min-w-0">
          <PanelTitle id="ingest-panel-heading">Ingest a source</PanelTitle>
          {!compact && (
            <p className="text-xs text-foreground-secondary mt-0.5">
              Drop a document or paste text — the agent plans, writes, and lints the vault for you.
            </p>
          )}
        </div>
        <div
          role="tablist"
          aria-label="Ingest input mode"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            setMode((prev) => (prev === 'file' ? 'text' : 'file'));
          }}
          className="inline-flex h-8 p-0.5 rounded-md bg-subtle"
        >
          {(['file', 'text'] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              id={`ingest-tab-${m}`}
              aria-selected={mode === m}
              aria-controls={`ingest-panel-${m}`}
              tabIndex={mode === m ? 0 : -1}
              onClick={() => setMode(m)}
              className={cn(
                'px-3 h-7 rounded-sm text-sm font-medium transition-colors focus-ring',
                mode === m
                  ? 'bg-surface text-foreground shadow-xs'
                  : 'text-foreground-secondary hover:text-foreground',
              )}
            >
              {m === 'file' ? 'File' : 'Text'}
            </button>
          ))}
        </div>
      </PanelHeader>

      <div className={cn('flex flex-col min-h-0 overflow-y-auto', compact ? 'p-3 space-y-3' : 'p-4 space-y-4')}>
        {mode === 'file' ? (
          <form
            onSubmit={handleFileSubmit}
            className="space-y-3"
            role="tabpanel"
            id="ingest-panel-file"
            aria-labelledby="ingest-tab-file"
          >
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={handleDrop}
              className={cn(
                'rounded-lg border border-dashed text-center transition-colors flex flex-col items-center gap-2',
                compact ? 'px-3 py-5' : 'px-6 py-8',
                isDragging ? 'border-accent bg-accent-subtle' : 'border-border bg-canvas',
              )}
            >
              <UploadCloud className="h-5 w-5 text-foreground-tertiary" aria-hidden />
              <label htmlFor="ingest-file-input" className="sr-only">
                Source file to ingest
              </label>
              <input
                ref={fileRef}
                id="ingest-file-input"
                type="file"
                accept=".md,.mdx,.txt,.html,.htm,.pdf"
                aria-describedby="ingest-file-hint"
                className="block w-full max-w-sm mx-auto text-xs text-foreground-secondary file:mr-3 file:py-1.5 file:px-3 file:rounded-md file:border file:border-border file:text-xs file:font-medium file:bg-surface file:text-foreground file:cursor-pointer hover:file:bg-subtle transition-colors"
              />
              <p id="ingest-file-hint" className="text-xs text-foreground-tertiary">
                Drag &amp; drop or browse — .md, .txt, .html, .pdf, up to 50 MB.
              </p>
            </div>
            <Button
              type="submit"
              intent="primary"
              size="base"
              loading={uploading}
              disabled={disableSubmit}
              className="w-full"
            >
              <FileUp className="h-3.5 w-3.5" />
              {uploading ? 'Uploading…' : 'Upload & Ingest'}
            </Button>
          </form>
        ) : (
          <form
            onSubmit={handleTextSubmit}
            className="space-y-3"
            role="tabpanel"
            id="ingest-panel-text"
            aria-labelledby="ingest-tab-text"
          >
            <label htmlFor="ingest-filename-input" className="sr-only">
              Filename for the pasted content
            </label>
            <Input
              id="ingest-filename-input"
              type="text"
              placeholder="Filename (optional, e.g. my-notes.md)"
              value={filenameInput}
              onChange={(e) => setFilenameInput(e.target.value)}
            />
            <label htmlFor="ingest-text-input" className="sr-only">
              Source text content
            </label>
            <Textarea
              id="ingest-text-input"
              rows={compact ? 3 : 8}
              placeholder="Paste your text here…"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              className="resize-y"
            />
            <Button
              type="submit"
              intent="primary"
              size="base"
              loading={uploading}
              disabled={disableSubmit}
              className="w-full"
            >
              {uploading ? 'Submitting…' : 'Submit & Ingest'}
            </Button>
          </form>
        )}

        {error && (
          <div
            role="alert"
            className="rounded-md bg-danger-bg border border-danger/40 px-3 py-2 text-sm text-danger"
          >
            {error}
          </div>
        )}

        {jobId && (
          <div className="rounded-md border border-border bg-canvas overflow-hidden">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-xs font-medium text-foreground">
                {isDone ? 'Ingest complete' : isFailed ? 'Ingest failed' : 'Processing…'}
              </span>
              <span className="text-[10px] font-mono text-foreground-tertiary">
                {jobId.slice(0, 8)}
              </span>
            </div>
            {cacheStats.promptIn > 0 && (
              <div
                className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-subtle"
                title="命中前缀缓存的输入 token（DeepSeek/OpenAI 自动缓存，按 ~0.1× 计费）"
              >
                <span className="text-[11px] text-foreground-secondary">Prompt cache hits</span>
                <span className="text-[11px] font-mono text-foreground tabular-nums">
                  {cacheStats.cacheHit.toLocaleString()} / {cacheStats.promptIn.toLocaleString()} in ({cacheStats.pct}%)
                </span>
              </div>
            )}
            <ul className={cn('px-3 py-2 space-y-1 overflow-y-auto', compact ? 'max-h-20' : 'max-h-40')}>
              {events.length === 0 ? (
                <li className="text-xs italic text-foreground-tertiary">Waiting for events…</li>
              ) : (
                events.slice(-20).map((evt, i) => (
                  <li key={i} className="text-xs text-foreground-secondary flex gap-2">
                    <span className="text-foreground-tertiary shrink-0">›</span>
                    <span className="truncate">
                      {(evt.data?.message as string) || evt.type}
                    </span>
                  </li>
                ))
              )}
            </ul>
            {(isDone || isFailed) && (
              <div className="px-3 py-3 border-t border-border space-y-2.5">
                {createdPages.length > 0 && (
                  <div className="space-y-1.5">
                    <SectionLabel>Created pages</SectionLabel>
                    <div className="flex flex-wrap gap-1.5">
                      {createdPages.map((slug) => (
                        <Link
                          key={slug}
                          href={`/wiki/${slug}`}
                          className="focus-ring rounded-sm"
                        >
                          <Tag tone="accent" size="base">{slug}</Tag>
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
                <Button intent="ghost" size="sm" onClick={reset}>
                  Ingest another source
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}
