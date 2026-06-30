import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ targetSlug: z.string().trim().min(1), sourceSlug: z.string().trim().min(1) });
const OutputSchema = z.object({
  ok: z.boolean(),
  mergedSlug: z.string().nullable(),
  deletedSlug: z.string().nullable(),
  referencesRepointed: z.number().nullable(),
  message: z.string(),
});

export const wikiMergeTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.merge',
  source: 'builtin',
  description:
    'Merge ONE wiki page (sourceSlug) into another (targetSlug) in the current subject: the source content is folded into the target, the source page is deleted, and references to it are repointed to the target. This CHANGES the wiki. Only merge pages that SUBSTANTIALLY duplicate each other.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'merge',
  async handler({ targetSlug, sourceSlug }, ctx) {
    if (!ctx.mergePages) {
      return { ok: false, mergedSlug: null, deletedSlug: null, referencesRepointed: null, message: 'Merging pages is not available in this context.' };
    }
    try {
      const { mergedSlug, deletedSlug, referencesRepointed } = await ctx.mergePages(targetSlug, sourceSlug);
      return { ok: true, mergedSlug, deletedSlug, referencesRepointed, message: `Merged "${deletedSlug}" into "${mergedSlug}" (${referencesRepointed} reference(s) repointed).` };
    } catch (err) {
      return { ok: false, mergedSlug: null, deletedSlug: null, referencesRepointed: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
