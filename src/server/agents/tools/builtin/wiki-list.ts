import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({});
const OutputSchema = z.object({
  pages: z.array(z.object({
    slug: z.string(), title: z.string(), summary: z.string(), tags: z.array(z.string()),
  })),
  total: z.number().int(),
});

export const wikiListTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.list',
  source: 'builtin',
  description: 'List all pages in the current subject (slug, title, summary, tags). Use for broad/overview questions.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(_input, ctx) {
    const pages = await ctx.listPages();
    for (const p of pages) ctx.onAccess?.({ slug: p.slug, title: p.title });
    return { pages, total: pages.length };
  },
};
