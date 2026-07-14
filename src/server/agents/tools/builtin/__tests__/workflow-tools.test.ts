import { describe, expect, it, vi } from 'vitest';
import { createBuiltinToolRegistry } from '..';

const subject = {
  id: 's1', slug: 'general', name: 'General', description: '',
  augmentationLevel: 'standard', createdAt: '', updatedAt: '',
};

function context() {
  return {
    subject,
    readWorkflowStatus: vi.fn().mockResolvedValue({
      found: true,
      job: { jobId: 'job-1', type: 'research', status: 'running' },
    }),
    previewWorkflowReenrich: vi.fn().mockResolvedValue({ actionId: 'action-reenrich' }),
    previewWorkflowResearch: vi.fn().mockResolvedValue({ actionId: 'action-research' }),
    previewWorkflowCancel: vi.fn().mockResolvedValue({ actionId: 'action-cancel' }),
    onPendingAction: vi.fn(),
    readPage: vi.fn(), search: vi.fn(), listPages: vi.fn(),
  };
}

describe('Phase 3C workflow builtin', () => {
  it('status 只委托 active Subject 上下文并返回安全视图', async () => {
    const ctx = context();
    const tool = createBuiltinToolRegistry().get('workflow.status')!;
    const result = await tool.handler({ jobId: 'job-1' }, ctx as never);
    expect(ctx.readWorkflowStatus).toHaveBeenCalledWith('job-1');
    expect(result).toEqual(expect.objectContaining({ found: true }));
  });

  it.each([
    ['workflow.reenrich.start', { slug: 'page-a' }, 'previewWorkflowReenrich', 'page-a'],
    ['workflow.research.start', { topic: 'SQLite WAL' }, 'previewWorkflowResearch', 'SQLite WAL'],
    ['workflow.cancel', { jobId: 'job-1' }, 'previewWorkflowCancel', 'job-1'],
  ] as const)('%s 只生成 PendingAction 并通知 UI', async (name, args, callback, expected) => {
    const ctx = context();
    const result = await createBuiltinToolRegistry().get(name)!.handler(args, ctx as never);
    expect(ctx[callback]).toHaveBeenCalledWith(expected);
    expect(ctx.onPendingAction).toHaveBeenCalledWith(result);
  });

  it('wiki.reenrich 委托新审批语义并记录弃用日志', async () => {
    const ctx = context();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await createBuiltinToolRegistry().get('wiki.reenrich')!.handler(
      { slug: 'page-a' },
      ctx as never,
    );
    expect(ctx.previewWorkflowReenrich).toHaveBeenCalledWith('page-a');
    expect(ctx.onPendingAction).toHaveBeenCalledWith(result);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('wiki.reenrich'));
    warning.mockRestore();
  });
});
