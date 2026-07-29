'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  CheckCircle2,
  ChevronDown,
  ListFilter,
  RefreshCw,
  Search,
  Square,
  Wand2,
  Wrench,
} from 'lucide-react';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useJobStream } from '@/hooks/use-job-stream';
import { useLintSummary } from '@/hooks/use-lint-summary';
import { useI18n } from '@/components/i18n-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  WorkspaceMetric,
  WorkspacePage,
  WorkspacePageHeader,
  WorkspaceState,
  WorkspaceSummary,
  WorkspaceToolbar,
} from '@/components/ui/workspace-page';
import { groupBySeverity } from './lint-findings';
import { FindingRow, findingTypeLabel } from './finding-row';
import { ResearchCandidatesDialog } from './research-candidates-dialog';
import { ResearchBacklogSection } from './research-backlog-section';
import { blockImeEnterSubmit } from '@/lib/keyboard';
import {
  isMatchingResearchRunUpdate,
  RESEARCH_RUN_UPDATED_EVENT,
  type ResearchRunUpdatedEventDetail,
} from '@/lib/research-run-updated-event';
import { MAX_RESEARCH_BATCH_JOBS } from '@/lib/research-plan';
import type {
  Job,
  LintFinding,
  PostconditionReport,
  ResearchRunView,
} from '@/lib/contracts';
import type { MessageKey } from '@/lib/i18n/messages';
import {
  buildPostconditionNotice,
  extractPostconditionReport,
} from './postcondition-summary';
import {
  activeJobsHydrationBusyActions,
  actionFindingIds,
  BATCH_TARGET,
  blockingRecoverableActions,
  coveredFindingIds,
  EXECUTABLE_REMEDIATION_ACTIONS as EXECUTABLE_ACTIONS,
  findFindingJob,
  createActionGate,
  createLintRerunQueue,
  fetchActiveHealthJobs,
  healthTerminalInvalidationKeys,
  healthActionButtonState,
  isHealthOriginCurrent,
  persistedBusyActions,
  readDeleteSourceResult,
  readResearchRun,
  readResearchRunId,
  recentOutcomeCounts,
  remediationButtonDisabled,
  researchApprovalBody,
  requestHealthJobCancel,
  selectRecoverableHealthJobs,
  summarizeFixOutcomes,
  rowActionDisabled,
  type ExecutableRemediationAction,
  type HealthActionButtonState,
  type RecoverableHealthJob,
  type HealthOrigin,
} from './remediation-ui';

type Scope = 'subject' | 'all';

/** 稳定空集：避免逐行渲染时新建对象。 */
const EMPTY_COVERED: ReadonlySet<string> = new Set();
type ResearchOrigin = 'manual' | 'backlog' | 'remediation';
type ActionJobMeta = {
  jobId: string;
  origin: HealthOrigin;
  /** 该 job 归属的处置目标（finding ID 或 `BATCH_TARGET`）。 */
  target: string;
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
  labelKey,
  report,
}: {
  labelKey: MessageKey;
  report: PostconditionReport;
}) {
  const { t } = useI18n();
  const notice = buildPostconditionNotice(report, t);
  const tone = notice.tone === 'success'
    ? 'border-success/40 bg-success-bg text-success'
    : 'border-warning/40 bg-warning-bg text-warning';

  return (
    <div className={`rounded-md border px-3 py-2 text-sm ${tone}`}>
      <p className="font-medium">{t(labelKey)} · {notice.title}</p>
      {notice.details.map((detail, index) => (
        <p key={`${index}-${detail}`} className="mt-0.5">{detail}</p>
      ))}
    </div>
  );
}

