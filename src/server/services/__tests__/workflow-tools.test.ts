import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getJob: vi.fn(),
  getHead: vi.fn(),
  webConfigured: vi.fn(),
  planReenrich: vi.fn(),
  emit: vi.fn(),
  reconcile: vi.fn(),
  getPage: vi.fn(),
  readPage: vi.fn(),
}));

vi.mock('@/server/jobs/queue', () => ({
  get: (...args: unknown[]) => mocks.getJob(...args),
}));
vi.mock('@/server/git/git-service', () => ({
  getVaultHead: (...args: unknown[]) => mocks.getHead(...args),
}));
vi.mock('@/server/search/web-search', () => ({
  isWebSearchConfigured: (...args: unknown[]) => mocks.webConfigured(...args),
}));
vi.mock('../reenrich-enqueue', () => ({
  planReenrich: (...args: unknown[]) => mocks.planReenrich(...args),
}));
vi.mock('@/server/jobs/events', () => ({
  emit: (...args: unknown[]) => mocks.emit(...args),
}));
vi.mock('../research-provenance-reconciler', () => ({
  reconcileResearchProvenanceForJob: (...args: unknown[]) => mocks.reconcile(...args),
}));
vi.mock('@/server/db/repos/pages-repo', () => ({
  getPageBySlug: (...args: unknown[]) => mocks.getPage(...args),
  isMetaPage: (page: { tags?: string[] }) => (page.tags ?? []).includes('meta'),
}));
vi.mock('@/server/wiki/wiki-store', () => ({
  readPageInSubject: (...args: unknown[]) => mocks.readPage(...args),
}));

import {
  planWorkflowCancel,
  planWorkflowImageInsert,
  planWorkflowReenrich,
  planWorkflowResearch,
  prepareWorkflowImageInsert,
  readWorkflowStatus,
  reportWorkflowCancellation,
} from '../workflow-tools';

const subject = {
  id: 's1', slug: 'general', name: 'General', description: '',
  augmentationLevel: 'standard' as const, createdAt: '', updatedAt: '',
};

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1', type: 'research', status: 'running', subjectId: 's1',
    paramsJson: JSON.stringify({ topic: 'secret' }),
    resultJson: JSON.stringify({ secret: 'do not expose' }),
    createdAt: '2026-07-14T00:00:00.000Z', startedAt: null, completedAt: null,
    leaseExpiresAt: null, heartbeatAt: null, attemptCount: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getHead.mockResolvedValue('head-1');
  mocks.webConfigured.mockReturnValue(true);
  mocks.planReenrich.mockResolvedValue({
    kind: 'workflow', preHead: 'head-1', summary: '重新丰富 page-a',
    affectedPages: [{ slug: 'page-a', action: 'update' }], diff: null, warnings: [],
  });
  mocks.getPage.mockReturnValue({ slug: 'page-a', tags: [] });
  mocks.readPage.mockReturnValue({ body: '# Context\n\nSelected paragraph.\n\nNext paragraph.' });
});

describe('readWorkflowStatus', () => {
  it('只返回 active Subject 的脱敏摘要', () => {
    mocks.getJob.mockReturnValue(job());
    expect(readWorkflowStatus(subject, 'job-1')).toEqual({
      found: true,
      job: {
        jobId: 'job-1', type: 'research', status: 'running', cancelled: false,
        createdAt: '2026-07-14T00:00:00.000Z', startedAt: null, completedAt: null,
        attemptCount: 1,
      },
    });
  });

  it.each([
    null,
    job({ subjectId: 's2' }),
    job({ subjectId: null }),
  ])('未知、跨 Subject 与全局 job 统一隐藏', (stored) => {
    mocks.getJob.mockReturnValue(stored);
    expect(readWorkflowStatus(subject, 'job-1')).toEqual({ found: false, job: null });
  });

  it('从终态 result 中只提取 cancelled 布尔值', () => {
    mocks.getJob.mockReturnValue(job({
      status: 'failed',
      resultJson: JSON.stringify({ cancelled: true, error: { message: 'secret' } }),
    }));
    expect(readWorkflowStatus(subject, 'job-1').job?.cancelled).toBe(true);
  });
});

