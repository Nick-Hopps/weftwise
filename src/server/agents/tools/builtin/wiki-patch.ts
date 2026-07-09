import { z } from 'zod';
import type { ToolDef } from '../../types';

const EditSchema = z.object({
  oldString: z.string().min(1).describe('Exact text that currently exists in the page body, verbatim — not a paraphrase. Must match exactly one location; include surrounding context to disambiguate.'),
  newString: z.string().describe('Replacement text. Empty string deletes the matched text.'),
});
const InputSchema = z.object({
  slug: z.string().trim().min(1),
  edits: z.array(EditSchema).min(1).describe('Applied in order; ALL must match or NOTHING is applied (one git commit).'),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  updatedSlug: z.string().nullable(),
  appliedEdits: z.number().nullable(),
  message: z.string(),
});

export const wikiPatchTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.patch',
  source: 'builtin',
  description:
    'Make targeted partial edits to the BODY of an EXISTING wiki page in the current subject. This CHANGES the wiki. ' +
    'Prefer this over wiki.update for small corrections — you only provide the fragments to change, so untouched content cannot be altered. ' +
    'Each oldString must be quoted verbatim from the page (read it first) and match exactly once. ' +
    'Cannot change the title, tags or summary — use wiki.update for those, or for full rewrites. ' +
    'Only use [[Page Title]] wikilinks to pages that already exist; a broken link causes the WHOLE batch to be REJECTED (nothing applied).',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'update',
  async handler(input, ctx) {
    if (!ctx.patchPage) {
      return { ok: false, updatedSlug: null, appliedEdits: null, message: 'Patching a page is not available in this context.' };
    }
    try {
      const { updatedSlug, appliedEdits } = await ctx.patchPage(input);
      return { ok: true, updatedSlug, appliedEdits, message: `Patched "${updatedSlug}" (${appliedEdits} edit${appliedEdits === 1 ? '' : 's'}).` };
    } catch (err) {
      return { ok: false, updatedSlug: null, appliedEdits: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
