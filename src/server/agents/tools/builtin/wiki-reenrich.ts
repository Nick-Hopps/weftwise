import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({ slug: z.string().trim().min(1) });
const OutputSchema = z.object({
  ok: z.boolean(),
  jobId: z.string().nullable(),
  message: z.string(),
});

export const wikiReenrichTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'wiki.reenrich',
  source: 'builtin',
  description:
    'Start a background job that re-runs the augmentation pass on ONE wiki page by slug in the current subject ' +
    '(layers fresh learning callouts onto its existing prose, then verifies). This CHANGES the page. ' +
    'Only call after the user has explicitly confirmed which page to re-enrich. Runs asynchronously.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'enqueue',
  async handler({ slug }, ctx) {
    if (!ctx.reenrich) {
      return { ok: false, jobId: null, message: 'Re-enrich is not available in this context.' };
    }
    try {
      const { jobId } = await ctx.reenrich(slug);
      return {
        ok: true,
        jobId,
        message: `Re-enrich started for "${slug}". It runs in the background; refresh the page shortly to see the result.`,
      };
    } catch (err) {
      return { ok: false, jobId: null, message: err instanceof Error ? err.message : String(err) };
    }
  },
};
