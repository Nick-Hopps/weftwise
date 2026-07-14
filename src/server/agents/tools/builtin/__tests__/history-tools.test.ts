import { describe, expect, it, vi } from 'vitest';
import { createBuiltinToolRegistry } from '..';

const subject = {
  id: 's1', slug: 'general', name: 'General', description: '',
  augmentationLevel: 'standard', createdAt: '', updatedAt: '',
};

function context() {
  return {
    subject,
    listHistory: vi.fn().mockResolvedValue({ entries: [{ id: 'op-1' }] }),
    readHistoryDiff: vi.fn().mockResolvedValue({
      operationId: 'op-1', status: 'applied', affectedPages: [], diff: 'diff',
    }),
    previewHistoryRevert: vi.fn().mockResolvedValue({ actionId: 'action-1' }),
    onPendingAction: vi.fn(),
    readPage: vi.fn(), search: vi.fn(), listPages: vi.fn(),
  };
}

describe('Phase 3B History builtin', () => {
  it('list/diff 只委托 active Subject 上下文', async () => {
    const registry = createBuiltinToolRegistry();
    const ctx = context();
    await registry.get('history.list')!.handler({ slug: 'a', limit: 5 }, ctx as never);
    await registry.get('history.diff')!.handler({ operationId: 'op-1' }, ctx as never);
    expect(ctx.listHistory).toHaveBeenCalledWith({ slug: 'a', limit: 5 });
    expect(ctx.readHistoryDiff).toHaveBeenCalledWith({ operationId: 'op-1' });
  });

  it('revert 只生成 PendingAction 并通知 UI，不直接写入', async () => {
    const registry = createBuiltinToolRegistry();
    const ctx = context();
    const result = await registry.get('history.revert')!.handler(
      { operationId: 'op-1' },
      ctx as never,
    );
    expect(ctx.previewHistoryRevert).toHaveBeenCalledWith('op-1');
    expect(ctx.onPendingAction).toHaveBeenCalledWith({ actionId: 'action-1' });
    expect(result).toEqual({ actionId: 'action-1' });
  });

  it('缺少注入能力时返回稳定错误', async () => {
    const registry = createBuiltinToolRegistry();
    const ctx = { ...context(), previewHistoryRevert: undefined };
    await expect(registry.get('history.revert')!.handler(
      { operationId: 'op-1' },
      ctx as never,
    )).rejects.toThrow(/ACTION_PLAN_INVALID/);
  });
});
