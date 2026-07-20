'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  FileUp,
  GitCommitHorizontal,
  ListChecks,
  Loader2,
  Maximize2,
  PenLine,
  ScanText,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  Wand2,
  type LucideIcon,
} from 'lucide-react';
import { useJobStream, type JobStreamEvent } from '@/hooks/use-job-stream';
import { apiFetch } from '@/lib/api-fetch';
import { setPendingIngestFile } from '@/lib/pending-ingest-file';
import { useUIStore } from '@/stores/ui-store';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/cn';
import {
  isIngestJobStarted,
  JOB_STARTED_EVENT,
  type JobStartedEventDetail,
} from '@/lib/job-started-event';
import { useI18n } from '@/components/i18n-provider';
import type { MessageKey } from '@/lib/i18n/messages';

/** The real ingest pipeline's six phases, in order. */
const PHASES: ReadonlyArray<{ labelKey: MessageKey; verbKey: MessageKey; Icon: LucideIcon }> = [
  { labelKey: 'jobs.phase.parse', verbKey: 'ingest.phase.parsing', Icon: ScanText },
  { labelKey: 'jobs.phase.plan', verbKey: 'ingest.phase.planning', Icon: ListChecks },
  { labelKey: 'jobs.phase.write', verbKey: 'ingest.phase.writing', Icon: PenLine },
  { labelKey: 'jobs.phase.enrich', verbKey: 'ingest.phase.enriching', Icon: Wand2 },
  { labelKey: 'jobs.phase.verify', verbKey: 'ingest.phase.verifying', Icon: ShieldCheck },
  { labelKey: 'jobs.phase.commit', verbKey: 'ingest.phase.committing', Icon: GitCommitHorizontal },
];

/** Accepted source file types — mirrors the ingest workbench. */
const ACCEPT = '.md,.mdx,.txt,.html,.htm,.pdf';

function payloadOf(evt: JobStreamEvent): Record<string, unknown> {
  const inner = evt.data?.data;
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : {};
}

/** Skills whose `label` payload names a page being written into the vault. */
const PAGE_SKILLS = new Set(['ingest-writer', 'ingest-enricher']);

/** Count of unique pages the run has drafted so far (mirrors the live view). */
function pagesWritten(events: JobStreamEvent[]): number {
  const seen = new Set<string>();
  for (const e of events) {
    const p = payloadOf(e);
    const skillId = typeof p.skillId === 'string' ? p.skillId : '';
    const label = typeof p.label === 'string' ? p.label : '';
    if (PAGE_SKILLS.has(skillId) && label) seen.add(label);
  }
  return seen.size;
}

/** Furthest pipeline phase any event has reached (mirrors ingest-live-view). */
function currentPhase(events: JobStreamEvent[]): number {
  let max = 0;
  for (const e of events) {
    const t = e.type;
    const skillId = typeof payloadOf(e).skillId === 'string' ? (payloadOf(e).skillId as string) : '';
    let idx: number | null = null;
    if (t === 'ingest:committing') idx = 5;
    else if (t === 'ingest:verify' || skillId.startsWith('ingest-verifier')) idx = 4;
    else if (skillId === 'ingest-enricher') idx = 3;
    else if (skillId === 'ingest-writer') idx = 2;
    else if (t === 'ingest:planning' || skillId === 'ingest-planner') idx = 1;
    else if (
      t === 'ingest:parsing' ||
      t === 'ingest:chunking' ||
      t === 'ingest:start' ||
      t === 'ingest:resuming' ||
      skillId === 'ingest-chunk-summarizer'
    ) {
      idx = 0;
    }
    if (idx !== null && idx > max) max = idx;
  }
  return max;
}

/**
 * Dashboard ingest hero — the dashboard's primary call to action. It does not
 * run the ingest itself (that lives on the dedicated `/ingest` workspace); it
 * invites the user there, and reflects a background ingest's progress when one
 * is running.
 */
