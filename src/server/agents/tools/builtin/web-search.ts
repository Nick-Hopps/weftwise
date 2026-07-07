import { z } from 'zod';
import type { ToolDef } from '../../types';

const InputSchema = z.object({
  query: z.string().min(1),
});
const OutputSchema = z.object({
  results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })),
});

const MAX_RESULTS = 5;

/**
 * 只读联网检索（Tavily search，不 extract）。仅供 query 工具循环使用，
 * 只有 isWebSearchConfigured() 为真时才会被解析进工具集，否则模型完全看不到它。
 */
export const webSearchTool: ToolDef<z.infer<typeof InputSchema>, z.infer<typeof OutputSchema>> = {
  name: 'web.search',
  source: 'builtin',
  description:
    'Search the public web (not the wiki) for supplementary information. Read-only. ' +
    'Only use when the wiki lacks the information needed; always prefer wiki content when available.',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  sideEffect: 'none',
  async handler({ query }, ctx) {
    if (!ctx.webSearch) {
      throw new Error('Web search is not available in this context');
    }
    const results = await ctx.webSearch(query);
    return { results: results.slice(0, MAX_RESULTS) };
  },
};
