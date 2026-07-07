import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  generateQueryCitations,
  NO_QUERY_CONTEXT_ANSWER,
  runQuery,
  streamAgenticQuery,
  subjectHasContent,
  accessedToContext,
  recordCoverageGap,
} from '@/server/services/query-service';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as queue from '@/server/jobs/queue';
import * as conversationsRepo from '@/server/db/repos/conversations-repo';
import { deriveConversationTitle } from '@/server/services/conversation-title';
import { summarizeToolArgs } from '@/lib/tool-activity';

export const runtime = 'nodejs';

const QueryBodySchema = z.object({
  question: z.string().min(1).optional(),
  conversationId: z.string().optional(),
  saveAsPage: z.boolean().optional(),
  pageTitle: z.string().optional(),
  answer: z.string().optional(),
  citations: z.array(z.object({
    pageSlug: z.string(),
    excerpt: z.string(),
  })).optional(),
  pageSlug: z.string().trim().min(1).optional(),
  subjectId: z.string().optional(),
  subjectSlug: z.string().optional(),
});

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;
  const csrfError = requireCsrf(request);
  if (csrfError) return csrfError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = QueryBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const resolution = resolveSubjectFromRequest(request, { body: parsed.data });
  if (resolution.error) return resolution.error;
  const { subject } = resolution;

  const { question, saveAsPage, pageTitle, answer, citations, pageSlug } = parsed.data;

  // Save-only mode: enqueue save-to-wiki job
  if (saveAsPage && pageTitle && pageTitle.trim().length > 0 && answer) {
    const job = queue.enqueue(
      'save-to-wiki',
      {
        answer,
        title: pageTitle.trim(),
        citations: citations ?? [],
        subjectId: subject.id,
      },
      subject.id,
    );
    return NextResponse.json({
      jobId: job.id,
      answer,
      citations: citations ?? [],
      subjectId: subject.id,
    }, { status: 202 });
  }

  if (!question || question.trim().length === 0) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }

  // Save-as-page + question: one-shot JSON mode
  if (saveAsPage) {
    const result = await runQuery(question.trim(), subject, pageSlug);
    let saveJobId: string | null = null;
    if (pageTitle && pageTitle.trim().length > 0) {
      const job = queue.enqueue(
        'save-to-wiki',
        {
          answer: result.answer,
          title: pageTitle.trim(),
          citations: result.citations,
          subjectId: subject.id,
        },
        subject.id,
      );
      saveJobId = job.id;
    }
    return NextResponse.json({
      answer: result.answer,
      citations: result.citations,
      saveJobId,
      subjectId: subject.id,
    });
  }

  // Default: streaming SSE mode
  const encoder = new TextEncoder();
  const trimmedQuestion = question.trim();

  const MAX_HISTORY_MESSAGES = 8;

  // 确定/创建会话（跨 subject 的 conversationId 静默当新会话，防泄漏他 subject 历史）
  const requestedConvId = parsed.data.conversationId;
  let activeConversationId: string;
  if (requestedConvId) {
    const existing = conversationsRepo.getConversation(requestedConvId);
    activeConversationId =
      existing && existing.subjectId === subject.id
        ? existing.id
        : conversationsRepo.createConversation(subject.id, deriveConversationTitle(trimmedQuestion)).id;
  } else {
    activeConversationId = conversationsRepo.createConversation(
      subject.id,
      deriveConversationTitle(trimmedQuestion),
    ).id;
  }

  const history = conversationsRepo
    .listMessages(activeConversationId)
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const closeStream = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };

      const emit = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const persistTurn = (
        answer: string,
        cits: { pageSlug: string; excerpt: string }[],
      ) => {
        try {
          conversationsRepo.appendMessage(activeConversationId, 'user', trimmedQuestion, null);
          conversationsRepo.appendMessage(
            activeConversationId,
            'assistant',
            answer,
            JSON.stringify(cits),
          );
          conversationsRepo.touchConversation(activeConversationId);
        } catch (err) {
          console.error('[query] persist conversation turn failed', err);
        }
      };

      const onAbort = () => closeStream();
      request.signal.addEventListener('abort', onAbort, { once: true });

      try {
        if (!subjectHasContent(subject.id)) {
          emit('answer-delta', { delta: NO_QUERY_CONTEXT_ANSWER });
          emit('citations', { citations: [] });
          persistTurn(NO_QUERY_CONTEXT_ANSWER, []);
          recordCoverageGap(subject, trimmedQuestion);
          emit('done', { subjectId: subject.id, conversationId: activeConversationId, coverageSufficient: false });
          closeStream();
          return;
        }

        const { stream: answerStream, accessed } = streamAgenticQuery({
          question: trimmedQuestion,
          subject,
          history,
          currentPageSlug: pageSlug,
          abortSignal: request.signal,
        });

        let fullAnswer = '';
        for await (const part of answerStream.fullStream) {
          if (request.signal.aborted) return;
          if (part.type === 'text-delta') {
            fullAnswer += part.textDelta;
            emit('answer-delta', { delta: part.textDelta });
          } else if (part.type === 'tool-call') {
            emit('tool-call', {
              toolName: part.toolName,
              args: summarizeToolArgs(part.toolName, part.args),
            });
          } else if (part.type === 'error') {
            const message = part.error instanceof Error ? part.error.message : String(part.error);
            emit('error', { error: message });
          }
        }

        if (fullAnswer.trim().length === 0) {
          fullAnswer = NO_QUERY_CONTEXT_ANSWER;
          emit('answer-delta', { delta: NO_QUERY_CONTEXT_ANSWER });
        }

        let streamedCitations: { pageSlug: string; excerpt: string }[] = [];
        let coverageSufficient = true;
        try {
          const result = await generateQueryCitations(
            trimmedQuestion,
            fullAnswer,
            accessedToContext(subject, accessed),
            subject,
          );
          streamedCitations = result.citations;
          coverageSufficient = result.coverageSufficient;
          if (!coverageSufficient) {
            recordCoverageGap(subject, trimmedQuestion, result.suggestedResearchQuestion);
          }
        } catch {
          streamedCitations = [];
        }

        emit('citations', { citations: streamedCitations });
        persistTurn(fullAnswer, streamedCitations);
        emit('done', { subjectId: subject.id, conversationId: activeConversationId, coverageSufficient });
      } catch (error) {
        if (!request.signal.aborted) {
          const message = error instanceof Error ? error.message : String(error);
          emit('error', { error: message });
        }
      } finally {
        request.signal.removeEventListener('abort', onAbort);
        closeStream();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

