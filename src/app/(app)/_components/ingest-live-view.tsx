'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Ban,
  Check,
  CircleCheck,
  Clock,
  GitCommitHorizontal,
  ListChecks,
  Loader2,
  Minimize2,
  PenLine,
  Plus,
  ScanText,
  ShieldCheck,
  Sparkles,
  Square,
  Wand2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Tag } from '@/components/ui/tag';
import { cn } from '@/lib/cn';
import type { JobStreamEvent, JobStreamStatus } from '@/hooks/use-job-stream';
import { useI18n } from '@/components/i18n-provider';

interface IngestLiveViewProps {
  jobId: string;
  sourceName: string;
  status: JobStreamStatus;
  events: JobStreamEvent[];
  latestMessage: string;
  createdPages: string[];
  onBackground: () => void;
  onIngestAnother: () => void;
  /** When true, render as a docked region filling its parent instead of a
   *  fixed full-screen overlay (used by the dedicated /ingest workspace). */
  inline?: boolean;
  /** Failure recovery — retry / resume the same job. */
  onRetry?: () => void;
  retrying?: boolean;
  retryLabel?: string;
  /** Manually terminate the job — stop a running ingest or abandon a failed one
   *  (clears its checkpoints so it can't be resumed). */
  onTerminate?: () => void;
  terminating?: boolean;
  /** 任务尚未被 worker claim 时显示真实排队状态。 */
  queued?: boolean;
}

interface Phase {
  id: string;
  label: string;
  Icon: LucideIcon;
  verb: string;
}

/** The real ingest pipeline's six phases, in order. */
const PHASES: readonly Phase[] = [
  { id: 'parse', label: 'Parse', Icon: ScanText, verb: 'Parsing source' },
  { id: 'plan', label: 'Plan', Icon: ListChecks, verb: 'Planning changes' },
  { id: 'write', label: 'Write', Icon: PenLine, verb: 'Writing pages' },
  { id: 'enrich', label: 'Enrich', Icon: Wand2, verb: 'Enriching pages' },
  { id: 'verify', label: 'Verify', Icon: ShieldCheck, verb: 'Verifying claims' },
  { id: 'commit', label: 'Commit', Icon: GitCommitHorizontal, verb: 'Committing changeset' },
];

const PAGE_SKILLS = new Set(['ingest-writer', 'ingest-enricher']);
const MILESTONE_SKILLS = new Set([
  'ingest-writer',
  'ingest-enricher',
  'ingest-planner',
]);

/** The raw stream has hundreds of low-level agent events; the timeline shows
 *  only meaningful milestones: phase signals, per-page starts, errors.
 *  NB: `agent:run-started` carries skillId+label; `agent:run-completed` does
 *  not (see agent-loop.ts), so we key per-page entries off run-started. */
function isMilestone(evt: JobStreamEvent): boolean {
  const t = evt.type;
  if (t.startsWith('ingest:')) return true;
  if (t === 'job:completed' || t === 'agent:error') return true;
  if (t === 'agent:run-started') {
    const sk = payloadOf(evt).skillId;
    return typeof sk === 'string' && MILESTONE_SKILLS.has(sk);
  }
  return false;
}

/** The emitted payload is nested one level deeper by the SSE bridge
 *  (`evt.data = { message, data: <payload>, createdAt }`). */
function payloadOf(evt: JobStreamEvent): Record<string, unknown> {
  const inner = evt.data?.data;
  return inner && typeof inner === 'object' ? (inner as Record<string, unknown>) : {};
}

function phaseIndexForEvent(evt: JobStreamEvent): number | null {
  const t = evt.type;
  const p = payloadOf(evt);
  const skillId = typeof p.skillId === 'string' ? p.skillId : '';
  if (t === 'ingest:committing' || t === 'job:completed') return 5;
  if (t === 'ingest:verify' || skillId.startsWith('ingest-verifier')) return 4;
  if (skillId === 'ingest-enricher') return 3;
  if (skillId === 'ingest-writer') return 2;
  if (t === 'ingest:planning' || skillId === 'ingest-planner') return 1;
  if (
    t === 'ingest:parsing' ||
    t === 'ingest:chunking' ||
    t === 'ingest:start' ||
    t === 'ingest:resuming' ||
    skillId === 'ingest-chunk-summarizer'
  ) {
    return 0;
  }
  return null;
}

