import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangesetEntry, Job, PersistedMarkdownBlockAnchor } from '@/lib/contracts';

const mocks = vi.hoisted(() => ({
  getSubject: vi.fn(),
  getPage: vi.fn(),
  listAppliedForJob: vi.fn(),
  readPage: vi.fn(),
  readAsset: vi.fn(),
  getHead: vi.fn(),
  generateImage: vi.fn(),
  createChangeset: vi.fn(),
  validateChangeset: vi.fn(),
  applyChangeset: vi.fn(),
  isCancelRequested: vi.fn(),
  enqueueEmbedIndex: vi.fn(),
  registerHandler: vi.fn(),
}));

vi.mock('../../db/repos/subjects-repo', () => ({ getById: mocks.getSubject }));
vi.mock('../../db/repos/pages-repo', () => ({
  getPageBySlug: mocks.getPage,
  isMetaPage: (page: { tags?: string[] }) => (page.tags ?? []).includes('meta'),
}));
vi.mock('../../db/repos/operations-repo', () => ({
  listAppliedForJob: mocks.listAppliedForJob,
}));
vi.mock('../../wiki/wiki-store', () => ({
  readPageInSubject: mocks.readPage,
  readVaultAsset: mocks.readAsset,
}));
vi.mock('../../git/git-service', () => ({ getVaultHead: mocks.getHead }));
vi.mock('../../agents/tools/builtin/image-generate', () => ({
  generateImageAsset: mocks.generateImage,
}));
vi.mock('../../wiki/wiki-transaction', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../wiki/wiki-transaction')>();
  return {
    ...original,
    createChangeset: mocks.createChangeset,
    validateChangeset: mocks.validateChangeset,
    applyChangeset: mocks.applyChangeset,
  };
});
vi.mock('../../jobs/queue', () => ({ isCancelRequested: mocks.isCancelRequested }));
vi.mock('../embedding-enqueue', () => ({ enqueueEmbedIndex: mocks.enqueueEmbedIndex }));
vi.mock('../../jobs/worker', () => ({ registerHandler: mocks.registerHandler }));

import {
  insertDiagramAfterAnchor,
  runImageInsertJob,
} from '../image-insert-service';

const subject = {
  id: 's1', slug: 'general', name: 'General', description: '',
  augmentationLevel: 'standard' as const, createdAt: '', updatedAt: '',
};
const body = '# Context\n\nSelected paragraph.\n\nNext paragraph.\n';
const start = body.indexOf('Selected paragraph.');
const anchor: PersistedMarkdownBlockAnchor = {
  start,
  end: start + 'Selected paragraph.'.length,
  markdown: 'Selected paragraph.',
  prefix: '# Context\n\n',
  suffix: '\n\nNext paragraph.\n',
  quote: 'Selected paragraph.',
  section: 'Context',
};
const params = {
  subjectId: subject.id,
  slug: 'page-a',
  anchor,
  request: { prompt: 'Explain visually', alt: 'Explanation [diagram]', aspectRatio: '16:9' as const },
};

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 'image-job-1', type: 'image-insert', status: 'running', subjectId: subject.id,
    paramsJson: JSON.stringify(params), resultJson: null,
    createdAt: '2026-07-17T00:00:00.000Z', startedAt: null, completedAt: null,
    leaseExpiresAt: null, heartbeatAt: null, attemptCount: 1,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSubject.mockReturnValue(subject);
  mocks.getPage.mockReturnValue({ slug: 'page-a', tags: [] });
  mocks.listAppliedForJob.mockReturnValue([]);
  mocks.readPage.mockReturnValue({
    frontmatter: {
      title: 'Page A', created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z', tags: [], sources: [],
    },
    body,
    links: [],
  });
  mocks.readAsset.mockReturnValue({ data: Buffer.from('image'), contentType: 'image/png' });
  mocks.getHead.mockResolvedValue('head-1');
  mocks.generateImage.mockResolvedValue({
    output: {
      type: 'image', path: 'assets/general/image-1.png',
      url: '/api/assets/general/image-1.png', alt: params.request.alt,
    },
    asset: {
      path: 'assets/general/image-1.png', content: 'aW1hZ2U=', mediaType: 'image/png',
    },
  });
  mocks.createChangeset.mockImplementation((jobId, scopedSubject, entries: ChangesetEntry[]) => ({
    id: 'changeset-1', jobId, subjectId: scopedSubject.id, subjectSlug: scopedSubject.slug,
    entries, preHead: '', postHead: null, status: 'pending',
  }));
  mocks.validateChangeset.mockReturnValue({ valid: true, errors: [], warnings: [] });
  mocks.applyChangeset.mockResolvedValue({ postHead: 'head-2', status: 'applied' });
  mocks.isCancelRequested.mockReturnValue(false);
});

