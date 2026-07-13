'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Activity, RefreshCw, Search, Wand2, Wrench } from 'lucide-react';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useJobStream } from '@/hooks/use-job-stream';
import { useLintSummary } from '@/hooks/use-lint-summary';
import { Button } from '@/components/ui/button';
import { Tag } from '@/components/ui/tag';
import { Input } from '@/components/ui/input';
import { groupBySeverity, SEVERITY_TONE } from './lint-findings';
import { FindingRow } from './finding-row';
import { ResearchCandidatesDialog } from './research-candidates-dialog';
import { ResearchBacklogSection } from './research-backlog-section';
import { blockImeEnterSubmit } from '@/lib/keyboard';
import type {
  LintFinding,
  PostconditionReport,
  ResearchCandidate,
} from '@/lib/contracts';
import {
  buildPostconditionNotice,
  extractPostconditionReport,
} from './postcondition-summary';
import {
  actionFindingIds,
  createActionGate,
  createLintRerunQueue,
  isHealthOriginCurrent,
  persistedBusyActions,
  readResearchCandidates,
  recentOutcomeBannerTone,
  recentOutcomeCounts,
  type ExecutableRemediationAction,
  type HealthOrigin,
} from './remediation-ui';

type Scope = 'subject' | 'all';
type ResearchOrigin = 'manual' | 'backlog' | 'remediation';
type ActionJobMeta = { jobId: string; origin: HealthOrigin };
type ResearchJobMeta = ActionJobMeta & { source: ResearchOrigin };
type CandidateResult = {
  candidates: ResearchCandidate[];
  subjectId: string;
  origin: HealthOrigin;
};

