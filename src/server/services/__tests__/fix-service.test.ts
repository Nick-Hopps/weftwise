import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  EnrichedLintFinding,
  Job,
  LintFinding,
  LintLatestResult,
  PostconditionReport,
  RemediationContext,
} from '@/lib/contracts';

vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));
const genMock = vi.hoisted(() => ({
  generateTextWithTools: vi.fn(async (_task: string, _opts: unknown) => ({ text: 'done' })),
}));
vi.mock('@/server/llm/provider-registry', () => genMock);
vi.mock('@/server/db/repos/subjects-repo', () => ({ getById: vi.fn(() => ({ id: 's1', slug: 'general', name: 'G', description: '' })) }));
const pagesMock = vi.hoisted(() => ({
  getAllPages: vi.fn(() => [{ slug: 'a', title: 'A', summary: '', tags: [] }, { slug: 'b', title: 'B', summary: '', tags: [] }]),
  getPageBySlug: vi.fn((_subjectId: string, slug: string) => ({ slug, title: slug.toUpperCase(), summary: '', tags: [] })),
  isMetaPage: vi.fn(() => false),
}));
vi.mock('@/server/db/repos/pages-repo', () => pagesMock);
vi.mock('@/server/wiki/wiki-store', () => ({
  readPageInSubject: vi.fn(() => ({ frontmatter: { title: 'A', created: '', updated: '', tags: [], sources: [] }, body: 'body' })),
}));
vi.mock('@/server/db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));
const embedMock = vi.hoisted(() => ({ enqueueEmbedIndex: vi.fn() }));
vi.mock('@/server/services/embedding-service', () => embedMock);
const searchMock = vi.hoisted(() => ({ hybridRankSlugs: vi.fn(async () => [] as string[]) }));
vi.mock('@/server/search/hybrid-retrieval', () => searchMock);
const pageOpsMock = vi.hoisted(() => ({
  executePageUpdate: vi.fn(async (_jobId: string, _subject: unknown, input: { slug: string }) => ({ updatedSlug: input.slug, referencesUpdated: 0 })),
  executePageCreate: vi.fn(async () => ({ createdSlug: 'x' })),
  executePagePatch: vi.fn(async (_jobId: string, _subject: unknown, input: { slug: string; edits: unknown[] }) => ({ updatedSlug: input.slug, appliedEdits: input.edits.length })),
}));
vi.mock('@/server/wiki/page-ops', () => pageOpsMock);
const txMock = vi.hoisted(() => ({
  createChangeset: vi.fn((id: string, s: { id: string; slug: string }, entries: unknown[]) => ({ id, subjectId: s.id, subjectSlug: s.slug, entries })),
  validateChangeset: vi.fn(() => ({ valid: true, errors: [] as string[], warnings: [] as string[] })),
  applyChangeset: vi.fn(async () => undefined),
}));
vi.mock('@/server/wiki/wiki-transaction', () => txMock);
const lintMock = vi.hoisted(() => ({ runDeterministicChecksForSubject: vi.fn(() => [] as LintFinding[]) }));
vi.mock('@/server/services/lint-deterministic', () => lintMock);
const latestMock = vi.hoisted(() => ({
  selectLatestFindings: vi.fn<(_jobs: Job[]) => LintLatestResult>(() => ({
    jobId: null,
    ranAt: null,
    bySeverity: { critical: 0, warning: 0, info: 0 },
    findings: [],
  })),
}));
vi.mock('@/server/services/lint-latest', () => latestMock);
const queueMock = vi.hoisted(() => ({
  list: vi.fn(() => [] as Job[]),
  get: vi.fn(() => null as Job | null),
  isCancelRequested: vi.fn(() => false),
}));
vi.mock('@/server/jobs/queue', () => queueMock);
const postconditionMock = vi.hoisted(() => ({ verifyJobPostconditions: vi.fn() }));
vi.mock('@/server/services/postcondition-service', () => postconditionMock);

import { runFixJob } from '../fix-service';
import { identifyFindings } from '../finding-identity';

function job(params: { subjectId?: string; remediationContext?: RemediationContext } = { subjectId: 's1' }): Job {
  return {
    id: 'j1',
    type: 'fix',
    status: 'running',
    subjectId: 's1',
    paramsJson: JSON.stringify(params),
    resultJson: null,
    createdAt: '2026-07-12T10:01:00.000Z',
    startedAt: '2026-07-12T10:01:00.000Z',
    completedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
  };
}

function jobWithParamsJson(
  paramsJson: string,
  subjectId: Job['subjectId'] = 's1',
): Job {
  return { ...job(), subjectId, paramsJson };
}

function lintJob(overrides: Partial<Job> = {}): Job {
  return {
    id: 'lint-1',
    type: 'lint',
    status: 'completed',
    subjectId: 's1',
    paramsJson: JSON.stringify({ subjectId: 's1' }),
    resultJson: JSON.stringify({ findings: [] }),
    createdAt: '2026-07-12T10:00:00.000Z',
    startedAt: '2026-07-12T10:00:00.000Z',
    completedAt: '2026-07-12T10:00:30.000Z',
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
    ...overrides,
  };
}

function finding(
  type: LintFinding['type'],
  pageSlug: string,
  description: string,
): LintFinding {
  return {
    type,
    severity: 'warning',
    pageSlug,
    description,
    suggestedFix: null,
  };
}

function identified(raw: LintFinding): EnrichedLintFinding {
  return identifyFindings([{
    ...raw,
    subjectId: 's1',
    subjectSlug: 'general',
  }])[0]!;
}

function snapshot(
  findings: EnrichedLintFinding[],
  overrides: Partial<LintLatestResult> = {},
): LintLatestResult {
  return {
    jobId: 'lint-1',
    ranAt: '2026-07-12T10:00:30.000Z',
    bySeverity: {
      critical: findings.filter((item) => item.severity === 'critical').length,
      warning: findings.filter((item) => item.severity === 'warning').length,
      info: findings.filter((item) => item.severity === 'info').length,
    },
    findings,
    ...overrides,
  };
}

function context(findingIds: string[], action: RemediationContext['action'] = 'fix'): RemediationContext {
  return { lintJobId: 'lint-1', findingIds, action };
}

function getFixPrompt(): string {
  const opts = genMock.generateTextWithTools.mock.calls[0]?.[1] as
    | { messages: Array<{ content: unknown }> }
    | undefined;
  return String(opts?.messages[0]?.content ?? '');
}

const cleanReport: PostconditionReport = {
  status: 'clean',
  checkedAt: '2026-07-12T08:00:00.000Z',
  scope: {
    jobId: 'j1',
    subjectId: 's1',
    createdSlugs: [],
    updatedSlugs: [],
    deletedSlugs: [],
    touchedSlugs: [],
    operationIds: [],
  },
  residualFindings: [],
  semanticStatus: 'not-needed',
  verificationError: null,
};

describe('runFixJob (tool-loop)', () => {
  beforeEach(() => {
    genMock.generateTextWithTools.mockReset();
    genMock.generateTextWithTools.mockResolvedValue({ text: 'done' });
    embedMock.enqueueEmbedIndex.mockClear();
    txMock.applyChangeset.mockClear();
    pageOpsMock.executePageUpdate.mockClear();
    pageOpsMock.executePageCreate.mockClear();
    pageOpsMock.executePagePatch.mockClear();
    searchMock.hybridRankSlugs.mockReset();
    searchMock.hybridRankSlugs.mockResolvedValue([]);
    lintMock.runDeterministicChecksForSubject.mockReset();
    lintMock.runDeterministicChecksForSubject.mockReturnValue([]);
    latestMock.selectLatestFindings.mockReset();
    latestMock.selectLatestFindings.mockReturnValue(snapshot([], { jobId: null, ranAt: null }));
    queueMock.list.mockReset();
    queueMock.list.mockReturnValue([]);
    queueMock.get.mockReset();
    queueMock.get.mockReturnValue(null);
    queueMock.isCancelRequested.mockReset();
    queueMock.isCancelRequested.mockReturnValue(false);
    postconditionMock.verifyJobPostconditions.mockReset();
    postconditionMock.verifyJobPostconditions.mockResolvedValue(cleanReport);
  });

  it('只有链接 finding 时使用 fix:links，提供页面与来源证据及 patch', async () => {
    lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([{ type: 'broken-link', severity: 'warning', pageSlug: 'a', description: '[[Ghost]] missing', suggestedFix: null }]);
    const emit = vi.fn();
    const res = await runFixJob(job(), emit);
    expect(genMock.generateTextWithTools).toHaveBeenCalledTimes(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = (genMock.generateTextWithTools.mock.calls as any[]);
    expect(calls[0][0]).toBe('fix');
    const opts = calls[0][1];
    const toolKeys = Object.keys(opts.tools);
    expect(toolKeys).toEqual(expect.arrayContaining([
      'wiki_read', 'wiki_search', 'wiki_inspect', 'source_search', 'source_read', 'wiki_patch',
    ]));
    expect(toolKeys).not.toContain('wiki_list');
    expect(toolKeys).not.toContain('wiki_update');
    expect(toolKeys).not.toContain('wiki_create');
    expect(emit).toHaveBeenCalledWith('fix:start', expect.any(String), expect.any(Object));
    expect(emit).toHaveBeenCalledWith('fix:complete', expect.any(String), expect.any(Object));
    expect(res).toMatchObject({
      writes: expect.any(Number),
      postconditionStatus: 'clean',
      postcondition: cleanReport,
    });
  });

  it('只有 missing-frontmatter → pre-pass 一个 commit，不调 LLM', async () => {
    lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([{ type: 'missing-frontmatter', severity: 'warning', pageSlug: 'a', description: 'missing title', suggestedFix: null }]);
    const emit = vi.fn();
    await runFixJob(job(), emit);
    expect(txMock.applyChangeset).toHaveBeenCalledOnce();
    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:deterministic', expect.any(String), expect.any(Object));
    expect(emit).toHaveBeenCalledWith('fix:complete', expect.any(String), expect.any(Object));
    expect(embedMock.enqueueEmbedIndex).toHaveBeenCalled();
  });

  it('含 contradiction 时使用 fix:contradiction，额外提供 wiki_update', async () => {
    const contradiction = identified(finding('contradiction', 'a', 'A 与 B 冲突'));
    latestMock.selectLatestFindings.mockReturnValueOnce(snapshot([contradiction]));
    const emit = vi.fn();
    await runFixJob(job(), emit);
    const opts = (genMock.generateTextWithTools.mock.calls[0] as unknown[])[1] as { tools: Record<string, unknown> };
    expect(Object.keys(opts.tools)).toContain('wiki_update');
    expect(Object.keys(opts.tools)).not.toContain('wiki_list');
    expect(postconditionMock.verifyJobPostconditions).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'fix',
      job: expect.objectContaining({ id: 'j1' }),
      semanticFindings: [contradiction],
      emit,
    }));
  });

  it('worklist 空 → 不调 LLM、不 commit，仍 emit complete', async () => {
    const emit = vi.fn();
    await runFixJob(job(), emit);
    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(txMock.applyChangeset).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('fix:complete', expect.any(String), expect.any(Object));
    expect(embedMock.enqueueEmbedIndex).not.toHaveBeenCalled();
    expect(postconditionMock.verifyJobPostconditions).toHaveBeenCalledOnce();
  });

  it('residual 报告仍正常完成并进入结果与 complete 事件', async () => {
    const residualReport: PostconditionReport = {
      ...cleanReport,
      status: 'residual',
      residualFindings: [
        {
          type: 'broken-link',
          severity: 'warning',
          pageSlug: 'a',
          description: '仍有坏链',
        },
      ],
    };
    postconditionMock.verifyJobPostconditions.mockResolvedValueOnce(residualReport);
    const emit = vi.fn();

    const result = await runFixJob(job(), emit);

    expect(result).toMatchObject({
      postconditionStatus: 'residual',
      postcondition: residualReport,
    });
    expect(emit).toHaveBeenCalledWith(
      'fix:complete',
      expect.stringContaining('Postcondition residual'),
      expect.objectContaining({
        postconditionStatus: 'residual',
        residualCount: 1,
      }),
    );
  });

  it('remediation context 只处理指定且属于 Fix 的 finding ID', async () => {
    const brokenARaw = finding('broken-link', 'a', 'A 中的坏链');
    const brokenBRaw = finding('broken-link', 'b', 'B 中的坏链');
    const brokenA = identified(brokenARaw);
    const brokenB = identified(brokenBRaw);
    const coverageC = identified(finding('coverage-gap', 'c', 'C 的覆盖缺口'));
    queueMock.get.mockReturnValueOnce(lintJob());
    latestMock.selectLatestFindings.mockReturnValueOnce(snapshot([brokenA, brokenB, coverageC]));
    lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([brokenARaw, brokenBRaw]);

    await runFixJob(job({
      subjectId: 's1',
      remediationContext: context([brokenA.id]),
    }), vi.fn());

    const prompt = getFixPrompt();
    expect(prompt).toContain(brokenA.description);
    expect(prompt).not.toContain(brokenB.description);
    expect(prompt).not.toContain(coverageC.description);
  });

  it.each([
    ['lint job 不存在', null, undefined, undefined],
    ['lint job 属于其他 subject', lintJob({ subjectId: 's2' }), undefined, undefined],
    ['lint job 未完成', lintJob({ status: 'running' }), undefined, undefined],
    ['引用的 job 不是 lint', lintJob({ type: 'fix' }), undefined, undefined],
    ['finding ID 不存在', lintJob(), 'f'.repeat(64), undefined],
    ['finding 不属于 Fix', lintJob(), undefined, 'coverage-gap'],
  ] as const)(
    '%s 时在写入或 LLM 前拒绝执行',
    async (_label, storedLintJob, missingId, nonFixType) => {
      const brokenA = identified(finding('broken-link', 'a', 'A 中的坏链'));
      const selected = nonFixType
        ? identified(finding(nonFixType, 'c', 'C 的覆盖缺口'))
        : brokenA;
      queueMock.get.mockReturnValueOnce(storedLintJob);
      latestMock.selectLatestFindings.mockReturnValueOnce(snapshot([selected]));
      lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([brokenA]);

      await expect(runFixJob(job({
        subjectId: 's1',
        remediationContext: context([missingId ?? selected.id]),
      }), vi.fn())).rejects.toThrow();

      expect(lintMock.runDeterministicChecksForSubject).not.toHaveBeenCalled();
      expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
      expect(txMock.applyChangeset).not.toHaveBeenCalled();
    },
  );

  it('错误 action 时在写入或 LLM 前拒绝执行', async () => {
    const missingFrontmatter = identified(finding('missing-frontmatter', 'a', 'A 缺 frontmatter'));
    queueMock.get.mockReturnValueOnce(lintJob());
    latestMock.selectLatestFindings.mockReturnValueOnce(snapshot([missingFrontmatter]));
    lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([missingFrontmatter]);

    await expect(runFixJob(job({
      subjectId: 's1',
      remediationContext: context([missingFrontmatter.id], 'curate'),
    }), vi.fn())).rejects.toThrow();

    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(txMock.applyChangeset).not.toHaveBeenCalled();
  });

  it('精确 lint job 解析出的 snapshot jobId 不匹配时拒绝执行', async () => {
    const brokenA = identified(finding('broken-link', 'a', 'A 中的坏链'));
    queueMock.get.mockReturnValueOnce(lintJob());
    latestMock.selectLatestFindings.mockReturnValueOnce(snapshot([brokenA], { jobId: 'lint-other' }));

    await expect(runFixJob(job({
      subjectId: 's1',
      remediationContext: context([brokenA.id]),
    }), vi.fn())).rejects.toThrow();

    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(txMock.applyChangeset).not.toHaveBeenCalled();
  });

  it('fresh deterministic 重新生成稳定 ID 后匹配，已 stale 的 deterministic 不处理', async () => {
    const currentRaw = finding('broken-link', 'a', '当前仍存在的坏链');
    const current = identified(currentRaw);
    const stale = identified(finding('broken-link', 'b', '快照中已过期的坏链'));
    queueMock.get.mockReturnValueOnce(lintJob());
    latestMock.selectLatestFindings.mockReturnValueOnce(snapshot([current, stale]));
    lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([currentRaw]);

    await runFixJob(job({
      subjectId: 's1',
      remediationContext: context([current.id, stale.id]),
    }), vi.fn());

    const prompt = getFixPrompt();
    expect(prompt).toContain(current.description);
    expect(prompt).not.toContain(stale.description);
  });

  it('无 remediation context 时保留 fresh deterministic 与最新 semantic 全量行为', async () => {
    const brokenA = identified(finding('broken-link', 'a', 'A 中的坏链'));
    const brokenB = identified(finding('broken-link', 'b', 'B 中的坏链'));
    const semanticC = identified(finding('missing-crossref', 'c', 'C 缺少交叉引用'));
    lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([brokenA, brokenB]);
    latestMock.selectLatestFindings.mockReturnValueOnce(snapshot([semanticC]));

    await runFixJob(job(), vi.fn());

    const prompt = getFixPrompt();
    expect(prompt).toContain(brokenA.description);
    expect(prompt).toContain(brokenB.description);
    expect(prompt).toContain(semanticC.description);
    expect(queueMock.list).toHaveBeenCalledWith({
      type: 'lint',
      status: 'completed',
      subjectId: 's1',
    });
    expect(queueMock.get).not.toHaveBeenCalled();
  });

  it('后置校验只接收 context 选中的 semantic findings', async () => {
    const missingA = identified(finding('missing-crossref', 'a', 'A 缺少交叉引用'));
    const contradictionB = identified(finding('contradiction', 'b', 'B 与 C 冲突'));
    queueMock.get.mockReturnValueOnce(lintJob());
    latestMock.selectLatestFindings.mockReturnValueOnce(snapshot([missingA, contradictionB]));
    const emit = vi.fn();

    await runFixJob(job({
      subjectId: 's1',
      remediationContext: context([missingA.id]),
    }), emit);

    expect(postconditionMock.verifyJobPostconditions).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'fix',
      semanticFindings: [missingA],
      emit,
    }));
  });

  it.each([
    ['顶层 null', 'null'],
    ['顶层 false', 'false'],
    ['顶层数组', '[]'],
    ['context null', JSON.stringify({ subjectId: 's1', remediationContext: null })],
    ['context false', JSON.stringify({ subjectId: 's1', remediationContext: false })],
    ['context 数组', JSON.stringify({ subjectId: 's1', remediationContext: [] })],
  ])('%s 不得降级到 legacy 全量路径', async (_label, paramsJson) => {
    await expect(runFixJob(jobWithParamsJson(paramsJson), vi.fn())).rejects.toThrow();

    expect(lintMock.runDeterministicChecksForSubject).not.toHaveBeenCalled();
    expect(queueMock.list).not.toHaveBeenCalled();
    expect(queueMock.get).not.toHaveBeenCalled();
    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(txMock.applyChangeset).not.toHaveBeenCalled();
  });

  it.each([
    ['空 lintJobId', { lintJobId: '', findingIds: ['a'.repeat(64)], action: 'fix' }],
    ['空 findingIds', { lintJobId: 'lint-1', findingIds: [], action: 'fix' }],
    ['finding ID 非 64hex', { lintJobId: 'lint-1', findingIds: ['not-a-finding-id'], action: 'fix' }],
    ['finding ID 含大写十六进制', { lintJobId: 'lint-1', findingIds: ['A'.repeat(64)], action: 'fix' }],
  ])('%s 时在 deterministic 扫描前拒绝', async (_label, remediationContext) => {
    const paramsJson = JSON.stringify({ subjectId: 's1', remediationContext });

    await expect(runFixJob(jobWithParamsJson(paramsJson), vi.fn())).rejects.toThrow();

    expect(lintMock.runDeterministicChecksForSubject).not.toHaveBeenCalled();
    expect(queueMock.list).not.toHaveBeenCalled();
    expect(queueMock.get).not.toHaveBeenCalled();
  });

  it('params.subjectId 与 job.subjectId 不一致时在 deterministic 扫描前拒绝', async () => {
    await expect(runFixJob(jobWithParamsJson(
      JSON.stringify({ subjectId: 's2' }),
      's1',
    ), vi.fn())).rejects.toThrow();

    expect(lintMock.runDeterministicChecksForSubject).not.toHaveBeenCalled();
    expect(queueMock.list).not.toHaveBeenCalled();
  });

  it('兼容旧 job.subjectId=null 且 params.subjectId 合法', async () => {
    await runFixJob(jobWithParamsJson(
      JSON.stringify({ subjectId: 's1' }),
      null,
    ), vi.fn());

    expect(lintMock.runDeterministicChecksForSubject).toHaveBeenCalledOnce();
    expect(queueMock.list).toHaveBeenCalledWith({
      type: 'lint',
      status: 'completed',
      subjectId: 's1',
    });
  });

  it('scoped 模式只限制写页，read/search 仍可访问同 subject 的 scope 外页面', async () => {
    const contradictionA = identified(finding('contradiction', 'a', 'A 与其他说法冲突'));
    queueMock.get.mockReturnValueOnce(lintJob());
    latestMock.selectLatestFindings.mockReturnValueOnce(snapshot([contradictionA]));
    searchMock.hybridRankSlugs.mockResolvedValueOnce(['b']);

    genMock.generateTextWithTools.mockImplementationOnce(async (_task, optsValue) => {
      const opts = optsValue as { tools: Record<string, { execute(input: unknown): Promise<unknown> }> };
      const read = await opts.tools.wiki_read!.execute({ slug: 'b' });
      const search = await opts.tools.wiki_search!.execute({ query: 'B' });
      const patch = await opts.tools.wiki_patch!.execute({
        slug: 'b',
        edits: [{ oldString: 'before', newString: 'after' }],
      });
      const update = await opts.tools.wiki_update!.execute({ slug: 'b', body: 'updated body' });

      expect(read).toEqual(expect.objectContaining({ found: true, title: 'B' }));
      expect(search).toEqual({ hits: [{ slug: 'b', title: 'B', summary: '' }] });
      expect(patch).toEqual(expect.objectContaining({ ok: false, message: expect.stringContaining('[PAGE_OUT_OF_SCOPE]') }));
      expect(update).toEqual(expect.objectContaining({ ok: false, message: expect.stringContaining('[PAGE_OUT_OF_SCOPE]') }));
      return { text: 'done' };
    });

    await runFixJob(job({
      subjectId: 's1',
      remediationContext: context([contradictionA.id]),
    }), vi.fn());

    expect(pageOpsMock.executePagePatch).not.toHaveBeenCalled();
    expect(pageOpsMock.executePageUpdate).not.toHaveBeenCalled();
  });

  it('legacy 模式保持 subject-wide 写范围', async () => {
    lintMock.runDeterministicChecksForSubject.mockReturnValueOnce([
      finding('broken-link', 'a', 'A 中的坏链'),
    ]);
    genMock.generateTextWithTools.mockImplementationOnce(async (_task, optsValue) => {
      const opts = optsValue as { tools: Record<string, { execute(input: unknown): Promise<unknown> }> };
      const patch = await opts.tools.wiki_patch!.execute({
        slug: 'b',
        edits: [{ oldString: 'before', newString: 'after' }],
      });
      expect(patch).toEqual(expect.objectContaining({ ok: true, updatedSlug: 'b' }));
      return { text: 'done' };
    });

    await runFixJob(job(), vi.fn());

    expect(pageOpsMock.executePagePatch).toHaveBeenCalledWith(
      'j1',
      expect.objectContaining({ id: 's1' }),
      { slug: 'b', edits: [{ oldString: 'before', newString: 'after' }] },
    );
  });
});
