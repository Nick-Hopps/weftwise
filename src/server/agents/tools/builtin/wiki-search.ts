import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).optional(),
});
const OutputSchema = z.object({
  hits: z.array(z.object({ slug: z.string(), title: z.string(), summary: z.string() })),
});

export const wikiSearchTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.search',
  source: 'builtin',
  description: 'Search wiki pages in the current subject by keyword or phrase. Returns matching pages (slug, title, summary).',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler({ query, limit }, ctx) {
    const hits = await ctx.search(query, limit ?? 8);
    for (const h of hits) ctx.onAccess?.({ slug: h.slug, title: h.title });
    return { hits };
  },
};
