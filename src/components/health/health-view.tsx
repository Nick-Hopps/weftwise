'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  ChevronDown,
  ListFilter,
  RefreshCw,
  Search,
  Wand2,
  Wrench,
} from 'lucide-react';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useJobStream } from '@/hooks/use-job-stream';
import { useLintSummary } from '@/hooks/use-lint-summary';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { groupBySeverity } from './lint-findings';
import { FindingRow, findingTypeLabel } from './finding-row';
import { ResearchCandidatesDialog } from './research-candidates-dialog';
import { ResearchBacklogSection } from './research-backlog-section';
import { blockImeEnterSubmit } from '@/lib/keyboard';
import type {
  Job,
  LintFinding,
  LintVerificationRequest,
  PostconditionReport,
  ResearchRunView,
} from '@/lib/contracts';
import {
  buildPostconditionNotice,
  extractPostconditionReport,
} from './postcondition-summary';
import {
  activeJobsHydrationBusyActions,
  actionFindingIds,
  createActionGate,
  createLintRerunQueue,
  fetchActiveHealthJobs,
  healthTerminalInvalidationKeys,
  isHealthOriginCurrent,
  persistedBusyActions,
  readResearchRun,
  readResearchRunId,
  recentOutcomeCounts,
  researchApprovalBody,
  selectRecoverableHealthJobs,
  summarizeFixOutcomes,
  type ExecutableRemediationAction,
  type HealthOrigin,
} from './remediation-ui';

type Scope = 'subject' | 'all';
type ResearchOrigin = 'manual' | 'backlog' | 'remediation';
type ActionJobMeta = {
  jobId: string;
  origin: HealthOrigin;
  baselineLintJobId?: string;
};
type ResearchJobMeta = ActionJobMeta & { source: ResearchOrigin };
type CandidateResult = {
  run: ResearchRunView;
  origin: HealthOrigin;
};
type ResearchApprovalAttempt = {
  runId: string;
  selection: string;
  idempotencyKey: string;
};

function isTerminalResearchRun(run: ResearchRunView): boolean {
  return run.status === 'completed'
    || run.status === 'partial'
    || run.status === 'failed'
    || run.status === 'dismissed'
    || run.status === 'empty';
}

