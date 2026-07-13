import { beforeEach, describe, expect, it, vi } from 'vitest';

const opsMocks = vi.hoisted(() => ({
  executePageLinkEnsure: vi.fn(async () => ({
    updatedSlug: 'source', mode: 'link', targetSubjectSlug: 'general', targetSlug: 'target',
  })),
}));
vi.mock('../../wiki/page-ops', () => opsMocks);

const planMocks = vi.hoisted(() => ({
  planPageLinkEnsure: vi.fn(async () => ({ operation: 'link-ensure' })),
}));
vi.mock('../../wiki/page-operation-plan', () => planMocks);

const storeMocks = vi.hoisted(() => ({
  readPageInSubject: vi.fn(() => ({ frontmatter: { title: 'Source' }, body: 'anchor' })),
}));
vi.mock('../../wiki/wiki-store', () => storeMocks);

const embedMocks = vi.hoisted(() => ({ enqueueEmbedIndex: vi.fn() }));
vi.mock('../embedding-service', () => embedMocks);

import { ensureLinkInSubject, planLinkEnsureInSubject } from '../page-write';

const subject = { id: 's1', slug: 'general', name: 'General' } as never;
const effectiveAt = '2026-07-13T00:00:00.000Z';
const input = {
  sourceSlug: 'source', targetSlug: 'target', oldString: 'anchor', mode: 'link' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('link ensure page-write 包装', () => {
  it.each(['index', 'log'])('plan/direct 都只保护 source 系统页 %s', async (sourceSlug) => {
    const protectedInput = { ...input, sourceSlug };
    await expect(planLinkEnsureInSubject(subject, protectedInput, effectiveAt))
      .rejects.toThrow(/protected system page/i);
    await expect(ensureLinkInSubject(subject, protectedInput))
      .rejects.toThrow(/protected system page/i);
    expect(planMocks.planPageLinkEnsure).not.toHaveBeenCalled();
    expect(opsMocks.executePageLinkEnsure).not.toHaveBeenCalled();
    expect(embedMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it('target 是系统页时仍允许，包装层不自行读取 source', async () => {
    const targetIsSystem = { ...input, targetSlug: 'index' };
    await planLinkEnsureInSubject(subject, targetIsSystem, effectiveAt);
    await ensureLinkInSubject(subject, targetIsSystem);
    expect(planMocks.planPageLinkEnsure).toHaveBeenCalledOnce();
    expect(opsMocks.executePageLinkEnsure).toHaveBeenCalledOnce();
    expect(storeMocks.readPageInSubject).not.toHaveBeenCalled();
  });

  it('缺 source 由共享内核拒绝，包装层不重复读页且不 enqueue', async () => {
    planMocks.planPageLinkEnsure.mockRejectedValueOnce(new Error('page "missing" not found'));
    await expect(planLinkEnsureInSubject(
      subject,
      { ...input, sourceSlug: 'missing' },
      effectiveAt,
    )).rejects.toThrow(/not found/i);

    opsMocks.executePageLinkEnsure.mockRejectedValueOnce(new Error('page "missing" not found'));
    await expect(ensureLinkInSubject(subject, { ...input, sourceSlug: 'missing' }))
      .rejects.toThrow(/not found/i);
    expect(storeMocks.readPageInSubject).not.toHaveBeenCalled();
    expect(embedMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it('plan 只生成计划，不 execute 或 enqueue', async () => {
    await planLinkEnsureInSubject(subject, input, effectiveAt);
    expect(planMocks.planPageLinkEnsure).toHaveBeenCalledWith(
      expect.any(String), subject, { ...input, effectiveAt },
    );
    expect(opsMocks.executePageLinkEnsure).not.toHaveBeenCalled();
    expect(embedMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });

  it('direct 成功只 enqueue 一次，内核失败不 enqueue', async () => {
    const result = await ensureLinkInSubject(subject, input);
    expect(result).toEqual({
      updatedSlug: 'source', mode: 'link', targetSubjectSlug: 'general', targetSlug: 'target',
    });
    expect(opsMocks.executePageLinkEnsure).toHaveBeenCalledOnce();
    expect(embedMocks.enqueueEmbedIndex).toHaveBeenCalledTimes(1);
    expect(embedMocks.enqueueEmbedIndex).toHaveBeenCalledWith('s1');

    vi.clearAllMocks();
    opsMocks.executePageLinkEnsure.mockRejectedValueOnce(new Error('concurrent vault update'));
    await expect(ensureLinkInSubject(subject, input)).rejects.toThrow(/concurrent/i);
    expect(embedMocks.enqueueEmbedIndex).not.toHaveBeenCalled();
  });
});
