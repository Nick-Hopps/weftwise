import { z } from 'zod';
import type { HistoryListInput, HistoryListResult } from '@/lib/contracts';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  slug: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(50).optional(),
}).strict();

const OutputSchema = z.custom<HistoryListResult>();

export const historyListTool: ToolDef<HistoryListInput, HistoryListResult> = {
  name: 'history.list',
  source: 'builtin',
  description: 'List recent committed operations in the active subject, optionally filtered by affected page slug. Read-only.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    if (!ctx.listHistory) {
      throw new Error('[TOOL_UNAVAILABLE] History list is not available in this context.');
    }
    return ctx.listHistory(input);
  },
};
