import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { WikiPage } from '@/lib/contracts';
import { pageEditorPagesQueryOptions } from '../page-editor-pages-query';

const PAGES: WikiPage[] = [
  {
    subjectId: 'subject-1',
    slug: 'linear-algebra',
    title: 'Linear Algebra',
    path: 'wiki/general/linear-algebra.md',
    summary: '',
    contentHash: 'hash',
    tags: [],
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
  },
];

describe('pageEditorPagesQueryOptions', () => {
  it('只在 observer 派生标题映射，共享 pages 缓存仍保持数组契约', async () => {
    const apiFetch = vi.fn(async () => Response.json(PAGES));
    const queryClient = new QueryClient();
    const observer = new QueryObserver(
      queryClient,
      pageEditorPagesQueryOptions(apiFetch, 'subject-1'),
    );

    const result = await observer.refetch();

    expect(result.data).toEqual({
      'Linear Algebra': 'linear-algebra',
      'linear algebra': 'linear-algebra',
    });
    expect(queryClient.getQueryData(['pages', 'subject-1'])).toEqual(PAGES);
  });
});
