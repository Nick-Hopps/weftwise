import { describe, expect, it, vi } from 'vitest';
import { wikiPreviewChangeTool } from '../wiki-preview-change';

const action = {
  actionId: 'a1', conversationId: 'c1', operation: 'delete', status: 'pending',
  kind: 'page-change', preHead: 'h1', summary: '删除 a',
  affectedPages: [{ slug: 'a', action: 'delete' }], diff: 'diff', warnings: [],
  expiresAt: '2026-07-11T00:30:00.000Z', operationId: null, jobId: null, error: null,
} as const;

describe('wiki.preview_change', () => {
  it('schema 接受 metadata/link 提案且保持严格 payload', () => {
    expect(wikiPreviewChangeTool.inputSchema.parse({
      operation: 'metadata-patch',
      payload: { slug: 'page-a', aliases: ['Alias A'] },
    })).toEqual({
      operation: 'metadata-patch',
      payload: { slug: 'page-a', aliases: ['Alias A'] },
    });
    expect(wikiPreviewChangeTool.inputSchema.parse({
      operation: 'link-ensure',
      payload: {
        sourceSlug: 'page-a', targetSlug: 'page-b', oldString: 'Page B', mode: 'link',
      },
    })).toMatchObject({ operation: 'link-ensure' });
    expect(() => wikiPreviewChangeTool.inputSchema.parse({
      operation: 'metadata-patch',
      payload: { slug: 'page-a', summary: 'Summary', unexpected: true },
    })).toThrow();
  });

  it('描述明确支持两个窄写 operation，且仍只是审批提案', () => {
    expect(wikiPreviewChangeTool.description).toContain('metadata-patch');
    expect(wikiPreviewChangeTool.description).toContain('link-ensure');
    expect(wikiPreviewChangeTool.sideEffect).toBe('propose');
    expect(wikiPreviewChangeTool.description).toMatch(/does not modify/i);
  });

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
