import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  assessCoverageInBackground,
  NO_QUERY_CONTEXT_ANSWER,
  runQuery,
  streamAgenticQuery,
} from '@/server/services/query-service';
import { extractCitationsFromAnswer } from '@/server/services/citation-extract';
import { requireAuth, requireCsrf } from '@/server/middleware/auth';
import { resolveSubjectFromRequest } from '@/server/middleware/subject';
import * as queue from '@/server/jobs/queue';
import * as conversationsRepo from '@/server/db/repos/conversations-repo';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { deriveConversationTitle } from '@/server/services/conversation-title';
import { summarizeToolArgs } from '@/lib/tool-activity';
import {
  classifyQueryIntent,
  queryModeForIntent,
  resolveDirectReenrichTarget,
} from '@/server/services/query-intent';
import { createPendingWorkflowActionPreview } from '@/server/services/pending-action-service';
import { MAX_USER_MESSAGE_REFERENCES } from '@/lib/chat-reference';
import type { UserMessageReference, WikiCitation } from '@/lib/contracts';

export const runtime = 'nodejs';

const QueryBodySchema = z.object({
  question: z.string().min(1).optional(),
  userQuestion: z.string().trim().min(1).max(10_000).optional(),
  intentContext: z.literal('reset-confirmation').optional(),
  conversationId: z.string().optional(),
  saveAsPage: z.boolean().optional(),
  pageTitle: z.string().optional(),
  answer: z.string().optional(),
  citations: z.array(z.object({
    pageSlug: z.string(),
    excerpt: z.string(),
    subjectSlug: z.string().optional(),
  })).optional(),
  messageReferences: z.array(z.object({
    section: z.string().trim().max(500).nullable(),
    excerpt: z.string().trim().min(1).max(4_001),
  }).strict()).max(MAX_USER_MESSAGE_REFERENCES).optional(),
  pageSlug: z.string().trim().min(1).optional(),
  subjectId: z.string().optional(),
  subjectSlug: z.string().optional(),
  selection: z.object({
    sourceKind: z.enum(['canonical', 'reshape']),
    quote: z.string().trim().min(1).max(4_001),
    section: z.string().trim().max(500).nullable(),
    blockStart: z.number().int().nonnegative(),
    blockEnd: z.number().int().positive(),
  }).strict().refine((selection) => selection.blockEnd > selection.blockStart, {
    message: 'selection blockEnd must be greater than blockStart',
  }).optional(),
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

  const {
    question,
    userQuestion,
    saveAsPage,
    pageTitle,
    answer,
    citations,
    messageReferences: requestedMessageReferences,
    pageSlug,
    selection,
  } = parsed.data;

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

  if (requestedMessageReferences?.length && !pageSlug) {
    return NextResponse.json(
      { error: 'pageSlug is required when messageReferences are provided' },
      { status: 400 },
    );
  }

  const referencePageTitle = pageSlug && requestedMessageReferences?.length
    ? pagesRepo.getPageBySlug(subject.id, pageSlug)?.title
    : undefined;
  const messageReferences: UserMessageReference[] = pageSlug
    ? (requestedMessageReferences ?? []).map((reference) => ({
        pageSlug,
        ...(referencePageTitle ? { pageTitle: referencePageTitle } : {}),
        subjectSlug: subject.slug,
        section: reference.section,
        excerpt: reference.excerpt,
      }))
    : [];

  // Default: streaming SSE mode
  const encoder = new TextEncoder();
  const trimmedQuestion = question.trim();
  const intentQuestion = userQuestion?.trim() || trimmedQuestion;

  const MAX_HISTORY_MESSAGES = 8;

  // 确定/创建会话（跨 subject 的 conversationId 静默当新会话，防泄漏他 subject 历史）
  const requestedConvId = parsed.data.conversationId;
  let activeConversationId: string;
  if (requestedConvId) {
    const existing = conversationsRepo.getConversation(requestedConvId);
    activeConversationId =
      existing && existing.subjectId === subject.id
        ? existing.id
        : conversationsRepo.createConversation(subject.id, deriveConversationTitle(intentQuestion)).id;
  } else {
    activeConversationId = conversationsRepo.createConversation(
      subject.id,
      deriveConversationTitle(intentQuestion),
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
        cits: WikiCitation[],
      ) => {
        try {
          conversationsRepo.appendMessage(
            activeConversationId,
            'user',
            intentQuestion,
            messageReferences.length > 0 ? JSON.stringify(messageReferences) : null,
          );
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
        const intent = await classifyQueryIntent(intentQuestion, {
          phase: parsed.data.intentContext ?? 'request',
          hasSelection: selection !== undefined,
          hasCurrentPage: pageSlug !== undefined,
        });
        if (request.signal.aborted) return;

        if (parsed.data.intentContext === 'reset-confirmation') {
          const decision = intent.intent === 'reset-confirm'
            ? 'confirm'
            : intent.intent === 'reset-cancel'
              ? 'cancel'
              : 'unclear';
          const answer = decision === 'confirm'
            ? '已确认重置请求，正在执行…'
            : decision === 'cancel'
              ? '好的，已取消重置，wiki 保持不变。'
              : '我没太确定你的意思。请明确确认执行重置，或取消重置。';
          emit('reset-confirmation', { decision });
          emit('answer-delta', { delta: answer });
          emit('citations', { citations: [] });
          persistTurn(answer, []);
          emit('done', { subjectId: subject.id, conversationId: activeConversationId });
          return;
        }

        if (intent.intent === 'reset-request') {
          const answer = '你确定要重置当前 Wiki 吗？这会清空当前 Subject 的所有页面、数据源和任务记录，且无法恢复。请明确确认执行，或取消。';
          emit('reset-confirmation', { decision: 'requested' });
          emit('answer-delta', { delta: answer });
          emit('citations', { citations: [] });
          persistTurn(answer, []);
          emit('done', { subjectId: subject.id, conversationId: activeConversationId });
          return;
        }

        if (selection?.sourceKind === 'reshape' && intent.intent === 'image-insert') {
          const answer = '当前选区来自 Reshape 内容。请切换至 Original 后重新选择正文，再发起配图插入。';
          emit('answer-delta', { delta: answer });
          emit('citations', { citations: [] });
          persistTurn(answer, []);
          emit('done', { subjectId: subject.id, conversationId: activeConversationId });
          return;
        }
        const directReenrichSlug = resolveDirectReenrichTarget(intent, pageSlug);
        // 明确的 re-enrich 是控制面命令，不需要让 Query LLM 再做一次工具选择。
        // 直接生成审批预览可避免模型首个 tool-call 最长等待 route timeout。
        if (directReenrichSlug) {
          const action = await createPendingWorkflowActionPreview({
            conversationId: activeConversationId,
            subject,
            input: {
              operation: 'workflow-reenrich-start',
              payload: { slug: directReenrichSlug },
            },
          });
          const answer = `已生成页面 \`${directReenrichSlug}\` 的重新丰富审批预览，请确认后启动任务。`;
          emit('tool-call', { toolName: 'workflow.reenrich.start', args: directReenrichSlug });
          emit('pending-action', action);
          emit('answer-delta', { delta: answer });
          emit('citations', { citations: [] });
          persistTurn(answer, []);
          emit('done', { subjectId: subject.id, conversationId: activeConversationId });
          return;
        }

        const mode = queryModeForIntent(intent);
        const { stream: answerStream, accessed } = streamAgenticQuery({
          question: trimmedQuestion,
          subject,
          history,
          currentPageSlug: pageSlug,
          conversationId: activeConversationId,
          mode,
          onPendingAction: (action) => emit('pending-action', action),
          selection,
          abortSignal: request.signal,
        });

        let fullAnswer = '';
        for await (const part of answerStream.fullStream) {
          if (request.signal.aborted) return;
          if (part.type === 'text-delta') {
            fullAnswer += part.text;
            emit('answer-delta', { delta: part.text });
          } else if (part.type === 'tool-call') {
            emit('tool-call', {
              toolName: part.toolName,
              args: summarizeToolArgs(part.toolName, part.input),
            });
          } else if (part.type === 'error') {
            // `error` 是本次生成的终态，不得继续走空答案回落、会话持久化与 done。
            // 统一交给外层 catch 发一次 SSE error，也与 iterator/setup 抛错行为保持一致。
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
        }

        if (fullAnswer.trim().length === 0) {
          fullAnswer = NO_QUERY_CONTEXT_ANSWER;
          emit('answer-delta', { delta: NO_QUERY_CONTEXT_ANSWER });
        }

        const citations = extractCitationsFromAnswer(fullAnswer, accessed, subject.slug);
        emit('citations', { citations });
        persistTurn(fullAnswer, citations);
        emit('done', { subjectId: subject.id, conversationId: activeConversationId });
        assessCoverageInBackground(subject, intentQuestion, fullAnswer);
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
