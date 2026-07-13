import { z } from 'zod';
import type { ToolDef } from '../../types';

const EditableFieldSchema = z.enum(['title', 'summary', 'tags', 'aliases']);
const InputSchema = z.object({
  slug: z.string().trim().min(1),
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().trim().max(2_000).optional(),
  tags: z.array(z.string().trim().max(64)).optional(),
  aliases: z.array(z.string().trim().max(200)).optional(),
}).strict().refine(
  (input) => ['title', 'summary', 'tags', 'aliases']
    .some((field) => input[field as keyof typeof input] !== undefined),
  { message: 'At least one metadata field is required.' },
);
const OutputSchema = z.object({
  ok: z.boolean(),
  updatedSlug: z.string().nullable(),
  referencesUpdated: z.number().nullable(),
  changedFields: z.array(EditableFieldSchema),
  message: z.string(),
}).strict();

export const wikiMetadataPatchTool: ToolDef<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>
> = {
  name: 'wiki.metadata.patch',
  source: 'builtin',
  description:
    'Patch only title, summary, tags, or aliases on one EXISTING wiki page in the current subject. This CHANGES the wiki while keeping the page body unchanged. ' +
    'Do not use this for body edits, creating pages, or system pages. Omit metadata fields that should remain unchanged.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'update',
  async handler(input, ctx) {
    if (!ctx.metadataPatch) {
      return {
        ok: false,
        updatedSlug: null,
        referencesUpdated: null,
        changedFields: [],
        message: 'Patching page metadata is not available in this context.',
      };
    }
    try {
      const result = await ctx.metadataPatch(input);
      return {
        ok: true,
        ...result,
        message: `Updated metadata for "${result.updatedSlug}".`,
      };
    } catch (err) {
      return {
        ok: false,
        updatedSlug: null,
        referencesUpdated: null,
        changedFields: [],
        message: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
