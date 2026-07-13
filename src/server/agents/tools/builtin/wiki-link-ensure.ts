import { z } from 'zod';
import type { ToolDef } from '../../types';

const ModeSchema = z.enum(['link', 'unlink', 'retarget']);
const InputSchema = z.object({
  sourceSlug: z.string().trim().min(1),
  targetSubjectSlug: z.string().trim().min(1).optional(),
  targetSlug: z.string().trim().min(1),
  oldString: z.string().min(1),
  displayText: z.string().optional(),
  mode: ModeSchema,
}).strict();
const OutputSchema = z.object({
  ok: z.boolean(),
  updatedSlug: z.string().nullable(),
  mode: ModeSchema.nullable(),
  targetSubjectSlug: z.string().nullable(),
  targetSlug: z.string().nullable(),
  message: z.string(),
}).strict();

export const wikiLinkEnsureTool: ToolDef<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>
> = {
  name: 'wiki.link.ensure',
  source: 'builtin',
  description:
    'Maintain exactly one wikilink in one EXISTING source page using an existing, uniquely matched visible anchor. This CHANGES only the source page. ' +
    'Use mode link to wrap existing prose, unlink to remove one matching token, or retarget to preserve its display text while changing the verified target. ' +
    'Do not rewrite surrounding prose, append Related sections, create targets, or use guessed anchor text.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'update',
  async handler(input, ctx) {
    if (!ctx.linkEnsure) {
      return {
        ok: false,
        updatedSlug: null,
        mode: null,
        targetSubjectSlug: null,
        targetSlug: null,
        message: 'Maintaining a wikilink is not available in this context.',
      };
    }
    try {
      const result = await ctx.linkEnsure(input);
      return {
        ok: true,
        ...result,
        message: `Maintained one link in "${result.updatedSlug}".`,
      };
    } catch (err) {
      return {
        ok: false,
        updatedSlug: null,
        mode: null,
        targetSubjectSlug: null,
        targetSlug: null,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
