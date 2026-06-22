import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSearch = vi.fn();
const mockConfigured = vi.fn();
const mockGenEmb = vi.fn();
const mockSemantic = vi.fn();

vi.mock('@/server/db/repos/pages-repo', () => ({ searchPages: (s: unknown, q: unknown) => mockSearch(s, q) }));
vi.mock('@/server/llm/provider-registry', () => ({
  isEmbeddingConfigured: () => mockConfigured(),
  generateEmbeddings: (t: string[]) => mockGenEmb(t),
}));
vi.mock('../semantic-search', () => ({ semanticSearch: (s: unknown, v: unknown, k: unknown) => mockSemantic(s, v, k) }));

import { hybridRankSlugs } from '../hybrid-retrieval';

beforeEach(() => {
  vi.clearAllMocks();
  mockSearch.mockReturnValue([{ page: { slug: 'x' } }, { page: { slug: 'y' } }]);
});

describe('hybridRankSlugs', () => {
  it('未配置 embedding → 纯 FTS（不调 generateEmbeddings）', async () => {
    mockConfigured.mockReturnValue(false);
    const out = await hybridRankSlugs('s1', 'q', 5);
    expect(out).toEqual(['x', 'y']);
    expect(mockGenEmb).not.toHaveBeenCalled();
  });

  it('配置后 → FTS + 向量 RRF 合并去重', async () => {
    mockConfigured.mockReturnValue(true);
    mockGenEmb.mockResolvedValue([[1, 0]]);
    mockSemantic.mockReturnValue([{ slug: 'y', score: 0.9 }, { slug: 'z', score: 0.8 }]);
    const out = await hybridRankSlugs('s1', 'q', 5);
    expect(out[0]).toBe('y'); // 双榜
    expect(new Set(out).size).toBe(out.length);
    expect(out).toContain('z');
  });

  it('查询嵌入抛错 → 回退纯 FTS', async () => {
    mockConfigured.mockReturnValue(true);
    mockGenEmb.mockRejectedValue(new Error('embed down'));
    const out = await hybridRankSlugs('s1', 'q', 5);
    expect(out).toEqual(['x', 'y']);
  });
});
