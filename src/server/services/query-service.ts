/**
 * Query service — answers user questions from wiki content using the LLM,
 * and optionally persists the answer as a new wiki page via the job queue.
 *
 * Every code path is subject-scoped: search, citation context, and
 * save-as-page all operate within a single Subject.
 */

import * as pagesRepo from '../db/repos/pages-repo';
import * as subjectsRepo from '../db/repos/subjects-repo';
import {
  generateStructuredOutput,
  streamTextWithTools,
  generateTextWithTools,
} from '../llm/provider-registry';
import type { CoreMessage } from 'ai';
import {
  buildQueryToolContext,
  createAccessedPages,
  accessedToContext,
  subjectHasContent,
} from './query-tools';
import type { AccessedPages, QueryContextPage } from './query-tools';
import { createBuiltinToolRegistry } from '@/server/agents/tools/builtin';
import { compileToolSet } from '@/server/agents/tools/compile';
import {
  QueryResponseSchema,
  QUERY_SYSTEM_PROMPT,
  QUERY_AGENTIC_SYSTEM_PROMPT,
  buildQueryUserPrompt,
  buildAgenticUserContent,
} from '../llm/prompts/query-prompt';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { PromptContext } from '../llm/prompts/prompt-context';
import {
  createChangeset,
  validateChangeset,
  applyChangeset,
} from '../wiki/wiki-transaction';
import { buildWikiPath, slugFromTitle } from '../wiki/page-identity';
import { serializeFrontmatter } from '../wiki/frontmatter';
import { registerHandler } from '../jobs/worker';
import type { QueryResult, Job, Subject } from '@/lib/contracts';

export const NO_QUERY_CONTEXT_ANSWER =
  'No relevant content was found in this subject to answer the question. Try ingesting more sources, switching subjects, or rephrasing your query.';

// 模块级：ToolDef 无状态纯对象，构造一次即可复用
const queryToolDefs = createBuiltinToolRegistry().resolve(['wiki.read', 'wiki.search', 'wiki.list']);

const QueryCitationsSchema = QueryResponseSchema.pick({ citations: true });

// QueryContextPage 类型已迁至 query-tools，此处再导出保持向后兼容
export type { QueryContextPage, AccessedPages } from './query-tools';
export { accessedToContext, subjectHasContent, createAccessedPages } from './query-tools';

/** 工具循环单 query 的最大步数（防 runaway）。 */
export const QUERY_MAX_STEPS = 6;

function subjectCtxFrom(subject: Subject) {
  return {
    slug: subject.slug,
    name: subject.name,
    description: subject.description,
  };
}

export async function generateQueryCitations(
  question: string,
  fullAnswer: string,
  context: QueryContextPage[],
  subject: Subject,
): Promise<{ pageSlug: string; excerpt: string }[]> {
  const promptCtx: PromptContext = {
    language: getWikiLanguage(),
    subject: subjectCtxFrom(subject),
  };
  const response = await generateStructuredOutput(
    'query',
    QueryCitationsSchema,
    QUERY_SYSTEM_PROMPT,
    `${buildQueryUserPrompt(question, context, promptCtx)}

## Draft answer to cite

<draft_answer>
${fullAnswer}
</draft_answer>

Return only the structured citations for the draft answer above. Do not rewrite the answer.`,
  );

  return response.citations.map((c) => {
    const page = context.find((p) => p.slug === c.pageSlug);
    if (!page) return { ...c, excerpt: `[unverified] ${c.excerpt}` };
    const normalizedContent = page.content.toLowerCase().replace(/\s+/g, ' ');
    const normalizedExcerpt = c.excerpt.toLowerCase().replace(/\s+/g, ' ');
    const isVerified = normalizedContent.includes(normalizedExcerpt);
    return isVerified ? c : { ...c, excerpt: `[unverified] ${c.excerpt}` };
  });
}

/**
 * Agentic 流式问答：构造 subject-scoped 工具 + 访问页收集器，
 * 用 streamTextWithTools 驱动工具循环；返回 stream 与 accessed（供事后引用）。
 */
