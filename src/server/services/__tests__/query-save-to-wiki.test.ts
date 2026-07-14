import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createPageInSubject: vi.fn(),
  listAppliedForJob: vi.fn(),
  readPageInSubject: vi.fn(),
  enqueueEmbedIndex: vi.fn(),
}));

vi.mock('../page-write', () => ({
  createPageInSubject: mocks.createPageInSubject,
}));
vi.mock('../../db/repos/operations-repo', () => ({
  listAppliedForJob: mocks.listAppliedForJob,
}));
vi.mock('../../wiki/wiki-store', () => ({
  readPageInSubject: mocks.readPageInSubject,
}));
vi.mock('../embedding-enqueue', () => ({
  enqueueEmbedIndex: mocks.enqueueEmbedIndex,
}));

vi.mock('../../jobs/worker', () => ({ registerHandler: vi.fn() }));
vi.mock('../../db/repos/subjects-repo', () => ({ getById: vi.fn() }));
vi.mock('../../db/repos/settings-repo', () => ({
  getWikiLanguage: vi.fn(() => 'English'),
  getWebSearchConfig: vi.fn(() => ({ provider: 'tavily', apiKey: '', maxResults: 5 })),
}));
vi.mock('../../llm/provider-registry', () => ({
  generateStructuredOutput: vi.fn(),
  streamTextWithTools: vi.fn(),
  generateTextWithTools: vi.fn(),
}));
vi.mock('../query-tools', () => ({
  buildQueryToolContext: vi.fn(),
  createAccessedPages: vi.fn(),
  accessedToContext: vi.fn(),
}));
vi.mock('../citation-extract', () => ({ extractCitationsFromAnswer: vi.fn() }));
vi.mock('@/server/agents/tools/builtin', () => ({
  createBuiltinToolRegistry: () => ({ resolve: vi.fn(() => []) }),
}));
vi.mock('@/server/agents/tools/compile', () => ({ compileToolSet: vi.fn() }));
vi.mock('@/server/db/repos/research-backlog-repo', () => ({ create: vi.fn() }));

import { saveQueryAsPage } from '../query-service';

const subject = {
  id: 'subject-1',
  slug: 'general',
  name: 'General',
  description: '',
  augmentationLevel: 'standard',
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
} as const;

function operation(changeset: unknown) {
  return {
    id: 'operation-1',
    jobId: 'save-job-1',
    subjectId: subject.id,
    preHead: 'head-1',
    postHead: 'head-2',
    changesetJson: JSON.stringify(changeset),
    status: 'applied',
    jobType: 'save-to-wiki',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listAppliedForJob.mockReturnValue([]);
  mocks.createPageInSubject.mockResolvedValue({ createdSlug: 'answer-page-2' });
  mocks.readPageInSubject.mockReturnValue({ frontmatter: { title: 'Answer Page' }, body: 'Answer' });
});

describe('saveQueryAsPage', () => {
  it('把回答与页面引用交给 shared create command，并返回真实冲突后缀 slug', async () => {
    const slug = await saveQueryAsPage(
      'Answer body',
      'Answer Page',
      [
        { pageSlug: 'page-a', excerpt: 'Excerpt A' },
        { pageSlug: 'page-b', excerpt: 'Excerpt B', subjectSlug: 'notes' },
      ],
      subject,
      'save-job-1',
    );

    expect(mocks.createPageInSubject).toHaveBeenCalledWith(
      subject,
      {
        title: 'Answer Page',
        body: [
          'Answer body',
          '',
          '## References',
          '',
          '- [[page-a]]: Excerpt A',
          '- [[notes:page-b]]: Excerpt B',
          '',
        ].join('\n'),
        tags: ['query-answer'],
      },
      { jobId: 'save-job-1' },
    );
    expect(slug).toBe('answer-page-2');
  });

  it('无引用时不生成 References 空章节', async () => {
    await saveQueryAsPage('Answer body', 'Answer Page', [], subject, 'save-job-1');

    expect(mocks.createPageInSubject).toHaveBeenCalledWith(
      subject,
      { title: 'Answer Page', body: 'Answer body\n', tags: ['query-answer'] },
      { jobId: 'save-job-1' },
    );
  });

  it('同一 job 已有 applied create → 恢复 canonical slug，不重复创建并补 enqueue embedding', async () => {
    mocks.listAppliedForJob.mockReturnValue([
      operation([{ action: 'create', path: 'wiki/general/answer-page-2.md', content: '...' }]),
    ]);

    const slug = await saveQueryAsPage(
      'Answer body',
      'Answer Page',
      [],
      subject,
      'save-job-1',
    );

    expect(slug).toBe('answer-page-2');
    expect(mocks.createPageInSubject).not.toHaveBeenCalled();
    expect(mocks.readPageInSubject).toHaveBeenCalledWith('general', 'answer-page-2');
    expect(mocks.enqueueEmbedIndex).toHaveBeenCalledWith(subject.id);
  });

  it.each([
    ['损坏 JSON', '{'],
    ['多个 create', JSON.stringify([
      { action: 'create', path: 'wiki/general/a.md', content: '...' },
      { action: 'create', path: 'wiki/general/b.md', content: '...' },
    ])],
    ['损坏 create entry', JSON.stringify([
      { action: 'create', path: 'wiki/general/a.md', content: '...' },
      { action: 'create', content: '...' },
    ])],
    ['非 canonical path', JSON.stringify([
      { action: 'create', path: 'answer-page.md', content: '...' },
    ])],
    ['跨 Subject path', JSON.stringify([
      { action: 'create', path: 'wiki/other/answer-page.md', content: '...' },
    ])],
  ])('%s 的 applied operation → 拒绝猜测', async (_label, changesetJson) => {
    mocks.listAppliedForJob.mockReturnValue([
      { ...operation([]), changesetJson },
    ]);

    await expect(saveQueryAsPage(
      'Answer body',
      'Answer Page',
      [],
      subject,
      'save-job-1',
    )).rejects.toThrow(/recover/i);

    expect(mocks.createPageInSubject).not.toHaveBeenCalled();
    expect(mocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it('operation 指向的页面已不存在 → 拒绝恢复', async () => {
    mocks.listAppliedForJob.mockReturnValue([
      operation([{ action: 'create', path: 'wiki/general/answer-page.md', content: '...' }]),
    ]);
    mocks.readPageInSubject.mockReturnValue(null);

    await expect(saveQueryAsPage(
      'Answer body',
      'Answer Page',
      [],
      subject,
      'save-job-1',
    )).rejects.toThrow(/no longer exists/i);

    expect(mocks.createPageInSubject).not.toHaveBeenCalled();
    expect(mocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });
});