interface GraphNode {
  label: string;
  x: number;
  y: number;
}

/** Stable sunflower layout — a node's position depends only on its index, so
 *  adding later nodes never shifts the ones already on screen. */
function layoutNode(i: number): { x: number; y: number } {
  const angle = i * 2.399963267; // golden angle
  const r = Math.min(38, 11 + Math.sqrt(i) * 9);
  const x = Math.max(7, Math.min(93, 50 + Math.cos(angle) * r));
  const y = Math.max(11, Math.min(84, 47 + Math.sin(angle) * r * 0.86));
  return { x, y };
}

function fmtClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function IngestLiveView({
  jobId,
  sourceName,
  status,
  events,
  latestMessage,
  createdPages,
  onBackground,
  onIngestAnother,
  inline = false,
  onRetry,
  retrying = false,
  retryLabel = 'Retry',
  onTerminate,
  terminating = false,
  queued = false,
}: IngestLiveViewProps) {
  const { t } = useI18n();
  const done = status === 'completed';
  const failed = status === 'failed';
  const running = !queued && (status === 'streaming' || status === 'idle');

  // Elapsed — ticks while running, freezes on completion/failure.
  const startedAt = useRef<number>(Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) return;
    const tick = () => setElapsed(Math.floor((Date.now() - startedAt.current) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [running]);

  // Escape sends the job to the background (overlay mode only — on the docked
  // /ingest page Escape must not yank the user away).
  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBackground();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBackground, inline]);

  // Current phase = the furthest phase any event has reached.
  const curPhase = useMemo(() => {
    let max = 0;
    for (const e of events) {
      const idx = phaseIndexForEvent(e);
      if (idx !== null && idx > max) max = idx;
    }
    return max;
  }, [events]);

  // Knowledge graph nodes — one per unique page a writer/enricher run touched.
  const nodes: GraphNode[] = useMemo(() => {
    const seen = new Set<string>();
    const out: GraphNode[] = [];
    const fromEvents = (label: string) => {
      if (!label || seen.has(label)) return;
      seen.add(label);
      const { x, y } = layoutNode(out.length);
      out.push({ label, x, y });
    };
    for (const e of events) {
      const p = payloadOf(e);
      const skillId = typeof p.skillId === 'string' ? p.skillId : '';
      const label = typeof p.label === 'string' ? p.label : '';
      if (PAGE_SKILLS.has(skillId) && label) fromEvents(label);
    }
    // After completion, ensure every committed page is represented.
    if (done) for (const slug of createdPages) fromEvents(slug);
    return out;
  }, [events, done, createdPages]);

  const stepCount = useMemo(
    () => events.filter((e) => e.type === 'agent:step').length,
    [events],
  );

  const phase = PHASES[Math.min(curPhase, PHASES.length - 1)];
  const progress = queued ? 0 : done ? 1 : Math.min(0.97, (curPhase + 0.5) / PHASES.length);

  return (
    <div
      {...(inline
        ? { 'aria-label': 'Ingest progress' }
        : { role: 'dialog', 'aria-modal': true, 'aria-label': 'Ingest progress' })}
      className={cn('flex flex-col bg-canvas', inline ? 'h-full min-h-0' : 'fixed inset-0 z-command')}
    >
      {/* top bar */}
      <div className="shrink-0 border-b border-border bg-surface">
        <div className="flex flex-wrap items-center gap-4 px-6 py-3">
          <span
            className={cn(
              'inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md',
              done
                ? 'bg-success/12 text-success'
                : failed
                  ? 'bg-danger/12 text-danger'
                  : queued
                    ? 'bg-subtle text-foreground-tertiary'
                    : 'bg-accent/12 text-accent',
            )}
          >
            {done ? (
              <Check className="h-[18px] w-[18px]" />
            ) : failed ? (
              <X className="h-[18px] w-[18px]" />
            ) : queued ? (
              <Clock className="h-[18px] w-[18px]" />
            ) : (
              <Loader2 className="h-[18px] w-[18px] animate-spin" />
            )}
          </span>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-mono text-sm font-semibold text-foreground">{sourceName}</span>
            </div>
            <span className="text-xs text-foreground-secondary">
              {done ? (
                <>
                  Ingest complete —{' '}
                  <strong className="font-semibold text-foreground">
                    {createdPages.length || nodes.length} pages
                  </strong>{' '}
                  committed
                </>
              ) : failed ? (
                <span className="text-danger">{latestMessage || 'Ingest failed'}</span>
              ) : queued ? (
                <strong className="font-semibold text-foreground">{t('ingest.queued')}</strong>
              ) : (
                <>
                  <strong className="font-semibold text-foreground">{phase.verb}…</strong> · phase {curPhase + 1} of {PHASES.length}
                </>
              )}
            </span>
          </div>

          <div className="flex shrink-0 items-center gap-3">
            <span className="flex items-center gap-1.5 font-mono text-sm tabular-nums text-foreground-secondary">
              <Clock className="h-3.5 w-3.5 text-foreground-tertiary" /> {fmtClock(elapsed)}
            </span>
            <span className="hidden font-mono text-[11px] text-foreground-tertiary sm:inline">#{jobId.slice(0, 8)}</span>
            <span className="h-5 w-px bg-border" aria-hidden />
            {done || failed ? (
              <>
                {failed && onRetry && (
                  <Button intent="primary" onClick={onRetry} loading={retrying} disabled={retrying}>
                    {retryLabel}
                  </Button>
                )}
                {failed && onTerminate && (
                  <Button
                    intent="ghost"
                    onClick={onTerminate}
                    loading={terminating}
                    disabled={terminating}
                    data-tip={t('ingest.abandon')}
                  >
                    <Ban className="h-3.5 w-3.5" /> End ingest
                  </Button>
                )}
                <Button intent="outline" onClick={onIngestAnother}>
                  <Plus className="h-3.5 w-3.5" /> Ingest another
                </Button>
                {done && createdPages.length > 0 && (
                  <Link href={`/wiki/${createdPages[0]}`} className={buttonVariants({ intent: 'primary' })}>
                    <ArrowRight className="h-3.5 w-3.5" /> View pages
                  </Link>
                )}
                {(failed || createdPages.length === 0) && (
                  <Button intent="ghost" onClick={onBackground}>
                    Close
                  </Button>
                )}
              </>
            ) : (
              <>
                {onTerminate && (
                  <Button
                    intent="ghost"
                    onClick={onTerminate}
                    disabled={terminating}
                    data-tip={t('ingest.stop')}
                  >
                    <Square className="h-3.5 w-3.5" /> Stop
                  </Button>
                )}
                <Button intent="outline" onClick={onBackground}>
                  <Minimize2 className="h-3.5 w-3.5" /> Run in background
                </Button>
              </>
            )}
          </div>
        </div>

        {/* phase stepper */}
        <div className="flex items-stretch gap-1.5 overflow-x-auto px-6 pb-3">
          {PHASES.map((p, order) => {
            const state = queued
              ? 'pending'
              : done || order < curPhase
                ? 'done'
                : order === curPhase
                  ? 'active'
                  : 'pending';
            return (
              <div
                key={p.id}
                className={cn(
                  'flex min-w-[92px] flex-1 items-center gap-2 rounded-md border px-2.5 py-[7px] transition-colors',
                  state === 'active'
                    ? 'border-accent/50 bg-accent/[0.07]'
                    : state === 'done'
                      ? 'border-border-subtle bg-success/[0.06]'
                      : 'border-border-subtle bg-canvas',
                )}
              >
                <span
                  className={cn(
                    'inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full',
                    state === 'done'
                      ? 'bg-success text-accent-fg'
                      : state === 'active'
                        ? 'bg-accent text-accent-fg'
                        : 'bg-subtle text-foreground-tertiary',
                  )}
                >
                  {state === 'done' ? (
                    <Check className="h-3 w-3" />
                  ) : state === 'active' ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <p.Icon className="h-3 w-3" />
                  )}
                </span>
                <span className="flex min-w-0 flex-col leading-tight">
                  <span
                    className={cn(
                      'truncate text-xs font-semibold',
                      state === 'pending' ? 'text-foreground-tertiary' : 'text-foreground',
                    )}
                  >
                    {p.label}
                  </span>
                  <span
                    className={cn(
                      'font-mono text-[10px]',
                      state === 'active' ? 'text-accent-strong' : 'text-foreground-tertiary',
                    )}
                  >
                    {state === 'done' ? 'done' : state === 'active' ? 'running' : '—'}
                  </span>
                </span>
              </div>
            );
          })}
        </div>

        {/* progress bar */}
        <div className="h-[3px] bg-subtle">
          <div
            className={cn('h-full transition-[width] duration-base ease-standard', done ? 'bg-success' : 'bg-accent')}
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>

      {/* split body */}
      <div className="grid min-h-0 flex-1 grid-rows-[1fr_1fr] lg:grid-cols-[minmax(380px,460px)_1fr] lg:grid-rows-1">
        <div className="min-h-0 overflow-y-auto border-b border-border bg-canvas lg:border-b-0 lg:border-r">
          <IngestTimeline
            events={events}
            curPhase={curPhase}
            done={done}
            queued={queued}
            createdPages={createdPages}
          />
        </div>
        <div className="relative min-h-0 bg-graph-canvas">
          <IngestGraph
            nodes={nodes}
            phase={phase}
            done={done}
            failed={failed}
            queued={queued}
            latestMessage={latestMessage}
            stepCount={stepCount}
          />
        </div>
      </div>
    </div>
  );
}

