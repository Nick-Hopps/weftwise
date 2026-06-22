import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockList = vi.fn();
const mockModelId = vi.fn();

vi.mock('@/server/db/repos/embeddings-repo', () => ({ listForSubject: (s: unknown, m: unknown) => mockList(s, m) }));
vi.mock('@/server/llm/provider-registry', () => ({ embeddingModelId: () => mockModelId() }));

import { semanticSearch } from '../semantic-search';

const buf = (nums: number[]) => Buffer.from(Float32Array.from(nums).buffer);

beforeEach(() => {
  vi.clearAllMocks();
  mockModelId.mockReturnValue('m1');
});

describe('semanticSearch', () => {
  it('按 cosine 降序返回 topK', () => {
    mockList.mockReturnValue([
      { slug: 'same', contentHash: 'h', dim: 2, vector: buf([1, 0]) },   // cosine=1
      { slug: 'orth', contentHash: 'h', dim: 2, vector: buf([0, 1]) },   // cosine=0
      { slug: 'opp', contentHash: 'h', dim: 2, vector: buf([-1, 0]) },   // cosine=-1
    ]);
    const out = semanticSearch('s1', [1, 0], 2);
    expect(out.map((r) => r.slug)).toEqual(['same', 'orth']);
    expect(out[0].score).toBeCloseTo(1, 6);
    expect(mockList).toHaveBeenCalledWith('s1', 'm1');
  });

  it('无向量 → 空数组', () => {
    mockList.mockReturnValue([]);
    expect(semanticSearch('s1', [1, 0], 5)).toEqual([]);
  });
});
