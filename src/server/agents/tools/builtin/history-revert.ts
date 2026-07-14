import { z } from 'zod';
import type { HistoryRevertInput, PendingActionView } from '@/lib/contracts';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ operationId: z.string().trim().min(1) }).strict();
const OutputSchema = z.custom<PendingActionView>();

export const historyRevertTool: ToolDef<HistoryRevertInput, PendingActionView> = {
  name: 'history.revert',
  source: 'builtin',
  description: 'Plan reverting one operation in the active subject. Returns a PendingAction that requires separate explicit approval; it never applies the revert itself.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'propose',
  async handler(input, ctx) {
    if (!ctx.previewHistoryRevert) {
      throw new Error('[ACTION_PLAN_INVALID] History revert preview is not available in this context.');
    }
    const action = await ctx.previewHistoryRevert(input.operationId);
    ctx.onPendingAction?.(action);
    return action;
  },
};
