import { z } from 'zod';
import type { HistoryDiffInput, HistoryDiffResult } from '@/lib/contracts';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ operationId: z.string().trim().min(1) }).strict();
const OutputSchema = z.custom<HistoryDiffResult>();

export const historyDiffTool: ToolDef<HistoryDiffInput, HistoryDiffResult> = {
  name: 'history.diff',
  source: 'builtin',
  description: 'Read the committed diff for one operation in the active subject. Read-only.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    if (!ctx.readHistoryDiff) {
      throw new Error('[TOOL_UNAVAILABLE] History diff is not available in this context.');
    }
    return ctx.readHistoryDiff(input);
  },
};
