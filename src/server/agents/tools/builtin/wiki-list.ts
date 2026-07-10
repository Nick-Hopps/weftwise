import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  tag: z.string().min(1).optional(),
  sort: z.enum(['title', 'updated']).optional(),
});
const OutputSchema = z.object({
  pages: z.array(z.object({
    slug: z.string(), title: z.string(), summary: z.string(), tags: z.array(z.string()),
    updatedAt: z.string(),
  })),
  nextCursor: z.string().nullable(),
});

export const wikiListTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.list',
  source: 'builtin',
  description: 'List pages in the current subject with bounded keyset pagination, filters, and stable sorting.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    const result = await ctx.listPages(input);
    for (const page of result.pages) {
      ctx.onAccess?.({ slug: page.slug, title: page.title });
    }
    return result;
  },
};
