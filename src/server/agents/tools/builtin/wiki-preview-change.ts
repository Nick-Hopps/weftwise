import { z } from 'zod';
import type { PendingActionView, PreviewChangeInput } from '@/lib/contracts';
import { PreviewChangeInputSchema } from '@/server/services/pending-action-payload';
import type { ToolDef } from '../../types';

const OutputSchema = z.custom<PendingActionView>();

export const wikiPreviewChangeTool: ToolDef<PreviewChangeInput, PendingActionView> = {
  name: 'wiki.preview_change',
  source: 'builtin',
  description: 'Plan one explicit wiki create, update, patch, delete, or re-enrich request. Returns a preview that requires a separate user approval actionId; it does not modify the wiki.',
  inputSchema: PreviewChangeInputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'propose',
  async handler(input, ctx) {
    if (!ctx.previewChange) {
      throw new Error('[ACTION_PLAN_INVALID] Change preview is not available in this context.');
    }
    const action = await ctx.previewChange(input);
    ctx.onPendingAction?.(action);
    return action;
  },
};
