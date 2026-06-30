import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ slug: z.string().trim().min(1) });
const OutputSchema = z.object({
  ok: z.boolean(),
  deletedSlug: z.string().nullable(),
  brokenBacklinks: z.number().nullable(),
  message: z.string(),
});

export const wikiDeleteTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.delete',
  source: 'builtin',
  description:
    'Permanently delete ONE wiki page by slug in the current subject. This CHANGES the wiki and removes the page. ' +
    'Only call after the user has explicitly confirmed which page to delete in a PRIOR turn. ' +
    'Other pages that link to it are left with broken links (count reported back). ' +
    'The deletion is recorded in History and can be reverted.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'destructive',
  async handler({ slug }, ctx) {
    if (!ctx.deletePage) {
      return { ok: false, deletedSlug: null, brokenBacklinks: null, message: 'Deleting a page is not available in this context.' };
    }
    try {
      const { deletedSlug, brokenBacklinks } = await ctx.deletePage(slug);
      const brokenNote =
        brokenBacklinks > 0
          ? ` ${brokenBacklinks} other page(s) linked to it and now have broken links — run a Health check to fix them.`
          : '';
      return {
        ok: true,
        deletedSlug,
        brokenBacklinks,
        message: `Deleted "${deletedSlug}".${brokenNote} This deletion is recorded in History and can be reverted.`,
      };
    } catch (err) {
      return { ok: false, deletedSlug: null, brokenBacklinks: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
