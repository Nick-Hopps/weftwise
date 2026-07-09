import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  slug: z.string().trim().min(1),
  title: z.string().trim().min(1).optional().describe('New title for the page. Omit to keep the current title.'),
  body: z
    .string()
    .describe('Full corrected markdown body WITHOUT a frontmatter block — the system manages frontmatter (title/timestamps).'),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  updatedSlug: z.string().nullable(),
  referencesUpdated: z.number().nullable(),
  message: z.string(),
});

export const wikiUpdateTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.update',
  source: 'builtin',
  description:
    'Replace the title and/or body (and optionally summary/tags) of an EXISTING wiki page in the current subject. This CHANGES the wiki. ' +
    'Provide the FULL corrected body, without a frontmatter block — not a diff or excerpt. ' +
    'Preserve information you have not been asked to remove; do not drop unrelated content. ' +
    'Only use [[Page Title]] wikilinks to pages that already exist; a broken or unresolved link causes the edit to be REJECTED (not applied). ' +
    'If you change the title, every wikilink elsewhere in this subject that references the OLD title is automatically rewritten to the new title.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'update',
  async handler(input, ctx) {
    if (!ctx.updatePage) {
      return { ok: false, updatedSlug: null, referencesUpdated: null, message: 'Updating a page is not available in this context.' };
    }
    try {
      const { updatedSlug, referencesUpdated } = await ctx.updatePage(input);
      const refNote = referencesUpdated > 0
        ? ` (${referencesUpdated} reference${referencesUpdated === 1 ? '' : 's'} updated)`
        : '';
      return { ok: true, updatedSlug, referencesUpdated, message: `Updated "${updatedSlug}".${refNote}` };
    } catch (err) {
      return { ok: false, updatedSlug: null, referencesUpdated: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