describe('insertDiagramAfterAnchor', () => {
  it('严格插在最后一个选中完整块之后，并转义 Markdown alt', () => {
    expect(insertDiagramAfterAnchor(body, anchor, {
      url: '/api/assets/general/image-1.png',
      alt: 'Explanation [diagram]',
    })).toBe([
      '# Context',
      '',
      'Selected paragraph.',
      '',
      '> [!diagram]',
      '> ![Explanation [diagram\\]](/api/assets/general/image-1.png)',
      '',
      'Next paragraph.',
      '',
    ].join('\n'));

    const shifted = `Intro.\n\n${body}`;
    expect(insertDiagramAfterAnchor(shifted, anchor, {
      url: '/api/assets/general/image-1.png', alt: 'Diagram',
    })).toContain('Selected paragraph.\n\n> [!diagram]');
  });
});

describe('runImageInsertJob', () => {
  it('生图前后复核同一 HEAD/锚点，并把页面与资产放进同一 Changeset', async () => {
    const emit = vi.fn();
    const result = await runImageInsertJob(job(), emit);

    expect(mocks.generateImage).toHaveBeenCalledWith(
      params.request,
      subject.slug,
      undefined,
      expect.any(AbortSignal),
    );
    expect(mocks.readPage).toHaveBeenCalledTimes(2);
    expect(mocks.getHead).toHaveBeenCalledTimes(2);
    const entries = mocks.createChangeset.mock.calls[0]![2] as ChangesetEntry[];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      action: 'update',
      path: 'wiki/general/page-a.md',
      content: expect.stringContaining(
        '> [!diagram]\n> ![Explanation [diagram\\]](/api/assets/general/image-1.png)',
      ),
    });
    expect(entries[1]).toEqual({
      action: 'create',
      path: 'assets/general/image-1.png',
      content: 'aW1hZ2U=',
      contentEncoding: 'base64',
      auxiliary: true,
      auxiliaryKind: 'asset',
      assetFor: 'page-a',
    });
    expect(mocks.applyChangeset).toHaveBeenCalledWith(
      expect.objectContaining({ entries }),
      undefined,
      expect.objectContaining({
        expectedPreHead: 'head-1',
        assertCanApply: expect.any(Function),
      }),
    );
    expect(mocks.enqueueEmbedIndex).toHaveBeenCalledWith(subject.id);
    expect(result).toEqual({
      subjectId: subject.id,
      slug: 'page-a',
      assetUrl: '/api/assets/general/image-1.png',
      operationId: 'changeset-1',
      recovered: false,
    });
    expect(emit).toHaveBeenCalledWith(
      'image-insert:complete', expect.any(String),
      expect.objectContaining({ slug: 'page-a', assetUrl: '/api/assets/general/image-1.png' }),
    );
  });

  it('生图后检测到取消或 HEAD 变化时不创建 Changeset', async () => {
    mocks.isCancelRequested
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    await expect(runImageInsertJob(job(), vi.fn())).rejects.toMatchObject({ name: 'AgentCancelled' });
    expect(mocks.createChangeset).not.toHaveBeenCalled();
    expect(mocks.applyChangeset).not.toHaveBeenCalled();

    mocks.isCancelRequested.mockReset();
    mocks.isCancelRequested.mockReturnValue(false);
    mocks.getHead.mockReset();
    mocks.getHead.mockResolvedValueOnce('head-1').mockResolvedValueOnce('head-2');
    await expect(runImageInsertJob(job(), vi.fn())).rejects.toThrow(/changed while generating/i);
    expect(mocks.createChangeset).not.toHaveBeenCalled();
    expect(mocks.applyChangeset).not.toHaveBeenCalled();
  });

  it('在途生图收到取消时主动 abort，并抛 AgentCancelled', async () => {
    vi.useFakeTimers();
    try {
      mocks.generateImage.mockImplementationOnce((
        _request: unknown,
        _subjectSlug: string,
        _usage: unknown,
        signal: AbortSignal,
      ) => {
        mocks.isCancelRequested.mockReturnValue(true);
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      });

      const pending = runImageInsertJob(job(), vi.fn());
      const assertion = expect(pending).rejects.toMatchObject({ name: 'AgentCancelled' });
      await vi.advanceTimersByTimeAsync(2_001);
      await assertion;
      expect(mocks.createChangeset).not.toHaveBeenCalled();
      expect(mocks.applyChangeset).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applied operation 恢复时不重复生图，并只补 best-effort embedding', async () => {
    const recoveredEntries: ChangesetEntry[] = [
      { action: 'update', path: 'wiki/general/page-a.md', content: 'page' },
      {
        action: 'create', path: 'assets/general/image-1.png', content: 'aW1hZ2U=',
        contentEncoding: 'base64', auxiliary: true, auxiliaryKind: 'asset', assetFor: 'page-a',
      },
    ];
    mocks.listAppliedForJob.mockReturnValue([{
      id: 'changeset-recovered', jobId: 'image-job-1', subjectId: subject.id,
      preHead: 'head-1', postHead: 'head-2', changesetJson: JSON.stringify(recoveredEntries),
      status: 'applied', jobType: 'image-insert',
    }]);
    mocks.readPage.mockReturnValue({
      frontmatter: { title: 'Page A' },
      body: '> [!diagram]\n> ![Explanation](/api/assets/general/image-1.png)',
    });

    await expect(runImageInsertJob(job(), vi.fn())).resolves.toEqual({
      subjectId: subject.id,
      slug: 'page-a',
      assetUrl: '/api/assets/general/image-1.png',
      operationId: 'changeset-recovered',
      recovered: true,
    });
    expect(mocks.generateImage).not.toHaveBeenCalled();
    expect(mocks.applyChangeset).not.toHaveBeenCalled();
    expect(mocks.enqueueEmbedIndex).toHaveBeenCalledWith(subject.id);

    mocks.enqueueEmbedIndex.mockImplementationOnce(() => { throw new Error('queue unavailable'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(runImageInsertJob(job(), vi.fn())).resolves.toMatchObject({ recovered: true });
    expect(warn).toHaveBeenCalledWith(
      '[image-insert] embedding enqueue failed (ignored)', expect.any(Error),
    );
    warn.mockRestore();
  });

  it('validation 或 apply 失败时不补 embedding，资产不会旁路写入', async () => {
    mocks.validateChangeset.mockReturnValueOnce({
      valid: false, errors: ['invalid asset'], warnings: [],
    });
    await expect(runImageInsertJob(job(), vi.fn())).rejects.toThrow(/invalid asset/);
    expect(mocks.applyChangeset).not.toHaveBeenCalled();
    expect(mocks.enqueueEmbedIndex).not.toHaveBeenCalled();

    mocks.validateChangeset.mockReturnValue({ valid: true, errors: [], warnings: [] });
    mocks.applyChangeset.mockRejectedValueOnce(new Error('git failed'));
    await expect(runImageInsertJob(job(), vi.fn())).rejects.toThrow(/git failed/);
    expect(mocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it('job 与 payload Subject 不一致时在任何读取或生图前拒绝', async () => {
    await expect(runImageInsertJob(job({ subjectId: 's2' }), vi.fn()))
      .rejects.toThrow(/subject does not match/i);
    expect(mocks.getSubject).not.toHaveBeenCalled();
    expect(mocks.generateImage).not.toHaveBeenCalled();
  });
});