export function DashboardIngestHero() {
  const { t } = useI18n();
  const router = useRouter();
  const [jobId, setJobId] = useState<string | null>(null);
  const { events, status, latestMessage } = useJobStream(jobId);
  const fileRef = useRef<HTMLInputElement>(null);

  // "Choose a file" → open the native picker, then hand the file off to the
  // /ingest workspace, which starts the upload and shows it live.
  const onPickFile = useCallback(
    (file: File) => {
      setPendingIngestFile(file);
      router.push('/ingest');
    },
    [router],
  );

  // Track a running background ingest (poll + the start event).
  const check = useCallback(async () => {
    if (jobId) return;
    const subjectId = useUIStore.getState().currentSubjectId;
    try {
      const qs = subjectId ? `&subjectId=${encodeURIComponent(subjectId)}` : '';
      const res = await apiFetch(`/api/jobs?status=running&type=ingest${qs}`);
      if (!res.ok) return;
      const jobs = (await res.json()) as Array<{ id: string }>;
      if (Array.isArray(jobs) && jobs.length > 0) setJobId(jobs[jobs.length - 1].id);
    } catch {
      /* ignore */
    }
  }, [jobId]);

  useEffect(() => {
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, [check]);

  useEffect(() => {
    const onStarted = (e: Event) => {
      const detail = (e as CustomEvent<JobStartedEventDetail>).detail;
      if (isIngestJobStarted(detail)) setJobId(detail.jobId);
    };
    window.addEventListener(JOB_STARTED_EVENT, onStarted);
    return () => window.removeEventListener(JOB_STARTED_EVENT, onStarted);
  }, []);

  // Drop the tracked job shortly after it settles.
  useEffect(() => {
    if (status !== 'completed' && status !== 'failed') return;
    const t = setTimeout(() => setJobId(null), 2000);
    return () => clearTimeout(t);
  }, [status]);

  // ⌘/Ctrl-I opens the ingest workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        router.push('/ingest');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [router]);

  const running = !!jobId && status === 'streaming';

  // ── Running strip ───────────────────────────────────────────────────────────
  if (running) {
    const idx = currentPhase(events);
    const pct = Math.min(97, Math.round(((idx + 0.5) / PHASES.length) * 100));
    const phase = PHASES[idx];
    const pages = pagesWritten(events);
    const status = latestMessage ? latestMessage.replace(/\[\[|\]\]/g, '') : t('ingest.starting');
    return (
      <button
        type="button"
        onClick={() => router.push('/ingest')}
        aria-label={t('ingest.openRunning')}
        className="ig-sheen group relative w-full overflow-hidden rounded-lg border border-accent/35 bg-surface p-5 text-left shadow-sm transition-colors hover:bg-subtle/40 focus-ring"
      >
        <div className="relative z-[1] flex items-center gap-3">
          <Loader2 className="h-5 w-5 shrink-0 animate-spin text-accent" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">{t('ingest.inProgress')}</p>
            <p className="mt-0.5 truncate text-xs text-foreground-secondary">
              <span className="font-semibold text-accent-strong">{t(phase.verbKey)}…</span>
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-accent group-hover:bg-accent/10">
            <Maximize2 className="h-3.5 w-3.5" /> {t('ingest.watchLive')}
          </span>
        </div>

        {/* mini phase stepper */}
        <div className="relative z-[1] mt-3.5 flex gap-1">
          {PHASES.map((p, i) => (
            <span
              key={p.labelKey}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors',
                i < idx ? 'bg-success' : i === idx ? 'bg-accent' : 'bg-subtle',
              )}
            />
          ))}
        </div>

        {/* status line: live step (left) · drafted-so-far + percent (right) */}
        <div className="relative z-[1] mt-3 flex items-center justify-between gap-3">
          <span className="min-w-0 truncate text-xs text-foreground-tertiary">{status}</span>
          <span className="shrink-0 text-xs text-foreground-secondary">
            {t('ingest.pageCount', { count: pages })}
            {' · '}
            <span className="font-mono tabular-nums">{pct}%</span>
          </span>
        </div>
      </button>
    );
  }

  // ── Idle launcher ─────────────────────────────────────────────────────────────
  return (
    <section
      aria-labelledby="dashboard-ingest-title"
      className={cn(
        'relative grid items-center gap-7 overflow-hidden rounded-lg border border-border bg-surface p-5 shadow-xs sm:p-7',
        'transition-colors duration-fast ease-standard hover:border-border-strong',
        'md:grid-cols-[minmax(0,1fr)_320px]',
      )}
    >
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        // 阻止程序触发的 input click 冒泡到周边交互区域；文件选择仍走原生默认行为。
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onPickFile(file);
        }}
      />

      {/* invitation */}
      <div className="flex min-w-0 flex-col gap-3.5">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-normal text-accent-strong">
          <Sparkles className="h-3 w-3" /> {t('ingest.startHere')}
        </span>
        <div className="flex items-center gap-3.5">
          <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent">
            <UploadCloud className="h-6 w-6" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="dashboard-ingest-title" className="text-[20px] font-semibold tracking-normal text-foreground">{t('ingest.title')}</h2>
            <p className="mt-0.5 text-sm leading-relaxed text-foreground-secondary text-pretty">
              {t('ingest.dashboardDescription')}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Button intent="primary" size="lg" onClick={() => fileRef.current?.click()}>
            <FileUp className="h-[15px] w-[15px]" /> {t('ingest.chooseFile')}
          </Button>
          <Button intent="ghost" size="lg" onClick={() => router.push('/ingest')}>
            <Maximize2 className="h-[15px] w-[15px]" /> {t('ingest.openWorkspace')}
            <Kbd className="ml-1">⌘I</Kbd>
          </Button>
        </div>
      </div>

      {/* pipeline preview */}
      <div className="flex flex-col gap-1 border-l border-border-subtle pl-5">
        <span className="mb-1 text-[11px] font-medium uppercase tracking-normal text-foreground-tertiary">
          {t('ingest.whatAgentDoes')}
        </span>
        {PHASES.map(({ labelKey, Icon }, i) => (
          <div key={labelKey} className="flex h-[26px] items-center gap-2.5">
            <span className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent">
              <Icon className="h-3 w-3" aria-hidden />
            </span>
            <span className="text-xs font-medium text-foreground-secondary">{t(labelKey)}</span>
            <span className="flex-1" />
            <span className="font-mono text-[11px] text-foreground-tertiary/70">
              {String(i + 1).padStart(2, '0')}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
