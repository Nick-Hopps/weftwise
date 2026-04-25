import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  generateQueryCitations,
  NO_QUERY_CONTEXT_ANSWER,
  prepareQueryContext,
  QUERY_STREAM_SYSTEM_PROMPT,
  runQuery,
  streamQueryAnswer,
} from '@/server/services/query-service';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as queue from '@/server/jobs/queue';

export const runtime = 'nodejs';

const QueryBodySchema = z.object({
  question: z.string().min(1).optional(),
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

      const onAbort = () => closeStream();
      request.signal.addEventListener('abort', onAbort, { once: true });

      try {
        const context = prepareQueryContext(trimmedQuestion, subject.id, pageSlug);

        if (context.length === 0) {
          emit('answer-delta', { delta: NO_QUERY_CONTEXT_ANSWER });
          emit('citations', { citations: [] });
          emit('done', { subjectId: subject.id });
          closeStream();
          return;
        }

        const answerStream = streamQueryAnswer(
          QUERY_STREAM_SYSTEM_PROMPT,
          trimmedQuestion,
          context,
          subject,
          request.signal,
        );

        let fullAnswer = '';
        for await (const delta of answerStream.textStream) {
          if (request.signal.aborted) return;
          fullAnswer += delta;
          emit('answer-delta', { delta });
        }

        let streamedCitations: { pageSlug: string; excerpt: string }[] = [];
        try {
          streamedCitations = await generateQueryCitations(
            trimmedQuestion,
            fullAnswer,
            context,
            subject,
          );
        } catch {
          streamedCitations = [];
        }

        emit('citations', { citations: streamedCitations });
        emit('done', { subjectId: subject.id });
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
