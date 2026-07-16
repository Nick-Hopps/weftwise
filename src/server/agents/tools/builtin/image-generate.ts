import { generateText } from 'ai';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolDef } from '../../types';
import type { ToolContext } from '../tool-context';
import { getLanguageModel } from '@/server/llm/provider-factory';
import { resolveTask } from '@/server/llm/task-router';
import { recordUsage } from '@/server/db/repos/usage-repo';

const ASSET_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export const ImageGenerateInputSchema = z.object({
  prompt: z.string().trim().min(1).max(4_000),
  alt: z.string().trim().min(1).max(240),
  aspectRatio: z.enum(['1:1', '4:3', '3:4', '16:9', '9:16']).optional(),
  style: z.string().trim().max(240).optional(),
}).strict();

export const ImageGenerateOutputSchema = z.object({
  type: z.literal('image'),
  path: z.string(),
  url: z.string(),
  alt: z.string(),
});

export type ImageGenerateInput = z.infer<typeof ImageGenerateInputSchema>;
export type ImageGenerateOutput = z.infer<typeof ImageGenerateOutputSchema>;

function extensionForMediaType(mediaType: string): 'png' | 'jpg' | 'webp' {
  if (mediaType === 'image/png') return 'png';
  if (mediaType === 'image/webp') return 'webp';
  return 'jpg';
}

export async function generateImageAsset(
  input: ImageGenerateInput,
  subjectSlug: string,
  onUsage?: (usage: { inputTokens?: number; outputTokens?: number }) => void,
): Promise<{ output: ImageGenerateOutput; asset: { path: string; content: string } }> {
  const route = resolveTask('ingest:image');
  if (route.provider.provider !== 'google') {
    throw new Error(
      `Task "ingest:image" must resolve to a Google image model; got ${route.provider.provider}:${route.model}. ` +
      'Configure an explicit ingest:image route in llm-config.json.',
    );
  }
  const googleOptions = route.providerOptions?.google ?? {};
  const result = await generateText({
    model: getLanguageModel(route),
    prompt: [
      'Create one educational illustration for a knowledge-base article.',
      'The image must explain the requested concept visually, contain no illegible text, logos, watermarks, or invented labels.',
      `Request: ${input.prompt}`,
      input.style ? `Visual style: ${input.style}` : '',
      input.aspectRatio ? `Aspect ratio: ${input.aspectRatio}` : '',
    ].filter(Boolean).join('\n'),
    maxOutputTokens: route.maxTokens,
    temperature: route.temperature,
    maxRetries: route.maxRetries,
    abortSignal: AbortSignal.timeout(route.timeoutMs ?? 8 * 60 * 1000),
    providerOptions: {
      ...route.providerOptions,
      google: { ...googleOptions, responseModalities: ['IMAGE'] },
    },
  });

  onUsage?.(result.usage ?? {});
  try {
    recordUsage({ task: route.task, model: route.model, inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
  } catch (err) {
    console.warn('[usage] image generation record failed (ignored)', err);
  }

  const file = result.files.find((candidate) => IMAGE_TYPES.has(candidate.mediaType));
  if (!file) throw new Error('image.generate did not return a PNG, JPEG, or WebP image');
  if (file.uint8Array.byteLength > ASSET_MAX_BYTES) throw new Error('image.generate returned an image over 8 MiB');

  const extension = extensionForMediaType(file.mediaType);
  const filename = `${randomUUID()}.${extension}`;
  const path = `assets/${subjectSlug}/${filename}`;
  return {
    output: {
      type: 'image',
      path,
      url: `/api/assets/${subjectSlug}/${filename}`,
      alt: input.alt,
    },
    asset: { path, content: file.base64 },
  };
}

export const imageGenerateTool: ToolDef<ImageGenerateInput, ImageGenerateOutput> = {
  name: 'image.generate',
  source: 'builtin',
  description: 'Generate one explanatory raster image for the current enrich page and return a Markdown-ready asset URL.',
  inputSchema: ImageGenerateInputSchema,
  outputSchema: ImageGenerateOutputSchema,
  sideEffect: 'none',
  async handler(input, ctx: ToolContext) {
    if (!ctx.generateImage) throw new Error('image.generate is only available during page enrichment');
    return ctx.generateImage(input);
  },
};
