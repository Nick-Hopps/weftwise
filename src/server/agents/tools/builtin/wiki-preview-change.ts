import { z } from 'zod';
import type { PendingActionView, PreviewChangeInput } from '@/lib/contracts';
import {
  PreviewChangeToolInputSchema,
  type PreviewChangeToolInput,
} from '@/server/services/pending-action-payload';
import type { ToolDef } from '../../types';

const OutputSchema = z.custom<PendingActionView>();

export const wikiPreviewChangeTool: ToolDef<PreviewChangeToolInput, PendingActionView> = {
  name: 'wiki.preview_change',
  source: 'builtin',
  description: 'Plan one explicit wiki create, update, patch, delete, re-enrich, metadata-patch, link-ensure, or move request. Returns a preview that requires a separate user approval actionId; it does not modify the wiki.',
  inputSchema: PreviewChangeToolInputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'propose',
  async handler(input, ctx) {
    if (!ctx.previewChange) {
      throw new Error('[ACTION_PLAN_INVALID] Change preview is not available in this context.');
    }
    // 扁平 payload 只为让 provider 收下 object 根 schema；operation 与 payload 的真实
    // 配对由 previewChange → normalizePreviewInput 的 strict parse 判定（单一校验源）。
    const action = await ctx.previewChange(input as PreviewChangeInput);
    ctx.onPendingAction?.(action);
    return action;
  },
};
