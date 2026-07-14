import { describe, it, expect, vi } from 'vitest';
import { wikiReenrichTool } from '../wiki-reenrich';
import type { ToolContext } from '../../tool-context';

const baseCtx = { subject: { id: 's', slug: 'general' } } as ToolContext;

describe('wiki.reenrich tool', () => {
  it('能力存在 → 生成审批并通知 UI，不直接入队', async () => {
    const action = { actionId: 'action-1' };
    const previewWorkflowReenrich = vi.fn().mockResolvedValue(action);
    const onPendingAction = vi.fn();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await wikiReenrichTool.handler(
      { slug: 'eigenvalues' },
      { ...baseCtx, previewWorkflowReenrich, onPendingAction },
    );
    expect(previewWorkflowReenrich).toHaveBeenCalledWith('eigenvalues');
    expect(onPendingAction).toHaveBeenCalledWith(action);
    expect(out).toBe(action);
    warning.mockRestore();
  });
  it('能力缺失 → 稳定拒绝', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(wikiReenrichTool.handler({ slug: 'x' }, baseCtx))
      .rejects.toThrow(/ACTION_PLAN_INVALID/);
    warning.mockRestore();
  });
  it('规划失败 → 原样拒绝，不伪装为已启动', async () => {
    const previewWorkflowReenrich = vi.fn()
      .mockRejectedValue(new Error('Page "x" not found in this subject.'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(wikiReenrichTool.handler(
      { slug: 'x' },
      { ...baseCtx, previewWorkflowReenrich },
    )).rejects.toThrow(/not found/);
    warning.mockRestore();
  });
});
