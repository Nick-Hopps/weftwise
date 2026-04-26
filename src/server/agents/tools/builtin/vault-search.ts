import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  query: z.string().min(1),
  subjectSlug: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
});
const HitSchema = z.object({
  slug: z.string(),
  title: z.string(),
  summary: z.string(),
  source: z.enum(['overlay', 'store']),
});
const OutputSchema = z.object({ hits: z.array(HitSchema) });

export const vaultSearchTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'vault.search',
  source: 'builtin',
  description: 'Search wiki pages by keyword. Includes pages staged in the current job (marked source="overlay").',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    const subjectSlug = input.subjectSlug ?? ctx.subject.slug;
    const limit = input.limit ?? 10;
    const all = await ctx.overlay.search(subjectSlug, input.query);
    return { hits: all.slice(0, limit) };
  },
};
