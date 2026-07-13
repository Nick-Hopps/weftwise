import { beforeEach, describe, expect, it, vi } from 'vitest';

const opsMocks = vi.hoisted(() => ({
  executePageMetadataPatch: vi.fn(async () => ({
    updatedSlug: 'page-a', referencesUpdated: 0, changedFields: ['tags'],
  })),
}));
vi.mock('../../wiki/page-ops', () => opsMocks);

const planMocks = vi.hoisted(() => ({
  planPageMetadataPatch: vi.fn(async () => ({ operation: 'metadata-patch' })),
}));
vi.mock('../../wiki/page-operation-plan', () => planMocks);

const storeMocks = vi.hoisted(() => ({
  readPageInSubject: vi.fn(() => ({ frontmatter: { title: 'Page A' }, body: 'body' })),
}));
vi.mock('../../wiki/wiki-store', () => storeMocks);

const embedMocks = vi.hoisted(() => ({ enqueueEmbedIndex: vi.fn() }));
vi.mock('../embedding-service', () => embedMocks);

import { patchMetadataInSubject, planMetadataPatchInSubject } from '../page-write';

const subject = { id: 's1', slug: 'general', name: 'General' } as never;

beforeEach(() => {
  vi.clearAllMocks();
  storeMocks.readPageInSubject.mockReturnValue({ frontmatter: { title: 'Page A' }, body: 'body' });
});

describe('metadata page-write 包装', () => {
  it.each(['index', 'log'])('plan/direct 都保护系统页 %s', async (slug) => {
    const input = { slug, tags: ['new-tag'] };
    await expect(planMetadataPatchInSubject(subject, input, '2026-07-13T00:00:00.000Z'))
      .rejects.toThrow(/protected system page/i);
    await expect(patchMetadataInSubject(subject, input))
      .rejects.toThrow(/protected system page/i);
    expect(planMocks.planPageMetadataPatch).not.toHaveBeenCalled();
    expect(opsMocks.executePageMetadataPatch).not.toHaveBeenCalled();
    expect(embedMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it('plan/direct 都在缺页时拒绝', async () => {
    planMocks.planPageMetadataPatch.mockRejectedValueOnce(new Error('page "missing" not found'));
    await expect(planMetadataPatchInSubject(
      subject,
      { slug: 'missing', title: 'Ghost' },
      '2026-07-13T00:00:00.000Z',
    )).rejects.toThrow(/not found/i);
    opsMocks.executePageMetadataPatch.mockRejectedValueOnce(new Error('page "missing" not found'));
    await expect(patchMetadataInSubject(subject, { slug: 'missing', title: 'Ghost' }))
      .rejects.toThrow(/not found/i);
    expect(storeMocks.readPageInSubject).not.toHaveBeenCalled();
    expect(embedMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it('plan 只生成计划，不 apply 或 enqueue', async () => {
    const input = { slug: 'page-a', summary: 'New summary' };
    await planMetadataPatchInSubject(subject, input, '2026-07-13T00:00:00.000Z');
    expect(planMocks.planPageMetadataPatch).toHaveBeenCalledWith(
      expect.any(String), subject, { ...input, effectiveAt: '2026-07-13T00:00:00.000Z' },
    );
    expect(opsMocks.executePageMetadataPatch).not.toHaveBeenCalled();
    expect(embedMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it('direct 成功后只 enqueue 一次，冲突失败不 enqueue', async () => {
    const result = await patchMetadataInSubject(subject, { slug: 'page-a', tags: ['new-tag'] });
    expect(result).toEqual({
      updatedSlug: 'page-a', referencesUpdated: 0, changedFields: ['tags'],
    });
    expect(opsMocks.executePageMetadataPatch).toHaveBeenCalledOnce();
    expect(embedMocks.enqueueEmbedIndex).toHaveBeenCalledTimes(1);
    expect(embedMocks.enqueueEmbedIndex).toHaveBeenCalledWith('s1');

    vi.clearAllMocks();
    opsMocks.executePageMetadataPatch.mockRejectedValueOnce(
      new Error('metadata alias conflict with page "other-page"'),
    );
    await expect(patchMetadataInSubject(subject, { slug: 'page-a', aliases: ['Other'] }))
      .rejects.toThrow(/alias conflict/i);
    expect(embedMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });
});