// ── Timeline (left) ─────────────────────────────────────────────────────────

function IngestTimeline({
  events,
  curPhase,
  done,
  queued,
  createdPages,
}: {
  events: JobStreamEvent[];
  curPhase: number;
  done: boolean;
  queued: boolean;
  createdPages: string[];
}) {
  const { t } = useI18n();
  // Bucket events into phases for the rail.
  const byPhase = useMemo(() => {
    const buckets: JobStreamEvent[][] = PHASES.map(() => []);
    events.forEach((e) => {
      if (!isMilestone(e)) return;
      const idx = phaseIndexForEvent(e);
      if (idx !== null) buckets[idx].push(e);
    });
    return buckets;
  }, [events]);

  return (
    <div className="px-6 py-5">
      {done && createdPages.length > 0 && (
        <div className="mb-4 flex flex-col gap-2 rounded-md border border-success-border/40 bg-success-bg px-3.5 py-3">
          <span className="flex items-center gap-2 text-sm font-semibold text-success">
            <CircleCheck className="h-[15px] w-[15px]" /> Committed to the vault
          </span>
          <div className="flex flex-wrap gap-1.5">
            {createdPages.map((slug) => (
              <Link key={slug} href={`/wiki/${slug}`} className="focus-ring rounded-sm">
                <Tag tone="accent">{slug}</Tag>
              </Link>
            ))}
          </div>
        </div>
      )}

      {PHASES.map((p, order) => {
        const state = queued
          ? 'pending'
          : done || order < curPhase
            ? 'done'
            : order === curPhase
              ? 'active'
              : 'pending';
        const entries = byPhase[order];
        const isLast = order === PHASES.length - 1;
        return (
          <div key={p.id} className="grid grid-cols-[24px_1fr] gap-x-3">
            {/* rail */}
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors',
                  state === 'done'
                    ? 'bg-success text-accent-fg'
                    : state === 'active'
                      ? 'bg-accent text-accent-fg ring-4 ring-accent/15'
                      : 'border border-border bg-subtle text-foreground-tertiary',
                )}
              >
                {state === 'done' ? <Check className="h-3.5 w-3.5" /> : <p.Icon className="h-3 w-3" />}
              </span>
              {!isLast && (
                <span className={cn('my-1 w-0.5 flex-1', state === 'done' ? 'bg-success/50' : 'bg-border')} />
              )}
            </div>

            {/* content */}
            <div className={cn(isLast ? 'pb-0' : 'pb-3.5')}>
              <div className="flex h-6 items-center gap-2">
                <span
                  className={cn('text-sm font-semibold', state === 'pending' ? 'text-foreground-tertiary' : 'text-foreground')}
                >
                  {p.label}
                </span>
                {state === 'active' && <span className="text-[11px] font-medium text-accent-strong">{t('ingest.running')}</span>}
              </div>

              {entries.length > 0 && (
                <ul className="mt-1.5 flex flex-col gap-2">
                  {entries.map((e, i) => {
                    const live = !done && order === curPhase && i === entries.length - 1;
                    const isError = e.type === 'agent:error';
                    const p = payloadOf(e);
                    const msg = (e.data?.message as string) || e.type;
                    const detail =
                      (typeof p.detail === 'string' && p.detail) ||
                      (typeof p.label === 'string' ? (p.label as string) : '');
                    return (
                      <li key={i} className="animate-fade-in flex flex-col gap-0.5">
                        <span className="flex items-start gap-2">
                          <span
                            className={cn(
                              'mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full',
                              isError ? 'bg-danger' : live ? 'bg-accent ig-blink' : 'bg-foreground-tertiary/50',
                            )}
                          />
                          <span className={cn('text-sm leading-[18px]', isError ? 'text-danger' : 'text-foreground')}>
                            {msg}
                          </span>
                        </span>
                        {detail && msg !== detail && (
                          <span className="ml-3.5 font-mono text-xs text-foreground-tertiary">{detail}</span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Knowledge graph (right) ──────────────────────────────────────────────────

function IngestGraph({
  nodes,
  phase,
  done,
  failed,
  queued,
  latestMessage,
  stepCount,
}: {
  nodes: GraphNode[];
  phase: Phase;
  done: boolean;
  failed: boolean;
  queued: boolean;
  latestMessage: string;
  stepCount: number;
}) {
  const hub = { x: 50, y: 47 };
  const activeIdx = nodes.length - 1;
  const running = !done && !failed && !queued;

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* now card */}
      <div
        className={cn(
          'absolute inset-x-4 top-4 z-[2] flex items-center gap-2.5 rounded-md border px-3 py-2.5 shadow-sm backdrop-blur',
          done
            ? 'border-success-border/50'
            : failed
              ? 'border-danger/40'
              : queued
                ? 'border-border'
                : 'border-accent/30',
          'bg-elevated/85',
        )}
      >
        <span
          className={cn(
            'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
            done
              ? 'bg-success/12 text-success'
              : failed
                ? 'bg-danger/12 text-danger'
                : queued
                  ? 'bg-subtle text-foreground-tertiary'
                  : 'bg-accent/12 text-accent',
          )}
        >
          {done ? (
            <CircleCheck className="h-[15px] w-[15px]" />
          ) : failed ? (
            <X className="h-[15px] w-[15px]" />
          ) : queued ? (
            <Clock className="h-[15px] w-[15px]" />
          ) : (
            <phase.Icon className="h-[15px] w-[15px]" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <span
            className={cn(
              'block text-[10px] font-semibold uppercase tracking-wider',
              done
                ? 'text-success'
                : failed
                  ? 'text-danger'
                  : queued
                    ? 'text-foreground-tertiary'
                    : 'text-accent-strong',
            )}
          >
            {done ? 'Complete' : failed ? 'Failed' : queued ? 'Queued' : phase.label}
          </span>
          <span className="block truncate text-sm font-medium text-foreground">
            {done
              ? 'Committed to the vault'
              : queued
                ? 'Waiting for a worker'
                : latestMessage || 'Starting…'}
            {running && <span className="ig-caret ml-0.5 text-accent">▍</span>}
          </span>
        </div>
      </div>

      {/* edges */}
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        aria-hidden
      >
        {nodes.map((n, i) => {
          const isActive = i === activeIdx && running;
          return (
            <line
              key={n.label}
              x1={hub.x}
              y1={hub.y}
              x2={n.x}
              y2={n.y}
              // While running every edge marches a dashed flow outward
              // (hub → page); on completion they settle into solid lines.
              className={cn(running && 'ig-edge-flow')}
              stroke={isActive ? 'rgb(var(--color-accent-primary))' : 'rgb(var(--color-graph-edge))'}
              strokeWidth={isActive ? 2 : 1.5}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          );
        })}
      </svg>

      {/* hub (the source) */}
      <div
        className="absolute z-[1] -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${hub.x}%`, top: `${hub.y}%` }}
      >
        <span className="relative flex">
          {/* sonar pulses behind the hub while working (centered via
           *  inset-0 + m-auto so the scale animation can own `transform`). */}
          {running && (
            <>
              <span className="ig-hub-pulse absolute inset-0 m-auto h-14 w-14 rounded-full bg-accent/25" />
              <span
                className="ig-hub-pulse absolute inset-0 m-auto h-14 w-14 rounded-full bg-accent/25"
                style={{ animationDelay: '1s' }}
              />
            </>
          )}
          <span
            className={cn(
              'relative flex h-14 w-14 items-center justify-center rounded-full border-2 border-graph-node-border bg-graph-node text-accent-fg shadow-md',
              running && 'ig-breathe',
            )}
          >
            <Sparkles className="h-7 w-7" />
          </span>
        </span>
      </div>

      {/* page nodes */}
      {nodes.map((n, i) => {
        const active = i === activeIdx && !done;
        return (
          <div
            key={n.label}
            className="absolute z-[1] -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${n.x}%`, top: `${n.y}%` }}
          >
            {/* 圆点本身作为居中锚点（与连线落在 n.x/n.y 的终点对齐）；
             *  标签绝对定位浮在点正下方、脱离文档流，避免把圆点挤出连线
             *  ——这正是 hub 能对齐的原因。*/}
            <span className="ig-pop relative inline-flex">
              {active && (
                <span className="ig-ring absolute -inset-1.5 rounded-full border-2 border-accent/50" />
              )}
              <span
                className={cn(
                  'relative h-7 w-7 rounded-full border-2 border-graph-node-border bg-graph-node shadow-sm',
                  active && 'ring-4 ring-accent/20',
                )}
              />
              <span
                className="pointer-events-none absolute left-1/2 top-[calc(100%+6px)] max-w-[120px] -translate-x-1/2 truncate font-mono text-[11px] font-semibold text-graph-label"
                style={{ textShadow: '0 1px 2px rgb(var(--color-graph-canvas)), 0 0 4px rgb(var(--color-graph-canvas))' }}
              >
                {n.label}
              </span>
            </span>
          </div>
        );
      })}

      {/* counters */}
      <div className="absolute inset-x-4 bottom-3.5 z-[2] flex items-center justify-between gap-3">
        <div className="flex gap-5">
          <Counter value={nodes.length} label="pages written" />
          <Counter value={stepCount} label="agent steps" />
        </div>
      </div>
    </div>
  );
}

function Counter({ value, label }: { value: number; label: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-xl font-semibold tabular-nums text-foreground">{value}</span>
      <span className="text-[11px] text-foreground-tertiary">{label}</span>
    </span>
  );
}
