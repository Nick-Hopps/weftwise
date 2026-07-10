import { z } from 'zod';
import type { ToolDef } from '../../types';
import { emptyWikiInspection } from '../evidence-results';

const InspectSectionSchema = z.enum(['links', 'backlinks', 'sources', 'health']);
const InputSchema = z.object({
  slug: z.string().min(1),
  include: z.array(InspectSectionSchema).optional(),
});
const OutputSchema = z.object({
  found: z.boolean(),
  page: z.object({
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
    updatedAt: z.string(),
  }).nullable(),
  outgoing: z.array(z.object({
    subjectSlug: z.string(),
    slug: z.string(),
    title: z.string().nullable(),
    context: z.string(),
    resolved: z.boolean(),
  })),
  backlinks: z.array(z.object({
    subjectSlug: z.string(),
    slug: z.string(),
    title: z.string(),
  })),
  sources: z.array(z.object({
    id: z.string(),
    filename: z.string(),
    originUrl: z.string().nullable(),
    parsedAt: z.string().nullable(),
    stale: z.boolean(),
  })),
  health: z.object({
    brokenLinks: z.number().int().nonnegative(),
    inboundCount: z.number().int().nonnegative(),
    outboundCount: z.number().int().nonnegative(),
    sourceCount: z.number().int().nonnegative(),
  }),
});

export const wikiInspectTool: ToolDef<
  z.infer<typeof InputSchema>,
  z.infer<typeof OutputSchema>
> = {
  name: 'wiki.inspect',
  source: 'builtin',
  description: 'Inspect page metadata, links, backlinks, sources, and health without returning page body.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler(input, ctx) {
    return ctx.inspectPage
      ? ctx.inspectPage(input.slug, input.include)
      : emptyWikiInspection();
  },
};
