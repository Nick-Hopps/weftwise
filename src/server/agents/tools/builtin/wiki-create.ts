import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  title: z.string().trim().min(1),
  body: z
    .string()
    .describe('Markdown content of the page WITHOUT a frontmatter block — the system writes frontmatter (title/timestamps/tags) deterministically.'),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const OutputSchema = z.object({
  ok: z.boolean(),
  createdSlug: z.string().nullable(),
  message: z.string(),
});

export const wikiCreateTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.create',
  source: 'builtin',
  description:
    'Create a NEW wiki page in the current subject from a title and markdown body. This CHANGES the wiki. ' +
    'The slug is derived from the title automatically (a numeric suffix is added on conflict). ' +
    'Use [[Page Title]] wikilinks only to pages that already exist; broken links are rejected. ' +
    'Only call after the user has explicitly confirmed they want the page created.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'create',
  async handler(input, ctx) {
    if (!ctx.createPage) {
      return { ok: false, createdSlug: null, message: 'Creating a page is not available in this context.' };
    }
    try {
      const { createdSlug } = await ctx.createPage(input);
      return { ok: true, createdSlug, message: `Created "${input.title}" (slug: ${createdSlug}).` };
    } catch (err) {
      return { ok: false, createdSlug: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
