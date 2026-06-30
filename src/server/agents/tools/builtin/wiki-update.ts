import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  slug: z.string().trim().min(1),
  body: z
    .string()
    .describe('Full corrected markdown body WITHOUT a frontmatter block — the system manages frontmatter (title/timestamps).'),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  updatedSlug: z.string().nullable(),
  message: z.string(),
});

export const wikiUpdateTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.update',
  source: 'builtin',
  description:
    'Replace the body (and optionally summary/tags) of an EXISTING wiki page in the current subject. This CHANGES the wiki. ' +
    'Provide the FULL corrected body, without a frontmatter block. ' +
    'Only use [[Page Title]] wikilinks to pages that already exist; a broken or unresolved link causes the edit to be REJECTED (not applied). ' +
    'Edit faithfully — fix only what the reported issues require; do not drop unrelated content.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'update',
  async handler(input, ctx) {
    if (!ctx.updatePage) {
      return { ok: false, updatedSlug: null, message: 'Updating a page is not available in this context.' };
    }
    try {
      const { updatedSlug } = await ctx.updatePage(input);
      return { ok: true, updatedSlug, message: `Updated "${updatedSlug}".` };
    } catch (err) {
      return { ok: false, updatedSlug: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
