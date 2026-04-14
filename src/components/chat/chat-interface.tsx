'use client';
import { useState, useRef, useCallback } from 'react';
import { MessageList } from './message-list';
import { SaveToWikiButton } from './save-to-wiki-button';
import { apiFetch } from '@/lib/api-fetch';
import type { ChatMessage, Citation } from './message-list';

interface SSEEvent {
  event: string;
  data: unknown;
}

function parseSSEEvents(chunk: string): SSEEvent[] {
  const events: SSEEvent[] = [];
  let currentEvent = '';

  for (const line of chunk.split('\n')) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        events.push({ event: currentEvent, data });
        currentEvent = '';
      } catch {
        // Incomplete JSON fragment — skip
      }
    }
  }
  return events;
}

export function ChatInterface() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
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

  const sendMessage = useCallback(async () => {
    const question = input.trim();
    if (!question || isLoading) return;

    setInput('');
    setIsLoading(true);

    // Add user message immediately
    setMessages((prev) => [...prev, { role: 'user', content: question }]);

    // Add placeholder assistant message
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', content: '', citations: [] },
    ]);

    abortRef.current = new AbortController();

    try {
      const response = await apiFetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
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
      let fullContent = '';

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          const events = parseSSEEvents(chunk);

          for (const { event, data } of events) {
            if (event === 'answer-delta') {
              const delta = (data as { delta: string }).delta;
              fullContent += delta;
              updateLastAssistant((msg) => ({ ...msg, content: fullContent }));
            } else if (event === 'citations') {
              const citations = (data as { citations: Citation[] }).citations;
              updateLastAssistant((msg) => ({ ...msg, citations }));
            }
            // 'done' event — stream finished naturally
          }
        }
      } finally {
        reader.releaseLock();
        readerRef.current = null;
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // Remove the empty placeholder on user-initiated abort
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant' && !last.content) {
            return prev.slice(0, -1);
          }
          return prev;
        });
        return;
      }
      const errMsg =
        err instanceof Error ? err.message : 'Something went wrong';
      updateLastAssistant((msg) => ({ ...msg, content: errMsg }));
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading]);

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
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
        <h2 className="text-sm font-semibold text-zinc-900 dark:text-slate-100">
          Ask your Wiki
        </h2>
        {messages.length > 0 && (
          <button
            onClick={handleClear}
            className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
          >
            Clear
          </button>
        )}
      </div>

      {/* Messages */}
      <MessageList
        messages={messages}
        isStreaming={isLoading}
        onSuggestionClick={(s) => {
          setInput(s);
          textareaRef.current?.focus();
        }}
      />

      {/* Save to Wiki (after last assistant message) */}
      {lastAssistantMessage && !isLoading && lastAssistantMessage.content && (
        <div className="px-4 pb-2">
          <SaveToWikiButton
            answer={lastAssistantMessage.content}
            citations={lastAssistantMessage.citations ?? []}
          />
        </div>
      )}

      {/* Input area */}
      <div className="border-t border-zinc-200 dark:border-zinc-700 p-3">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question..."
            rows={2}
            className="flex-1 resize-none rounded-xl border border-zinc-200 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-800/50 px-3 py-2.5 text-sm text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500 dark:focus:border-indigo-400 transition-all"
          />
          {isLoading ? (
            <button
              onClick={handleStop}
              className="px-3 py-2 rounded-xl bg-red-500 hover:bg-red-600 text-white text-sm font-medium transition-colors shadow-sm"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={sendMessage}
              disabled={!input.trim()}
              className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors shadow-sm"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
