'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import React, { useEffect, useRef, useState, memo, useMemo } from 'react';
import { ChevronDown, MessageCircleQuestion, TextQuote } from 'lucide-react';
import { renderMarkdown } from '@/lib/markdown-client';
import { cn } from '@/lib/cn';
import { toolActivityIcon, toolActivityVerb } from '@/lib/tool-activity';
import { citationHref } from '@/lib/wiki-citation';
import { displayTitleForSlug } from '@/lib/path-display';
import {
  didTouchGestureScrollUp,
  shouldPauseMessageFollowForWheel,
  updateMessageScrollFollowState,
} from './message-scroll';
import type { UserMessageReference } from '@/lib/contracts';
import type { ChatMessage, Citation } from './chat-message';

export type { ChatMessage, Citation } from './chat-message';

interface MessageListProps {
  messages: ChatMessage[];
  isStreaming?: boolean;
  onSuggestionClick?: (suggestion: string) => void;
}

// Memoize to prevent re-parsing on every streaming tick for unchanged messages
export const MarkdownText = memo(function MarkdownText({ content }: { content: string }) {
  const rendered = useMemo(() => renderMarkdown(content), [content]);
  return (
    <div className={cn(
      'min-w-0 max-w-full overflow-x-auto text-sm leading-[22px] text-foreground',
      '[&>h1]:text-lg [&>h1]:font-semibold [&>h1]:text-foreground [&>h1]:mt-3 [&>h1]:mb-1',
      '[&>h2]:text-base [&>h2]:font-semibold [&>h2]:text-foreground [&>h2]:mt-3 [&>h2]:mb-1',
      '[&>h3]:text-sm [&>h3]:font-semibold [&>h3]:text-foreground [&>h3]:mt-3 [&>h3]:mb-1',
      '[&>p]:mb-2',
      '[&>ul]:ml-4 [&>ul]:list-disc [&>ul]:mb-2',
      '[&>ol]:ml-4 [&>ol]:list-decimal [&>ol]:mb-2',
      '[&>pre]:bg-prose-code-bg [&>pre]:text-prose-code [&>pre]:rounded-md [&>pre]:p-3 [&>pre]:my-2 [&>pre]:overflow-x-auto [&>pre]:text-xs [&>pre]:font-mono',
      '[&_code]:bg-prose-code-bg [&_code]:text-prose-code [&_code]:rounded-sm [&_code]:px-1 [&_code]:text-xs [&_code]:font-mono',
      '[&>pre_code]:bg-transparent [&>pre_code]:p-0',
      '[&_a]:text-accent [&_a]:underline [&_a]:decoration-accent/40 [&_a]:underline-offset-4 [&_a]:hover:decoration-accent',
      '[&>blockquote]:border-l-2 [&>blockquote]:border-prose-quote [&>blockquote]:pl-3 [&>blockquote]:py-0.5 [&>blockquote]:my-2 [&>blockquote]:italic [&>blockquote]:text-foreground-secondary',
      '[&>table]:my-2 [&>table]:min-w-full [&>table]:table-fixed [&>table]:border-collapse [&>table]:text-xs',
      '[&_th]:break-words [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold',
      '[&_td]:break-words [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
    )}>
      {rendered}
    </div>
  );
});

