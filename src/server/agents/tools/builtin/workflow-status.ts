import { z } from 'zod';
import type { WorkflowStatusInput, WorkflowStatusResult } from '@/lib/contracts';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ jobId: z.string().trim().min(1) }).strict();
const OutputSchema = z.custom<WorkflowStatusResult>();

export const workflowStatusTool: ToolDef<WorkflowStatusInput, WorkflowStatusResult> = {
  name: 'workflow.status',
  source: 'builtin',
  description: 'Read a safe status summary for one background job in the active subject. Jobs from other subjects are not visible.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler({ jobId }, ctx) {
    if (!ctx.readWorkflowStatus) {
      throw new Error('Workflow status is not available in this context.');
    }
    return ctx.readWorkflowStatus(jobId);
  },
};
