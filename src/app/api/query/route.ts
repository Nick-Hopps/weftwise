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
import { requireAuth } from '@/server/middleware/auth';
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
});

export async function POST(request: NextRequest) {
  const authError = requireAuth(request);
  if (authError) return authError;

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

  const { question, saveAsPage, pageTitle, answer, citations } = parsed.data;

  // Save-only mode: enqueue save-to-wiki job
  if (saveAsPage && pageTitle && pageTitle.trim().length > 0 && answer) {
    const job = queue.enqueue('save-to-wiki', {
      answer,
      title: pageTitle.trim(),
      citations: citations ?? [],
    });
    return NextResponse.json({
      jobId: job.id,
      answer,
      citations: citations ?? [],
    }, { status: 202 });
  }

  if (!question || question.trim().length === 0) {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }

  // Save-as-page + question: one-shot JSON mode
  if (saveAsPage) {
    const result = await runQuery(question.trim());
    let saveJobId: string | null = null;
    if (pageTitle && pageTitle.trim().length > 0) {
      const job = queue.enqueue('save-to-wiki', {
        answer: result.answer,
        title: pageTitle.trim(),
        citations: result.citations,
      });
      saveJobId = job.id;
    }
    return NextResponse.json({
      answer: result.answer,
      citations: result.citations,
      saveJobId,
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
        const context = prepareQueryContext(trimmedQuestion);

        if (context.length === 0) {
          emit('answer-delta', { delta: NO_QUERY_CONTEXT_ANSWER });
          emit('citations', { citations: [] });
          emit('done', {});
          closeStream();
          return;
        }

        const answerStream = streamQueryAnswer(
          QUERY_STREAM_SYSTEM_PROMPT,
          trimmedQuestion,
          context,
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
          );
        } catch {
          streamedCitations = [];
        }

        emit('citations', { citations: streamedCitations });
        emit('done', {});
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
