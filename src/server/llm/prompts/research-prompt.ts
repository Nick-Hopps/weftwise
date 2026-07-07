import { z } from 'zod';
import { renderLanguageDirective, type PromptContext } from './prompt-context';

// ── Stage 1: query generation ───────────────────────────────────────────────

export const ResearchQueriesSchema = z.object({
  queries: z
    .array(z.string().min(1))
    .describe('Web search queries likely to surface authoritative sources on the topic(s).'),
});

export type ResearchQueriesResult = z.infer<typeof ResearchQueriesSchema>;

export const RESEARCH_QUERIES_SYSTEM_PROMPT = `You are a research assistant helping fill knowledge gaps in a personal wiki.

Given one or more topics that are missing dedicated coverage, generate concise, high-signal web search queries
that would surface authoritative sources (docs, reference material, well-regarded articles) on those topics.

Rules:
- 1-2 queries per topic; keep the total small and focused.
- Prefer queries a careful researcher would actually type — specific, not generic.
- Do not include the words "wiki" or "article" in the queries.
- Output only the queries, no commentary.`;

export function buildResearchQueriesUserPrompt(topics: string[], ctx: PromptContext): string {
  const lines = [
    renderLanguageDirective(ctx.language),
    '',
    '=== TOPICS NEEDING COVERAGE ===',
    ...topics.map((t, i) => `${i + 1}. ${t}`),
    '=== END TOPICS ===',
    '',
    'Generate the search queries now.',
  ];
  return lines.join('\n');
}

// ── Stage 2 (orchestration, not LLM): web search — see search/web-search.ts ─

export interface TriageCandidateInput {
  url: string;
  title: string;
  snippet: string;
}

// ── Stage 3: relevance/quality triage ───────────────────────────────────────

export const ResearchTriageSchema = z.object({
  results: z
    .array(
      z.object({
        url: z.string().describe('Must match one of the candidate URLs exactly.'),
        score: z
          .number()
          .int()
          .min(0)
          .max(3)
          .describe('0 = irrelevant/low-quality, 3 = highly relevant and authoritative.'),
        reason: z.string().describe('One short sentence justifying the score.'),
      }),
    )
    .describe('One entry per candidate URL provided.'),
});

export type ResearchTriageResult = z.infer<typeof ResearchTriageSchema>;

export const RESEARCH_TRIAGE_SYSTEM_PROMPT = `You are triaging web search results for relevance and quality before they get
ingested into a personal wiki.

For each candidate, score 0-3:
- 3: highly relevant, authoritative, worth ingesting as-is
- 2: relevant and useful, moderate quality
- 1: tangential or low-quality
- 0: irrelevant, spam, or duplicate content

Give exactly one result per candidate URL, matching the URL string exactly.`;

export function buildResearchTriageUserPrompt(
  topics: string[],
  candidates: TriageCandidateInput[],
  ctx: PromptContext,
): string {
  const lines = [
    renderLanguageDirective(ctx.language),
    '',
    '=== TOPICS ===',
    ...topics.map((t, i) => `${i + 1}. ${t}`),
    '=== END TOPICS ===',
    '',
    '=== CANDIDATES ===',
    ...candidates.map(
      (c, i) => `${i + 1}. url: ${c.url}\n   title: ${c.title}\n   snippet: ${c.snippet.slice(0, 400)}`,
    ),
    '=== END CANDIDATES ===',
    '',
    'Score every candidate now.',
  ];
  return lines.join('\n');
}
