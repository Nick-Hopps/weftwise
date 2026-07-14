import { z } from 'zod';
import type { PendingActionView, WorkflowResearchStartInput } from '@/lib/contracts';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ topic: z.string().trim().min(1).max(500) }).strict();
const OutputSchema = z.custom<PendingActionView>();

export const workflowResearchStartTool: ToolDef<WorkflowResearchStartInput, PendingActionView> = {
  name: 'workflow.research.start',
  source: 'builtin',
  description: 'Create an approval preview for starting public-web research on one topic in the active subject. It does not enqueue a job or import findings.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'propose',
  async handler({ topic }, ctx) {
    if (!ctx.previewWorkflowResearch) {
      throw new Error('[ACTION_PLAN_INVALID] Workflow preview is not available in this context.');
    }
    const action = await ctx.previewWorkflowResearch(topic);
    ctx.onPendingAction?.(action);
    return action;
  },
};