function createResearchIdempotencyKey(runId: string): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${runId}:${random}`;
}

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
  const researchActionOriginRef = useRef<HealthOrigin | null>(null);
  const researchApprovalAttemptRef = useRef<ResearchApprovalAttempt | null>(null);
  const deleteOriginsRef = useRef(new Map<string, HealthOrigin>());
  const settledJobIdsRef = useRef(new Set<string>());
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
    researchActionOriginRef.current = null;
    researchApprovalAttemptRef.current = null;
    deleteOriginsRef.current.clear();
    settledJobIdsRef.current.clear();
  }

  const { data, isLoading } = useLintSummary(allSubjects);
  const {
    data: activeJobs = [],
    isSuccess: activeJobsReady,
    isError: activeJobsHydrationError,
    isFetching: activeJobsFetching,
    refetch: refetchActiveJobs,
  } = useQuery({
    queryKey: ['health-active-jobs', originSubjectId],
    queryFn: (): Promise<Job[]> => fetchActiveHealthJobs(originSubjectId, apiFetch),
    enabled: !allSubjects && !!originSubjectId,
    refetchInterval: 5_000,
    staleTime: 2_000,
  });
  const recoverableJobs = useMemo(
    () => !allSubjects
      ? selectRecoverableHealthJobs(
          data ?? { jobId: null, findings: [], remediations: {}, ranAt: null },
          activeJobs,
        )
      : {},
    [allSubjects, data, activeJobs],
  );
  const snapshotBusyActions = useMemo(
    () => data ? persistedBusyActions(data) : new Set<ExecutableRemediationAction>(),
    [data],
  );
  const hydrationBusyActions = useMemo(
    () => activeJobsHydrationBusyActions(scope, originSubjectId, activeJobsReady),
    [scope, originSubjectId, activeJobsReady],
  );
  const workflowBusyActions = useMemo(
    () => new Set([
      ...snapshotBusyActions,
      ...(Object.keys(recoverableJobs) as ExecutableRemediationAction[]),
      ...busyActions,
    ]),
    [snapshotBusyActions, recoverableJobs, busyActions],
  );
  const effectiveBusyActions = useMemo(
    () => new Set([
      ...hydrationBusyActions,
      ...workflowBusyActions,
    ]),
    [hydrationBusyActions, workflowBusyActions],
  );

  function captureOrigin(): HealthOrigin {
    return { ...originRef.current };
  }

  function isCurrentOrigin(origin: HealthOrigin): boolean {
    return isHealthOriginCurrent(originRef.current, origin);
  }

  function invalidateWorkflowLifecycle(origin: HealthOrigin): void {
    if (!isCurrentOrigin(origin)) return;
    for (const queryKey of healthTerminalInvalidationKeys(origin.subjectId)) {
      void queryClient.invalidateQueries({ queryKey });
    }
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
    researchActionOriginRef.current = null;
    researchApprovalAttemptRef.current = null;
    deleteOriginsRef.current.clear();
    settledJobIdsRef.current.clear();
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
      if (rerun) void runLint(rerun.origin, rerun.verification);
    } else if (streamStatus === 'failed') {
      if (!isCurrentOrigin(meta.origin)) return;
      setLintError('Health check failed — see job details for the underlying error.');
      lintJobMetaRef.current = null;
      setJobId(null);
      const rerun = lintRerunQueueRef.current.finish(meta.origin, captureOrigin());
      if (rerun) void runLint(rerun.origin, rerun.verification);
    }
    // jobId 变化时 useJobStream 尚可能保留上个任务的终态，不能据此提前结算新任务。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamStatus, events, queryClient]);

  const running = starting || (jobId !== null && streamStatus !== 'completed' && streamStatus !== 'failed');

  async function runLint(
    expectedOrigin: HealthOrigin = captureOrigin(),
    verification?: LintVerificationRequest,
  ) {
    if (!isCurrentOrigin(expectedOrigin)) return;
    const decision = lintRerunQueueRef.current.request(expectedOrigin, verification);
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
            : {
                subjectId: expectedOrigin.subjectId,
                ...(verification ? { verification } : {}),
              },
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
        if (rerun) void runLint(rerun.origin, rerun.verification);
      }
    }
  }

  const [curateJobId, setCurateJobId] = useState<string | null>(null);
  const [curatePostcondition, setCuratePostcondition] = useState<PostconditionReport | null>(null);
  const { status: curateStatus, events: curateEvents, latestMessage: curateMessage } = useJobStream(curateJobId);
  const curating = workflowBusyActions.has('curate');

  const [fixJobId, setFixJobId] = useState<string | null>(null);
  const [fixSummary, setFixSummary] = useState<{
    fixed: number;
    skipped: number;
    failed: number;
  } | null>(null);
  const [fixPostcondition, setFixPostcondition] = useState<PostconditionReport | null>(null);
  const { status: fixStatus, events: fixEvents, latestMessage: fixMessage } = useJobStream(fixJobId);
  const fixing = workflowBusyActions.has('fix');

  useEffect(() => {
    const meta = actionJobMetaRef.current.curate;
    if (!curateJobId || !meta || meta.jobId !== curateJobId || !isCurrentOrigin(meta.origin)) return;
    if (curateStatus === 'completed') {
      const verification = [...curateEvents]
        .reverse()
        .find((event) => event.type === 'curate:verify:complete');
      setCuratePostcondition(extractPostconditionReport(verification));
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      settledJobIdsRef.current.add(meta.jobId);
      invalidateWorkflowLifecycle(meta.origin);
      delete actionJobMetaRef.current.curate;
      setCurateJobId(null);
      releaseAction('curate', meta.origin);
      if (meta.baselineLintJobId) {
        void runLint(meta.origin, {
          baselineLintJobId: meta.baselineLintJobId,
          remediationJobId: meta.jobId,
        });
      }
    } else if (curateStatus === 'failed') {
      settledJobIdsRef.current.add(meta.jobId);
      invalidateWorkflowLifecycle(meta.origin);
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
      setFixSummary(summarizeFixOutcomes(done?.data.data));
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      settledJobIdsRef.current.add(meta.jobId);
      invalidateWorkflowLifecycle(meta.origin);
      delete actionJobMetaRef.current.fix;
      setFixJobId(null);
      releaseAction('fix', meta.origin);
      // 闭环：只复核原快照与确定性不变量，不重新开放式发现语义问题。
      if (meta.baselineLintJobId) {
        void runLint(meta.origin, {
          baselineLintJobId: meta.baselineLintJobId,
          remediationJobId: meta.jobId,
        });
      }
    } else if (fixStatus === 'failed') {
      settledJobIdsRef.current.add(meta.jobId);
      invalidateWorkflowLifecycle(meta.origin);
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
      settledJobIdsRef.current.add(meta.jobId);
      invalidateWorkflowLifecycle(meta.origin);
      delete actionJobMetaRef.current['re-ingest'];
      setReingestJobId(null);
      releaseAction('re-ingest', meta.origin);
      void runLint(meta.origin);
    } else if (reingestStatus === 'failed') {
      settledJobIdsRef.current.add(meta.jobId);
      invalidateWorkflowLifecycle(meta.origin);
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
  const [researchComposerOpen, setResearchComposerOpen] = useState(false);
  const [researchActing, setResearchActing] = useState(false);
  const [handledSourceIds, setHandledSourceIds] = useState<Set<string>>(new Set());
  const [deletingSourceIds, setDeletingSourceIds] = useState<Set<string>>(new Set());
  const { status: researchStatus } = useJobStream(researchJobId);
  const researching = workflowBusyActions.has('research');

  function showResearchError(source: ResearchOrigin, message: string): void {
    if (source === 'remediation') setRemediationError(message);
    else setResearchError(message);
  }

  useEffect(() => {
    if (allSubjects || !originSubjectId) return;
    const origin = captureOrigin();
    const recoverableIds = new Set(
      Object.values(recoverableJobs).map((candidate) => candidate?.jobId).filter(Boolean),
    );
    for (const settledId of settledJobIdsRef.current) {
      if (!recoverableIds.has(settledId)) settledJobIdsRef.current.delete(settledId);
    }

    for (const [workflow, candidate] of Object.entries(recoverableJobs) as Array<
      [ExecutableRemediationAction, NonNullable<(typeof recoverableJobs)[ExecutableRemediationAction]>]
    >) {
      if (!candidate || settledJobIdsRef.current.has(candidate.jobId)) continue;
      const existing = actionJobMetaRef.current[workflow];
      if (existing?.jobId === candidate.jobId) continue;

      if (!actionGateRef.current.isBusy(workflow)) {
        actionGateRef.current.tryAcquire(workflow, origin);
      }
      setBusyActions((current) => new Set(current).add(workflow));
      const meta = {
        jobId: candidate.jobId,
        origin,
        ...(candidate.baselineLintJobId
          ? { baselineLintJobId: candidate.baselineLintJobId }
          : {}),
      };
      actionJobMetaRef.current[workflow] = meta;

      switch (workflow) {
        case 'fix':
          setFixJobId(candidate.jobId);
          break;
        case 'curate':
          setCurateJobId(candidate.jobId);
          break;
        case 'research':
          researchFetchJobIdRef.current = null;
          researchJobMetaRef.current = { ...meta, source: candidate.source };
          setResearchJobId(candidate.jobId);
          break;
        case 're-ingest':
          setReingestJobId(candidate.jobId);
          break;
      }
    }
    // 恢复动作只由服务端 job/snapshot 列表变化驱动，不能依赖本地 job state 形成循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoverableJobs, allSubjects, originSubjectId, scope]);

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
          const runId = await readResearchRunId(res);
          if (!isCurrentOrigin(meta.origin)) return;
          const run = await loadResearchRun(runId, meta.origin);
          if (!isCurrentOrigin(meta.origin)) return;
          setCandidateResult({ run, origin: meta.origin });
        } catch (error) {
          if (isCurrentOrigin(meta.origin)) {
            showResearchError(
              meta.source,
              error instanceof Error ? error.message : 'Research result could not be loaded.',
            );
          }
        } finally {
          if (researchJobMetaRef.current?.jobId === researchJobId) {
            settledJobIdsRef.current.add(meta.jobId);
            invalidateWorkflowLifecycle(meta.origin);
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
      settledJobIdsRef.current.add(meta.jobId);
      invalidateWorkflowLifecycle(meta.origin);
      researchJobMetaRef.current = null;
      delete actionJobMetaRef.current.research;
      setResearchJobId(null);
      releaseAction('research', meta.origin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchStatus]);

  useEffect(() => {
    const result = candidateResult;
    if (
      !result
      || !isCurrentOrigin(result.origin)
      || (result.run.status !== 'importing' && result.run.status !== 'verifying')
    ) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = async () => {
      try {
        const run = await loadResearchRun(result.run.id, result.origin);
        if (cancelled || !isCurrentOrigin(result.origin)) return;
        setCandidateResult((current) => current?.run.id === run.id
          ? { ...current, run }
          : current);
        if (isTerminalResearchRun(run)) {
          queryClient.invalidateQueries({ queryKey: ['pages'] });
          invalidateWorkflowLifecycle(result.origin);
          return;
        }
      } catch (error) {
        if (!cancelled && isCurrentOrigin(result.origin)) {
          showResearchError(
            result.run.origin === 'findings' ? 'remediation' : 'manual',
            error instanceof Error ? error.message : 'Research run could not be refreshed.',
          );
        }
      }
      if (!cancelled) timer = setTimeout(poll, 2_000);
    };

    timer = setTimeout(poll, 2_000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // 只在 run 身份或阶段改变时重建轮询；内容刷新不重置计时器。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidateResult?.run.id, candidateResult?.run.status]);

  async function loadResearchRun(runId: string, origin: HealthOrigin): Promise<ResearchRunView> {
    const response = await apiFetch(
      `/api/research-runs/${encodeURIComponent(runId)}?subjectId=${encodeURIComponent(origin.subjectId)}`,
    );
    return readResearchRun(response);
  }

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
      const meta = { jobId: remediationJobId, origin, baselineLintJobId: lintJobId };
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

  async function approveResearchCandidates(candidateIds: string[]) {
    const result = candidateResult;
    if (
      !result
      || result.run.status !== 'awaiting-approval'
      || !isCurrentOrigin(result.origin)
      || researchActionOriginRef.current
    ) return;
    researchActionOriginRef.current = result.origin;
    setResearchActing(true);
    const selection = [...candidateIds].sort().join('\u0000');
    const previousAttempt = researchApprovalAttemptRef.current;
    const idempotencyKey = previousAttempt?.runId === result.run.id
      && previousAttempt.selection === selection
      ? previousAttempt.idempotencyKey
      : createResearchIdempotencyKey(result.run.id);
    researchApprovalAttemptRef.current = { runId: result.run.id, selection, idempotencyKey };

    try {
      const res = await apiFetch(`/api/research-runs/${encodeURIComponent(result.run.id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(researchApprovalBody(result.run, candidateIds, idempotencyKey)),
      });
      if (!isCurrentOrigin(result.origin)) return;
      if (res.ok) {
        const run = await readResearchRun(res);
        if (isCurrentOrigin(result.origin)) {
          setCandidateResult({ run, origin: result.origin });
          invalidateWorkflowLifecycle(result.origin);
        }
        return;
      }

      const latest = await loadResearchRun(result.run.id, result.origin);
      if (!isCurrentOrigin(result.origin)) return;
      setCandidateResult({ run: latest, origin: result.origin });
      if (latest.status === 'awaiting-approval') {
        showResearchError(
          result.run.origin === 'findings' ? 'remediation' : 'manual',
          `Research approval failed (${res.status}).`,
        );
      }
    } catch (error) {
      try {
        const latest = await loadResearchRun(result.run.id, result.origin);
        if (isCurrentOrigin(result.origin)) {
          setCandidateResult({ run: latest, origin: result.origin });
          if (latest.status === 'awaiting-approval') {
            showResearchError(
              result.run.origin === 'findings' ? 'remediation' : 'manual',
              'Research approval result is uncertain. Review the current run before retrying.',
            );
          }
        }
      } catch {
        if (isCurrentOrigin(result.origin)) {
          showResearchError(
            result.run.origin === 'findings' ? 'remediation' : 'manual',
            error instanceof Error ? error.message : 'Research approval failed.',
          );
        }
      }
    } finally {
      const held = researchActionOriginRef.current;
      if (held && isHealthOriginCurrent(held, result.origin)) {
        researchActionOriginRef.current = null;
        if (isCurrentOrigin(result.origin)) setResearchActing(false);
      }
    }
  }

  async function dismissResearchCandidates() {
    const result = candidateResult;
    if (
      !result
      || result.run.status !== 'awaiting-approval'
      || !isCurrentOrigin(result.origin)
      || researchActionOriginRef.current
    ) return;
    researchActionOriginRef.current = result.origin;
    setResearchActing(true);
    try {
      const response = await apiFetch(
        `/api/research-runs/${encodeURIComponent(result.run.id)}/dismiss`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subjectId: result.run.subjectId }),
        },
      );
      const run = await readResearchRun(response);
      if (!isCurrentOrigin(result.origin)) return;
      setCandidateResult({ run, origin: result.origin });
      invalidateWorkflowLifecycle(result.origin);
    } catch (error) {
      if (isCurrentOrigin(result.origin)) {
        showResearchError(
          result.run.origin === 'findings' ? 'remediation' : 'manual',
          error instanceof Error ? error.message : 'Research dismiss failed.',
        );
      }
    } finally {
      const held = researchActionOriginRef.current;
      if (held && isHealthOriginCurrent(held, result.origin)) {
        researchActionOriginRef.current = null;
        if (isCurrentOrigin(result.origin)) setResearchActing(false);
      }
    }
  }

  async function retryResearchCandidates() {
    const result = candidateResult;
    if (
      !result
      || result.run.status !== 'failed'
      || !isCurrentOrigin(result.origin)
      || researchActionOriginRef.current
    ) return;
    researchActionOriginRef.current = result.origin;
    setResearchActing(true);
    try {
      const response = await apiFetch(
        `/api/research-runs/${encodeURIComponent(result.run.id)}/retry`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subjectId: result.run.subjectId,
            expectedVersion: result.run.version,
          }),
        },
      );
      const run = await readResearchRun(response);
      if (!isCurrentOrigin(result.origin)) return;
      setCandidateResult({ run, origin: result.origin });
      invalidateWorkflowLifecycle(result.origin);
    } catch (error) {
      if (isCurrentOrigin(result.origin)) {
        showResearchError(
          result.run.origin === 'findings' ? 'remediation' : 'manual',
          error instanceof Error ? error.message : 'Research retry failed.',
        );
      }
    } finally {
      const held = researchActionOriginRef.current;
      if (held && isHealthOriginCurrent(held, result.origin)) {
        researchActionOriginRef.current = null;
        if (isCurrentOrigin(result.origin)) setResearchActing(false);
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
    setResearchActing(false);
    setResearchError(null);
    setResearchComposerOpen(false);
    setTopicInput('');
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
  const activeMessages = [
    running ? latestMessage || 'Running health check...' : null,
    researching ? 'Researching sources...' : null,
    curating ? curateMessage || 'Curating structure...' : null,
    fixing ? fixMessage || 'Fixing issues...' : null,
  ].filter((message): message is string => message !== null);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <header className="mb-6 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <Activity className="h-5 w-5 text-accent" aria-hidden />
            <h1 className="text-2xl font-semibold text-foreground">Health</h1>
          </div>
          <p className="mt-1.5 truncate text-sm text-foreground-secondary">
            {allSubjects ? 'All subjects' : subjectSlug}
            <span className="text-foreground-tertiary">
              {data?.ranAt
                ? ` · Checked ${new Date(data.ranAt).toLocaleString()}`
                : ' · Not checked yet'}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="radiogroup"
            aria-label="Health check scope"
            className="inline-flex h-8 rounded-md border border-border bg-surface p-0.5"
          >
            <button
              type="button"
              role="radio"
              aria-checked={!allSubjects}
              onClick={() => switchScope('subject')}
              className={
                'rounded-sm px-2.5 text-xs font-medium transition-colors ' +
                (!allSubjects
                  ? 'bg-subtle text-foreground shadow-xs'
                  : 'text-foreground-secondary hover:text-foreground')
              }
            >
              This subject
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={allSubjects}
              onClick={() => switchScope('all')}
              className={
                'rounded-sm px-2.5 text-xs font-medium transition-colors ' +
                (allSubjects
                  ? 'bg-subtle text-foreground shadow-xs'
                  : 'text-foreground-secondary hover:text-foreground')
              }
            >
              All subjects
            </button>
          </div>
          <Button intent="primary" onClick={() => void runLint()} loading={running}>
            {!running && <RefreshCw className="h-3.5 w-3.5" />}
            {neverRun ? 'Run check' : 'Run again'}
          </Button>
        </div>
      </header>

      <section
        aria-label="Health summary"
        className="grid grid-cols-2 overflow-hidden border-y border-border bg-surface sm:grid-cols-4 lg:grid-cols-[1.2fr_repeat(3,0.8fr)_2fr]"
      >
        <div className="px-4 py-3.5">
          <p className="text-xs font-medium text-foreground-tertiary">Open findings</p>
          <p className="mt-1 text-2xl font-semibold text-foreground">{total}</p>
        </div>
        {(['critical', 'warning', 'info'] as const).map((severity) => (
          <div key={severity} className="border-l border-border-subtle px-4 py-3.5">
            <p className="text-xs font-medium capitalize text-foreground-tertiary">{severity}</p>
            <p className={
              'mt-1 text-xl font-semibold ' +
              (severity === 'critical'
                ? 'text-danger'
                : severity === 'warning'
                  ? 'text-warning'
                  : 'text-foreground')
            }>
              {data?.bySeverity[severity] ?? 0}
            </p>
          </div>
        ))}
        <div className="col-span-2 border-t border-border-subtle px-4 py-3.5 sm:col-span-4 lg:col-span-1 lg:border-l lg:border-t-0">
          <p className="text-xs font-medium text-foreground-tertiary">Recently verified</p>
          {recentTerminalCount > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span><strong className="text-success">{recentOutcomeSummary.fixed}</strong> fixed</span>
              <span><strong className="text-danger">{recentOutcomeSummary.failed}</strong> failed</span>
              <span><strong className="text-foreground-secondary">{recentOutcomeSummary.skipped}</strong> skipped</span>
            </div>
          ) : (
            <p className="mt-1.5 text-xs text-foreground-tertiary">No recent results</p>
          )}
        </div>
      </section>

      <div className="sticky top-0 z-10 -mx-4 mt-6 border-y border-border bg-canvas/95 px-4 py-3 backdrop-blur-sm sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <ListFilter className="h-3.5 w-3.5 text-foreground-tertiary" aria-hidden />
            <Select
              aria-label="Filter findings by type"
              value={typeFilter ?? ''}
              onChange={(event) => {
                setTypeFilter(event.target.value
                  ? event.target.value as LintFinding['type']
                  : null);
              }}
              className="min-w-[170px]"
            >
              <option value="">All finding types</option>
              {presentTypes.map((type) => (
                <option key={type} value={type}>{findingTypeLabel(type)}</option>
              ))}
            </Select>
            {typeFilter && (
              <span className="text-xs text-foreground-tertiary">
                {visibleFindings.length} of {total}
              </span>
            )}
          </div>

          {!allSubjects && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                intent="ghost"
                onClick={() => setResearchComposerOpen((current) => !current)}
                aria-expanded={researchComposerOpen}
              >
                <Search className="h-3.5 w-3.5" />
                Custom research
                <ChevronDown
                  className={'h-3.5 w-3.5 transition-transform ' + (researchComposerOpen ? 'rotate-180' : '')}
                />
              </Button>
              <span className="hidden h-5 w-px bg-border lg:block" aria-hidden />
              <Button
                intent="outline"
                onClick={() => void runRemediation('curate', curateFindingIds)}
                loading={curating}
                disabled={
                  neverRun
                  || curateFindingIds.length === 0
                  || running
                  || fixing
                  || effectiveBusyActions.has('curate')
                }
                title="Curate orphaned pages"
              >
                {!curating && <Wand2 className="h-3.5 w-3.5" />}
                Tidy {curateFindingIds.length > 0 && `(${curateFindingIds.length})`}
              </Button>
              <Button
                intent="outline"
                onClick={() => void runRemediation('fix', fixFindingIds)}
                loading={fixing}
                disabled={
                  neverRun
                  || fixFindingIds.length === 0
                  || running
                  || curating
                  || effectiveBusyActions.has('fix')
                }
                title="Fix deterministic findings"
              >
                {!fixing && <Wrench className="h-3.5 w-3.5" />}
                Fix {fixFindingIds.length > 0 && `(${fixFindingIds.length})`}
              </Button>
              <Button
                intent="outline"
                onClick={() => void runRemediation('research', researchFindingIds)}
                loading={researching}
                disabled={
                  neverRun
                  || researchFindingIds.length === 0
                  || effectiveBusyActions.has('research')
                }
                title="Research coverage gaps"
              >
                {!researching && <Search className="h-3.5 w-3.5" />}
                Research {researchFindingIds.length > 0 && `(${researchFindingIds.length})`}
              </Button>
            </div>
          )}
        </div>

        {!allSubjects && researchComposerOpen && (
          <form
            className="mt-3 flex animate-slide-down items-center gap-2 border-t border-border-subtle pt-3"
            onKeyDown={blockImeEnterSubmit}
            onSubmit={(event) => {
              event.preventDefault();
              if (effectiveBusyActions.has('research')) return;
              const topic = topicInput.trim();
              if (!topic) return;
              void startResearch(topic, 'manual');
              setTopicInput('');
            }}
          >
            <Input
              value={topicInput}
              onChange={(event) => setTopicInput(event.target.value)}
              placeholder="Topic or question"
              aria-label="Research topic"
              className="max-w-md"
            />
            <Button
              intent="secondary"
              type="submit"
              loading={researching}
              disabled={effectiveBusyActions.has('research') || !topicInput.trim()}
            >
              {!researching && <Search className="h-3.5 w-3.5" />}
              Start research
            </Button>
          </form>
        )}
      </div>

      <div className="mt-5 space-y-2">
        {researchError && (
          <div className="border-l-2 border-danger bg-danger-bg px-3 py-2 text-sm text-danger">
            {researchError}
          </div>
        )}
        {lintError && (
          <div className="border-l-2 border-danger bg-danger-bg px-3 py-2 text-sm text-danger">
            {lintError}
          </div>
        )}
        {remediationError && (
          <div className="border-l-2 border-danger bg-danger-bg px-3 py-2 text-sm text-danger">
            {remediationError}
          </div>
        )}
        {!allSubjects && activeJobsHydrationError && (
          <div className="flex items-center justify-between gap-3 border-l-2 border-danger bg-danger-bg px-3 py-2 text-sm text-danger">
            <span>Could not restore active jobs. Actions remain disabled while retrying.</span>
            <Button
              intent="secondary"
              size="sm"
              loading={activeJobsFetching}
              onClick={() => void refetchActiveJobs()}
            >
              Retry
            </Button>
          </div>
        )}
        {activeMessages.length > 0 && (
          <div className="flex items-start gap-2 border-l-2 border-accent bg-accent-subtle px-3 py-2 text-sm text-accent-strong">
            <Activity className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-pulse" aria-hidden />
            <div>{activeMessages.map((message) => <p key={message}>{message}</p>)}</div>
          </div>
        )}
        {semanticErrored && (
          <div className="border-l-2 border-warning bg-warning-bg px-3 py-2 text-sm text-warning">
            Semantic checks did not complete. Only deterministic findings are shown.
          </div>
        )}
        {fixSummary && (
          <div className="border-l-2 border-accent bg-accent-subtle px-3 py-2 text-sm text-accent-strong">
            {fixSummary.fixed + fixSummary.failed + fixSummary.skipped > 0
              ? `Verified ${fixSummary.fixed} fixed · ${fixSummary.failed} failed · ${fixSummary.skipped} skipped`
              : 'Per-finding verification was unavailable'}
            . Verifying the selected findings.
          </div>
        )}
        {curatePostcondition && (
          <PostconditionBanner label="Tidy structure" report={curatePostcondition} />
        )}
        {fixPostcondition && (
          <PostconditionBanner label="Fix issues" report={fixPostcondition} />
        )}
      </div>

      {candidateResult && (
        <ResearchCandidatesDialog
          run={candidateResult.run}
          onClose={() => setCandidateResult(null)}
          onApprove={approveResearchCandidates}
          onDismiss={dismissResearchCandidates}
          onRetry={retryResearchCandidates}
          acting={researchActing}
        />
      )}

      <div className="mt-6">
        {isLoading ? (
          <div className="overflow-hidden rounded-md border border-border bg-surface">
            {[1, 2, 3].map((item) => (
              <div key={item} className="flex gap-3 border-b border-border-subtle px-4 py-4 last:border-b-0">
                <div className="h-8 w-8 animate-pulse rounded-md bg-subtle" />
                <div className="flex-1 space-y-2 py-0.5">
                  <div className="h-3 w-40 animate-pulse rounded-sm bg-subtle" />
                  <div className="h-3 w-4/5 animate-pulse rounded-sm bg-subtle" />
                </div>
              </div>
            ))}
          </div>
        ) : neverRun ? (
          <div className="border-y border-border py-14 text-center">
            <Activity className="mx-auto h-6 w-6 text-foreground-tertiary" aria-hidden />
            <p className="mt-3 text-sm font-medium text-foreground">No health check yet</p>
            <p className="mt-1 text-sm text-foreground-secondary">
              Run a check to inspect links, sources, coverage, and structure.
            </p>
            <Button intent="primary" className="mt-4" onClick={() => void runLint()} loading={running}>
              Run check
            </Button>
          </div>
        ) : total === 0 ? (
          <div className="border-y border-border py-14 text-center">
            <p className="text-sm font-medium text-foreground">No open findings</p>
            <p className="mt-1 text-sm text-foreground-secondary">This scope passed the latest health check.</p>
          </div>
        ) : (
          <div>
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Open findings</h2>
                <p className="mt-0.5 text-xs text-foreground-tertiary">
                  Ordered by severity, then finding type.
                </p>
              </div>
              <span className="text-xs text-foreground-tertiary">
                Showing {visibleFindings.length} of {total}
              </span>
            </div>

            <div className="space-y-6">
              {groups.map((group) =>
                group.findings.length === 0 ? null : (
                  <section key={group.severity} aria-labelledby={`health-${group.severity}`}>
                    <div className="mb-2 flex items-center gap-2 px-1">
                      <span className={
                        'h-1.5 w-1.5 rounded-full ' +
                        (group.severity === 'critical'
                          ? 'bg-danger'
                          : group.severity === 'warning'
                            ? 'bg-warning'
                            : 'bg-foreground-tertiary')
                      } />
                      <h3
                        id={`health-${group.severity}`}
                        className="text-xs font-semibold capitalize text-foreground-secondary"
                      >
                        {group.severity}
                      </h3>
                      <span className="text-xs text-foreground-tertiary">{group.findings.length}</span>
                    </div>
                    <div className="divide-y divide-border-subtle overflow-hidden rounded-md border border-border bg-surface shadow-xs">
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
          </div>
        )}
      </div>

      {!allSubjects && (
        <div className="mt-10 border-t border-border pt-7">
          <ResearchBacklogSection
            researchBusy={effectiveBusyActions.has('research')}
            onResearch={(topic) => startResearch(topic, 'backlog')}
          />
        </div>
      )}
    </div>
  );
}