export function HealthView() {
  const { t, formatDate } = useI18n();
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();

  const [scope, setScope] = useState<Scope>('subject');
  const allSubjects = scope === 'all';
  const originSubjectId = subjectId ?? '';
  const [remediationError, setRemediationError] = useState<string | null>(null);
  /**
   * 正在提交中的处置目标，键为 `action\0target`（target = findingId 或 `BATCH_TARGET`）。
   *
   * 只覆盖「POST 已发出、active-jobs 还没回来」这个窗口——之后行的禁用与 Stop 一律由
   * 服务端 active jobs 派生（`coveredFindingIds` / `findFindingJob`），客户端不再自己记账
   * 谁在跑。这样刷新也不会丢，并且天然按 finding 而非按 action 类型隔离。
   */
  const [submittingTargets, setSubmittingTargets] = useState<Set<string>>(new Set());
  const [cancellingTargets, setCancellingTargets] = useState<Set<string>>(new Set());
  /** 每个 action 当前被 SSE 观察的那个 job 归属哪个 target（render 需要，故用 state）。 */
  const [observedTargets, setObservedTargets] = useState<
    Partial<Record<ExecutableRemediationAction, string>>
  >({});

  const actionGateRef = useRef(createActionGate());
  const cancellingTargetsRef = useRef<Set<string>>(new Set());
  const actionJobMetaRef = useRef<Partial<Record<ExecutableRemediationAction, ActionJobMeta>>>({});
  const researchJobMetaRef = useRef<ResearchJobMeta | null>(null);
  const researchFetchJobIdRef = useRef<string | null>(null);
  /**
   * 批量 Research 拆出的其余 job（当前正在观察的那个不在其中）。
   *
   * worker 对非 ingest job 串行独占执行，所以逐个用 SSE 观察即可覆盖整批，
   * 既不必为 N 个 job 建 N 条连接，也避开「POST 后 active 列表尚未刷新就误判整批完成」。
   * 队列排空前不释放 research 锁。
   */
  const researchQueueRef = useRef<string[]>([]);
  const lintJobMetaRef = useRef<{ jobId: string; origin: HealthOrigin } | null>(null);
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
    cancellingTargetsRef.current.clear();
    actionJobMetaRef.current = {};
    researchJobMetaRef.current = null;
    researchFetchJobIdRef.current = null;
    researchQueueRef.current = [];
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
  /**
   * 「这个 action 有东西在跑」——**只用于状态文案与运行态呈现，不用于禁用判定**。
   *
   * 禁用一律走目标粒度：行内看 `coveredFindingIds`（服务端事实），工具栏看自己那一批
   * 的 `submittingTargets` / 观察中的 job。整类禁用是这次要修掉的东西。
   */
  const workflowBusyActions = useMemo(
    () => new Set<ExecutableRemediationAction>([
      ...snapshotBusyActions,
      ...blockingRecoverableActions(recoverableJobs),
      ...[...submittingTargets].map(
        (key) => key.split(' ')[0] as ExecutableRemediationAction,
      ),
    ]),
    [snapshotBusyActions, recoverableJobs, submittingTargets],
  );
  /** 每个 action 当前被在途 job 覆盖的 finding（服务端 active jobs 派生）。 */
  const coveredByAction = useMemo(() => {
    const map = new Map<ExecutableRemediationAction, Set<string>>();
    for (const action of EXECUTABLE_ACTIONS) {
      map.set(action, coveredFindingIds(activeJobs, action));
    }
    return map;
  }, [activeJobs]);

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

  function targetKey(action: ExecutableRemediationAction, target: string): string {
    return `${action} ${target}`;
  }

  /**
   * 抢占某个**处置目标**的提交权（防同一目标重复提交），而非整个 action 类型。
   *
   * hydration 未就绪时仍整类拒绝：那时还不知道有什么在途，防的是刷新后重复提交。
   */
  function acquireAction(
    action: ExecutableRemediationAction,
    origin: HealthOrigin,
    target: string,
  ): boolean {
    if (hydrationBusyActions.has(action)) return false;
    if (!actionGateRef.current.tryAcquire(action, target, origin)) return false;
    setSubmittingTargets((current) => new Set(current).add(targetKey(action, target)));
    return true;
  }

  function releaseAction(
    action: ExecutableRemediationAction,
    origin: HealthOrigin,
    target: string,
  ): void {
    if (!actionGateRef.current.release(action, target, origin)) return;
    setSubmittingTargets((current) => {
      const next = new Set(current);
      next.delete(targetKey(action, target));
      return next;
    });
  }

  /**
   * 结算一个观察完的处置 job：清掉观察头与该 target 的取消标记。
   *
   * 不释放提交窗口锁——它在 POST 成功、active jobs 刷新后就已经释放，之后的禁用一律
   * 由服务端在途 job 派生。清空观察头后，恢复 effect 会从新的 active jobs 里挑下一个。
   */
  function settleActionJob(
    action: ExecutableRemediationAction,
    meta: ActionJobMeta,
    setJobIdState: (jobId: string | null) => void,
  ): void {
    delete actionJobMetaRef.current[action];
    setObservedTargets((current) => {
      const next = { ...current };
      delete next[action];
      return next;
    });
    setJobIdState(null);
    setActionCancelling(action, meta.target, false);
  }

  function setActionCancelling(
    action: ExecutableRemediationAction,
    target: string,
    cancelling: boolean,
  ): void {
    const key = targetKey(action, target);
    if (cancelling) cancellingTargetsRef.current.add(key);
    else cancellingTargetsRef.current.delete(key);
    setCancellingTargets(new Set(cancellingTargetsRef.current));
  }

  function invalidateOrigin(nextScope: Scope): void {
    originRef.current = {
      generation: originRef.current.generation + 1,
      subjectId: originSubjectId,
      scope: nextScope,
    };
    originKeyRef.current = `${originSubjectId}\u0000${nextScope}`;
    actionGateRef.current.reset();
    cancellingTargetsRef.current.clear();
    actionJobMetaRef.current = {};
    researchJobMetaRef.current = null;
    researchFetchJobIdRef.current = null;
    researchQueueRef.current = [];
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
      if (rerun) void runLint(rerun.origin);
    } else if (streamStatus === 'failed') {
      if (!isCurrentOrigin(meta.origin)) return;
      setLintError(t('health.error.jobFailed'));
      lintJobMetaRef.current = null;
      setJobId(null);
      const rerun = lintRerunQueueRef.current.finish(meta.origin, captureOrigin());
      if (rerun) void runLint(rerun.origin);
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
        setLintError(t('health.error.requestStatus', { status: res.status }));
        return;
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        setLintError(t('health.error.invalidResponse'));
        return;
      }
      if (
        !isCurrentOrigin(expectedOrigin)
        || typeof json !== 'object'
        || json === null
        || typeof (json as { jobId?: unknown }).jobId !== 'string'
        || !(json as { jobId: string }).jobId
      ) {
        if (isCurrentOrigin(expectedOrigin)) setLintError(t('health.error.invalidResponse'));
        return;
      }
      accepted = true;
      const nextJobId = (json as { jobId: string }).jobId;
      lintJobMetaRef.current = { jobId: nextJobId, origin: expectedOrigin };
      setJobId(nextJobId);
    } catch {
      if (isCurrentOrigin(expectedOrigin)) {
        setLintError(t('health.error.requestRetry'));
      }
    } finally {
      if (isCurrentOrigin(expectedOrigin)) setStarting(false);
      if (!accepted) {
        const rerun = lintRerunQueueRef.current.finish(expectedOrigin, captureOrigin());
        if (rerun) void runLint(rerun.origin);
      }
    }
  }

  const [curateJobId, setCurateJobId] = useState<string | null>(null);
  const [curatePostcondition, setCuratePostcondition] = useState<PostconditionReport | null>(null);
  const {
    status: curateStatus,
    events: curateEvents,
    latestMessage: curateMessage,
    reset: resetCurateStream,
  } = useJobStream(curateJobId);
  const curating = workflowBusyActions.has('curate');

  const [fixJobId, setFixJobId] = useState<string | null>(null);
  const [fixSummary, setFixSummary] = useState<{
    fixed: number;
    skipped: number;
    failed: number;
  } | null>(null);
  const [fixPostcondition, setFixPostcondition] = useState<PostconditionReport | null>(null);
  const {
    status: fixStatus,
    events: fixEvents,
    latestMessage: fixMessage,
    reset: resetFixStream,
  } = useJobStream(fixJobId);
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
      settleActionJob('curate', meta, setCurateJobId);
    } else if (curateStatus === 'failed') {
      settledJobIdsRef.current.add(meta.jobId);
      invalidateWorkflowLifecycle(meta.origin);
      settleActionJob('curate', meta, setCurateJobId);
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
      settleActionJob('fix', meta, setFixJobId);
    } else if (fixStatus === 'failed') {
      settledJobIdsRef.current.add(meta.jobId);
      invalidateWorkflowLifecycle(meta.origin);
      settleActionJob('fix', meta, setFixJobId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixStatus, fixEvents, queryClient, allSubjects, subjectId]);

  const [reingestJobId, setReingestJobId] = useState<string | null>(null);
  const { status: reingestStatus, reset: resetReingestStream } = useJobStream(reingestJobId);

  // Retry ingest 完成 → 自动重跑体检刷新 findings（与 Fix 闭环一致）；失败则仅停止追踪
  useEffect(() => {
    const meta = actionJobMetaRef.current['re-ingest'];
    if (!reingestJobId || !meta || meta.jobId !== reingestJobId || !isCurrentOrigin(meta.origin)) return;
    if (reingestStatus === 'completed') {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      settledJobIdsRef.current.add(meta.jobId);
      invalidateWorkflowLifecycle(meta.origin);
      settleActionJob('re-ingest', meta, setReingestJobId);
      void runLint(meta.origin);
    } else if (reingestStatus === 'failed') {
      settledJobIdsRef.current.add(meta.jobId);
      invalidateWorkflowLifecycle(meta.origin);
      settleActionJob('re-ingest', meta, setReingestJobId);
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
  const {
    status: researchStatus,
    events: researchEvents,
    reset: resetResearchStream,
  } = useJobStream(researchJobId);
  const researching = workflowBusyActions.has('research');

  useEffect(() => {
    const onResearchRunUpdated = (event: Event) => {
      const { run } = (event as CustomEvent<ResearchRunUpdatedEventDetail>).detail;
      setCandidateResult((current) => {
        if (
          !current
          || !isHealthOriginCurrent(originRef.current, current.origin)
          || !isMatchingResearchRunUpdate(current.run, run)
        ) return current;
        return { ...current, run };
      });
    };
    window.addEventListener(RESEARCH_RUN_UPDATED_EVENT, onResearchRunUpdated);
    return () => window.removeEventListener(RESEARCH_RUN_UPDATED_EVENT, onResearchRunUpdated);
  }, []);

  function showResearchError(source: ResearchOrigin, message: string): void {
    if (source === 'remediation') setRemediationError(message);
    else setResearchError(message);
  }

  useEffect(() => {
    if (allSubjects || !originSubjectId) return;
    const origin = captureOrigin();
    const recoverableIds = new Set(
      Object.values(recoverableJobs).flatMap(
        (candidates) => (candidates ?? []).map((candidate) => candidate.jobId),
      ),
    );
    for (const settledId of settledJobIdsRef.current) {
      if (!recoverableIds.has(settledId)) settledJobIdsRef.current.delete(settledId);
    }

    for (const [workflow, candidates] of Object.entries(recoverableJobs) as Array<
      [ExecutableRemediationAction, RecoverableHealthJob[] | undefined]
    >) {
      const pending = (candidates ?? [])
        .filter((candidate) => !settledJobIdsRef.current.has(candidate.jobId));
      const candidate = pending[0];
      if (!candidate) continue;
      const existing = actionJobMetaRef.current[workflow];
      if (existing?.jobId === candidate.jobId) continue;

      // 不再抢锁、不再整类置 busy：提交窗口锁只管 POST 那一瞬间，之后的禁用由
      // `coveredFindingIds` 按 finding 派生。这里只负责把 SSE 观察头指到队首。
      const meta = { jobId: candidate.jobId, origin, target: candidate.target };
      actionJobMetaRef.current[workflow] = meta;
      setObservedTargets((current) => ({ ...current, [workflow]: candidate.target }));

      switch (workflow) {
        case 'fix':
          // 切换观察目标前必须清流：`useJobStream` 在 jobId 变化时不重置 status，
          // 残留终态会让下一个 job 被立刻误判为已完成（7-27 在 research 上踩过）。
          resetFixStream();
          setFixJobId(candidate.jobId);
          break;
        case 'curate':
          resetCurateStream();
          setCurateJobId(candidate.jobId);
          break;
        case 'research':
          // 批量拆出的其余主题进入队列，Stop 与结算都以整批为单位。
          researchFetchJobIdRef.current = null;
          researchQueueRef.current = pending.slice(1).map((item) => item.jobId);
          researchJobMetaRef.current = { ...meta, source: candidate.source };
          resetResearchStream();
          setResearchJobId(candidate.jobId);
          break;
        case 're-ingest':
          resetReingestStream();
          setReingestJobId(candidate.jobId);
          break;
      }
    }
    // 恢复动作只由服务端 job/snapshot 列表变化驱动，不能依赖本地 job state 形成循环。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoverableJobs, allSubjects, originSubjectId, scope]);

  /**
   * 结算当前观察的 research job：队列还有主题就接着观察下一个，排空才释放 action 锁。
   * 一个主题失败不影响后续主题继续执行。
   */
  function settleResearchJob(meta: ResearchJobMeta): void {
    settledJobIdsRef.current.add(meta.jobId);
    invalidateWorkflowLifecycle(meta.origin);
    researchFetchJobIdRef.current = null;

    const next = researchQueueRef.current.shift();
    if (next) {
      const nextMeta = {
        jobId: next,
        origin: meta.origin,
        source: meta.source,
        target: meta.target,
      };
      researchJobMetaRef.current = nextMeta;
      actionJobMetaRef.current.research = nextMeta;
      // 必须先清流：`useJobStream` 在 jobId 变化时不会重置 status，残留的上一个主题终态
      // 会让下一个主题被立刻误判为已完成（整批瞬间「跑完」）；reset 同时清掉
      // lastEventId，避免新 job 带着上一个 job 的游标续播。
      resetResearchStream();
      setResearchJobId(next);
      return;
    }

    researchJobMetaRef.current = null;
    settleActionJob('research', meta, setResearchJobId);
  }

  useEffect(() => {
    const meta = researchJobMetaRef.current;
    if (!researchJobId || !meta || meta.jobId !== researchJobId || !isCurrentOrigin(meta.origin)) return;
    if (researchStatus === 'completed') {
      // remediation 来源的候选由 finding 行内入口按需打开，不自动弹窗劫持焦点；
      // 手动 / backlog 主题没有对应的 finding 行，仍必须自动弹出，否则候选无处审批。
      if (meta.source === 'remediation') {
        settleResearchJob(meta);
        return;
      }
      if (researchFetchJobIdRef.current === researchJobId) return;
      researchFetchJobIdRef.current = researchJobId;
      void (async () => {
        try {
          const res = await apiFetch(`/api/jobs/${researchJobId}`);
          if (!isCurrentOrigin(meta.origin)) return;
          const runId = await readResearchRunId(res, t);
          if (!isCurrentOrigin(meta.origin)) return;
          const run = await loadResearchRun(runId, meta.origin);
          if (!isCurrentOrigin(meta.origin)) return;
          setCandidateResult({ run, origin: meta.origin });
        } catch (error) {
          if (isCurrentOrigin(meta.origin)) {
            showResearchError(
              meta.source,
              error instanceof Error ? error.message : t('health.error.resultLoad'),
            );
          }
        } finally {
          if (researchJobMetaRef.current?.jobId === researchJobId) {
            settleResearchJob(meta);
          } else if (researchFetchJobIdRef.current === researchJobId) {
            researchFetchJobIdRef.current = null;
          }
        }
      })();
    } else if (researchStatus === 'failed') {
      const wasCancelled = researchEvents.some((event) => event.type === 'job:cancelled');
      if (!wasCancelled) {
        showResearchError(meta.source, 'Research failed — see job details for the underlying error.');
      }
      settleResearchJob(meta);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchStatus, researchEvents]);

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
          queryClient.invalidateQueries({
            queryKey: ['research-backlog', result.origin.subjectId],
          });
          invalidateWorkflowLifecycle(result.origin);
          return;
        }
      } catch (error) {
        if (!cancelled && isCurrentOrigin(result.origin)) {
          showResearchError(
            result.run.origin === 'findings' ? 'remediation' : 'manual',
            error instanceof Error ? error.message : t('health.error.runRefresh'),
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

  /**
   * 行内审批入口：plan 已带 runId，直接读 run，不必再经 `GET /api/jobs/:id`。
   * 只打开弹窗，不动 action gate——研究是否仍在跑由 job/快照决定，与「看候选」无关。
   */
  function openResearchRun(runId: string): void {
    const origin = captureOrigin();
    if (!isCurrentOrigin(origin) || origin.scope !== 'subject') return;
    void (async () => {
      try {
        const run = await loadResearchRun(runId, origin);
        if (!isCurrentOrigin(origin)) return;
        setCandidateResult({ run, origin });
      } catch (error) {
        if (!isCurrentOrigin(origin)) return;
        setRemediationError(
          error instanceof Error ? error.message : t('health.error.resultLoad'),
        );
      }
    })();
  }

  async function loadResearchRun(runId: string, origin: HealthOrigin): Promise<ResearchRunView> {
    const response = await apiFetch(
      `/api/research-runs/${encodeURIComponent(runId)}?subjectId=${encodeURIComponent(origin.subjectId)}`,
    );
    return readResearchRun(response, t);
  }

  async function startResearch(topic: string, source: Exclude<ResearchOrigin, 'remediation'>): Promise<string | null> {
    const origin = captureOrigin();
    if (
      !isCurrentOrigin(origin)
      || origin.scope !== 'subject'
      || !acquireAction('research', origin, BATCH_TARGET)
    ) {
      return null;
    }
    setResearchError(null);
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
        const meta = { jobId: json.jobId, origin, source, target: BATCH_TARGET };
        researchJobMetaRef.current = meta;
        actionJobMetaRef.current.research = meta;
        setObservedTargets((current) => ({ ...current, research: BATCH_TARGET }));
        resetResearchStream();
        setResearchJobId(json.jobId);
        await queryClient.invalidateQueries({
          queryKey: ['health-active-jobs', origin.subjectId],
        });
        return json.jobId;
      } else {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (!isCurrentOrigin(origin)) return null;
        setResearchError(json.error ?? t('health.error.researchStatus', { status: res.status }));
      }
    } catch {
      if (isCurrentOrigin(origin)) setResearchError(t('health.error.researchRetry'));
    } finally {
      // 提交窗口结束即释放：之后的禁用/Stop 全由服务端在途 job 派生。
      releaseAction('research', origin, BATCH_TARGET);
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
    // 逐条点击以 finding 为 target，工具栏批量用哨兵——两者互不占用。
    const target = actingFindingId ?? BATCH_TARGET;
    if (!isCurrentOrigin(origin) || !acquireAction(action, origin, target)) return;

    setRemediationError(null);
    if (action === 'fix') {
      setFixSummary(null);
      setFixPostcondition(null);
    } else if (action === 'curate') {
      setCuratePostcondition(null);
    }

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
        setRemediationError(t('health.error.snapshotChanged'));
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        if (!isCurrentOrigin(origin)) return;
        setRemediationError(payload.error ?? t('health.error.remediationStatus', { status: response.status }));
        return;
      }

      const { jobIds } = await response.json() as {
        jobIds?: unknown;
        deduplicated?: boolean;
      };
      // Research 按主题拆分后返回多个 job；其余动作恒为一个。
      const remediationJobIds = Array.isArray(jobIds)
        ? jobIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        : [];
      const remediationJobId = remediationJobIds[0];
      if (!isCurrentOrigin(origin) || !remediationJobId) return;

      // 该 action 已有观察头时不抢流：新 job 会由恢复 effect 在队首轮到它时接管，
      // 否则先点的那个任务会失去进度事件。
      if (!actionJobMetaRef.current[action]) {
        const meta = { jobId: remediationJobId, origin, target };
        actionJobMetaRef.current[action] = meta;
        setObservedTargets((current) => ({ ...current, [action]: target }));
        switch (action) {
          case 'fix':
            resetFixStream();
            setFixJobId(remediationJobId);
            break;
          case 'curate':
            resetCurateStream();
            setCurateJobId(remediationJobId);
            break;
          case 'research':
            researchFetchJobIdRef.current = null;
            researchQueueRef.current = remediationJobIds.slice(1);
            researchJobMetaRef.current = { ...meta, source: 'remediation' };
            resetResearchStream();
            setResearchJobId(remediationJobId);
            break;
          case 're-ingest':
            resetReingestStream();
            setReingestJobId(remediationJobId);
            break;
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['lint-latest', origin.subjectId] });
      // 等 active jobs 落地后才松开提交窗口锁：此后该行的禁用由服务端在途 job 派生，
      // 中间没有「锁已放、事实还没到」的空窗。
      await queryClient.invalidateQueries({
        queryKey: ['health-active-jobs', origin.subjectId],
      });
    } catch {
      if (isCurrentOrigin(origin)) setRemediationError(t('health.error.remediationRetry'));
    } finally {
      releaseAction(action, origin, target);
    }
  }

  async function cancelHealthAction(
    action: Extract<ExecutableRemediationAction, 'fix' | 'curate' | 'research' | 're-ingest'>,
    jobIdToCancel: string,
    target: string,
  ) {
    const meta = actionJobMetaRef.current[action];
    const origin = meta?.jobId === jobIdToCancel ? meta.origin : captureOrigin();
    if (
      !isCurrentOrigin(origin)
      || cancellingTargetsRef.current.has(targetKey(action, target))
    ) return;

    setRemediationError(null);
    setActionCancelling(action, target, true);
    // Research 批量是整批：先清队列再取消，避免 head 终态时又接着观察已取消的主题。
    // 逐条 Research（target 是 finding）只取消它自己那一个。
    const wholeBatch = action === 'research' && target === BATCH_TARGET;
    const queued = wholeBatch ? researchQueueRef.current : [];
    if (wholeBatch) researchQueueRef.current = [];
    let accepted = false;
    try {
      const results = await Promise.allSettled(
        [jobIdToCancel, ...queued].map((id) => requestHealthJobCancel(id, apiFetch, t)),
      );
      const failure = results.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      accepted = true;
      if (isCurrentOrigin(origin)) invalidateWorkflowLifecycle(origin);
    } catch (error) {
      if (isCurrentOrigin(origin)) {
        setRemediationError(
          error instanceof Error ? error.message : t('health.error.cancelRetry'),
        );
      }
    } finally {
      if (!accepted && isCurrentOrigin(origin)) setActionCancelling(action, target, false);
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
        const run = await readResearchRun(res, t);
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
          t('health.error.approvalStatus', { status: res.status }),
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
              t('health.error.approvalUncertain'),
            );
          }
        }
      } catch {
        if (isCurrentOrigin(result.origin)) {
          showResearchError(
            result.run.origin === 'findings' ? 'remediation' : 'manual',
            error instanceof Error ? error.message : t('health.error.approval'),
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
      const run = await readResearchRun(response, t);
      if (!isCurrentOrigin(result.origin)) return;
      setCandidateResult({ run, origin: result.origin });
      invalidateWorkflowLifecycle(result.origin);
    } catch (error) {
      if (isCurrentOrigin(result.origin)) {
        showResearchError(
          result.run.origin === 'findings' ? 'remediation' : 'manual',
          error instanceof Error ? error.message : t('health.error.dismiss'),
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
      const run = await readResearchRun(response, t);
      if (!isCurrentOrigin(result.origin)) return;
      setCandidateResult({ run, origin: result.origin });
      invalidateWorkflowLifecycle(result.origin);
    } catch (error) {
      if (isCurrentOrigin(result.origin)) {
        showResearchError(
          result.run.origin === 'findings' ? 'remediation' : 'manual',
          error instanceof Error ? error.message : t('health.error.retry'),
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

  async function reselectResearchCandidates() {
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
        `/api/research-runs/${encodeURIComponent(result.run.id)}/reselect`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subjectId: result.run.subjectId,
            expectedVersion: result.run.version,
          }),
        },
      );
      const run = await readResearchRun(response, t);
      if (!isCurrentOrigin(result.origin)) return;
      researchApprovalAttemptRef.current = null;
      setCandidateResult({ run, origin: result.origin });
      invalidateWorkflowLifecycle(result.origin);
    } catch (error) {
      if (isCurrentOrigin(result.origin)) {
        showResearchError(
          result.run.origin === 'findings' ? 'remediation' : 'manual',
          error instanceof Error ? error.message : t('health.error.reselect'),
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
    setRemediationError(null);
    try {
      const res = await apiFetch(
        `/api/sources/${sourceId}?subjectId=${encodeURIComponent(origin.subjectId)}`,
        { method: 'DELETE' },
      );
      const result = await readDeleteSourceResult(res, t);
      if (isCurrentOrigin(origin)) {
        setHandledSourceIds((prev) => new Set(prev).add(sourceId));
        void queryClient.invalidateQueries({ queryKey: ['sources'] });
        void queryClient.invalidateQueries({
          queryKey: ['lint-latest', origin.subjectId],
        });
        if (result === 'deleted') void runLint(origin);
      }
    } catch (error) {
      if (isCurrentOrigin(origin)) {
        setRemediationError(
          error instanceof Error ? error.message : t('health.error.deleteSource'),
        );
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
    setSubmittingTargets(new Set());
    cancellingTargetsRef.current.clear();
    setCancellingTargets(new Set());
    setObservedTargets({});
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
  // 批量范围＝当前可见列表：类型筛选生效时不把筛掉的条目一起提交，计数也随之变化。
  const fixFindingIds = data ? actionFindingIds(data, 'fix', visibleFindings) : [];
  const curateFindingIds = data ? actionFindingIds(data, 'curate', visibleFindings) : [];
  const researchFindingIds = data ? actionFindingIds(data, 'research', visibleFindings) : [];
  // 一个主题一个 job 且 worker 串行执行，一次只提交前 N 条（快照已按严重度排序）。
  const researchBatchIds = researchFindingIds.slice(0, MAX_RESEARCH_BATCH_JOBS);
  const researchDeferredCount = researchFindingIds.length - researchBatchIds.length;
  /**
   * 工具栏批量按钮的状态**只看自己那一批**（`BATCH_TARGET`）。
   *
   * 逐条行点出来的 job 不会让它变 starting/running，也不会禁用它——那正是这次修掉的
   * 整类阻塞。行内 job 的进度仍在下方活动文案里体现（`curating`/`fixing`/`researching`）。
   */
  function batchState(
    action: ExecutableRemediationAction,
    observedJobId: string | null,
  ): HealthActionButtonState {
    const mine = observedTargets[action] === BATCH_TARGET;
    const busy = submittingTargets.has(targetKey(action, BATCH_TARGET)) || mine;
    return healthActionButtonState(
      busy,
      mine ? observedJobId : null,
      cancellingTargets.has(targetKey(action, BATCH_TARGET)),
    );
  }
  /** 批量按钮 idle 态的禁用集：hydration 未就绪，或自己那一批已在途。 */
  const batchBusyActions = useMemo(() => {
    const set = new Set<ExecutableRemediationAction>(hydrationBusyActions);
    for (const action of EXECUTABLE_ACTIONS) {
      if (
        submittingTargets.has(targetKey(action, BATCH_TARGET))
        || observedTargets[action] === BATCH_TARGET
      ) set.add(action);
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrationBusyActions, submittingTargets, observedTargets]);
  const curateButtonState = batchState('curate', curateJobId);
  const fixButtonState = batchState('fix', fixJobId);
  const researchButtonState = batchState('research', researchJobId);
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
    running ? latestMessage || t('health.activity.check') : null,
    researching ? t('health.activity.research') : null,
    curating ? curateMessage || t('health.activity.curate') : null,
    fixing ? fixMessage || t('health.activity.fix') : null,
  ].filter((message): message is string => message !== null);

  return (
    <WorkspacePage>
      <WorkspacePageHeader
        icon={<Activity className="h-5 w-5 text-foreground-tertiary" aria-hidden />}
        title={t('health.title')}
        description={(
          <span className="block truncate">
            {allSubjects ? t('health.scope.all') : subjectSlug}
            <span className="text-foreground-tertiary">
              {data?.ranAt
                ? ` · ${t('health.checkedAt', {
                    time: formatDate(data.ranAt, { dateStyle: 'medium', timeStyle: 'short' }),
                  })}`
                : ` · ${t('health.notChecked')}`}
            </span>
          </span>
        )}
        actions={<div className="flex flex-wrap items-center gap-2">
          <div
            role="radiogroup"
            aria-label={t('health.scope')}
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
              {t('health.scope.subject')}
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
              {t('health.scope.all')}
            </button>
          </div>
          <Button intent="primary" onClick={() => void runLint()} loading={running}>
            {!running && <RefreshCw className="h-3.5 w-3.5" />}
            {neverRun ? t('health.runCheck') : t('health.runAgain')}
          </Button>
        </div>}
      />

      <WorkspaceSummary
        aria-label={t('health.summary')}
        className="grid-cols-2 sm:grid-cols-4 lg:grid-cols-[1.15fr_repeat(3,0.85fr)_1.5fr]"
      >
        <WorkspaceMetric
          label={t('health.openFindings')}
          value={total}
          className="border-b border-r border-border-subtle sm:border-b-0"
        />
        <WorkspaceMetric
          label={t('health.metric.critical')}
          value={data?.bySeverity.critical ?? 0}
          tone="danger"
          className="border-b border-border-subtle sm:border-b-0 sm:border-r"
        />
        <WorkspaceMetric
          label={t('health.metric.warning')}
          value={data?.bySeverity.warning ?? 0}
          tone="warning"
          className="border-r border-border-subtle sm:border-r-0 lg:border-r"
        />
        <WorkspaceMetric
          label={t('health.metric.info')}
          value={data?.bySeverity.info ?? 0}
          className="sm:border-r lg:border-r"
        />
        <WorkspaceMetric
          label={t('health.metric.recent')}
          value={recentTerminalCount}
          className="col-span-2 border-t border-border-subtle sm:col-span-4 lg:col-span-1 lg:border-t-0"
          detail={recentTerminalCount > 0 ? (
            <span className="flex flex-wrap gap-x-3 gap-y-1">
              <span><strong className="text-success">{recentOutcomeSummary.fixed}</strong> {t('health.fixed')}</span>
              <span><strong className="text-danger">{recentOutcomeSummary.failed}</strong> {t('health.failed')}</span>
              <span><strong className="text-foreground-secondary">{recentOutcomeSummary.skipped}</strong> {t('health.skipped')}</span>
            </span>
          ) : t('health.noRecentResults')}
        />
      </WorkspaceSummary>

      <WorkspaceToolbar aria-label={t('health.controls')}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <ListFilter className="h-3.5 w-3.5 text-foreground-tertiary" aria-hidden />
            <Select
              aria-label={t('health.filterType')}
              value={typeFilter ?? ''}
              onChange={(event) => {
                setTypeFilter(event.target.value
                  ? event.target.value as LintFinding['type']
                  : null);
              }}
              className="min-w-[170px]"
            >
              <option value="">{t('health.allTypes')}</option>
              {presentTypes.map((type) => (
                <option key={type} value={type}>{t(findingTypeLabel(type))}</option>
              ))}
            </Select>
            {typeFilter && (
              <span className="text-xs text-foreground-tertiary">
                {t('health.visibleCount', { visible: visibleFindings.length, total })}
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
                {t('health.customResearch')}
                <ChevronDown
                  className={'h-3.5 w-3.5 transition-transform ' + (researchComposerOpen ? 'rotate-180' : '')}
                />
              </Button>
              <span className="hidden h-5 w-px bg-border lg:block" aria-hidden />
              <Button
                intent={curateButtonState === 'running' || curateButtonState === 'cancelling' ? 'danger' : 'outline'}
                onClick={() => curateJobId && curateButtonState !== 'idle'
                  ? void cancelHealthAction('curate', curateJobId, BATCH_TARGET)
                  : void runRemediation('curate', curateFindingIds)}
                loading={curateButtonState === 'starting' || curateButtonState === 'cancelling'}
                disabled={curateButtonState === 'idle' && remediationButtonDisabled({
                  neverRun,
                  targetCount: curateFindingIds.length,
                  action: 'curate',
                  busyActions: batchBusyActions,
                  lintRunning: running,
                })}
                title={curateButtonState === 'idle' ? t('health.curate') : t('jobs.stop')}
              >
                {curateButtonState === 'running' && <Square className="h-3.5 w-3.5" />}
                {curateButtonState === 'idle' && <Wand2 className="h-3.5 w-3.5" />}
                {curateButtonState === 'idle'
                  ? <>{t('health.action.tidy')} {curateFindingIds.length > 0 && `(${curateFindingIds.length})`}</>
                  : t('jobs.stop')}
              </Button>
              <Button
                intent={fixButtonState === 'running' || fixButtonState === 'cancelling' ? 'danger' : 'outline'}
                onClick={() => fixJobId && fixButtonState !== 'idle'
                  ? void cancelHealthAction('fix', fixJobId, BATCH_TARGET)
                  : void runRemediation('fix', fixFindingIds)}
                loading={fixButtonState === 'starting' || fixButtonState === 'cancelling'}
                disabled={fixButtonState === 'idle' && remediationButtonDisabled({
                  neverRun,
                  targetCount: fixFindingIds.length,
                  action: 'fix',
                  busyActions: batchBusyActions,
                  lintRunning: running,
                })}
                title={fixButtonState === 'idle' ? t('health.fix') : t('jobs.stop')}
              >
                {fixButtonState === 'running' && <Square className="h-3.5 w-3.5" />}
                {fixButtonState === 'idle' && <Wrench className="h-3.5 w-3.5" />}
                {fixButtonState === 'idle'
                  ? <>{t('health.action.fix')} {fixFindingIds.length > 0 && `(${fixFindingIds.length})`}</>
                  : t('jobs.stop')}
              </Button>
              <Button
                intent={researchButtonState === 'running' || researchButtonState === 'cancelling' ? 'danger' : 'outline'}
                onClick={() => researchJobId && researchButtonState !== 'idle'
                  ? void cancelHealthAction('research', researchJobId, BATCH_TARGET)
                  : void runRemediation('research', researchBatchIds)}
                loading={researchButtonState === 'starting' || researchButtonState === 'cancelling'}
                disabled={researchButtonState === 'idle' && remediationButtonDisabled({
                  neverRun,
                  targetCount: researchBatchIds.length,
                  action: 'research',
                  busyActions: batchBusyActions,
                  lintRunning: running,
                })}
                title={researchButtonState !== 'idle'
                  ? t('jobs.stop')
                  : researchDeferredCount > 0
                    ? t('health.research.batchLimit', {
                        batch: researchBatchIds.length,
                        remaining: researchDeferredCount,
                      })
                    : t('health.research')}
              >
                {researchButtonState === 'running' && <Square className="h-3.5 w-3.5" />}
                {researchButtonState === 'idle' && <Search className="h-3.5 w-3.5" />}
                {researchButtonState === 'idle'
                  ? <>
                      {t('health.action.research')}
                      {researchBatchIds.length > 0 && (
                        researchDeferredCount > 0
                          ? ` (${researchBatchIds.length} / ${researchFindingIds.length})`
                          : ` (${researchBatchIds.length})`
                      )}
                    </>
                  : t('jobs.stop')}
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
              if (batchBusyActions.has('research')) return;
              const topic = topicInput.trim();
              if (!topic) return;
              void startResearch(topic, 'manual');
              setTopicInput('');
            }}
          >
            <Input
              value={topicInput}
              onChange={(event) => setTopicInput(event.target.value)}
              placeholder={t('health.topicPlaceholder')}
              aria-label={t('health.researchTopic')}
              className="max-w-md"
            />
            <Button
              intent="secondary"
              type="submit"
              loading={researching}
              disabled={batchBusyActions.has('research') || !topicInput.trim()}
            >
              {!researching && <Search className="h-3.5 w-3.5" />}
              {t('health.action.startResearch')}
            </Button>
          </form>
        )}
      </WorkspaceToolbar>

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
            <span>{t('health.restoreError')}</span>
            <Button
              intent="secondary"
              size="sm"
              loading={activeJobsFetching}
              onClick={() => void refetchActiveJobs()}
            >
              {t('common.retry')}
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
            {t('health.semanticIncomplete')}
          </div>
        )}
        {fixSummary && (
          <div className="border-l-2 border-accent bg-accent-subtle px-3 py-2 text-sm text-accent-strong">
            {fixSummary.fixed + fixSummary.failed + fixSummary.skipped > 0
              ? t('health.fixSummary', fixSummary)
              : t('health.fixSummaryUnavailable')}
          </div>
        )}
        {curatePostcondition && (
          <PostconditionBanner labelKey="health.postcondition.tidy" report={curatePostcondition} />
        )}
        {fixPostcondition && (
          <PostconditionBanner labelKey="health.postcondition.fix" report={fixPostcondition} />
        )}
      </div>

      {candidateResult && (
        <ResearchCandidatesDialog
          run={candidateResult.run}
          onClose={() => setCandidateResult(null)}
          onApprove={approveResearchCandidates}
          onDismiss={dismissResearchCandidates}
          onRetry={retryResearchCandidates}
          onReselect={reselectResearchCandidates}
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
          <WorkspaceState
            icon={<Activity className="h-6 w-6 text-foreground-tertiary" aria-hidden />}
            title={t('health.empty.title')}
            description={t('health.empty.description')}
            action={<Button intent="primary" onClick={() => void runLint()} loading={running}>{t('health.runCheck')}</Button>}
          />
        ) : total === 0 ? (
          <WorkspaceState
            icon={<CheckCircle2 className="h-6 w-6 text-success" aria-hidden />}
            title={t('health.noFindings.title')}
            description={t('health.noFindings.description')}
          />
        ) : (
          <div>
            <div className="mb-3 flex items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">{t('health.openFindings')}</h2>
                <p className="mt-0.5 text-xs text-foreground-tertiary">
                  {t('health.findingsOrder')}
                </p>
              </div>
              <span className="text-xs text-foreground-tertiary">
                {t('health.showing', { visible: visibleFindings.length, total })}
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
                        {t(`health.severity.${group.severity}` as MessageKey)}
                      </h3>
                      <span className="text-xs text-foreground-tertiary">{group.findings.length}</span>
                    </div>
                    <div className="divide-y divide-border-subtle border-y border-border-subtle bg-surface">
                      {group.findings.map((finding) => {
                        const plan = data?.remediations[finding.id];
                        // 提交中（POST 未回）→ 本行该动作转 loading。
                        const actingActions = new Set(
                          EXECUTABLE_ACTIONS.filter(
                            (action) => submittingTargets.has(targetKey(action, finding.id)),
                          ),
                        );
                        // 禁用只看本行：被在途 job 覆盖，或 hydration 未就绪，或正在提交。
                        const rowDisabled = new Set(
                          EXECUTABLE_ACTIONS.filter((action) => rowActionDisabled({
                            findingId: finding.id,
                            action,
                            coveredIds: coveredByAction.get(action) ?? EMPTY_COVERED,
                            hydrationBusy: hydrationBusyActions,
                          }) || submittingTargets.has(targetKey(action, finding.id))),
                        );
                        // 本行是否有在途 job（含 pending，排队中也要能 Stop）。
                        const rowRunning = allSubjects ? undefined : (() => {
                          for (const item of plan?.actions ?? []) {
                            if (item.type === 'review-source') continue;
                            const found = findFindingJob(activeJobs, item.type, finding.id);
                            if (!found) continue;
                            return {
                              type: item.type,
                              jobId: found.jobId,
                              cancelling: cancellingTargets.has(
                                targetKey(item.type, finding.id),
                              ),
                            };
                          }
                          return undefined;
                        })();
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
                            disabledActions={rowDisabled}
                            runningAction={rowRunning}
                            onStop={!allSubjects && rowRunning ? (jobIdToCancel) => {
                              void cancelHealthAction(
                                rowRunning.type,
                                jobIdToCancel,
                                finding.id,
                              );
                            } : undefined}
                            onAction={!allSubjects ? (action) => {
                              if (action.type !== 'review-source') {
                                void runRemediation(action.type, [finding.id], finding.id);
                              }
                            } : undefined}
                            onReviewRun={!allSubjects ? openResearchRun : undefined}
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
            researchBusy={batchBusyActions.has('research')}
            onResearch={(topic) => startResearch(topic, 'backlog')}
          />
        </div>
      )}
    </WorkspacePage>
  );
}
