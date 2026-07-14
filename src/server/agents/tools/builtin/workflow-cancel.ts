import { z } from 'zod';
import type { PendingActionView, WorkflowCancelInput } from '@/lib/contracts';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ jobId: z.string().trim().min(1) }).strict();
const OutputSchema = z.custom<PendingActionView>();

export const workflowCancelTool: ToolDef<WorkflowCancelInput, PendingActionView> = {
  name: 'workflow.cancel',
  source: 'builtin',
  description: 'Create an approval preview for cancelling one non-terminal background job in the active subject. It does not cancel the job directly.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'propose',
  async handler({ jobId }, ctx) {
    if (!ctx.previewWorkflowCancel) {
      throw new Error('[ACTION_PLAN_INVALID] Workflow preview is not available in this context.');
    }
    const action = await ctx.previewWorkflowCancel(jobId);
    ctx.onPendingAction?.(action);
    return action;
  },
};