// 单条消息引用列表的可折叠区块。
// citations.length > 3 → 默认折叠；<= 3 → 默认展开。
// 每条消息独立维护本地折叠状态，交互模式仿 layout/sidebar.tsx 现有的 "Sources" 分组折叠。
const MessageCitations = memo(function MessageCitations({ citations }: { citations: Citation[] }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(citations.length <= 3);

  return (
    <div className="mt-3 pt-2 border-t border-border">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="w-full flex items-center justify-between h-6 rounded-md text-[10px] font-medium uppercase tracking-wider text-foreground-tertiary hover:text-foreground transition-colors focus-ring"
      >
        <span className="flex items-center gap-1.5">
          <ChevronDown className={cn('h-3 w-3 transition-transform', !expanded && '-rotate-90')} />
          Sources
        </span>
        <span className="tabular-nums text-xs font-normal normal-case tracking-normal">
          {citations.length}
        </span>
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1.5">
          {citations.map((cite, cIdx) => (
            <button
              key={cIdx}
              onClick={() => router.push(citationHref(cite))}
              className="block w-full text-left rounded-sm px-2 py-1.5 bg-subtle hover:bg-accent-subtle transition-colors focus-ring"
            >
              <p className="text-xs font-medium text-accent-strong">
                {cite.subjectSlug ? `${cite.subjectSlug}:${cite.pageSlug}` : cite.pageSlug}
              </p>
              {cite.excerpt && (
                <p className="text-xs text-foreground-secondary mt-0.5 line-clamp-2">
                  {cite.excerpt}
                </p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export function UserMessageReferenceCapsule({
  references,
}: {
  references: UserMessageReference[];
}) {
  const reference = references[0];

  if (!reference) return null;

  const rawSummary = reference.section?.trim()
    || reference.excerpt.replace(/\s+/g, ' ').trim();
  const summaryCharacters = Array.from(rawSummary);
  const summary = summaryCharacters.length > 36
    ? `${summaryCharacters.slice(0, 35).join('').trimEnd()}…`
    : rawSummary;
  const label = summary
    ? `${reference.pageTitle?.trim() || displayTitleForSlug(reference.pageSlug)} · ${summary}`
    : reference.pageTitle?.trim() || displayTitleForSlug(reference.pageSlug);

  return (
    <Link
      href={citationHref(reference)}
      aria-label="Open referenced page"
      className="mb-2 inline-flex h-6 max-w-full items-center gap-1.5 overflow-hidden rounded-full border border-accent/20 bg-accent-subtle/60 px-2.5 text-[11px] font-medium text-accent-strong transition-colors hover:border-accent/35 hover:bg-accent-subtle focus-ring"
    >
      <TextQuote className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </Link>
  );
}

function StreamingIndicator() {
  return (
    <span className="inline-flex gap-1 items-center ml-2 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-1 h-1 rounded-full bg-accent animate-pulse"
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

const MessageRow = memo(function MessageRow({
  message,
  showStreaming,
}: {
  message: ChatMessage;
  showStreaming: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className={cn(
        'text-[10px] font-medium uppercase tracking-wider',
        message.role === 'user' ? 'text-foreground-tertiary' : 'text-accent-strong',
      )}>
        {message.role === 'user' ? 'You' : 'Wiki'}
      </span>
      <div className={cn(
        'min-w-0 border-l-2 py-0.5 pl-3',
        message.role === 'user' ? 'border-border-strong' : 'border-accent',
      )}>
        {message.role === 'user' ? (
          <>
            {message.references && message.references.length > 0 && (
              <UserMessageReferenceCapsule references={message.references} />
            )}
            <p className="whitespace-pre-wrap text-sm text-foreground">{message.content}</p>
          </>
        ) : (
          <>
            {message.activity && message.activity.length > 0 && (
              <ul className="mb-1.5 space-y-0.5">
                {message.activity.map((activity, index) => (
                  <li
                    key={index}
                    className="flex items-center gap-1.5 font-mono text-[11px] text-foreground-tertiary"
                  >
                    <span>{toolActivityIcon(activity.tool)}</span>
                    <span className="truncate">
                      {toolActivityVerb(activity.tool)}
                      {activity.label ? `: ${activity.label}` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <MarkdownText content={message.content} />
          </>
        )}
        {showStreaming && <StreamingIndicator />}

        {message.role === 'assistant' && message.citations && message.citations.length > 0 && (
          <MessageCitations citations={message.citations} />
        )}
      </div>
    </div>
  );
});

export function MessageList({ messages, isStreaming = false, onSuggestionClick }: MessageListProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const scrollFollowStateRef = useRef({
    followsBottom: true,
    previousScrollTop: 0,
  });
  const previousTouchYRef = useRef<number | null>(null);
  const previousMessageCountRef = useRef(0);

  useEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (!scrollFollowStateRef.current.followsBottom) return;
      list.scrollTop = list.scrollHeight;
      scrollFollowStateRef.current.previousScrollTop = list.scrollTop;
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const previousCount = previousMessageCountRef.current;
    if (messages.slice(previousCount).some((message) => message.role === 'user')) {
      scrollFollowStateRef.current.followsBottom = true;
    }
    previousMessageCountRef.current = messages.length;
    if (!scrollFollowStateRef.current.followsBottom) return;
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      list.scrollTop = list.scrollHeight;
      scrollFollowStateRef.current.previousScrollTop = list.scrollTop;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, isStreaming]);

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center">
        <div className="h-10 w-10 rounded-full bg-accent-subtle flex items-center justify-center mb-3">
          <MessageCircleQuestion className="h-5 w-5 text-accent" aria-hidden />
        </div>
        <p className="text-sm font-medium text-foreground mb-1">Ask your Wiki</p>
        <p className="text-xs text-foreground-secondary mb-5 max-w-[240px] leading-relaxed">
          Query your knowledge base with natural language.
        </p>
        <div className="flex flex-col gap-1.5 w-full max-w-[280px]">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => onSuggestionClick?.(suggestion)}
              className="text-xs py-2 px-3 border border-border rounded-md text-foreground-secondary hover:bg-subtle hover:text-foreground transition-colors text-left focus-ring"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      data-ask-ai-message-list
      className="min-w-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3"
      onWheel={(event) => {
        if (shouldPauseMessageFollowForWheel(event.deltaY)) {
          scrollFollowStateRef.current.followsBottom = false;
        }
      }}
      onTouchStart={(event) => {
        previousTouchYRef.current = event.touches[0]?.clientY ?? null;
      }}
      onTouchMove={(event) => {
        const currentY = event.touches[0]?.clientY;
        const previousY = previousTouchYRef.current;
        if (currentY === undefined) return;
        if (previousY !== null && didTouchGestureScrollUp(previousY, currentY)) {
          scrollFollowStateRef.current.followsBottom = false;
        }
        previousTouchYRef.current = currentY;
      }}
      onTouchEnd={() => {
        previousTouchYRef.current = null;
      }}
      onTouchCancel={() => {
        previousTouchYRef.current = null;
      }}
      onScroll={(event) => {
        scrollFollowStateRef.current = updateMessageScrollFollowState(
          scrollFollowStateRef.current,
          event.currentTarget,
        );
      }}
    >
      {messages.map((msg, idx) => {
        const isLast = idx === messages.length - 1;
        const showStreaming = isStreaming && isLast && msg.role === 'assistant';

        return (
          <MessageRow
            key={`${msg.role}-${idx}`}
            message={msg}
            showStreaming={showStreaming}
          />
        );
      })}
    </div>
  );
}
