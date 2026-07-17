import { z } from 'zod';
import type { PendingActionView } from '@/lib/contracts';
import type { ToolDef } from '../../types';
import {
  ImageGenerateInputSchema,
  type ImageGenerateInput,
} from './image-generate';

const OutputSchema = z.custom<PendingActionView>();

export const wikiImageInsertTool: ToolDef<ImageGenerateInput, PendingActionView> = {
  name: 'wiki.image.insert',
  source: 'builtin',
  description:
    'Propose generating one explanatory illustration below the trusted canonical Markdown selection attached to this request. ' +
    'Provide only the visual prompt, accessible alt text, and optional aspect ratio/style. ' +
    'The current page and selection are bound by the runtime. This returns an approval preview and does not generate or insert the image.',
  inputSchema: ImageGenerateInputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'propose',
  async handler(input, ctx) {
    if (!ctx.previewImageInsert) {
      throw new Error('[ACTION_PLAN_INVALID] Image insertion requires a canonical page selection.');
    }
    const action = await ctx.previewImageInsert(input);
    ctx.onPendingAction?.(action);
    return action;
  },
};
