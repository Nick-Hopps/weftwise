import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  subjectSlug: z.string().trim().min(1),
  slug: z.string().trim().min(1),
});
const OutputSchema = z.object({
  found: z.boolean(),
  subjectSlug: z.string(),
  slug: z.string(),
  title: z.string().nullable(),
  body: z.string().nullable(),
});

export const wikiReadCrossSubjectTool: ToolDef<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>
> = {
  name: 'wiki.read_cross_subject',
  source: 'builtin',
  description: 'Read one committed non-system page from an explicitly named subject other than the active subject. Use subjectSlug exactly as returned by subject.list.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    if (!ctx.readCrossSubjectPage) {
      throw new Error('[TOOL_NOT_ALLOWED] wiki.read_cross_subject is unavailable in this runner.');
    }
    const result = await ctx.readCrossSubjectPage(input);
    if (result.found && result.title && result.body) {
      ctx.onAccess?.({
        subjectSlug: result.subjectSlug,
        slug: result.slug,
        title: result.title,
        body: result.body,
      });
    }
    return result;
  },
};
