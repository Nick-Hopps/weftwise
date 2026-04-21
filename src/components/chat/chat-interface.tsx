'use client';
import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Send, StopCircle, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import { MessageList } from './message-list';
import { SaveToWikiButton } from './save-to-wiki-button';
import { apiFetch } from '@/lib/api-fetch';
import type { ChatMessage, Citation } from './message-list';

type PendingAction = { kind: 'reset' } | null;

const RESET_INTENT_PATTERNS: RegExp[] = [
  /重置.*(当前)?.*(wiki|知识库|数据|内容|页面)/i,
  /清空.*(当前)?.*(wiki|知识库|数据|内容|页面)/i,
  /(把|将).*(wiki|知识库).*(清|重置|清空|清除|删除)/i,
  /(reset|wipe|clear|erase)\s+(the\s+)?(wiki|knowledge\s*base|everything|all)/i,
  /(start|begin)\s+over\s+(the\s+)?(wiki|knowledge\s*base)?/i,
];

function detectResetIntent(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return RESET_INTENT_PATTERNS.some((p) => p.test(normalized));
}

function detectConfirmation(text: string): 'yes' | 'no' | 'unclear' {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return 'unclear';

  if (/^(是|对|确认|确定|好|好的|是的|同意|继续|执行|没错|请继续)[!！。.?？]?$/.test(normalized)) {
    return 'yes';
  }
  if (/^(y|yes|yep|yeah|confirm|ok|okay|do it|proceed|go ahead)[!.?]?$/.test(normalized)) {
    return 'yes';
  }
  if (/^(否|不|不要|取消|放弃|别|停|算了|先不|再想想)[!！。.?？]?$/.test(normalized)) {
    return 'no';
  }
  if (/^(n|no|nope|cancel|abort|stop|nevermind|never mind)[!.?]?$/.test(normalized)) {
    return 'no';
  }
  return 'unclear';
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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const readerRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);

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
    setMessages((prev) => [...prev, { role: 'assistant', content: '正在重置 wiki…' }]);
    try {
      const res = await apiFetch('/api/reset', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await queryClient.invalidateQueries({ queryKey: ['pages'] });
      router.refresh();
      updateLastAssistant((msg) => ({
        ...msg,
        content:
          '✅ Wiki 已重置。所有页面、数据源与任务记录都已清空，你可以重新摄入内容了。',
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      updateLastAssistant((m) => ({ ...m, content: `❌ 重置失败：${msg}` }));
    } finally {
      setIsLoading(false);
    }
  }, [queryClient, router]);

  const sendMessage = useCallback(async () => {
    const question = input.trim();
    if (!question || isLoading) return;
    setInput('');

    if (pendingAction?.kind === 'reset') {
      setMessages((prev) => [...prev, { role: 'user', content: question }]);
      const decision = detectConfirmation(question);
      if (decision === 'yes') {
        setPendingAction(null);
        await performReset();
        return;
      }
      if (decision === 'no') {
        setPendingAction(null);
        setMessages((prev) => [...prev, { role: 'assistant', content: '好的，已取消重置，wiki 保持不变。' }]);
        return;
      }
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            '我没太确定你的意思。请回复 **“是”** 执行重置，或 **“否”** 取消（重置会清空所有页面和数据源，无法恢复）。',
        },
      ]);
      return;
    }

    if (detectResetIntent(question)) {
      setMessages((prev) => [...prev, { role: 'user', content: question }]);
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            '⚠️ 你确定要 **重置当前 wiki** 吗？\n\n这会 **清空所有页面、数据源和任务记录**，且 **无法恢复**。\n\n请回复 **“是”** 确认执行，或 **“否”** 取消。',
        },
      ]);
      setPendingAction({ kind: 'reset' });
      return;
    }

    setIsLoading(true);
    setMessages((prev) => [...prev, { role: 'user', content: question }]);
    setMessages((prev) => [...prev, { role: 'assistant', content: '', citations: [] }]);
    abortRef.current = new AbortController();

    try {
      const response = await apiFetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          currentPageSlug ? { question, pageSlug: currentPageSlug } : { question },
        ),
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
            } else if (event === 'citations') {
              const citations = (data as { citations: Citation[] }).citations;
              updateLastAssistant((msg) => ({ ...msg, citations }));
            }
          });
        }
      } finally {
        reader.releaseLock();
        readerRef.current = null;
      }
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
  }, [input, isLoading, pendingAction, performReset, currentPageSlug]);

  // Abort any in-flight SSE stream when the component unmounts to avoid
  // leaking work and stale setState calls after the panel closes.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      readerRef.current?.cancel().catch(() => {});
    };
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
    setPendingAction(null);
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
        messages={messages}
        isStreaming={isLoading}
        onSuggestionClick={(s) => {
          setInput(s);
          textareaRef.current?.focus();
        }}
      />

      {lastAssistantMessage && !isLoading && lastAssistantMessage.content && (
        <div className="px-3 pb-2">
          <SaveToWikiButton
            answer={lastAssistantMessage.content}
            citations={lastAssistantMessage.citations ?? []}
          />
        </div>
      )}

      <div className="border-t border-border p-3">
        <div className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question…"
            rows={2}
            className="flex-1 resize-none"
          />
          {isLoading ? (
            <Button intent="danger" size="base" onClick={handleStop}>
              <StopCircle className="h-3.5 w-3.5" />
              Stop
            </Button>
          ) : (
            <Button
              intent="primary"
              size="base"
              onClick={sendMessage}
              disabled={!input.trim()}
            >
              <Send className="h-3.5 w-3.5" />
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
