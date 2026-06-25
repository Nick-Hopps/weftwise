import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ slug: z.string().min(1) });
const OutputSchema = z.object({
  found: z.boolean(),
  title: z.string().nullable(),
  markdown: z.string().nullable(),
});

export const wikiReadTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.read',
  source: 'builtin',
  description: 'Read the full markdown of a wiki page by slug in the current subject. Returns found:false when missing.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler({ slug }, ctx) {
    const p = await ctx.readPage(slug);
    if (!p) return { found: false, title: null, markdown: null };
    ctx.onAccess?.({ slug, title: p.title, body: p.markdown });
    return { found: true, title: p.title, markdown: p.markdown };
  },
};
