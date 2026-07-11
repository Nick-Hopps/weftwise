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
  subjectHasContent,
} from './query-tools';
import type { AccessedPages } from './query-tools';
import { createBuiltinToolRegistry } from '@/server/agents/tools/builtin';
import { compileToolSet } from '@/server/agents/tools/compile';
import {
  createToolExecutionPolicy,
  resolveToolProfile,
} from '@/server/agents/tools/profiles';
import {
  QUERY_AGENTIC_SYSTEM_PROMPT,
  buildAgenticUserContent,
  CoverageSchema,
  COVERAGE_SYSTEM_PROMPT,
  buildCoverageUserPrompt,
} from '../llm/prompts/query-prompt';
import { extractCitationsFromAnswer } from './citation-extract';
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
import { isWebSearchConfigured } from '@/server/search/web-search';
import * as researchBacklogRepo from '../db/repos/research-backlog-repo';
import type { QueryMode } from './query-intent';

export const NO_QUERY_CONTEXT_ANSWER =
  'No relevant content was found in this subject to answer the question. Try ingesting more sources, switching subjects, or rephrasing your query.';

/** query 工具集：`web.search` 仅在联网检索已配置时注入——未配置时模型完全看不到该工具。导出供单测直接校验。 */
export function resolveQueryTools(mode: QueryMode = 'read') {
  const profile = resolveToolProfile(mode === 'propose' ? 'query:propose' : 'query:read', { webSearchConfigured: isWebSearchConfigured() });
  return createBuiltinToolRegistry().resolve([...profile.tools]);
}

function compileQueryTools(subject: Subject, accessed: AccessedPages) {
  const profile = resolveToolProfile('query:read', { webSearchConfigured: isWebSearchConfigured() });
  return compileToolSet(resolveQueryTools(), buildQueryToolContext(subject, accessed), {
    policy: createToolExecutionPolicy(profile, subject.id),
  });
}

/**
 * best-effort 把"库内答不上"的问题写入待研究队列；写入失败只记日志，不影响问答响应。
 */
export function recordCoverageGap(subject: Subject, question: string, suggestedQuestion?: string): void {
  try {
    researchBacklogRepo.create(subject.id, suggestedQuestion?.trim() || question, 'ask-ai');
  } catch (err) {
    console.error('[query] failed to record research backlog entry', err);
  }
}

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

/**
 * 异步 coverage 判定（fire-and-forget）：只喂问题+最终答案，
 * 不足时 best-effort 写 research backlog；任何失败只记日志，不影响问答响应。
 */
export function assessCoverageInBackground(
  subject: Subject,
  question: string,
  answer: string,
): void {
  const promptCtx: PromptContext = {
    language: getWikiLanguage(),
    subject: subjectCtxFrom(subject),
  };
  void generateStructuredOutput(
    'query',
    CoverageSchema,
    COVERAGE_SYSTEM_PROMPT,
    buildCoverageUserPrompt(question, answer, promptCtx),
  )
    .then((r) => {
      if (!r.coverageSufficient) {
        recordCoverageGap(subject, question, r.suggestedResearchQuestion);
      }
    })
    .catch((err) => {
      console.error('[query] coverage assessment failed', err);
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
  const tools = compileQueryTools(opts.subject, accessed);
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
    recordCoverageGap(subject, question);
    return { answer: NO_QUERY_CONTEXT_ANSWER, citations: [], savedAsPage: null };
  }

  const accessed = createAccessedPages();
  const tools = compileQueryTools(subject, accessed);
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
  const citations = extractCitationsFromAnswer(answer, accessed, subject.slug);
  assessCoverageInBackground(subject, question, answer);

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
