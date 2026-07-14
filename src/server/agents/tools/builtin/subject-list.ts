import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({});
const OutputSchema = z.object({
  subjects: z.array(z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
    description: z.string(),
    pageCount: z.number().int().nonnegative(),
  })),
});

export const subjectListTool: ToolDef<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>
> = {
  name: 'subject.list',
  source: 'builtin',
  description: 'List available wiki subjects with stable slugs and non-system page counts. Read-only and does not switch the active subject.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(_input, ctx) {
    if (!ctx.listSubjects) {
      throw new Error('[TOOL_NOT_ALLOWED] subject.list is unavailable in this runner.');
    }
    return ctx.listSubjects();
  },
};
