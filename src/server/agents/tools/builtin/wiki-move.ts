import { z } from 'zod';
import type { MovePageInput, PendingActionView } from '@/lib/contracts';
import { isCanonicalPageSlug } from '@/server/wiki/page-identity';
import type { ToolDef } from '../../types';

const CanonicalSlugSchema = z.string().trim().min(1).refine(
  isCanonicalPageSlug,
  'slug must be canonical',
);

const InputSchema = z.object({
  slug: CanonicalSlugSchema,
  newSlug: CanonicalSlugSchema,
}).strict().refine((input) => input.slug !== input.newSlug, {
  message: 'newSlug must differ from slug',
  path: ['newSlug'],
});

const OutputSchema = z.custom<PendingActionView>();

export const wikiMoveTool: ToolDef<MovePageInput, PendingActionView> = {
  name: 'wiki.move',
  source: 'builtin',
  description:
    'Plan moving ONE existing page in the current subject from slug to newSlug. ' +
    'This creates an approval preview and does not modify the wiki. It changes the canonical slug/path, not the page title.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'propose',
  async handler(input, ctx) {
    if (!ctx.previewChange) {
      throw new Error('[ACTION_PLAN_INVALID] Move preview is not available in this context.');
    }
    const action = await ctx.previewChange({ operation: 'move', payload: input });
    ctx.onPendingAction?.(action);
    return action;
  },
};
