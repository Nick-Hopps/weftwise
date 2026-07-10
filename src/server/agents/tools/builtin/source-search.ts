import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  query: z.string().trim().min(1),
  pageSlug: z.string().min(1).optional(),
  sourceIds: z.array(z.string().min(1)).optional(),
  limit: z.number().int().min(1).max(10).optional(),
});
const OutputSchema = z.object({
  hits: z.array(z.object({
    sourceId: z.string(),
    filename: z.string(),
    chunkId: z.string(),
    heading: z.string(),
    excerpt: z.string().max(2_000),
    score: z.number().nonnegative(),
  })),
});

export const sourceSearchTool: ToolDef<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>
> = {
  name: 'source.search',
  source: 'builtin',
  description: 'Search parsed source chunks in the current subject and return bounded excerpts.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    if (!ctx.searchSources) {
      throw new Error('[TOOL_NOT_ALLOWED] source.search is unavailable in this runner.');
    }
    const result = await ctx.searchSources(input);
    for (const hit of result.hits) {
      ctx.onSourceAccess?.({ sourceId: hit.sourceId, chunkId: hit.chunkId });
    }
    return result;
  },
};
