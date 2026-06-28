import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockGetPageBySlug = vi.fn();
const mockEnqueue = vi.fn();
vi.mock('@/server/db/repos/pages-repo', () => ({
  getPageBySlug: (...a: unknown[]) => mockGetPageBySlug(...a),
}));
vi.mock('@/server/jobs/queue', () => ({
  enqueue: (...a: unknown[]) => mockEnqueue(...a),
}));

import { validateReenrichTarget, enqueueReenrich } from '../reenrich-enqueue';

describe('validateReenrichTarget', () => {
  it('meta slug（index/log）→ 错误', () => {
    expect(validateReenrichTarget('index', { tags: [] })).toMatch(/meta/);
    expect(validateReenrichTarget('log', { tags: [] })).toMatch(/meta/);
  });
  it('页不存在 → 错误', () => {
    expect(validateReenrichTarget('ghost', null)).toMatch(/not found/);
  });
  it('meta 标签页 → 错误', () => {
    expect(validateReenrichTarget('eigen', { tags: ['meta', 'math'] })).toMatch(/meta/);
  });
  it('正常页 → null（可入队）', () => {
    expect(validateReenrichTarget('eigen', { tags: ['math'] })).toBeNull();
  });
});

describe('enqueueReenrich', () => {
  beforeEach(() => {
    mockGetPageBySlug.mockReset();
    mockEnqueue.mockReset();
  });
  it('正常页 → enqueue 并返回 jobId', () => {
    mockGetPageBySlug.mockReturnValue({ slug: 'eigen', tags: ['math'] });
    mockEnqueue.mockReturnValue({ id: 'job-9' });
    const out = enqueueReenrich('s1', 'eigen');
    expect(mockEnqueue).toHaveBeenCalledWith('re-enrich', { slug: 'eigen', subjectId: 's1' }, 's1');
    expect(out).toEqual({ jobId: 'job-9' });
  });
  it('缺页 → 抛错，不 enqueue', () => {
    mockGetPageBySlug.mockReturnValue(null);
    expect(() => enqueueReenrich('s1', 'ghost')).toThrow(/not found/);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