describe('workflow plan', () => {
  it('re-enrich 委托既有页面校验计划', async () => {
    await expect(planWorkflowReenrich(subject, 'page-a')).resolves.toEqual(
      expect.objectContaining({ kind: 'workflow' }),
    );
    expect(mocks.planReenrich).toHaveBeenCalledWith('s1', 'page-a');
  });

  it('Research trim topic 并生成不写 Wiki 的工作流预览', async () => {
    await expect(planWorkflowResearch(subject, '  SQLite WAL  ')).resolves.toEqual({
      kind: 'workflow',
      preHead: 'head-1',
      summary: '研究主题 SQLite WAL',
      affectedPages: [],
      diff: null,
      warnings: [expect.stringContaining('候选')],
    });
  });

  it('Research 未配置 Web Search 或 topic 过长时拒绝', async () => {
    mocks.webConfigured.mockReturnValue(false);
    await expect(planWorkflowResearch(subject, 'SQLite')).rejects.toThrow(/Web search/i);
    mocks.webConfigured.mockReturnValue(true);
    await expect(planWorkflowResearch(subject, 'x'.repeat(501))).rejects.toThrow(/500/);
  });

  it('cancel 只允许 active Subject 非终态 job', async () => {
    mocks.getJob.mockReturnValue(job());
    await expect(planWorkflowCancel(subject, 'job-1')).resolves.toEqual({
      kind: 'workflow',
      preHead: 'head-1',
      summary: '取消 research 任务 job-1',
      affectedPages: [],
      diff: null,
      warnings: [expect.stringContaining('终止')],
    });

    mocks.getJob.mockReturnValue(job({ status: 'completed' }));
    await expect(planWorkflowCancel(subject, 'job-1')).rejects.toThrow(/terminal/i);
    mocks.getJob.mockReturnValue(job({ subjectId: 's2' }));
    await expect(planWorkflowCancel(subject, 'job-1')).rejects.toThrow(/not found/i);
  });

  it('选区配图只接受 canonical 完整块，并生成服务端持久化锚点', async () => {
    const body = '# Context\n\nSelected paragraph.\n\nNext paragraph.';
    const start = body.indexOf('Selected paragraph.');
    const prepared = await prepareWorkflowImageInsert(
      subject,
      ' page-a ',
      {
        sourceKind: 'canonical',
        quote: 'Selected paragraph.',
        section: 'Context',
        blockStart: start,
        blockEnd: start + 'Selected paragraph.'.length,
      },
      { prompt: 'Explain visually', alt: 'Explanation diagram', aspectRatio: '16:9' },
    );

    expect(prepared.input).toMatchObject({
      operation: 'workflow-image-insert-start',
      payload: {
        slug: 'page-a',
        anchor: { start, markdown: 'Selected paragraph.', quote: 'Selected paragraph.' },
        request: { prompt: 'Explain visually', alt: 'Explanation diagram' },
      },
    });
    expect(prepared.preview).toMatchObject({
      kind: 'workflow',
      preHead: 'head-1',
      affectedPages: [{ slug: 'page-a', action: 'update' }],
      imageInsert: {
        selection: 'Selected paragraph.',
        prompt: 'Explain visually',
        alt: 'Explanation diagram',
        aspectRatio: '16:9',
      },
    });
  });

  it('选区配图拒绝 Reshape、meta 页与批准时失效的锚点', async () => {
    await expect(prepareWorkflowImageInsert(
      subject,
      'page-a',
      { sourceKind: 'reshape', quote: 'x', section: null, blockStart: 0, blockEnd: 1 },
      { prompt: 'Explain', alt: 'Diagram' },
    )).rejects.toThrow(/Original/i);

    mocks.getPage.mockReturnValueOnce({ slug: 'page-a', tags: ['meta'] });
    await expect(prepareWorkflowImageInsert(
      subject,
      'page-a',
      { sourceKind: 'canonical', quote: 'x', section: null, blockStart: 0, blockEnd: 1 },
      { prompt: 'Explain', alt: 'Diagram' },
    )).rejects.toThrow(/system page/i);

    mocks.getPage.mockReturnValue({ slug: 'page-a', tags: [] });
    mocks.readPage.mockReturnValue({ body: '# Context\n\nChanged paragraph.' });
    await expect(planWorkflowImageInsert(subject, {
      slug: 'page-a',
      anchor: {
        start: 11,
        end: 30,
        markdown: 'Selected paragraph.',
        prefix: '# Context\n\n',
        suffix: '',
        quote: 'Selected paragraph.',
        section: 'Context',
      },
      request: { prompt: 'Explain', alt: 'Diagram' },
    })).rejects.toThrow(/unique location/i);
  });
});

describe('reportWorkflowCancellation', () => {
  it('发取消事件并触发 Research provenance 对账', () => {
    reportWorkflowCancellation('job-1');
    expect(mocks.emit).toHaveBeenCalledWith(
      'job-1', 'job:cancelled', expect.any(String), { manual: true },
    );
    expect(mocks.reconcile).toHaveBeenCalledWith('job-1');
  });

  it('对账失败不反转已经提交的取消', () => {
    mocks.reconcile.mockImplementationOnce(() => { throw new Error('failed'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => reportWorkflowCancellation('job-1')).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      '[research-provenance] workflow cancel reconcile failed',
      expect.any(Error),
    );
    error.mockRestore();
  });

  it('取消事件写入失败也不反转已经提交的取消', () => {
    mocks.emit.mockImplementationOnce(() => { throw new Error('failed'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => reportWorkflowCancellation('job-1')).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      '[workflow] cancel event emit failed',
      expect.any(Error),
    );
    expect(mocks.reconcile).toHaveBeenCalledWith('job-1');
    error.mockRestore();
  });
});
