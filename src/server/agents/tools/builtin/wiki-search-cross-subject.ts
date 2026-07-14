import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  query: z.string().trim().min(1),
  subjectSlugs: z.array(z.string().trim().min(1)).min(1).max(5),
  limit: z.number().int().min(1).max(20).optional(),
});
const OutputSchema = z.object({
  hits: z.array(z.object({
    subjectSlug: z.string(),
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
  })),
});

export const wikiSearchCrossSubjectTool: ToolDef<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>
> = {
  name: 'wiki.search_cross_subject',
  source: 'builtin',
  description: 'Search explicitly selected subjects other than the active subject. Results always include subjectSlug and are metadata only; read a hit before citing it.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    if (!ctx.searchCrossSubject) {
      throw new Error('[TOOL_NOT_ALLOWED] wiki.search_cross_subject is unavailable in this runner.');
    }
    const result = await ctx.searchCrossSubject(input);
    for (const hit of result.hits) {
      ctx.onAccess?.({
        subjectSlug: hit.subjectSlug,
        slug: hit.slug,
        title: hit.title,
      });
    }
    return result;
  },
};
