import { describe, it, expect, vi } from 'vitest';
import { wikiReenrichTool } from '../wiki-reenrich';
import type { ToolContext } from '../../tool-context';

const baseCtx = { subject: { id: 's', slug: 'general' } } as ToolContext;

describe('wiki.reenrich tool', () => {
  it('能力存在 → 入队并返回 ok+jobId', async () => {
    const reenrich = vi.fn().mockResolvedValue({ jobId: 'job-1' });
    const out = await wikiReenrichTool.handler({ slug: 'eigenvalues' }, { ...baseCtx, reenrich });
    expect(reenrich).toHaveBeenCalledWith('eigenvalues');
    expect(out).toEqual(expect.objectContaining({ ok: true, jobId: 'job-1' }));
  });
  it('能力缺失 → ok:false，不抛', async () => {
    const out = await wikiReenrichTool.handler({ slug: 'x' }, baseCtx);
    expect(out.ok).toBe(false);
    expect(out.jobId).toBeNull();
  });
  it('enqueue 抛错 → 捕获为 ok:false + message', async () => {
    const reenrich = vi.fn().mockRejectedValue(new Error('Page "x" not found in this subject.'));
    const out = await wikiReenrichTool.handler({ slug: 'x' }, { ...baseCtx, reenrich });
    expect(out.ok).toBe(false);
    expect(out.message).toContain('not found');
  });
});
