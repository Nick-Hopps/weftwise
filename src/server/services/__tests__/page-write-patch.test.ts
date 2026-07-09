import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../wiki/page-ops', () => ({
  executePagePatch: vi.fn(async () => ({ updatedSlug: 'foo', appliedEdits: 1 })),
}));
vi.mock('../embedding-service', () => ({ enqueueEmbedIndex: vi.fn() }));

import { patchPageInSubject } from '../page-write';
import { executePagePatch } from '../../wiki/page-ops';
import { enqueueEmbedIndex } from '../embedding-service';

const subject = { id: 'sub1', slug: 'general', name: 'General' } as never;

beforeEach(() => vi.clearAllMocks());

describe('patchPageInSubject', () => {
  it('META 保护页拒绝，不触内核', async () => {
    await expect(patchPageInSubject(subject, { slug: 'index', edits: [{ oldString: 'a', newString: 'b' }] }))
      .rejects.toThrow(/protected system page/);
    expect(executePagePatch).not.toHaveBeenCalled();
  });

  it('成功路径：调内核 + enqueue embed', async () => {
    const res = await patchPageInSubject(subject, { slug: 'foo', edits: [{ oldString: 'a', newString: 'b' }] });
    expect(res).toEqual({ updatedSlug: 'foo', appliedEdits: 1 });
    expect(enqueueEmbedIndex).toHaveBeenCalledWith('sub1');
  });

  it('内核抛错透传', async () => {
    vi.mocked(executePagePatch).mockRejectedValueOnce(new Error('edit #1: old_string not found'));
    await expect(patchPageInSubject(subject, { slug: 'foo', edits: [{ oldString: 'x', newString: 'y' }] }))
      .rejects.toThrow(/not found/);
    expect(enqueueEmbedIndex).not.toHaveBeenCalled();
  });
});
