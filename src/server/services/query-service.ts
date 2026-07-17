/**
 * Query service — answers user questions from wiki content using the LLM,
 * and optionally persists the answer as a new wiki page via the job queue.
 *
 * Every code path is subject-scoped: search, citation context, and
 * save-as-page all operate within a single Subject.
 */

import * as subjectsRepo from '../db/repos/subjects-repo';
import * as operationsRepo from '../db/repos/operations-repo';
import {
  generateStructuredOutput,
  streamTextWithTools,
  generateTextWithTools,
} from '../llm/provider-registry';
import type { CoreMessage } from 'ai';
import {
  buildQueryToolContext,
  createAccessedPages,
} from './query-tools';
import type { AccessedPages } from './query-tools';
import { createBuiltinToolRegistry } from '@/server/agents/tools/builtin';
import { compileToolSet } from '@/server/agents/tools/compile';
import {
  createToolExecutionPolicy,
  resolveToolProfile,
} from '@/server/agents/tools/profiles';
import {
  buildQueryAgenticSystemPrompt,
  buildAgenticUserContent,
  CoverageSchema,
  COVERAGE_SYSTEM_PROMPT,
  buildCoverageUserPrompt,
} from '../llm/prompts/query-prompt';
import { extractCitationsFromAnswer } from './citation-extract';
import { getWikiLanguage } from '../db/repos/settings-repo';
import type { PromptContext } from '../llm/prompts/prompt-context';
import {
  buildWikiPath,
  isCanonicalPageSlug,
  parseWikiPath,
} from '../wiki/page-identity';
import { readPageInSubject } from '../wiki/wiki-store';
import { registerHandler } from '../jobs/worker';
import type { PendingActionView, QueryResult, Job, Subject, WikiCitation, SelectionAnchorInput } from '@/lib/contracts';
import { isWebSearchConfigured } from '@/server/search/web-search';
import * as researchBacklogRepo from '../db/repos/research-backlog-repo';
import type { QueryMode } from './query-intent';
import { createPageInSubject } from './page-write';
import { enqueueEmbedIndex } from './embedding-enqueue';
import { citationWikiLink } from '@/lib/wiki-citation';

export const NO_QUERY_CONTEXT_ANSWER =
  'No relevant content was found in this subject to answer the question. Try ingesting more sources, switching subjects, or rephrasing your query.';

/** query 工具集：`web.search` 仅在联网检索已配置时注入——未配置时模型完全看不到该工具。导出供单测直接校验。 */
export function resolveQueryTools(
  mode: QueryMode = 'read',
) {
  const resolutionContext = { webSearchConfigured: isWebSearchConfigured() };
  const profile = resolveToolProfile(mode === 'read' ? 'query:read' : 'query:propose', resolutionContext);
  const readTools = new Set(resolveToolProfile('query:read', resolutionContext).tools);
  const toolNames = profile.tools.filter((name) => {
    if (mode === 'read') return true;
    if (mode === 'image-insert') return readTools.has(name) || name === 'wiki.image.insert';
    return name !== 'wiki.image.insert';
  });
  return createBuiltinToolRegistry().resolve([...toolNames]);
}

interface QueryCompileOptions {
  mode?: QueryMode;
  conversationId?: string;
  onPendingAction?: (action: PendingActionView) => void;
  currentPageSlug?: string;
  selection?: SelectionAnchorInput;
}

