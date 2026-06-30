import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ slug: z.string().trim().min(1), hint: z.string().optional() });
const OutputSchema = z.object({
  ok: z.boolean(),
  primarySlug: z.string().nullable(),
  pageSlugs: z.array(z.string()).nullable(),
  message: z.string(),
});

export const wikiSplitTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.split',
  source: 'builtin',
  description:
    'Split ONE overloaded wiki page (slug) in the current subject into multiple independent pages (one primary page carries the original topic; references repoint to it). This CHANGES the wiki. Only split a page that bundles MULTIPLE DISTINCT topics. Optionally pass a hint describing how to divide it.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'split',
  async handler({ slug, hint }, ctx) {
    if (!ctx.splitPage) {
      return { ok: false, primarySlug: null, pageSlugs: null, message: 'Splitting pages is not available in this context.' };
    }
    try {
      const { primarySlug, pageSlugs } = await ctx.splitPage(slug, hint);
      return { ok: true, primarySlug, pageSlugs, message: `Split "${slug}" into ${pageSlugs.length} page(s) (primary: "${primarySlug}").` };
    } catch (err) {
      return { ok: false, primarySlug: null, pageSlugs: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
