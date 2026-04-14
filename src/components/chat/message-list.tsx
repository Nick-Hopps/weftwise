'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, memo, useMemo } from 'react';
import { renderMarkdown } from '@/lib/markdown-client';

export interface Citation {
  pageSlug: string;
  excerpt: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
}

interface MessageListProps {
  messages: ChatMessage[];
  isStreaming?: boolean;
  onSuggestionClick?: (suggestion: string) => void;
}

// Memoize to prevent re-parsing on every streaming tick for unchanged messages
const MarkdownText = memo(function MarkdownText({ content }: { content: string }) {
  const rendered = useMemo(() => renderMarkdown(content), [content]);
  return (
    <div className="space-y-0.5 text-sm leading-relaxed [&>h1]:text-xl [&>h1]:font-bold [&>h1]:mt-3 [&>h1]:mb-1 [&>h2]:text-lg [&>h2]:font-semibold [&>h2]:mt-3 [&>h2]:mb-1 [&>h3]:text-base [&>h3]:font-semibold [&>h3]:mt-3 [&>h3]:mb-1 [&>p]:leading-relaxed [&>ul]:ml-4 [&>ul]:list-disc [&>ol]:ml-4 [&>ol]:list-decimal [&>pre]:bg-zinc-100 [&>pre]:dark:bg-zinc-800 [&>pre]:rounded-md [&>pre]:p-3 [&>pre]:my-2 [&>pre]:overflow-x-auto [&>pre]:text-sm [&>pre]:font-mono [&_code]:bg-zinc-100 [&_code]:dark:bg-zinc-700 [&_code]:rounded [&_code]:px-1 [&_code]:text-sm [&_code]:font-mono [&>pre_code]:bg-transparent [&>pre_code]:p-0 [&>table]:w-full [&>table]:border-collapse [&>table]:my-2 [&>table]:text-xs [&_th]:border [&_th]:border-zinc-200 [&_th]:dark:border-zinc-700 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-zinc-200 [&_td]:dark:border-zinc-700 [&_td]:px-2 [&_td]:py-1 [&_a]:text-indigo-600 [&_a]:dark:text-indigo-400 [&_a]:hover:underline [&>blockquote]:border-l-4 [&>blockquote]:border-indigo-300 [&>blockquote]:dark:border-indigo-600 [&>blockquote]:pl-3 [&>blockquote]:py-0.5 [&>blockquote]:my-2 [&>blockquote]:italic [&>blockquote]:text-zinc-500">
      {rendered}
    </div>
  );
});

function StreamingIndicator() {
  return (
    <span className="inline-flex gap-1.5 items-center ml-2 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-indigo-400 dark:bg-indigo-400 animate-pulse"
          style={{ animationDelay: `${i * 0.2}s` }}
        />
      ))}
    </span>
  );
}

const SUGGESTIONS = [
  'Summarize this page',
  'Find related concepts',
  'What are the key takeaways?',
];

export function MessageList({ messages, isStreaming = false, onSuggestionClick }: MessageListProps) {
  const router = useRouter();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isStreaming]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <div className="w-12 h-12 bg-indigo-50 dark:bg-indigo-900/30 rounded-full flex items-center justify-center mb-4">
          <svg className="w-6 h-6 text-indigo-500 dark:text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
        </div>
        <p className="text-zinc-900 dark:text-slate-100 font-medium text-sm mb-1">Ask your Wiki</p>
        <p className="text-zinc-400 dark:text-zinc-500 text-xs mb-5 max-w-[220px] leading-relaxed">
          Query your knowledge base with natural language.
        </p>
        <div className="flex flex-col gap-2 w-full">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => onSuggestionClick?.(suggestion)}
              className="text-xs py-2 px-3 border border-zinc-200 dark:border-zinc-700 rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-indigo-50 dark:hover:bg-indigo-900/20 hover:border-indigo-300 dark:hover:border-indigo-800 hover:text-indigo-700 dark:hover:text-indigo-300 transition-colors text-left"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
      {messages.map((msg, idx) => {
        const isLast = idx === messages.length - 1;
        const showStreaming = isStreaming && isLast && msg.role === 'assistant';

        return (
          <div
            key={idx}
            className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 text-sm shadow-sm transition-all ${
                msg.role === 'user'
                  ? 'bg-indigo-600 dark:bg-indigo-500 text-white rounded-br-none border border-white/10'
                  : 'bg-zinc-50/80 dark:bg-zinc-800/80 backdrop-blur-sm border border-zinc-200/50 dark:border-zinc-700/50 text-zinc-900 dark:text-slate-100 rounded-bl-none'
              }`}
            >
              {msg.role === 'user' ? (
                <p className="whitespace-pre-wrap">{msg.content}</p>
              ) : (
                <MarkdownText content={msg.content} />
              )}
              {showStreaming && <StreamingIndicator />}

              {/* Citations */}
              {msg.citations && msg.citations.length > 0 && (
                <div className="mt-3 pt-3 border-t border-zinc-200 dark:border-zinc-700 space-y-2">
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    Sources
                  </p>
                  {msg.citations.map((cite, cIdx) => (
                    <button
                      key={cIdx}
                      onClick={() => router.push(`/wiki/${cite.pageSlug}`)}
                      className="block w-full text-left rounded-lg px-2.5 py-2 bg-white/50 dark:bg-zinc-900/50 border-l-2 border-indigo-500 hover:bg-indigo-50/50 dark:hover:bg-indigo-900/20 transition-colors"
                    >
                      <p className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
                        {cite.pageSlug}
                      </p>
                      {cite.excerpt && (
                        <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 line-clamp-2">
                          {cite.excerpt}
                        </p>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
