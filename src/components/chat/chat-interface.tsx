'use client';
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Check, StopCircle, TextQuote, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { MessageList } from './message-list';
import {
  chatMessageFromConversation,
  createOutgoingUserMessage,
} from './chat-message';
import { SaveToWikiButton } from './save-to-wiki-button';
import { PendingActionCard } from './pending-action-card';
import { replacePendingActions, upsertPendingAction } from './pending-action-state';
import {
  applyResetConfirmationDecision,
  resetIntentContext,
  type ResetConfirmationDecision,
  type ResetConfirmationState,
} from './reset-confirmation-state';
import { apiFetch, useApiFetch } from '@/lib/api-fetch';
import { useUIStore } from '@/stores/ui-store';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { cn } from '@/lib/cn';
import { isImeComposing } from '@/lib/keyboard';
import { dispatchJobStarted, jobStartedDetailForAction } from '@/lib/job-started-event';
import { buildUserMessageReferences } from '@/lib/chat-reference';
import type { ChatMessage, Citation } from './chat-message';
import type { ConversationMessage, PendingActionView, SelectionAnchorInput } from '@/lib/contracts';

interface Passage {
  id: string;
  section: string;
  text: string;
  selection?: SelectionAnchorInput;
}

/** Split a page's markdown into referenceable passages, tagged by section. */
function parsePassages(content: string, title: string): Passage[] {
  const lines = content.replace(/\r/g, '').split('\n');
  const out: Passage[] = [];
  let section = title;
  let buf: string[] = [];
  const clean = (s: string) =>
    s
      .replace(/\[\[([^\]|]*)\|?([^\]]*)\]\]/g, (_m, a, b) => b || a)
      .replace(/[*`_>#]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  const flush = () => {
    const raw = clean(buf.join(' '));
    buf = [];
    if (raw.length >= 24) out.push({ id: String(out.length), section, text: raw });
  };
  for (const line of lines) {
    const h = line.match(/^#{1,3}\s+(.*)/);
    if (h) {
      flush();
      section = clean(h[1]) || section;
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (/^\s*[-*]\s/.test(line)) {
      flush();
      buf.push(line.replace(/^\s*[-*]\s/, ''));
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out.slice(0, 40);
}

interface SSEEvent {
  event: string;
  data: unknown;
}

/**
 * Incremental SSE parser. Browsers may deliver a frame split across multiple
 * `reader.read()` chunks; callers keep a rolling buffer and call `parse()` —
 * only complete `\n\n`-terminated frames are consumed, the remainder stays in
 * the buffer for the next read.
 */
function createSSEParser() {
  let buffer = '';
  return {
    push(chunk: string, onEvent: (ev: SSEEvent) => void) {
      buffer += chunk;
      let boundary: number;
      // Events are separated by a blank line (\n\n).
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let eventName = '';
        let dataLine = '';
        for (const line of frame.split('\n')) {
          if (line.startsWith('event: ')) eventName = line.slice(7).trim();
          else if (line.startsWith('data: ')) dataLine = line.slice(6);
        }
        if (!dataLine) continue;
        try {
          const data = JSON.parse(dataLine);
          onEvent({ event: eventName, data });
        } catch {
          /* malformed JSON — drop this frame */
        }
      }
    },
    reset() {
      buffer = '';
    },
  };
}

interface ChatInterfaceProps {
  variant?: 'standalone' | 'embedded';
  hideHeader?: boolean;
}

export function ChatInterface({ variant = 'standalone', hideHeader = false }: ChatInterfaceProps = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const currentConversationId = useUIStore((s) => s.currentConversationId);
  const setCurrentConversation = useUIStore((s) => s.setCurrentConversation);
  const pendingChatReference = useUIStore((s) => s.pendingChatReference);
  const consumePendingChatReference = useUIStore((s) => s.consumePendingChatReference);
  const apiFetchClient = useApiFetch();

  // Derive the currently-open wiki page slug from the route so that questions
  // typed in the context panel's chat tab are always answered with that page
  // in context — even when FTS over the raw question returns nothing.
  const currentPageSlug = useMemo(() => {
    if (!pathname) return undefined;
    const match = pathname.match(/^\/wiki\/(.+)$/);
    if (!match) return undefined;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }, [pathname]);

  // Referenceable passages from the open page (context-panel chat only).
  const { id: ctxSubjectId, slug: ctxSubjectSlug } = useCurrentSubject();
  const canReference = variant === 'embedded' && !!currentPageSlug;
  const { data: pageContent } = useQuery({
    queryKey: ['page-detail', ctxSubjectId, currentPageSlug],
    queryFn: async () => {
      if (!currentPageSlug) return null;
      const res = await apiFetchClient(`/api/pages/${currentPageSlug}`);
      if (!res.ok) return null;
      return (await res.json()) as { title: string; content: string };
    },
    enabled: canReference && !!ctxSubjectId,
    staleTime: 30_000,
  });
  const passages = useMemo(
    () =>
      pageContent?.content
        ? parsePassages(pageContent.content, pageContent.title ?? currentPageSlug ?? '')
        : [],
    [pageContent, currentPageSlug],
  );
  const canRef = canReference && passages.length > 0;
  const [refs, setRefs] = useState<Passage[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  // Drop pinned references when navigating to a different page.
  // 用 ref 守卫：仅在 slug 真正变化时清空，不在挂载时清——否则（含 React
  // StrictMode dev 双挂载）会把刚通过选区信箱 pin 进来的引用误清掉。
  const prevPageSlugRef = useRef(currentPageSlug);
  useEffect(() => {
    if (prevPageSlugRef.current === currentPageSlug) return;
    prevPageSlugRef.current = currentPageSlug;
    setRefs([]);
    setPickerOpen(false);
  }, [currentPageSlug]);

  // 选中正文文本点「Ask AI」→ ui-store 信箱 → 这里 pin 进引用并聚焦。
  // 仅 embedded（右侧面板）变体消费，避免命令面板等其它实例抢占。
  useEffect(() => {
    if (variant !== 'embedded') return;
    if (!pendingChatReference) return;
    const ref = consumePendingChatReference();
    if (!ref) return;
    setRefs((prev) => {
      const withoutAnchoredSelection = ref.selection
        ? prev.filter((item) => !item.selection)
        : prev;
      return withoutAnchoredSelection.some((x) => x.id === ref.id)
        ? withoutAnchoredSelection
        : [...withoutAnchoredSelection, {
            id: ref.id,
            section: ref.section ?? 'Selection',
            text: ref.text,
            selection: ref.selection,
          }];
    });
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [variant, pendingChatReference, consumePendingChatReference]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [resetConfirmationState, setResetConfirmationState] =
    useState<ResetConfirmationState>('idle');
  const [pendingActions, setPendingActions] = useState<PendingActionView[]>([]);
  const [busyActionId, setBusyActionId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  // 记录「当前内存消息所属的会话 id」——防止 done 设置新 id 后再重拉覆盖流式消息
  const loadedConversationIdRef = useRef<string | null>(null);
  const loadedSubjectIdRef = useRef<string | null>(null);

  // 监听 conversation/subject 变化：并行恢复消息与审批操作；切换时取消旧请求。
  // 注意：done 事件会先把 loadedConversationIdRef 设为新 id，再 setCurrentConversation
  // 这样 useEffect 进来时 ref === currentConversationId，跳过重拉，避免覆盖流式消息
  useEffect(() => {
    const controller = new AbortController();
    if (
      currentConversationId === loadedConversationIdRef.current
      && ctxSubjectId === loadedSubjectIdRef.current
    ) return; // 自身 done 设置/未变，跳过重拉
    setResetConfirmationState('idle');
    if (!currentConversationId) {
      setMessages([]);
      setPendingActions([]);
      loadedConversationIdRef.current = null;
      loadedSubjectIdRef.current = ctxSubjectId ?? null;
      return;
    }
    (async () => {
      try {
        const [messagesResponse, actionsResponse] = await Promise.all([
          apiFetchClient(`/api/conversations/${currentConversationId}`, {
            signal: controller.signal,
          }),
          apiFetchClient(
            `/api/pending-actions?conversationId=${encodeURIComponent(currentConversationId)}`,
            { signal: controller.signal },
          ),
        ]);
        if (controller.signal.aborted) return;
        const messagesData = messagesResponse.ok
          ? await messagesResponse.json() as { messages: ConversationMessage[] }
          : { messages: [] };
        const actionsData = actionsResponse.ok
          ? await actionsResponse.json() as { actions: PendingActionView[] }
          : { actions: [] };
        if (controller.signal.aborted) return;
        setMessages(messagesData.messages.map(chatMessageFromConversation));
        setPendingActions(replacePendingActions(actionsData.actions));
        loadedConversationIdRef.current = currentConversationId;
        loadedSubjectIdRef.current = ctxSubjectId ?? null;
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        setMessages([]);
        setPendingActions([]);
        loadedConversationIdRef.current = currentConversationId;
        loadedSubjectIdRef.current = ctxSubjectId ?? null;
      }
    })();
    return () => controller.abort();
  }, [currentConversationId, ctxSubjectId, apiFetchClient]);

  const lastAssistantMessage =
    [...messages].reverse().find((m) => m.role === 'assistant') ?? null;

  const updateLastAssistant = (updater: (msg: ChatMessage) => ChatMessage) => {
    setMessages((prev) => {
      const idx = prev.findLastIndex((m) => m.role === 'assistant');
      if (idx === -1) return prev;
      const next = [...prev];
      next[idx] = updater(next[idx]);
      return next;
    });
  };

  const performReset = useCallback(async () => {
    setIsLoading(true);
    try {
      // Chat reset is always subject-scoped. If the bootstrap hasn't resolved
      // a subject yet we MUST refuse — sending an empty body to /api/reset
      // would clear every subject in the database.
      const subjectId = useUIStore.getState().currentSubjectId;
      if (!subjectId) {
        throw new Error('Subject is still loading. Please retry in a moment.');
      }
      const res = await apiFetch('/api/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await Promise.all(
        ['pages', 'page-detail', 'graph', 'search', 'jobs', 'backlinks', 'context', 'frontmatter']
          .map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
      );
      router.refresh();
      updateLastAssistant((msg) => ({
        ...msg,
        content:
          '✅ 当前 subject 已重置。该 subject 的页面、数据源与任务记录都已清空，你可以重新摄入内容了。',
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateLastAssistant((m) => ({ ...m, content: `❌ 重置失败：${msg}` }));
    } finally {
      setIsLoading(false);
    }
  }, [queryClient, router]);

  const handlePendingAction = useCallback(async (
    actionId: string,
    decision: 'approve' | 'reject',
  ) => {
    const subjectId = useUIStore.getState().currentSubjectId;
    if (!subjectId || busyActionId) return;
    setBusyActionId(actionId);
    try {
      const response = await apiFetchClient(`/api/pending-actions/${actionId}/${decision}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        action?: PendingActionView;
        error?: string;
        code?: string;
      };
      if (data.action) {
        setPendingActions((current) => upsertPendingAction(current, data.action!));
      }
      if (!response.ok) {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      if (!data.action) return;

      const startedJob = jobStartedDetailForAction(data.action);
      if (startedJob) dispatchJobStarted(startedJob);
      if (decision === 'approve' && data.action.kind === 'page-change') {
        await Promise.all(
          ['pages', 'page-detail', 'graph', 'search', 'backlinks', 'context', 'frontmatter', 'history']
            .map((key) => queryClient.invalidateQueries({ queryKey: [key] })),
        );
        router.refresh();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Action request failed.';
      setPendingActions((current) => current.map((action) =>
        action.actionId === actionId
          ? { ...action, error: { code: 'ACTION_REQUEST_FAILED', message } }
          : action,
      ));
    } finally {
      setBusyActionId(null);
    }
  }, [apiFetchClient, busyActionId, queryClient, router]);

  const sendMessage = useCallback(async () => {
    const question = input.trim();
    if (!question || isLoading) return;
    setInput('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';

    // Pinned passages travel as extra context to the model, then clear.
    const sentRefs = refs;
    setRefs([]);
    const backendQuestion = sentRefs.length
      ? `Use these excerpts from "${pageContent?.title ?? currentPageSlug}" as context:\n${sentRefs
          .map((r) => `> [${r.section}] ${r.text}`)
          .join('\n')}\n\nQuestion: ${question}`
      : question;
    const userReferences = currentPageSlug
      ? buildUserMessageReferences(sentRefs, {
          pageSlug: currentPageSlug,
          pageTitle: pageContent?.title ?? currentPageSlug,
          subjectSlug: ctxSubjectSlug,
        })
      : [];

    setIsLoading(true);
    setMessages((prev) => [...prev, createOutgoingUserMessage(question, userReferences)]);
    setMessages((prev) => [...prev, { role: 'assistant', content: '', citations: [] }]);
    abortRef.current = new AbortController();

    try {
      const subjectId = useUIStore.getState().currentSubjectId;
      const queryBody: Record<string, unknown> = {
        question: backendQuestion,
        userQuestion: question,
      };
      if (userReferences.length > 0) {
        queryBody.messageReferences = userReferences.map(({ section, excerpt }) => ({
          section,
          excerpt,
        }));
      }
      const intentContext = resetIntentContext(resetConfirmationState);
      if (intentContext) queryBody.intentContext = intentContext;
      const structuredSelection = sentRefs.find((ref) => ref.selection)?.selection;
      if (structuredSelection) queryBody.selection = structuredSelection;
      if (currentPageSlug) queryBody.pageSlug = currentPageSlug;
      if (subjectId) queryBody.subjectId = subjectId;
      const conversationId = useUIStore.getState().currentConversationId;
      if (conversationId) queryBody.conversationId = conversationId;

      const response = await apiFetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(queryBody),
        signal: abortRef.current.signal,
      });

      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        const errMsg = body.error ?? `Error: HTTP ${response.status}`;
        updateLastAssistant((msg) => ({ ...msg, content: errMsg }));
        return;
      }

      const reader = response.body.getReader();
      readerRef.current = reader;
      const decoder = new TextDecoder();
      const parser = createSSEParser();
      let fullContent = '';
      let shouldResetAfterStream = false;

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          parser.push(chunk, ({ event, data }) => {
            if (event === 'answer-delta') {
              const delta = (data as { delta: string }).delta;
              fullContent += delta;
              updateLastAssistant((msg) => ({ ...msg, content: fullContent }));
            } else if (event === 'tool-call') {
              const { toolName, args } = data as { toolName: string; args: string };
              updateLastAssistant((msg) => ({
                ...msg,
                activity: [...(msg.activity ?? []), { tool: toolName, label: args }],
              }));
            } else if (event === 'citations') {
              const citations = (data as { citations: Citation[] }).citations;
              updateLastAssistant((msg) => ({ ...msg, citations }));
            } else if (event === 'pending-action') {
              setPendingActions((current) =>
                upsertPendingAction(current, data as PendingActionView),
              );
            } else if (event === 'reset-confirmation') {
              const decision = (data as { decision: ResetConfirmationDecision }).decision;
              const transition = applyResetConfirmationDecision(
                resetConfirmationState,
                decision,
              );
              setResetConfirmationState(transition.state);
              shouldResetAfterStream = transition.shouldReset;
            } else if (event === 'error') {
              const message = (data as { error?: unknown }).error;
              const detail = typeof message === 'string' ? message : 'Query failed';
              fullContent = fullContent
                ? `${fullContent}\n\nError: ${detail}`
                : `Error: ${detail}`;
              updateLastAssistant((msg) => ({ ...msg, content: fullContent }));
            } else if (event === 'done') {
              const convId = (data as { conversationId?: string }).conversationId;
              if (convId) {
                // 先同步 ref，使随后 useEffect 因 ref === currentConversationId 而跳过重拉
                loadedConversationIdRef.current = convId;
                loadedSubjectIdRef.current = subjectId ?? null;
                if (convId !== useUIStore.getState().currentConversationId) {
                  setCurrentConversation(convId);
                }
                queryClient.invalidateQueries({ queryKey: ['conversations'] });
              }
            }
          });
        }
      } finally {
        reader.releaseLock();
        readerRef.current = null;
      }
      if (shouldResetAfterStream) await performReset();
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant' && !last.content) return prev.slice(0, -1);
          return prev;
        });
        return;
      }
      const errMsg = err instanceof Error ? err.message : 'Something went wrong';
      updateLastAssistant((msg) => ({ ...msg, content: errMsg }));
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, resetConfirmationState, performReset, currentPageSlug, ctxSubjectSlug, refs, pageContent, setCurrentConversation, queryClient]);

  // Abort any in-flight SSE stream when the component unmounts to avoid
  // leaking work and stale setState calls after the panel closes.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      readerRef.current?.cancel().catch(() => {});
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const handleStop = () => {
    abortRef.current?.abort();
    readerRef.current?.cancel();
    readerRef.current = null;
    setIsLoading(false);
  };

  const handleClear = () => {
    if (isLoading) handleStop();
    setMessages([]);
    setResetConfirmationState('idle');
  };

  const containerClass =
    variant === 'embedded'
      ? 'flex flex-col h-full bg-surface overflow-hidden'
      : 'flex flex-col h-full bg-surface rounded-md border border-border overflow-hidden';

  return (
    <div className={containerClass}>
      {!hideHeader && (
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Ask your Wiki</h2>
          {messages.length > 0 && (
            <Button intent="ghost" size="sm" onClick={handleClear}>
              <Trash2 className="h-3 w-3" />
              Clear
            </Button>
          )}
        </div>
      )}
      {hideHeader && messages.length > 0 && (
        <div className="flex items-center justify-end px-3 py-1">
          <Button intent="ghost" size="sm" onClick={handleClear}>
            <Trash2 className="h-3 w-3" />
            Clear
          </Button>
        </div>
      )}

      <MessageList
        key={currentConversationId ?? 'none'}
        messages={messages}
        isStreaming={isLoading}
        onSuggestionClick={(s) => {
          setInput(s);
          textareaRef.current?.focus();
        }}
      />

      {pendingActions.length > 0 && (
        <div className="max-h-72 space-y-2 overflow-y-auto border-t border-border px-3 py-2">
          {pendingActions.map((action) => (
            <PendingActionCard
              key={action.actionId}
              action={action}
              busy={busyActionId === action.actionId}
              onApprove={(actionId) => void handlePendingAction(actionId, 'approve')}
              onReject={(actionId) => void handlePendingAction(actionId, 'reject')}
            />
          ))}
        </div>
      )}

      {lastAssistantMessage && !isLoading && lastAssistantMessage.content && (
        <div className="px-3 pb-2">
          <SaveToWikiButton
            answer={lastAssistantMessage.content}
            citations={lastAssistantMessage.citations ?? []}
          />
        </div>
      )}

      <div className="relative border-t border-border p-3">
        {pickerOpen && canReference && (
          <ReferencePicker
            passages={passages}
            selected={refs}
            onPick={(p) => {
              setRefs((r) => (r.some((x) => x.id === p.id) ? r : [...r, p]));
              setPickerOpen(false);
              textareaRef.current?.focus();
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}

        {/* Composer — one rounded surface holding references, the field, and the
            action row, with a focus ring on the whole container. */}
        <div
          className={cn(
            'overflow-hidden rounded-lg border bg-canvas transition-[border-color,box-shadow] duration-fast ease-standard',
            composerFocused
              ? 'border-border-strong ring-[3px] ring-accent/20'
              : 'border-border',
          )}
        >
          {refs.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2.5 pt-2.5">
              {refs.map((r) => (
                <span
                  key={r.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-accent/25 bg-accent-subtle py-1 pl-2 pr-1"
                >
                  <TextQuote className="h-3 w-3 shrink-0 text-accent" />
                  <span className="max-w-[170px] truncate text-[11px] font-medium text-accent-strong">
                    {r.section}: {r.text}
                  </span>
                  <button
                    type="button"
                    onClick={() => setRefs((rs) => rs.filter((x) => x.id !== r.id))}
                    aria-label="Remove reference"
                    className="inline-flex rounded-sm p-0.5 text-accent-strong hover:bg-accent/10"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => setComposerFocused(true)}
            onBlur={() => setComposerFocused(false)}
            placeholder="Ask a question…"
            rows={2}
            className="block w-full resize-none border-0 bg-transparent px-3 pb-1 pt-2.5 text-sm leading-5 text-foreground placeholder:text-input-placeholder focus:outline-none"
          />

          <div className="flex items-center justify-between px-2 pb-2 pt-0.5">
            <button
              type="button"
              onClick={() => canRef && setPickerOpen((o) => !o)}
              disabled={!canRef}
              title={canRef ? undefined : 'Open a page to reference its content'}
              className={cn(
                'inline-flex h-7 items-center gap-1.5 rounded-md border border-border px-2 text-xs transition-colors focus-ring',
                canRef
                  ? 'text-foreground-secondary hover:bg-subtle'
                  : 'cursor-not-allowed text-foreground-tertiary opacity-60',
                pickerOpen && 'bg-subtle',
              )}
            >
              <TextQuote className="h-3.5 w-3.5" />
              <span>Reference</span>
            </button>

            {isLoading ? (
              <IconButton
                intent="danger"
                aria-label="Stop generating"
                data-tip="Stop"
                onClick={handleStop}
                className="tip tip-l rounded-full"
              >
                <StopCircle />
              </IconButton>
            ) : (
              <IconButton
                intent="primary"
                aria-label="Send"
                data-tip="Send · Enter"
                onClick={sendMessage}
                disabled={!input.trim()}
                className="tip tip-l rounded-full"
              >
                <ArrowUp />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Popover listing the current page's passages to attach as chat references. */
function ReferencePicker({
  passages,
  selected,
  onPick,
  onClose,
}: {
  passages: Passage[];
  selected: Passage[];
  onPick: (p: Passage) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-overlay" aria-hidden />
      <div className="absolute bottom-[calc(100%-8px)] left-3 right-3 z-sheet animate-slide-down overflow-hidden rounded-lg border border-border bg-surface shadow-md">
        <div className="border-b border-border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-foreground-tertiary">
          Reference from this page
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {passages.map((p) => {
            const on = selected.some((x) => x.id === p.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => onPick(p)}
                disabled={on}
                className={cn(
                  'flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left',
                  on ? 'opacity-55' : 'hover:bg-subtle',
                )}
              >
                {on ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                ) : (
                  <TextQuote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" />
                )}
                <span className="min-w-0">
                  <span className="mb-0.5 block text-[11px] font-semibold text-foreground-secondary">
                    {p.section}
                  </span>
                  <span className="block text-xs text-foreground line-clamp-2">{p.text}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