export function streamAgenticQuery(opts: {
  question: string;
  subject: Subject;
  history?: { role: 'user' | 'assistant'; content: string }[];
  currentPageSlug?: string;
  abortSignal?: AbortSignal;
}): { stream: ReturnType<typeof streamTextWithTools>; accessed: AccessedPages } {
  const accessed = createAccessedPages();
  const tools = compileToolSet(queryToolDefs, buildQueryToolContext(opts.subject, accessed));
  const promptCtx: PromptContext = {
    language: getWikiLanguage(),
    subject: subjectCtxFrom(opts.subject),
  };
  const userContent = buildAgenticUserContent(opts.question, promptCtx, {
    currentPageSlug: opts.currentPageSlug,
  });
  const messages: CoreMessage[] = [
    ...(opts.history ?? []).map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ];
  const stream = streamTextWithTools('query', {
    system: QUERY_AGENTIC_SYSTEM_PROMPT,
    messages,
    tools,
    maxSteps: QUERY_MAX_STEPS,
    abortSignal: opts.abortSignal,
  });
  return { stream, accessed };
}

export async function runQuery(
  question: string,
  subject: Subject,
  currentPageSlug?: string,
): Promise<QueryResult> {
  if (!subjectHasContent(subject.id)) {
    return { answer: NO_QUERY_CONTEXT_ANSWER, citations: [], savedAsPage: null };
  }

  const accessed = createAccessedPages();
  const tools = compileToolSet(queryToolDefs, buildQueryToolContext(subject, accessed));
  const promptCtx: PromptContext = {
    language: getWikiLanguage(),
    subject: subjectCtxFrom(subject),
  };
  const userContent = buildAgenticUserContent(question, promptCtx, { currentPageSlug });

  const { text } = await generateTextWithTools('query', {
    system: QUERY_AGENTIC_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    tools,
    maxSteps: QUERY_MAX_STEPS,
  });

  const answer = text.trim().length > 0 ? text : NO_QUERY_CONTEXT_ANSWER;

  let citations: { pageSlug: string; excerpt: string }[] = [];
  try {
    citations = await generateQueryCitations(
      question,
      answer,
      accessedToContext(subject, accessed),
      subject,
    );
  } catch {
    citations = [];
  }

  return { answer, citations, savedAsPage: null };
}

export async function saveQueryAsPage(
  answer: string,
  title: string,
  citations: { pageSlug: string; excerpt: string }[],
  subject: Subject,
  jobId: string,
): Promise<string> {
  const slug = slugFromTitle(title);
  const now = new Date().toISOString();
  const wikiPath = buildWikiPath(subject.slug, slug);

  const existing = pagesRepo.getPageBySlug(subject.id, slug);
  if (existing) {
    throw new Error(
      `A page with slug "${slug}" already exists in subject "${subject.slug}" ("${existing.title}"). Choose a different title or update the existing page.`,
    );
  }

  const citationsSection =
    citations.length > 0
      ? [
          '',
          '## References',
          '',
          ...citations.map((c) => `- [[${c.pageSlug}]]: ${c.excerpt}`),
        ].join('\n')
      : '';

  const body = `${answer}${citationsSection}\n`;

  const content = serializeFrontmatter(
    {
      title,
      created: now,
      updated: now,
      tags: ['query-answer'],
      sources: citations.map((c) => c.pageSlug),
    },
    body,
  );

  const changeset = createChangeset(jobId, subject, [
    { action: 'create', path: wikiPath, content },
  ]);

  const validation = validateChangeset(changeset);
  if (!validation.valid) {
    throw new Error(
      `Changeset validation failed: ${validation.errors.join('; ')}`,
    );
  }

  await applyChangeset(changeset);
  return slug;
}

async function runSaveToWikiJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as {
    answer: string;
    title: string;
    citations: { pageSlug: string; excerpt: string }[];
    subjectId?: string;
  };

  const subjectId = params.subjectId ?? job.subjectId;
  if (!subjectId) {
    throw new Error('save-to-wiki job missing subjectId');
  }
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) {
    throw new Error(`Subject ${subjectId} not found`);
  }

  emit('save:start', `Saving answer to subject "${subject.slug}" as page: ${params.title}`);
  const slug = await saveQueryAsPage(
    params.answer,
    params.title,
    params.citations,
    subject,
    job.id,
  );
  emit('save:complete', `Saved as wiki page: ${slug}`, { slug, subject: subject.slug });

  return { slug, subjectId: subject.id };
}

registerHandler('save-to-wiki', runSaveToWikiJob);
