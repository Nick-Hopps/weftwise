'use client';

import { useEffect, useMemo, useState } from 'react';
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
import type { LintFinding, ResearchCandidate } from '@/lib/contracts';

type Scope = 'subject' | 'all';

export function HealthView() {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();

  const [scope, setScope] = useState<Scope>('subject');
  const allSubjects = scope === 'all';

  const { data, isLoading } = useLintSummary(allSubjects);

  const [jobId, setJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [semanticErrored, setSemanticErrored] = useState(false);
  const { status: streamStatus, events, latestMessage } = useJobStream(jobId);

  // 体检完成 → 记录语义阶段是否报错 → 失效缓存重取
  useEffect(() => {
    if (streamStatus === 'completed') {
      setSemanticErrored(events.some((e) => e.type === 'lint:semantic:error'));
      queryClient.invalidateQueries({ queryKey: ['lint-latest', allSubjects ? 'all' : subjectId] });
      setJobId(null);
    } else if (streamStatus === 'failed') {
      setJobId(null);
    }
  }, [streamStatus, events, queryClient, allSubjects, subjectId]);

  const running = starting || (jobId !== null && streamStatus !== 'completed' && streamStatus !== 'failed');

  async function runLint() {
    setStarting(true);
    setSemanticErrored(false);
    try {
      const res = await apiFetch('/api/lint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(allSubjects ? { allSubjects: true } : { subjectId }),
      });
      if (res.ok) {
        const json = (await res.json()) as { jobId: string };
        setJobId(json.jobId);
      }
    } finally {
      setStarting(false);
    }
  }

  const [curateJobId, setCurateJobId] = useState<string | null>(null);
  const [curateStarting, setCurateStarting] = useState(false);
  const { status: curateStatus, latestMessage: curateMessage } = useJobStream(curateJobId);
  const curating = curateStarting || (curateJobId !== null && curateStatus !== 'completed' && curateStatus !== 'failed');

  const [fixJobId, setFixJobId] = useState<string | null>(null);
  const [fixStarting, setFixStarting] = useState(false);
  const [fixSummary, setFixSummary] = useState<{ fixed: number; skipped: number; failed: number } | null>(null);
  const { status: fixStatus, events: fixEvents, latestMessage: fixMessage } = useJobStream(fixJobId);
  const fixing = fixStarting || (fixJobId !== null && fixStatus !== 'completed' && fixStatus !== 'failed');

  useEffect(() => {
    if (curateStatus === 'completed') {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['lint-latest', allSubjects ? 'all' : subjectId] });
      setCurateJobId(null);
    } else if (curateStatus === 'failed') {
      setCurateJobId(null);
    }
  }, [curateStatus, queryClient, allSubjects, subjectId]);

  useEffect(() => {
    if (fixStatus === 'completed') {
      const done = [...fixEvents].reverse().find((e) => e.type === 'fix:complete');
      const d = done?.data as { fixed?: number; skipped?: number; failed?: number } | undefined;
      setFixSummary({ fixed: d?.fixed ?? 0, skipped: d?.skipped ?? 0, failed: d?.failed ?? 0 });
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['lint-latest', allSubjects ? 'all' : subjectId] });
      setFixJobId(null);
      // 闭环：修复后自动重跑体检刷新 findings
      void runLint();
    } else if (fixStatus === 'failed') {
      setFixJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixStatus, fixEvents, queryClient, allSubjects, subjectId]);

  const [reingestJobId, setReingestJobId] = useState<string | null>(null);
  const { status: reingestStatus } = useJobStream(reingestJobId);

  // Retry ingest 完成 → 自动重跑体检刷新 findings（与 Fix 闭环一致）；失败则仅停止追踪
  useEffect(() => {
    if (reingestStatus === 'completed') {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      setReingestJobId(null);
      void runLint();
    } else if (reingestStatus === 'failed') {
      setReingestJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reingestStatus, queryClient]);

  async function runCurate() {
    setCurateStarting(true);
    try {
      const res = await apiFetch('/api/curate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
      if (res.ok) {
        const json = (await res.json()) as { jobId: string };
        setCurateJobId(json.jobId);
      }
    } finally {
      setCurateStarting(false);
    }
  }

  async function runFix() {
    setFixStarting(true);
    setFixSummary(null);
    try {
      const res = await apiFetch('/api/fix', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
      if (res.ok) {
        const json = (await res.json()) as { jobId: string };
        setFixJobId(json.jobId);
      }
    } finally {
      setFixStarting(false);
    }
  }

  // ── Research：缺口/主题 → 联网检索候选清单（只发现不写入） ─────────────────
  const [researchJobId, setResearchJobId] = useState<string | null>(null);
  const [researchStarting, setResearchStarting] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<ResearchCandidate[] | null>(null);
  const [topicInput, setTopicInput] = useState('');
  const [ingesting, setIngesting] = useState(false);
  const { status: researchStatus } = useJobStream(researchJobId);
  const researching = researchStarting || (researchJobId !== null && researchStatus !== 'completed' && researchStatus !== 'failed');

  useEffect(() => {
    if (researchStatus === 'completed' && researchJobId) {
      (async () => {
        const res = await apiFetch(`/api/jobs/${researchJobId}`);
        if (res.ok) {
          const json = (await res.json()) as { resultJson?: string | null };
          try {
            const parsed = json.resultJson ? (JSON.parse(json.resultJson) as { candidates?: ResearchCandidate[] }) : null;
            setCandidates(parsed?.candidates ?? []);
          } catch {
            setCandidates([]);
          }
        }
        setResearchJobId(null);
      })();
    } else if (researchStatus === 'failed') {
      setResearchError('Research failed — see job details for the underlying error.');
      setResearchJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [researchStatus, researchJobId]);

  async function startResearch(body: { gapIds?: string[]; topic?: string }) {
    setResearchStarting(true);
    setResearchError(null);
    try {
      const res = await apiFetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const json = (await res.json()) as { jobId: string };
        setResearchJobId(json.jobId);
      } else {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setResearchError(json.error ?? `Research request failed (${res.status})`);
      }
    } finally {
      setResearchStarting(false);
    }
  }

  async function confirmIngest(urls: string[]) {
    setIngesting(true);
    try {
      const res = await apiFetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls, subjectId }),
      });
      if (res.ok || res.status === 202) {
        setCandidates(null);
        queryClient.invalidateQueries({ queryKey: ['pages'] });
      }
    } finally {
      setIngesting(false);
    }
  }

  async function reingestSource(sourceId: string) {
    setSourceActing(sourceId);
    try {
      const res = await apiFetch(`/api/sources/${sourceId}/reingest`, { method: 'POST' });
      if (res.status === 202) {
        // 新 job 会出现在全局 JobsPanel；本行标记已处置并本地隐藏；同时本地追踪完成后自动重跑体检
        const json = (await res.json()) as { jobId: string };
        setReingestJobId(json.jobId);
        setHandledSourceIds((prev) => new Set(prev).add(sourceId));
      }
    } finally {
      setSourceActing(null);
    }
  }

  async function deleteSource(sourceId: string) {
    setSourceActing(sourceId);
    try {
      const res = await apiFetch(`/api/sources/${sourceId}`, { method: 'DELETE' });
      if (res.ok) {
        setHandledSourceIds((prev) => new Set(prev).add(sourceId));
        queryClient.invalidateQueries({ queryKey: ['sources'] });
      }
    } finally {
      setSourceActing(null);
    }
  }

  function switchScope(next: Scope) {
    setScope(next);
    setJobId(null);
    setSemanticErrored(false);
    setCurateJobId(null);
    setFixJobId(null);
    setFixSummary(null);
    setResearchJobId(null);
    setCandidates(null);
    setResearchError(null);
    setHandledSourceIds(new Set());
    setSourceActing(null);
    setReingestJobId(null);
  }

  const [typeFilter, setTypeFilter] = useState<LintFinding['type'] | null>(null);
  useEffect(() => setTypeFilter(null), [scope]);

  // orphan-source 行内动作：处置成功后本地隐藏该行（快照要等下次 lint 才刷新）
  const [handledSourceIds, setHandledSourceIds] = useState<Set<string>>(new Set());
  const [sourceActing, setSourceActing] = useState<string | null>(null);

  const allFindings = data?.findings ?? [];
  // ⚠️ 已处置的 orphan-source 行过滤只能放在这一层——allFindings 的数组下标是
  // coverageGapIds 的 gapId，服务端按最近快照同序校验，动 allFindings 会导致下标漂移
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

  const FIXABLE_TYPES: LintFinding['type'][] = ['missing-frontmatter', 'broken-link', 'missing-crossref', 'contradiction'];
  const fixableCount = allFindings.filter((f) => FIXABLE_TYPES.includes(f.type)).length;

  // gapId = 该 finding 在最近快照 findings 数组里的下标（服务端 selectLatestFindings 同一顺序），
  // 由 POST /api/research 重新读取快照校验存在——见 research-service.ts::resolveTopicsFromGapIds。
  const coverageGapIds = allFindings
    .map((f, i) => (f.type === 'coverage-gap' ? String(i) : null))
    .filter((id): id is string => id !== null);

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
          <Button intent="primary" onClick={runLint} loading={running}>
            {/* loading 时 Button 自带 spinner，隐藏本图标避免双图标 */}
            {!running && <RefreshCw className="h-3.5 w-3.5" />}
            {neverRun ? 'Run health check' : 'Re-run'}
          </Button>
          <Button intent="secondary" onClick={runCurate} loading={curating} disabled={allSubjects}>
            {!curating && <Wand2 className="h-3.5 w-3.5" />}
            Tidy structure
          </Button>
          <Button
            intent="secondary"
            onClick={runFix}
            loading={fixing}
            disabled={allSubjects || neverRun || fixableCount === 0 || running || curating}
          >
            {!fixing && <Wrench className="h-3.5 w-3.5" />}
            Fix issues
          </Button>
          <Button
            intent="secondary"
            onClick={() => startResearch({ gapIds: coverageGapIds })}
            loading={researching}
            disabled={allSubjects || coverageGapIds.length === 0}
          >
            {!researching && <Search className="h-3.5 w-3.5" />}
            Research gaps{coverageGapIds.length > 0 ? ` (${coverageGapIds.length})` : ''}
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
            void startResearch({ topic: t });
            setTopicInput('');
          }}
        >
          <Input
            value={topicInput}
            onChange={(e) => setTopicInput(e.target.value)}
            placeholder="Research a topic…"
            className="max-w-xs"
          />
          <Button intent="secondary" type="submit" loading={researching} disabled={!topicInput.trim()}>
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

      {candidates && (
        <ResearchCandidatesDialog
          candidates={candidates}
          onClose={() => setCandidates(null)}
          onConfirm={confirmIngest}
          confirming={ingesting}
        />
      )}

      {!allSubjects && <ResearchBacklogSection onResearchStarted={setResearchJobId} />}

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
          <Button intent="primary" className="mt-3" onClick={runLint} loading={running}>
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
                  {group.findings.map((f, i) => {
                    const gapId = f.type === 'coverage-gap' ? String(allFindings.indexOf(f)) : null;
                    // thin-page：复用 topic research（以页 slug 为主题），引导补内容
                    const onResearch =
                      gapId && !allSubjects
                        ? () => startResearch({ gapIds: [gapId] })
                        : f.type === 'thin-page' && !allSubjects
                          ? () => startResearch({ topic: f.pageSlug })
                          : undefined;
                    return (
                      <FindingRow
                        key={`${f.subjectId}:${f.type}:${f.pageSlug}:${i}`}
                        finding={f}
                        showSubject={allSubjects}
                        onResearch={onResearch}
                        researching={researching}
                        onReingestSource={
                          f.type === 'orphan-source' && f.sourceId && !allSubjects
                            ? () => reingestSource(f.sourceId!)
                            : undefined
                        }
                        onDeleteSource={
                          f.type === 'orphan-source' && f.sourceId && !allSubjects
                            ? () => deleteSource(f.sourceId!)
                            : undefined
                        }
                        sourceActing={f.type === 'orphan-source' && f.sourceId === sourceActing}
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
