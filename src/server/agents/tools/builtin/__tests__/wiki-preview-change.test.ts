import { describe, expect, it, vi } from 'vitest';
import { wikiPreviewChangeTool } from '../wiki-preview-change';

const action = {
  actionId: 'a1', conversationId: 'c1', operation: 'delete', status: 'pending',
  kind: 'page-change', preHead: 'h1', summary: '删除 a',
  affectedPages: [{ slug: 'a', action: 'delete' }], diff: 'diff', warnings: [],
  expiresAt: '2026-07-11T00:30:00.000Z', operationId: null, jobId: null, error: null,
} as const;

describe('wiki.preview_change', () => {
  it('只转发到 context 并在持久化后触发回调', async () => {
    const previewChange = vi.fn(async () => action);
    const onPendingAction = vi.fn();
    const result = await wikiPreviewChangeTool.handler(
      { operation: 'delete', payload: { slug: 'a' } },
      { previewChange, onPendingAction } as never,
    );
    expect(previewChange).toHaveBeenCalledOnce();
    expect(onPendingAction).toHaveBeenCalledWith(action);
    expect(result).toEqual(action);
  });

  it('context 未注入能力时拒绝', async () => {
    await expect(wikiPreviewChangeTool.handler(
      { operation: 'delete', payload: { slug: 'a' } }, {} as never,
    )).rejects.toThrow(/ACTION_PLAN_INVALID/);
  });
});
