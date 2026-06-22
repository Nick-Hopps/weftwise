import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfigured = vi.fn();
const mockModelId = vi.fn();
const mockGenEmb = vi.fn();
const mockGetAllPages = vi.fn();
const mockReadPage = vi.fn();
const mockList = vi.fn();
const mockUpsert = vi.fn();
const mockPrune = vi.fn();
const mockGetSubject = vi.fn();

vi.mock('@/server/jobs/worker', () => ({ registerHandler: vi.fn() }));
vi.mock('@/server/jobs/queue', () => ({ enqueue: vi.fn() }));
vi.mock('@/server/llm/provider-registry', () => ({
  isEmbeddingConfigured: () => mockConfigured(),
  embeddingModelId: () => mockModelId(),
  generateEmbeddings: (texts: string[]) => mockGenEmb(texts),
}));
vi.mock('@/server/db/repos/pages-repo', () => ({ getAllPages: (s: unknown) => mockGetAllPages(s) }));
vi.mock('@/server/db/repos/subjects-repo', () => ({ getById: (s: unknown) => mockGetSubject(s) }));
vi.mock('@/server/db/repos/embeddings-repo', () => ({
  listForSubject: (s: unknown, m: unknown) => mockList(s, m),
  upsertEmbedding: (row: unknown) => mockUpsert(row),
  pruneOrphans: (s: unknown, live: unknown) => mockPrune(s, live),
}));
vi.mock('@/server/wiki/wiki-store', () => ({ readPageInSubject: (ss: unknown, slug: unknown) => mockReadPage(ss, slug) }));

import { runEmbedIndex } from '../embedding-service';

beforeEach(() => {
  vi.clearAllMocks();
  mockConfigured.mockReturnValue(true);
  mockModelId.mockReturnValue('m1');
  mockGetSubject.mockReturnValue({ id: 's1', slug: 'sub-a' });
  mockReadPage.mockReturnValue({ body: 'BODY' });
  mockGenEmb.mockResolvedValue([[1, 0]]);
});

describe('runEmbedIndex', () => {
  it('未配置 embedding → no-op（不读页/不嵌入）', async () => {
    mockConfigured.mockReturnValue(false);
    await runEmbedIndex('s1');
    expect(mockGetAllPages).not.toHaveBeenCalled();
    expect(mockGenEmb).not.toHaveBeenCalled();
  });

  it('只嵌入缺/过期页，跳过新鲜页', async () => {
    mockGetAllPages.mockReturnValue([
      { slug: 'a', title: 'A', summary: 'sa', contentHash: 'h1' }, // 已有同 hash → 跳过
      { slug: 'b', title: 'B', summary: 'sb', contentHash: 'h2new' }, // hash 变 → 重嵌
      { slug: 'c', title: 'C', summary: 'sc', contentHash: 'h3' }, // 无向量 → 嵌
    ]);
    mockList.mockReturnValue([
      { slug: 'a', contentHash: 'h1', dim: 2, vector: Buffer.alloc(8) },
      { slug: 'b', contentHash: 'h2old', dim: 2, vector: Buffer.alloc(8) },
    ]);
    mockGenEmb.mockResolvedValue([[1, 0], [0, 1]]); // b, c
    await runEmbedIndex('s1');
    expect(mockGenEmb).toHaveBeenCalledTimes(1);
    const embeddedSlugs = mockUpsert.mock.calls.map((c) => c[0].slug).sort();
    expect(embeddedSlugs).toEqual(['b', 'c']);
    expect(mockPrune).toHaveBeenCalledWith('s1', ['a', 'b', 'c']);
  });

  it('全部新鲜 → 不调 generateEmbeddings，但仍 prune', async () => {
    mockGetAllPages.mockReturnValue([{ slug: 'a', title: 'A', summary: '', contentHash: 'h1' }]);
    mockList.mockReturnValue([{ slug: 'a', contentHash: 'h1', dim: 2, vector: Buffer.alloc(8) }]);
    await runEmbedIndex('s1');
    expect(mockGenEmb).not.toHaveBeenCalled();
    expect(mockPrune).toHaveBeenCalledWith('s1', ['a']);
  });
});