function compileQueryTools(
  subject: Subject,
  accessed: AccessedPages,
  options: QueryCompileOptions = {},
) {
  const mode = options.mode ?? 'read';
  const profile = resolveToolProfile(mode === 'read' ? 'query:read' : 'query:propose', {
    webSearchConfigured: isWebSearchConfigured(),
  });
  return compileToolSet(resolveQueryTools(mode), buildQueryToolContext(subject, accessed, {
    conversationId: options.conversationId,
    onPendingAction: options.onPendingAction,
    currentPageSlug: options.currentPageSlug,
    selection: options.selection,
  }), {
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
export { accessedToContext, createAccessedPages } from './query-tools';

/** 工具循环单 query 的最大步数（防 runaway）。 */
export const QUERY_MAX_STEPS = 8;

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
  mode?: QueryMode;
  conversationId?: string;
  onPendingAction?: (action: PendingActionView) => void;
  selection?: SelectionAnchorInput;
}): { stream: ReturnType<typeof streamTextWithTools>; accessed: AccessedPages } {
  const accessed = createAccessedPages();
  const tools = compileQueryTools(opts.subject, accessed, {
    mode: opts.mode,
    conversationId: opts.conversationId,
    onPendingAction: opts.onPendingAction,
    currentPageSlug: opts.currentPageSlug,
    selection: opts.selection,
  });
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
    system: buildQueryAgenticSystemPrompt({
      mode: opts.mode ?? 'read',
    }),
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
  const accessed = createAccessedPages();
  const tools = compileQueryTools(subject, accessed);
  const promptCtx: PromptContext = {
    language: getWikiLanguage(),
    subject: subjectCtxFrom(subject),
  };
  const userContent = buildAgenticUserContent(question, promptCtx, { currentPageSlug });

  const { text } = await generateTextWithTools('query', {
    system: buildQueryAgenticSystemPrompt({ mode: 'read' }),
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
  citations: WikiCitation[],
  subject: Subject,
  jobId: string,
): Promise<string> {
  const applied = operationsRepo.listAppliedForJob(jobId, subject.id);
  if (applied.length > 0) {
    const createPaths: string[] = [];
    for (const operation of applied) {
      let entries: unknown;
      try {
        entries = JSON.parse(operation.changesetJson);
      } catch {
        throw new Error(`Cannot recover save-to-wiki job "${jobId}": applied operation is invalid.`);
      }
      if (!Array.isArray(entries)) {
        throw new Error(`Cannot recover save-to-wiki job "${jobId}": applied operation is invalid.`);
      }
      for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null || !('action' in entry)) continue;
        if (entry.action === 'create') {
          if (!('path' in entry) || typeof entry.path !== 'string') {
            throw new Error(`Cannot recover save-to-wiki job "${jobId}": applied operation is invalid.`);
          }
          createPaths.push(entry.path);
        }
      }
    }

    if (createPaths.length !== 1) {
      throw new Error(`Cannot recover save-to-wiki job "${jobId}": expected exactly one created page.`);
    }
    const path = createPaths[0]!;
    const parsed = parseWikiPath(path);
    if (
      !parsed
      || parsed.subjectSlug !== subject.slug
      || !isCanonicalPageSlug(parsed.slug)
      || buildWikiPath(parsed.subjectSlug, parsed.slug) !== path
    ) {
      throw new Error(`Cannot recover save-to-wiki job "${jobId}": created page path is invalid.`);
    }
    if (!readPageInSubject(subject.slug, parsed.slug)) {
      throw new Error(
        `Cannot recover save-to-wiki job "${jobId}": created page "${parsed.slug}" no longer exists.`,
      );
    }

    // 页面已提交但 job 尚未收口时，重试只补派生索引，绝不能再创建后缀重复页。
    enqueueEmbedIndex(subject.id);
    return parsed.slug;
  }

  const citationsSection =
    citations.length > 0
      ? [
          '',
          '',
          '## References',
          '',
          ...citations.map((citation) =>
            `- ${citationWikiLink(citation, subject.slug)}: ${citation.excerpt}`),
        ].join('\n')
      : '';

  const body = `${answer}${citationsSection}\n`;
  const result = await createPageInSubject(
    subject,
    { title, body, tags: ['query-answer'] },
    { jobId },
  );
  return result.createdSlug;
}

async function runSaveToWikiJob(
  job: Job,
  emit: (type: string, message: string, data?: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const params = JSON.parse(job.paramsJson) as {
    answer: string;
    title: string;
    citations: WikiCitation[];
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
