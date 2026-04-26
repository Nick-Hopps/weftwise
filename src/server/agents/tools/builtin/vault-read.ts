import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  slug: z.string(),
  subjectSlug: z.string().optional(),
});
const OutputSchema = z.object({
  found: z.boolean(),
  markdown: z.string().nullable(),
});

export const vaultReadTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'vault.read',
  source: 'builtin',
  description: 'Read a wiki page by slug. Returns null when the page does not exist. Includes pages staged in the current job.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    const subjectSlug = input.subjectSlug ?? ctx.subject.slug;
    const result = await ctx.overlay.readPage(subjectSlug, input.slug);
    return { found: result !== null, markdown: result ? result.markdown : null };
  },
};
