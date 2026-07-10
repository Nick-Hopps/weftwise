import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  sourceId: z.string().min(1),
  chunkId: z.string().min(1).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(20_000).optional(),
});
const OutputSchema = z.object({
  sourceId: z.string(),
  filename: z.string(),
  chunkId: z.string().nullable(),
  content: z.string().max(20_000),
  nextOffset: z.number().int().nonnegative().nullable(),
  truncated: z.boolean(),
});

export const sourceReadTool: ToolDef<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>
> = {
  name: 'source.read',
  source: 'builtin',
  description: 'Read a bounded parsed source chunk or window in the current subject.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    if (!ctx.readSource) {
      throw new Error('[TOOL_NOT_ALLOWED] source.read is unavailable in this runner.');
    }
    const result = await ctx.readSource(input);
    ctx.onSourceAccess?.({
      sourceId: result.sourceId,
      chunkId: result.chunkId ?? undefined,
    });
    return result;
  },
};