function PostconditionBanner({
  label,
  report,
}: {
  label: string;
  report: PostconditionReport;
}) {
  const notice = buildPostconditionNotice(report);
  const tone = notice.tone === 'success'
    ? 'border-success/40 bg-success-bg text-success'
    : 'border-warning/40 bg-warning-bg text-warning';

  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${tone}`}>
      <p className="font-medium">{label} · {notice.title}</p>
      {notice.details.map((detail, index) => (
        <p key={`${index}-${detail}`} className="mt-0.5">{detail}</p>
      ))}
    </div>
  );
}

export function HealthView() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();

  const [scope, setScope] = useState<Scope>('subject');
  const allSubjects = scope === 'all';
  const originSubjectId = subjectId ?? '';
  const [remediationError, setRemediationError] = useState<string | null>(null);
  const [busyActions, setBusyActions] = useState<Set<ExecutableRemediationAction>>(new Set());
  const [actingFindingByAction, setActingFindingByAction] = useState<
    Partial<Record<ExecutableRemediationAction, string>>
  >({});

  const actionGateRef = useRef(createActionGate());
  const actionJobMetaRef = useRef<Partial<Record<ExecutableRemediationAction, ActionJobMeta>>>({});
  const researchJobMetaRef = useRef<ResearchJobMeta | null>(null);
  const researchFetchJobIdRef = useRef<string | null>(null);
  const lintJobMetaRef = useRef<ActionJobMeta | null>(null);
  const lintRerunQueueRef = useRef(createLintRerunQueue());
  const ingestOriginRef = useRef<HealthOrigin | null>(null);
  const deleteOriginsRef = useRef(new Map<string, HealthOrigin>());
  const originKey = `${originSubjectId}\u0000${scope}`;
  const originKeyRef = useRef(originKey);
  const originRef = useRef<HealthOrigin>({ generation: 0, subjectId: originSubjectId, scope });

  // render 阶段同步使旧异步响应失效，避免 effect 执行前的微任务回写新 scope。
  if (originKeyRef.current !== originKey) {
    originKeyRef.current = originKey;
    originRef.current = {
      generation: originRef.current.generation + 1,
      subjectId: originSubjectId,
      scope,
    };
    actionGateRef.current.reset();
    actionJobMetaRef.current = {};
    researchJobMetaRef.current = null;
    researchFetchJobIdRef.current = null;
    lintJobMetaRef.current = null;
    lintRerunQueueRef.current.reset();
    ingestOriginRef.current = null;
    deleteOriginsRef.current.clear();
  }

  const { data, isLoading } = useLintSummary(allSubjects);
  const snapshotBusyActions = useMemo(
    () => data ? persistedBusyActions(data) : new Set<ExecutableRemediationAction>(),
    [data],
  );
  const effectiveBusyActions = useMemo(
    () => new Set([...snapshotBusyActions, ...busyActions]),
    [snapshotBusyActions, busyActions],
  );

  function captureOrigin(): HealthOrigin {
    return { ...originRef.current };
  }

  function isCurrentOrigin(origin: HealthOrigin): boolean {
    return isHealthOriginCurrent(originRef.current, origin);
  }

  function acquireAction(
    action: ExecutableRemediationAction,
    origin: HealthOrigin,
    findingId?: string,
  ): boolean {
    if (effectiveBusyActions.has(action)) return false;
    if (!actionGateRef.current.tryAcquire(action, origin)) return false;
    setBusyActions((current) => new Set(current).add(action));
    if (findingId) {
      setActingFindingByAction((current) => ({ ...current, [action]: findingId }));
    }
    return true;
  }

  function releaseAction(action: ExecutableRemediationAction, origin: HealthOrigin): void {
    if (!actionGateRef.current.release(action, origin)) return;
    setBusyActions((current) => {
      const next = new Set(current);
      next.delete(action);
      return next;
    });
    setActingFindingByAction((current) => {
      const next = { ...current };
      delete next[action];
      return next;
    });
  }

  function invalidateOrigin(nextScope: Scope): void {
    originRef.current = {
      generation: originRef.current.generation + 1,
      subjectId: originSubjectId,
      scope: nextScope,
    };
    originKeyRef.current = `${originSubjectId}\u0000${nextScope}`;
    actionGateRef.current.reset();
    actionJobMetaRef.current = {};
    researchJobMetaRef.current = null;
    researchFetchJobIdRef.current = null;
    lintJobMetaRef.current = null;
    lintRerunQueueRef.current.reset();
    ingestOriginRef.current = null;
    deleteOriginsRef.current.clear();
  }

  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [lintError, setLintError] = useState<string | null>(null);
  const [semanticErrored, setSemanticErrored] = useState(false);
  const { status: streamStatus, events, latestMessage } = useJobStream(jobId);

  // 体检完成 → 记录语义阶段是否报错 → 失效缓存重取
  useEffect(() => {
    const meta = lintJobMetaRef.current;
    if (!jobId || !meta || meta.jobId !== jobId) return;
    if (streamStatus === 'completed') {
      if (!isCurrentOrigin(meta.origin)) return;
      setSemanticErrored(events.some((e) => e.type === 'lint:semantic:error'));
      queryClient.invalidateQueries({
        queryKey: ['lint-latest', meta.origin.scope === 'all' ? 'all' : meta.origin.subjectId],
      });
      lintJobMetaRef.current = null;
      setJobId(null);
      const rerun = lintRerunQueueRef.current.finish(meta.origin, captureOrigin());
      if (rerun) void runLint(rerun);
    } else if (streamStatus === 'failed') {
      if (!isCurrentOrigin(meta.origin)) return;
      setLintError('Health check failed — see job details for the underlying error.');
      lintJobMetaRef.current = null;
      setJobId(null);
      const rerun = lintRerunQueueRef.current.finish(meta.origin, captureOrigin());
      if (rerun) void runLint(rerun);
    }
    // jobId 变化时 useJobStream 尚可能保留上个任务的终态，不能据此提前结算新任务。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamStatus, events, queryClient]);

  const running = starting || (jobId !== null && streamStatus !== 'completed' && streamStatus !== 'failed');

  async function runLint(expectedOrigin: HealthOrigin = captureOrigin()) {
    if (!isCurrentOrigin(expectedOrigin)) return;
    const decision = lintRerunQueueRef.current.request(expectedOrigin);
    if (decision !== 'start') return;
    setStarting(true);
    setSemanticErrored(false);
    setLintError(null);
    let accepted = false;
    try {
      const res = await apiFetch('/api/lint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          expectedOrigin.scope === 'all'
            ? { allSubjects: true }
            : { subjectId: expectedOrigin.subjectId },
        ),
      });
      if (!isCurrentOrigin(expectedOrigin)) return;
      if (!res.ok) {
        setLintError(`Health check request failed (${res.status}).`);
        return;
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        setLintError('Health check response is invalid.');
        return;
      }
      if (
        !isCurrentOrigin(expectedOrigin)
        || typeof json !== 'object'
        || json === null
        || typeof (json as { jobId?: unknown }).jobId !== 'string'
        || !(json as { jobId: string }).jobId
      ) {
        if (isCurrentOrigin(expectedOrigin)) setLintError('Health check response is invalid.');
        return;
      }
      accepted = true;
      const nextJobId = (json as { jobId: string }).jobId;
      lintJobMetaRef.current = { jobId: nextJobId, origin: expectedOrigin };
      setJobId(nextJobId);
    } catch {
      if (isCurrentOrigin(expectedOrigin)) {
        setLintError('Health check request failed. Please try again.');
      }
    } finally {
      if (isCurrentOrigin(expectedOrigin)) setStarting(false);
      if (!accepted) {
        const rerun = lintRerunQueueRef.current.finish(expectedOrigin, captureOrigin());
        if (rerun) void runLint(rerun);
      }
    }
  }

  const [curateJobId, setCurateJobId] = useState<string | null>(null);
  const [curatePostcondition, setCuratePostcondition] = useState<PostconditionReport | null>(null);
  const { status: curateStatus, events: curateEvents, latestMessage: curateMessage } = useJobStream(curateJobId);
  const curating = effectiveBusyActions.has('curate');

  const [fixJobId, setFixJobId] = useState<string | null>(null);
  const [fixSummary, setFixSummary] = useState<{ fixed: number; skipped: number; failed: number } | null>(null);
  const [fixPostcondition, setFixPostcondition] = useState<PostconditionReport | null>(null);
  const { status: fixStatus, events: fixEvents, latestMessage: fixMessage } = useJobStream(fixJobId);
  const fixing = effectiveBusyActions.has('fix');

  useEffect(() => {
    const meta = actionJobMetaRef.current.curate;
    if (!curateJobId || !meta || meta.jobId !== curateJobId || !isCurrentOrigin(meta.origin)) return;
    if (curateStatus === 'completed') {
      const verification = [...curateEvents]
        .reverse()
        .find((event) => event.type === 'curate:verify:complete');
      setCuratePostcondition(extractPostconditionReport(verification));
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      delete actionJobMetaRef.current.curate;
      setCurateJobId(null);
      releaseAction('curate', meta.origin);
      void runLint(meta.origin);
    } else if (curateStatus === 'failed') {
      delete actionJobMetaRef.current.curate;
      setCurateJobId(null);
      releaseAction('curate', meta.origin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curateStatus, curateEvents, queryClient, allSubjects, subjectId]);

  useEffect(() => {
    const meta = actionJobMetaRef.current.fix;
    if (!fixJobId || !meta || meta.jobId !== fixJobId || !isCurrentOrigin(meta.origin)) return;
    if (fixStatus === 'completed') {
      const verification = [...fixEvents]
        .reverse()
        .find((event) => event.type === 'fix:verify:complete');
      setFixPostcondition(extractPostconditionReport(verification));
      const done = [...fixEvents].reverse().find((e) => e.type === 'fix:complete');
      const d = done?.data.data as {
        writes?: number;
        residualCount?: number;
        semanticStatus?: string;
      } | undefined;
      setFixSummary({
        fixed: d?.writes ?? 0,
        skipped: d?.residualCount ?? 0,
        failed: d?.semanticStatus === 'failed' ? 1 : 0,
      });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      delete actionJobMetaRef.current.fix;
      setFixJobId(null);
      releaseAction('fix', meta.origin);
      // 闭环：修复后自动重跑体检刷新 findings
      void runLint(meta.origin);
    } else if (fixStatus === 'failed') {
      delete actionJobMetaRef.current.fix;
      setFixJobId(null);
      releaseAction('fix', meta.origin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixStatus, fixEvents, queryClient, allSubjects, subjectId]);

  const [reingestJobId, setReingestJobId] = useState<string | null>(null);
  const { status: reingestStatus } = useJobStream(reingestJobId);

  // Retry ingest 完成 → 自动重跑体检刷新 findings（与 Fix 闭环一致）；失败则仅停止追踪
  useEffect(() => {
    const meta = actionJobMetaRef.current['re-ingest'];
    if (!reingestJobId || !meta || meta.jobId !== reingestJobId || !isCurrentOrigin(meta.origin)) return;
    if (reingestStatus === 'completed') {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      delete actionJobMetaRef.current['re-ingest'];
      setReingestJobId(null);
      releaseAction('re-ingest', meta.origin);
      void runLint(meta.origin);
    } else if (reingestStatus === 'failed') {
      delete actionJobMetaRef.current['re-ingest'];
      setReingestJobId(null);
      releaseAction('re-ingest', meta.origin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reingestStatus, queryClient]);

  // ── Research：缺口/主题 → 联网检索候选清单（只发现不写入） ─────────────────
  const [researchJobId, setResearchJobId] = useState<string | null>(null);
  const [researchError, setResearchError] = useState<string | null>(null);
  const [candidateResult, setCandidateResult] = useState<CandidateResult | null>(null);
  const [topicInput, setTopicInput] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const [handledSourceIds, setHandledSourceIds] = useState<Set<string>>(new Set());
  const [deletingSourceIds, setDeletingSourceIds] = useState<Set<string>>(new Set());
  const { status: researchStatus } = useJobStream(researchJobId);
  const researching = effectiveBusyActions.has('research');

  function showResearchError(source: ResearchOrigin, message: string): void {
    if (source === 'remediation') setRemediationError(message);
    else setResearchError(message);
  }

  useEffect(() => {
    const meta = researchJobMetaRef.current;
    if (!researchJobId || !meta || meta.jobId !== researchJobId || !isCurrentOrigin(meta.origin)) return;
    if (researchStatus === 'completed') {
      if (researchFetchJobIdRef.current === researchJobId) return;
      researchFetchJobIdRef.current = researchJobId;
      void (async () => {
        try {
          const res = await apiFetch(`/api/jobs/${researchJobId}`);
          if (!isCurrentOrigin(meta.origin)) return;
          const nextCandidates = await readResearchCandidates(res);
          if (!isCurrentOrigin(meta.origin)) return;
          setCandidateResult({
            candidates: nextCandidates,
            subjectId: meta.origin.subjectId,
            origin: meta.origin,
          });
        } catch (error) {
          if (isCurrentOrigin(meta.origin)) {
            showResearchError(
              meta.source,
              error instanceof Error ? error.message : 'Research result could not be loaded.',
            );
          }
        } finally {
          if (researchJobMetaRef.current?.jobId === researchJobId) {
            researchJobMetaRef.current = null;
            delete actionJobMetaRef.current.research;
            setResearchJobId(null);
            releaseAction('research', meta.origin);
          }
          if (researchFetchJobIdRef.current === researchJobId) {
            researchFetchJobIdRef.current = null;
          }
        }
      })();
    } else if (researchStatus === 'failed') {
      showResearchError(meta.source, 'Research failed — see job details for the underlying error.');
      researchJobMetaRef.current = null;
      delete actionJobMetaRef.current.research;
      setResearchJobId(null);
      releaseAction('research', meta.origin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchStatus]);

  async function startResearch(topic: string, source: Exclude<ResearchOrigin, 'remediation'>): Promise<string | null> {
    const origin = captureOrigin();
    if (!isCurrentOrigin(origin) || origin.scope !== 'subject' || !acquireAction('research', origin)) {
      return null;
    }
    setResearchError(null);
    let accepted = false;
    try {
      const res = await apiFetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, subjectId: origin.subjectId }),
      });
      if (!isCurrentOrigin(origin)) return null;
      if (res.ok) {
        const json = (await res.json()) as { jobId: string };
        if (!isCurrentOrigin(origin) || !json.jobId) return null;
        accepted = true;
        const meta = { jobId: json.jobId, origin, source };
        researchJobMetaRef.current = meta;
        actionJobMetaRef.current.research = meta;
        setResearchJobId(json.jobId);
        return json.jobId;
      } else {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!isCurrentOrigin(origin)) return null;
        setResearchError(json.error ?? `Research request failed (${res.status})`);
      }
    } catch {
      if (isCurrentOrigin(origin)) setResearchError('Research request failed. Please try again.');
    } finally {
      if (!accepted) releaseAction('research', origin);
    }
    return null;
  }

  async function runRemediation(
    action: ExecutableRemediationAction,
    findingIds: string[],
    actingFindingId?: string,
  ) {
    if (!data?.jobId || findingIds.length === 0 || allSubjects) return;
    const origin = captureOrigin();
    const lintJobId = data.jobId;
    if (!isCurrentOrigin(origin) || !acquireAction(action, origin, actingFindingId)) return;

    setRemediationError(null);
    if (action === 'fix') {
      setFixSummary(null);
      setFixPostcondition(null);
    } else if (action === 'curate') {
      setCuratePostcondition(null);
    }

    let accepted = false;
    try {
      const response = await apiFetch('/api/health/remediations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subjectId: origin.subjectId,
          lintJobId,
          findingIds,
          action,
        }),
      });

      if (!isCurrentOrigin(origin)) return;

      if (response.status === 409) {
        await queryClient.invalidateQueries({ queryKey: ['lint-latest', origin.subjectId] });
        if (!isCurrentOrigin(origin)) return;
        setRemediationError('体检结果已更新，请重新确认。');
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        if (!isCurrentOrigin(origin)) return;
        setRemediationError(payload.error ?? `处置请求失败（${response.status}）`);
        return;
      }

      const { jobId: remediationJobId } = await response.json() as {
        jobId: string;
        deduplicated?: boolean;
      };
      if (!isCurrentOrigin(origin) || !remediationJobId) return;
      accepted = true;
      const meta = { jobId: remediationJobId, origin };
      actionJobMetaRef.current[action] = meta;
      switch (action) {
        case 'fix':
          setFixJobId(remediationJobId);
          break;
        case 'curate':
          setCurateJobId(remediationJobId);
          break;
        case 'research':
          researchJobMetaRef.current = { ...meta, source: 'remediation' };
          setResearchJobId(remediationJobId);
          break;
        case 're-ingest':
          setReingestJobId(remediationJobId);
          break;
      }
      await queryClient.invalidateQueries({ queryKey: ['lint-latest', origin.subjectId] });
    } catch {
      if (isCurrentOrigin(origin)) setRemediationError('处置请求失败，请稍后重试。');
    } finally {
      if (!accepted) releaseAction(action, origin);
    }
  }

  async function confirmIngest(urls: string[]) {
    const result = candidateResult;
    if (!result || !isCurrentOrigin(result.origin) || ingestOriginRef.current) return;
    ingestOriginRef.current = result.origin;
    setIngesting(true);
    try {
      const res = await apiFetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, subjectId: result.subjectId }),
      });
      if (isCurrentOrigin(result.origin) && (res.ok || res.status === 202)) {
        setCandidateResult(null);
        queryClient.invalidateQueries({ queryKey: ['pages'] });
      }
    } finally {
      const held = ingestOriginRef.current;
      if (held && isHealthOriginCurrent(held, result.origin)) {
        ingestOriginRef.current = null;
        if (isCurrentOrigin(result.origin)) setIngesting(false);
      }
    }
  }

  async function deleteSource(sourceId: string) {
    const origin = captureOrigin();
    if (!isCurrentOrigin(origin) || deleteOriginsRef.current.has(sourceId)) return;
    deleteOriginsRef.current.set(sourceId, origin);
    setDeletingSourceIds((current) => new Set(current).add(sourceId));
    try {
      const res = await apiFetch(
        `/api/sources/${sourceId}?subjectId=${encodeURIComponent(origin.subjectId)}`,
        { method: 'DELETE' },
      );
      if (res.ok && isCurrentOrigin(origin)) {
        setHandledSourceIds((prev) => new Set(prev).add(sourceId));
        queryClient.invalidateQueries({ queryKey: ['sources'] });
        void runLint(origin);
      }
    } finally {
      const held = deleteOriginsRef.current.get(sourceId);
      if (held && isHealthOriginCurrent(held, origin)) {
        deleteOriginsRef.current.delete(sourceId);
        if (isCurrentOrigin(origin)) {
          setDeletingSourceIds((current) => {
            const next = new Set(current);
            next.delete(sourceId);
            return next;
          });
        }
      }
    }
  }

  function switchScope(next: Scope) {
    if (next === scope) return;
    invalidateOrigin(next);
    setScope(next);
  }

  useEffect(() => {
    setJobId(null);
    setStarting(false);
    setLintError(null);
    setSemanticErrored(false);
    setCurateJobId(null);
    setCuratePostcondition(null);
    setFixJobId(null);
    setFixSummary(null);
    setFixPostcondition(null);
    setResearchJobId(null);
    setCandidateResult(null);
    setIngesting(false);
    setResearchError(null);
    setRemediationError(null);
    setBusyActions(new Set());
    setActingFindingByAction({});
    setHandledSourceIds(new Set());
    setDeletingSourceIds(new Set());
    setReingestJobId(null);
  }, [scope, subjectId]);

  const [typeFilter, setTypeFilter] = useState<LintFinding['type'] | null>(null);
  useEffect(() => setTypeFilter(null), [scope]);

  const allFindings = useMemo(() => data?.findings ?? [], [data?.findings]);
  const visibleFindings = useMemo(() => {
    const notHandled = allFindings.filter(
      (f) => !(f.type === 'orphan-source' && f.sourceId && handledSourceIds.has(f.sourceId)),
    );
    return typeFilter ? notHandled.filter((f) => f.type === typeFilter) : notHandled;
  }, [allFindings, typeFilter, handledSourceIds]);
  const groups = useMemo(() => groupBySeverity(visibleFindings), [visibleFindings]);
  const presentTypes = useMemo(
    () => [...new Set(allFindings.map((f) => f.type))].sort(),
    [allFindings],
  );

  const total = allFindings.length;
  const neverRun = data?.jobId == null;
  const fixFindingIds = data ? actionFindingIds(data, 'fix') : [];
  const curateFindingIds = data ? actionFindingIds(data, 'curate') : [];
  const researchFindingIds = data ? actionFindingIds(data, 'research') : [];
  const recentOutcomeSummary = useMemo(
    () => data
      ? recentOutcomeCounts(data)
      : { fixed: 0, failed: 0, skipped: 0 },
    [data],
  );
  const recentTerminalCount = recentOutcomeSummary.fixed
    + recentOutcomeSummary.failed
    + recentOutcomeSummary.skipped;
  const recentTone = recentOutcomeBannerTone(recentOutcomeSummary);
  const recentBannerClass = recentTone === 'danger'
    ? 'border-danger/40 bg-danger-bg text-danger'
    : recentTone === 'warning'
      ? 'border-warning/40 bg-warning-bg text-warning'
      : 'border-success/40 bg-success-bg text-success';

  // 动作条一行 5 个控件超出 65ch 阅读宽度，本页放宽到 max-w-4xl
  return (
    <div className="max-w-4xl mx-auto px-6 py-8 w-full space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <Activity className="h-5 w-5 text-foreground-tertiary" />
            Health
          </h1>
          <p className="mt-1 text-sm text-foreground-secondary">
            {allSubjects
              ? 'Quality findings across all subjects.'
              : `Quality findings for "${subjectSlug}".`}
            {data?.ranAt && (
              <span className="text-foreground-tertiary"> · Last checked {new Date(data.ranAt).toLocaleString()}</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => switchScope('subject')}
              className={
                'h-8 px-3 text-sm whitespace-nowrap transition-colors ' +
                (!allSubjects ? 'bg-subtle text-foreground font-medium' : 'text-foreground-secondary hover:bg-subtle')
              }
            >
              This subject
            </button>
            <button
              type="button"
              onClick={() => switchScope('all')}
              className={
                'h-8 px-3 text-sm whitespace-nowrap transition-colors border-l border-border ' +
                (allSubjects ? 'bg-subtle text-foreground font-medium' : 'text-foreground-secondary hover:bg-subtle')
              }
            >
              All subjects
            </button>
          </div>
          <Button intent="primary" onClick={() => void runLint()} loading={running}>
            {/* loading 时 Button 自带 spinner，隐藏本图标避免双图标 */}
            {!running && <RefreshCw className="h-3.5 w-3.5" />}
            {neverRun ? 'Run health check' : 'Re-run'}
          </Button>
          <Button
            intent="secondary"
            onClick={() => void runRemediation('curate', curateFindingIds)}
            loading={curating}
            disabled={allSubjects || neverRun || curateFindingIds.length === 0 || running || fixing}
          >
            {!curating && <Wand2 className="h-3.5 w-3.5" />}
            Tidy structure
          </Button>
          <Button
            intent="secondary"
            onClick={() => void runRemediation('fix', fixFindingIds)}
            loading={fixing}
            disabled={allSubjects || neverRun || fixFindingIds.length === 0 || running || curating}
          >
            {!fixing && <Wrench className="h-3.5 w-3.5" />}
            Fix issues
          </Button>
          <Button
            intent="secondary"
            onClick={() => void runRemediation('research', researchFindingIds)}
            loading={researching}
            disabled={allSubjects || neverRun || researchFindingIds.length === 0}
          >
            {!researching && <Search className="h-3.5 w-3.5" />}
            Research gaps{researchFindingIds.length > 0 ? ` (${researchFindingIds.length})` : ''}
          </Button>
        </div>
      </header>

      {!allSubjects && (
        <form
          className="flex items-center gap-2"
          onKeyDown={blockImeEnterSubmit}
          onSubmit={(e) => {
            e.preventDefault();
            const t = topicInput.trim();
            if (!t) return;
            void startResearch(t, 'manual');
            setTopicInput('');
          }}
        >
          <Input
            value={topicInput}
            onChange={(e) => setTopicInput(e.target.value)}
            placeholder="Research a topic…"
            className="max-w-xs"
          />
          <Button
            intent="secondary"
            type="submit"
            loading={researching}
            disabled={researching || !topicInput.trim()}
          >
            {!researching && <Search className="h-3.5 w-3.5" />}
            Research
          </Button>
        </form>
      )}

      {researchError && (
        <div className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
          {researchError}
        </div>
      )}

      {lintError && (
        <div className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
          {lintError}
        </div>
      )}

      {remediationError && (
        <div className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger">
          {remediationError}
        </div>
      )}

      {recentTerminalCount > 0 && (
        <div className={`rounded-md border px-3 py-2 text-sm ${recentBannerClass}`}>
          Recently verified: {recentOutcomeSummary.fixed} fixed
          {' · '}{recentOutcomeSummary.failed} failed
          {' · '}{recentOutcomeSummary.skipped} skipped
        </div>
      )}

      {candidateResult && (
        <ResearchCandidatesDialog
          candidates={candidateResult.candidates}
          onClose={() => setCandidateResult(null)}
          onConfirm={confirmIngest}
          confirming={ingesting}
        />
      )}

      {!allSubjects && (
        <ResearchBacklogSection
          researchBusy={researching}
          onResearch={(topic) => startResearch(topic, 'backlog')}
        />
      )}

      {running && (
        <p className="text-sm text-foreground-secondary">{latestMessage || 'Running health check…'}</p>
      )}

      {researching && (
        <p className="text-sm text-foreground-secondary">Researching…</p>
      )}

      {curating && (
        <p className="text-sm text-foreground-secondary">{curateMessage || 'Curating structure…'}</p>
      )}

      {fixing && (
        <p className="text-sm text-foreground-secondary">{fixMessage || 'Fixing issues…'}</p>
      )}

      {semanticErrored && (
        <div className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
          Semantic checks did not complete — only deterministic findings are shown.
        </div>
      )}

      {fixSummary && (
        <div className="rounded-md border border-accent/40 bg-accent-subtle px-3 py-2 text-sm text-accent-strong">
          Fixed {fixSummary.fixed} · skipped {fixSummary.skipped} (needs manual review)
          {fixSummary.failed > 0 ? ` · failed ${fixSummary.failed}` : ''}. Re-running health check…
        </div>
      )}

      {curatePostcondition && (
        <PostconditionBanner label="Tidy structure" report={curatePostcondition} />
      )}

      {fixPostcondition && (
        <PostconditionBanner label="Fix issues" report={fixPostcondition} />
      )}

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 rounded-md bg-subtle animate-pulse" />
          ))}
        </div>
      ) : neverRun ? (
        <div className="rounded-md border border-border bg-canvas px-6 py-10 text-center">
          <p className="text-sm text-foreground-secondary">
            Never run a health check{allSubjects ? '' : ` for "${subjectSlug}"`} yet.
          </p>
          <Button intent="primary" className="mt-3" onClick={() => void runLint()} loading={running}>
            Run now
          </Button>
        </div>
      ) : total === 0 ? (
        <p className="text-sm text-foreground-tertiary italic">No findings — looks healthy. ✨</p>
      ) : (
        <div className="space-y-4">
          {/* 概要计数条 */}
          <div className="flex items-center gap-3">
            {(['critical', 'warning', 'info'] as const).map((sev) => (
              <span key={sev} className="inline-flex items-center gap-1.5 text-sm text-foreground-secondary">
                <Tag tone={SEVERITY_TONE[sev]} size="sm">
                  {data?.bySeverity[sev] ?? 0}
                </Tag>
                {sev}
              </span>
            ))}
          </div>

          {/* type 过滤 chips */}
          {presentTypes.length > 1 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <button
                type="button"
                onClick={() => setTypeFilter(null)}
                className={
                  'h-6 px-2 rounded-sm text-xs transition-colors ' +
                  (typeFilter === null ? 'bg-accent-subtle text-accent-strong' : 'bg-subtle text-foreground-secondary hover:text-foreground')
                }
              >
                All
              </button>
              {presentTypes.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTypeFilter((cur) => (cur === t ? null : t))}
                  className={
                    'h-6 px-2 rounded-sm text-xs transition-colors ' +
                    (typeFilter === t ? 'bg-accent-subtle text-accent-strong' : 'bg-subtle text-foreground-secondary hover:text-foreground')
                  }
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          {/* 分组列表 */}
          {groups.map((group) =>
            group.findings.length === 0 ? null : (
              <section key={group.severity}>
                <h2 className="text-xs font-medium uppercase tracking-wider text-foreground-tertiary px-3 mb-1">
                  {group.severity} ({group.findings.length})
                </h2>
                <div className="space-y-0.5">
                  {group.findings.map((finding) => {
                    const plan = data?.remediations[finding.id];
                    const actingActions = new Set(
                      (Object.entries(actingFindingByAction) as Array<
                        [ExecutableRemediationAction, string]
                      >)
                        .filter(([, findingId]) => findingId === finding.id)
                        .map(([action]) => action),
                    );
                    const deleting = finding.sourceId
                      ? deletingSourceIds.has(finding.sourceId)
                      : false;
                    return (
                      <FindingRow
                        key={finding.id}
                        finding={finding}
                        plan={plan}
                        showSubject={allSubjects}
                        acting={actingActions}
                        deleting={deleting}
                        busyActions={effectiveBusyActions}
                        onAction={!allSubjects ? (action) => {
                          if (action.type !== 'review-source') {
                            void runRemediation(action.type, [finding.id], finding.id);
                          }
                        } : undefined}
                        onDeleteSource={
                          finding.type === 'orphan-source' && finding.sourceId && !allSubjects
                            ? () => deleteSource(finding.sourceId!)
                            : undefined
                        }
                      />
                    );
                  })}
                </div>
              </section>
            ),
          )}
        </div>
      )}
    </div>
  );
}
