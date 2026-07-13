import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  EnrichedLintFinding,
  Job,
  LintFinding,
  PostconditionReport,
  RemediationContext,
} from '@/lib/contracts';

// vi.mock 路径用 @/server/... 绝对别名（解析到与 SUT import 同一模块；与 query-tools.test 一致）
vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));
const queueMock = vi.hoisted(() => ({
  get: vi.fn(() => null as Job | null),
  isCancelRequested: vi.fn(() => false),
}));
vi.mock('@/server/jobs/queue', () => queueMock);
const genMock = vi.hoisted(() => ({
  generateTextWithTools: vi.fn(async (task: string, opts: unknown) => {
    void task;
    void opts;
    return { text: 'done' };
  }),
}));
vi.mock('@/server/llm/provider-registry', () => genMock);
vi.mock('@/server/db/repos/subjects-repo', () => ({ getById: vi.fn(() => ({ id: 's1', slug: 'general', name: 'G', description: '' })) }));
const pagesMock = vi.hoisted(() => ({
  getAllPages: vi.fn(() => [{ slug: 'a', tags: [] }, { slug: 'b', tags: [] }]),
  getAllLinks: vi.fn(() => []),
  getPageBySlug: vi.fn(() => null), isMetaPage: () => false,
}));
vi.mock('@/server/db/repos/pages-repo', () => pagesMock);
vi.mock('@/server/wiki/wiki-store', () => ({
  readPageInSubject: vi.fn(() => ({ frontmatter: { title: 'T', summary: 's', tags: [] }, body: 'body' })),
}));
vi.mock('@/server/db/repos/settings-repo', () => ({ getWikiLanguage: vi.fn(() => 'English') }));
const embedMock = vi.hoisted(() => ({ enqueueEmbedIndex: vi.fn() }));
vi.mock('@/server/services/embedding-service', () => embedMock);
const pageOpsMock = vi.hoisted(() => ({
  executePageMerge: vi.fn(),
  executePageSplit: vi.fn(),
  executePageDelete: vi.fn(),
  executePageCreate: vi.fn(),
  executePageMetadataPatch: vi.fn(async (_jobId: string, _subject: unknown, input: { slug: string }) => ({
    updatedSlug: input.slug,
    referencesUpdated: 0,
    changedFields: ['summary'],
  })),
  executePageLinkEnsure: vi.fn(async (_jobId: string, _subject: unknown, input: {
    sourceSlug: string;
    targetSubjectSlug?: string;
    targetSlug: string;
    mode: 'link' | 'unlink' | 'retarget';
  }) => ({
    updatedSlug: input.sourceSlug,
    mode: input.mode,
    targetSubjectSlug: input.targetSubjectSlug ?? 'general',
    targetSlug: input.targetSlug,
  })),
}));
vi.mock('@/server/wiki/page-ops', () => pageOpsMock);
// curate-tools 透传引入；本测试不触发搜索，mock 防 import-time 副作用
vi.mock('@/server/search/hybrid-retrieval', () => ({ hybridRankSlugs: vi.fn(async () => []) }));
const postconditionMock = vi.hoisted(() => ({ verifyJobPostconditions: vi.fn() }));
vi.mock('@/server/services/postcondition-service', () => postconditionMock);

import { runCurateJob } from '../curate-service';
import { identifyFindings } from '../finding-identity';

function job(params: object) {
  return { id: 'j1', type: 'curate', subjectId: 's1', paramsJson: JSON.stringify(params) } as never;
}

function orphan(
  pageSlug: string,
  description = `${pageSlug} 没有入链`,
): EnrichedLintFinding {
  const finding: LintFinding & { subjectId: string; subjectSlug: string } = {
    type: 'orphan',
    severity: 'info',
    pageSlug,
    description,
    suggestedFix: null,
    subjectId: 's1',
    subjectSlug: 'general',
  };
  return identifyFindings([finding])[0]!;
}

function lintJob(findings: EnrichedLintFinding[]): Job {
  return {
    id: 'lint-1',
    type: 'lint',
    status: 'completed',
    subjectId: 's1',
    paramsJson: JSON.stringify({ subjectId: 's1' }),
    resultJson: JSON.stringify({ findings }),
    createdAt: '2026-07-13T10:00:00.000Z',
    startedAt: '2026-07-13T10:00:00.000Z',
    completedAt: '2026-07-13T10:01:00.000Z',
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
  };
}

