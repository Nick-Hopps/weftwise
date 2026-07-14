import { describe, expect, it, vi } from 'vitest';
import { wikiMoveTool } from '../wiki-move';

describe('wiki.move', () => {
  it('严格校验 canonical slug 与不同目标', () => {
    expect(wikiMoveTool.inputSchema.parse({
      slug: 'old-page', newSlug: 'folder/new-page',
    })).toEqual({ slug: 'old-page', newSlug: 'folder/new-page' });
    expect(() => wikiMoveTool.inputSchema.parse({
      slug: 'old-page', newSlug: '../escape',
    })).toThrow();
    expect(() => wikiMoveTool.inputSchema.parse({
      slug: 'old-page', newSlug: 'old-page',
    })).toThrow();
  });

  it('只创建 move PendingAction 并触发回调', async () => {
    const action = { actionId: 'a1', operation: 'move' } as never;
    const previewChange = vi.fn(async () => action);
    const onPendingAction = vi.fn();
    await expect(wikiMoveTool.handler(
      { slug: 'old-page', newSlug: 'new-page' },
      { previewChange, onPendingAction } as never,
    )).resolves.toBe(action);
    expect(previewChange).toHaveBeenCalledWith({
      operation: 'move', payload: { slug: 'old-page', newSlug: 'new-page' },
    });
    expect(onPendingAction).toHaveBeenCalledWith(action);
  });

  it('没有审批上下文时拒绝，不执行任何直接写入', async () => {
    await expect(wikiMoveTool.handler(
      { slug: 'old-page', newSlug: 'new-page' },
      {} as never,
    )).rejects.toThrow(/ACTION_PLAN_INVALID/);
  });
});
