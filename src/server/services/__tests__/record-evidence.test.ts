import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAppend = vi.fn();
vi.mock('@/server/db/repos/evidence-repo', () => ({
  appendEvidence: (...a: unknown[]) => mockAppend(...a),
}));

import { recordEvidence, recordEvidenceBatch } from '../record-evidence';

const ROW = {
  userId: 'local',
  subjectId: 's1',
  slug: 'p',
  kind: 'citation-hit' as const,
};

beforeEach(() => {
  mockAppend.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('recordEvidence —— best-effort 语义', () => {
  it('正常路径透传给 repo', () => {
    recordEvidence(ROW);
    expect(mockAppend).toHaveBeenCalledWith(ROW);
  });

  it('repo 抛错时吞掉并只 console.error —— 绝不影响主流程', () => {
    // 为了记一条锦上添花的派生事实而让阅读/问答/重塑失败，是完全不成比例的代价。
    mockAppend.mockImplementation(() => {
      throw new Error('db locked');
    });
    expect(() => recordEvidence(ROW)).not.toThrow();
    expect(console.error).toHaveBeenCalled();
  });

  it('批量时一条失败不影响其余', () => {
    mockAppend.mockImplementation((row: { slug: string }) => {
      if (row.slug === 'bad') throw new Error('boom');
    });
    expect(() =>
      recordEvidenceBatch([{ ...ROW, slug: 'a' }, { ...ROW, slug: 'bad' }, { ...ROW, slug: 'b' }]),
    ).not.toThrow();
    expect(mockAppend).toHaveBeenCalledTimes(3);
  });

  it('空批量不调 repo', () => {
    recordEvidenceBatch([]);
    expect(mockAppend).not.toHaveBeenCalled();
  });
});