function remediationContext(findings: EnrichedLintFinding[]): RemediationContext {
  return {
    lintJobId: 'lint-1',
    findingIds: findings.map((finding) => finding.id).sort(),
    action: 'curate',
  };
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

describe('runCurateJob (tool-loop)', () => {
  beforeEach(() => {
    genMock.generateTextWithTools.mockReset();
    genMock.generateTextWithTools.mockResolvedValue({ text: 'done' });
    embedMock.enqueueEmbedIndex.mockClear();
    pageOpsMock.executePageMetadataPatch.mockReset();
    pageOpsMock.executePageMetadataPatch.mockImplementation(async (_jobId, _subject, input) => ({
      updatedSlug: input.slug,
      referencesUpdated: 0,
      changedFields: ['summary'],
    }));
    pageOpsMock.executePageLinkEnsure.mockReset();
    pageOpsMock.executePageLinkEnsure.mockImplementation(async (_jobId, _subject, input) => ({
      updatedSlug: input.sourceSlug,
      mode: input.mode,
      targetSubjectSlug: input.targetSubjectSlug ?? 'general',
      targetSlug: input.targetSlug,
    }));
    queueMock.get.mockReset();
    queueMock.get.mockReturnValue(null);
    queueMock.isCancelRequested.mockReset();
    queueMock.isCancelRequested.mockReturnValue(false);
    postconditionMock.verifyJobPostconditions.mockReset();
    postconditionMock.verifyJobPostconditions.mockResolvedValue(cleanReport);
  });
  it('manual：驱动 generateTextWithTools(curate) + emit start/complete', async () => {
    const emit = vi.fn();
    const res = await runCurateJob(job({ scope: 'subject', subjectId: 's1' }), emit);
    expect(genMock.generateTextWithTools).toHaveBeenCalledTimes(1);
    const [task, rawOpts] = genMock.generateTextWithTools.mock.calls[0];
    const opts = rawOpts as { tools: Record<string, unknown> };
    expect(task).toBe('curate');
    expect(Object.keys(opts.tools)).toEqual(expect.arrayContaining([
      'wiki_merge', 'wiki_split', 'wiki_delete', 'wiki_create', 'wiki_read', 'wiki_inspect',
      'wiki_metadata_patch', 'wiki_link_ensure',
    ]));
    expect(emit).toHaveBeenCalledWith('curate:start', expect.any(String), expect.any(Object));
    expect(emit).toHaveBeenCalledWith('curate:complete', expect.any(String), expect.any(Object));
    expect(res).toMatchObject({
      writes: expect.any(Number),
      postconditionStatus: 'clean',
      postcondition: cleanReport,
    });
    expect(postconditionMock.verifyJobPostconditions).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'curate',
      semanticFindings: undefined,
      emit,
    }));
  });
  it.each([
    ['manual', { scope: 'subject', subjectId: 's1' }],
    ['auto', { scope: 'pages', slugs: ['a'], subjectId: 's1' }],
  ] as const)('单页 %s scope 仍运行两个窄写工具，并只在 job 末尾入队一次', async (mode, params) => {
    if (mode === 'manual') {
      pagesMock.getAllPages.mockReturnValueOnce([{ slug: 'a', tags: [] }]);
    }
    genMock.generateTextWithTools.mockImplementationOnce(async (_task, optsValue) => {
      const opts = optsValue as { tools: Record<string, { execute(input: unknown): Promise<unknown> }> };
      const metadata = await opts.tools.wiki_metadata_patch!.execute({
        slug: 'a',
        summary: '单页新摘要',
      });
      expect(metadata).toEqual(expect.objectContaining({ ok: true, updatedSlug: 'a' }));
      expect(embedMock.enqueueEmbedIndex).not.toHaveBeenCalled();

      const link = await opts.tools.wiki_link_ensure!.execute({
        sourceSlug: 'a',
        targetSubjectSlug: 'other-subject',
        targetSlug: 'outside-target',
        oldString: '唯一自然锚点',
        mode: 'link',
      });
      expect(link).toEqual(expect.objectContaining({
        ok: true,
        updatedSlug: 'a',
        targetSubjectSlug: 'other-subject',
        targetSlug: 'outside-target',
      }));
      expect(embedMock.enqueueEmbedIndex).not.toHaveBeenCalled();
      return { text: 'done' };
    });

    const result = await runCurateJob(job(params), vi.fn());

    expect(genMock.generateTextWithTools).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ update: 2, writes: 2 });
    expect(embedMock.enqueueEmbedIndex).toHaveBeenCalledTimes(1);
    expect(embedMock.enqueueEmbedIndex).toHaveBeenCalledWith('s1');
  });

  it.each([
    ['显式 pages 空集合', { scope: 'pages', slugs: [], subjectId: 's1' }],
    ['subject 无页面', { scope: 'subject', subjectId: 's1' }],
  ] as const)('%s 时早退为零写入，不调模型、不入队', async (caseName, params) => {
    if (caseName === 'subject 无页面') {
      pagesMock.getAllPages.mockReturnValueOnce([]);
    }
    const emit = vi.fn();

    const result = await runCurateJob(job(params), emit);

    expect(genMock.generateTextWithTools).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      'curate:complete',
      expect.stringMatching(/Nothing to curate \(empty scope\)/),
      expect.any(Object),
    );
    expect(emit).not.toHaveBeenCalledWith(
      'curate:complete',
      expect.stringMatching(/need at least 2 pages/),
      expect.any(Object),
    );
    expect(result).toMatchObject({ update: 0, writes: 0 });
    expect(embedMock.enqueueEmbedIndex).not.toHaveBeenCalled();
    expect(postconditionMock.verifyJobPostconditions).toHaveBeenCalledOnce();
  });
  it('auto（scope:pages）：seed 驱动 → 用户消息为 AUTOMATIC 模式', async () => {
    // 2 个 seed 页保证 scope>=2 触发 LLM；getAllLinks 返回 [] → scope=seed
    const emit = vi.fn();
    await runCurateJob(job({ scope: 'pages', slugs: ['a', 'b'], subjectId: 's1' }), emit);
    expect(genMock.generateTextWithTools).toHaveBeenCalledTimes(1);
    const opts = genMock.generateTextWithTools.mock.calls[0][1] as {
      tools: Record<string, unknown>;
      messages: Array<{ content: unknown }>;
    };
    // auto 模式只保留 scope 内 read/search/merge/split，无 list/create/delete
    const toolKeys = Object.keys(opts.tools);
    expect(toolKeys).toEqual(expect.arrayContaining([
      'wiki_merge', 'wiki_split', 'wiki_read', 'wiki_inspect',
      'wiki_metadata_patch', 'wiki_link_ensure',
    ]));
    expect(toolKeys).not.toContain('wiki_create');
    expect(toolKeys).not.toContain('wiki_delete');
    expect(toolKeys).not.toContain('wiki_list');
    const userMsg = String(opts.messages[0].content);
    expect(userMsg).toMatch(/AUTOMATIC/);        // 证明 {auto:true} 传入 → seedSet!==null
    expect(userMsg).toMatch(/do NOT create/i);   // auto 禁建页提示
    expect(emit).toHaveBeenCalledWith('curate:start', expect.any(String), expect.objectContaining({ scope: 'pages' }));
    expect(emit).toHaveBeenCalledWith(
      'curate:agent:start',
      expect.stringContaining('update≤5'),
      expect.objectContaining({ caps: expect.objectContaining({ update: 5 }) }),
    );
  });

  it('两个窄写能力不自行入队，job 末尾按 totals.writes 统一入队一次', async () => {
    genMock.generateTextWithTools.mockImplementationOnce(async (_task, optsValue) => {
      const opts = optsValue as { tools: Record<string, { execute(input: unknown): Promise<unknown> }> };
      const metadata = await opts.tools.wiki_metadata_patch!.execute({ slug: 'a', summary: '新摘要' });
      expect(metadata).toEqual(expect.objectContaining({ ok: true, updatedSlug: 'a' }));
      expect(embedMock.enqueueEmbedIndex).not.toHaveBeenCalled();

      const link = await opts.tools.wiki_link_ensure!.execute({
        sourceSlug: 'a',
        targetSlug: 'b',
        oldString: 'B',
        mode: 'link',
      });
      expect(link).toEqual(expect.objectContaining({ ok: true, updatedSlug: 'a' }));
      expect(embedMock.enqueueEmbedIndex).not.toHaveBeenCalled();
      return { text: 'done' };
    });
    const emit = vi.fn();

    const result = await runCurateJob(job({ scope: 'subject', subjectId: 's1' }), emit);

    expect(result).toMatchObject({ update: 2, writes: 2 });
    expect(embedMock.enqueueEmbedIndex).toHaveBeenCalledTimes(1);
    expect(embedMock.enqueueEmbedIndex).toHaveBeenCalledWith('s1');
    expect(emit).toHaveBeenCalledWith(
      'curate:complete',
      expect.stringContaining('2 update(s)'),
      expect.objectContaining({ update: 2, writes: 2 }),
    );
  });

  it('窄写失败时 totals 保持零且不入队', async () => {
    pageOpsMock.executePageLinkEnsure.mockRejectedValueOnce(new Error('anchor is not unique'));
    genMock.generateTextWithTools.mockImplementationOnce(async (_task, optsValue) => {
      const opts = optsValue as { tools: Record<string, { execute(input: unknown): Promise<unknown> }> };
      const result = await opts.tools.wiki_link_ensure!.execute({
        sourceSlug: 'a',
        targetSlug: 'b',
        oldString: 'B',
        mode: 'link',
      });
      expect(result).toEqual(expect.objectContaining({ ok: false, message: 'anchor is not unique' }));
      return { text: 'done' };
    });

    const result = await runCurateJob(job({ scope: 'subject', subjectId: 's1' }), vi.fn());

    expect(result).toMatchObject({ update: 0, writes: 0 });
    expect(embedMock.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it('residual 报告仍正常完成并进入结果与 complete 事件', async () => {
    const residualReport: PostconditionReport = {
      ...cleanReport,
      status: 'residual',
      residualFindings: [
        {
          type: 'orphan-page',
          severity: 'info',
          pageSlug: 'a',
          description: '新页面无入链',
        },
      ],
    };
    postconditionMock.verifyJobPostconditions.mockResolvedValueOnce(residualReport);
    const emit = vi.fn();

    const result = await runCurateJob(
      job({ scope: 'subject', subjectId: 's1' }),
      emit,
    );

    expect(result).toMatchObject({
      postconditionStatus: 'residual',
      postcondition: residualReport,
    });
    expect(emit).toHaveBeenCalledWith(
      'curate:complete',
      expect.stringContaining('Postcondition residual'),
      expect.objectContaining({
        postconditionStatus: 'residual',
        residualCount: 1,
      }),
    );
  });

  it('批量 Curate 按 orphan 对应残留分别记录 fixed 与 failed', async () => {
    const fixed = orphan('a');
    const failed = orphan('b');
    const context = remediationContext([fixed, failed]);
    queueMock.get.mockReturnValueOnce(lintJob([fixed, failed]));
    postconditionMock.verifyJobPostconditions.mockResolvedValueOnce({
      ...cleanReport,
      status: 'residual',
      scope: {
        ...cleanReport.scope,
        updatedSlugs: ['a'],
        touchedSlugs: ['a'],
      },
      residualFindings: [{
        type: 'orphan-page',
        severity: 'info',
        pageSlug: 'b',
        description: 'B 仍没有入链',
      }],
    });

    const result = await runCurateJob(job({
      scope: 'pages',
      slugs: ['a', 'b'],
      subjectId: 's1',
      remediationContext: context,
    }), vi.fn());

    expect(result.perFindingOutcomes).toEqual({
      [fixed.id]: 'fixed',
      [failed.id]: 'failed',
    });
    expect(queueMock.get).toHaveBeenCalledWith('lint-1');
  });

  it('Curate residual 可通过 relatedSlugs 归因到原 orphan', async () => {
    const fixed = orphan('a');
    const failed = orphan('b');
    const context = remediationContext([fixed, failed]);
    queueMock.get.mockReturnValueOnce(lintJob([fixed, failed]));
    postconditionMock.verifyJobPostconditions.mockResolvedValueOnce({
      ...cleanReport,
      status: 'residual',
      scope: {
        ...cleanReport.scope,
        updatedSlugs: ['a'],
        touchedSlugs: ['a'],
      },
      residualFindings: [{
        type: 'dangling-incoming-link',
        severity: 'warning',
        pageSlug: 'source-page',
        relatedSlugs: ['b'],
        description: '关联页仍异常',
      }],
    });

    const result = await runCurateJob(job({
      scope: 'pages',
      slugs: ['a', 'b'],
      subjectId: 's1',
      remediationContext: context,
    }), vi.fn());

    expect(result.perFindingOutcomes).toEqual({
      [fixed.id]: 'fixed',
      [failed.id]: 'failed',
    });
  });

  it('Curate 同页多个 orphan 遇到该页 residual 时保守全部 failed', async () => {
    const first = orphan('same-page', '第一条孤儿诊断');
    const second = orphan('same-page', '第二条孤儿诊断');
    const context = remediationContext([first, second]);
    queueMock.get.mockReturnValueOnce(lintJob([first, second]));
    postconditionMock.verifyJobPostconditions.mockResolvedValueOnce({
      ...cleanReport,
      status: 'residual',
      residualFindings: [{
        type: 'orphan-page',
        severity: 'info',
        pageSlug: 'same-page',
        description: '该页仍没有入链',
      }],
    });

    const result = await runCurateJob(job({
      scope: 'pages',
      slugs: ['same-page', 'neighbor'],
      subjectId: 's1',
      remediationContext: context,
    }), vi.fn());

    expect(result.perFindingOutcomes).toEqual({
      [first.id]: 'failed',
      [second.id]: 'failed',
    });
  });

  it('Curate residual 无法归因时 scoped orphan 全部保守记录为 failed', async () => {
    const first = orphan('a');
    const second = orphan('b');
    const context = remediationContext([first, second]);
    queueMock.get.mockReturnValueOnce(lintJob([first, second]));
    postconditionMock.verifyJobPostconditions.mockResolvedValueOnce({
      ...cleanReport,
      status: 'residual',
      residualFindings: [{
        type: 'orphan-page',
        severity: 'info',
        pageSlug: 'outside-worklist',
        description: '无法映射到原 orphan',
      }],
    });

    const result = await runCurateJob(job({
      scope: 'pages',
      slugs: ['a', 'b'],
      subjectId: 's1',
      remediationContext: context,
    }), vi.fn());

    expect(result.perFindingOutcomes).toEqual({
      [first.id]: 'failed',
      [second.id]: 'failed',
    });
  });

  it('Curate 零写入且后置 clean 时 scoped orphan 全部记录为 skipped', async () => {
    const first = orphan('a');
    const second = orphan('b');
    const context = remediationContext([first, second]);
    queueMock.get.mockReturnValueOnce(lintJob([first, second]));

    const result = await runCurateJob(job({
      scope: 'pages',
      slugs: ['a', 'b'],
      subjectId: 's1',
      remediationContext: context,
    }), vi.fn());

    expect(result.perFindingOutcomes).toEqual({
      [first.id]: 'skipped',
      [second.id]: 'skipped',
    });
  });

  it('批量 Curate 只有实际触达页为 fixed，未触达 orphan 为 skipped', async () => {
    const touched = orphan('a');
    const untouched = orphan('b');
    const context = remediationContext([touched, untouched]);
    queueMock.get.mockReturnValueOnce(lintJob([touched, untouched]));
    postconditionMock.verifyJobPostconditions.mockResolvedValueOnce({
      ...cleanReport,
      scope: {
        ...cleanReport.scope,
        updatedSlugs: ['a'],
        touchedSlugs: ['a'],
      },
    });

    const result = await runCurateJob(job({
      scope: 'pages',
      slugs: ['a', 'b'],
      subjectId: 's1',
      remediationContext: context,
    }), vi.fn());

    expect(result.perFindingOutcomes).toEqual({
      [touched.id]: 'fixed',
      [untouched.id]: 'skipped',
    });
  });

  it('Curate 后置校验异常时 scoped orphan 全部记录为 failed', async () => {
    const first = orphan('a');
    const second = orphan('b');
    const context = remediationContext([first, second]);
    queueMock.get.mockReturnValueOnce(lintJob([first, second]));
    postconditionMock.verifyJobPostconditions.mockResolvedValueOnce({
      ...cleanReport,
      status: 'residual',
      residualFindings: [{
        type: 'verification-error',
        severity: 'warning',
        pageSlug: null,
        description: '无法完成后置校验',
      }],
      verificationError: 'verify failed',
    });

    const result = await runCurateJob(job({
      scope: 'pages',
      slugs: ['a', 'b'],
      subjectId: 's1',
      remediationContext: context,
    }), vi.fn());

    expect(result.perFindingOutcomes).toEqual({
      [first.id]: 'failed',
      [second.id]: 'failed',
    });
  });
});
