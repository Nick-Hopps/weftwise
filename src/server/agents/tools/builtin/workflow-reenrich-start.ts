import { z } from 'zod';
import type { PendingActionView, WorkflowReenrichStartInput } from '@/lib/contracts';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ slug: z.string().trim().min(1) }).strict();
const OutputSchema = z.custom<PendingActionView>();

export const workflowReenrichStartTool: ToolDef<WorkflowReenrichStartInput, PendingActionView> = {
  name: 'workflow.reenrich.start',
  source: 'builtin',
  description: 'Create an approval preview for starting re-enrichment of one page in the active subject. It does not enqueue a job.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'propose',
  async handler({ slug }, ctx) {
    if (!ctx.previewWorkflowReenrich) {
      throw new Error('[ACTION_PLAN_INVALID] Workflow preview is not available in this context.');
    }
    const action = await ctx.previewWorkflowReenrich(slug);
    ctx.onPendingAction?.(action);
    return action;
  },
};
