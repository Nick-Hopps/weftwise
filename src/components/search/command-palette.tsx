'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import {
  ArrowRight,
  FileText,
  MessageCircle,
  PanelRight,
  Search,
  Sparkles,
} from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { useWikiSearch } from '@/hooks/use-wiki-search';
import { apiFetch } from '@/lib/api-fetch';
import { renderMarkdown } from '@/lib/markdown-client';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/cn';

type PaletteMode = 'search' | 'ask';

function AskAnswerDisplay({ answer }: { answer: string }) {
  const rendered = useMemo(() => renderMarkdown(answer), [answer]);
  return (
    <div className="max-h-80 overflow-y-auto px-4 py-3 border-t border-border">
      <div className="text-sm leading-relaxed text-prose-body [&_a]:text-accent [&_code]:text-xs [&_code]:bg-prose-code-bg [&_code]:text-prose-code [&_code]:rounded [&_code]:px-1">
        {rendered}
      </div>
    </div>
  );
}

export function CommandPalette() {
  const router = useRouter();
  const isOpen = useUIStore((s) => s.commandPaletteOpen);
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);
  const openContextPanel = useUIStore((s) => s.openContextPanel);
  const toggleContextPanel = useUIStore((s) => s.toggleContextPanel);
  const toggleDarkMode = useUIStore((s) => s.toggleDarkMode);

  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<PaletteMode>('search');
  const [askLoading, setAskLoading] = useState(false);
  const [askAnswer, setAskAnswer] = useState<string | null>(null);

  const searchQuery = mode === 'search' ? query : '';
  const { results, isLoading } = useWikiSearch(searchQuery);
  const askAbortRef = useRef<AbortController | null>(null);

  // Global ⌘K / Ctrl+K shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        toggleCommandPalette();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleCommandPalette]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setMode('search');
      setAskAnswer(null);
    }
  }, [isOpen]);

  // Detect mode from input
  useEffect(() => {
    if (query.startsWith('/ask ') || query.startsWith('/ask\t')) {
      setMode('ask');
    } else if (mode === 'ask' && !query.startsWith('/ask')) {
      setMode('search');
      setAskAnswer(null);
    }
  }, [query, mode]);

  const navigate = useCallback(
    (slug: string) => {
      router.push(`/wiki/${slug}`);
      toggleCommandPalette();
      setQuery('');
    },
    [router, toggleCommandPalette],
  );

  const handleAsk = useCallback(async () => {
    const question = query.replace(/^\/ask\s*/, '').trim();
    if (!question) return;
    askAbortRef.current?.abort();
    askAbortRef.current = new AbortController();

    setAskLoading(true);
    setAskAnswer('');
    try {
      const res = await apiFetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
        signal: askAbortRef.current.signal,
      });
      if (!res.ok || !res.body) {
        setAskAnswer('Failed to get answer');
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullAnswer = '';
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          // SSE frames are separated by \n\n — only parse complete frames.
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data: ')) continue;
              try {
                const data = JSON.parse(line.slice(6));
                if (data.delta) {
                  fullAnswer += data.delta;
                  setAskAnswer(fullAnswer);
                }
              } catch {
                /* malformed — drop */
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
      if (!fullAnswer) setAskAnswer('No answer');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setAskAnswer('Network error');
    } finally {
      setAskLoading(false);
    }
  }, [query]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      askAbortRef.current?.abort();
      toggleCommandPalette();
      return;
    }
    if (mode === 'ask' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleAsk();
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) toggleCommandPalette();
  };

  if (!isOpen) return null;

  const showCommands = !query.trim() && mode === 'search';

  return (
    <div
      className="fixed inset-0 z-command flex items-start justify-center pt-[15vh] bg-overlay/40 backdrop-blur-sm animate-fade-in"
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl mx-4 bg-surface rounded-lg shadow-lg border border-border overflow-hidden animate-slide-down"
      >
        <Command label="Command Menu" shouldFilter={false}>
          <div className="flex items-center gap-3 px-4 h-12 border-b border-border">
            {mode === 'search' ? (
              <Search className="h-4 w-4 text-foreground-tertiary shrink-0" />
            ) : (
              <Sparkles className="h-4 w-4 text-accent shrink-0" />
            )}
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              onKeyDown={handleKeyDown}
              placeholder={mode === 'ask' ? 'Ask a question…' : 'Search pages or type /ask to query AI…'}
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-foreground-tertiary focus:outline-none"
            />
            {(isLoading || askLoading) && (
              <span className="text-xs text-foreground-tertiary animate-pulse">
                {askLoading ? 'Thinking…' : 'Searching…'}
              </span>
            )}
            {mode === 'ask' && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-sm bg-accent-subtle text-accent-strong font-medium">
                ASK
              </span>
            )}
            <Kbd>ESC</Kbd>
          </div>

          <Command.List className="max-h-80 overflow-y-auto py-1">
            {mode === 'search' && (
              <>
                {query.trim() && results.length === 0 && !isLoading && (
                  <Command.Empty className="px-4 py-6 text-center text-sm text-foreground-tertiary">
                    No pages found for &quot;{query}&quot;
                  </Command.Empty>
                )}

                {query.trim() && results.length > 0 && (
                  <Command.Group heading="Pages">
                    {results.map((result) => (
                      <Command.Item
                        key={result.page.slug}
                        value={`page-${result.page.slug}`}
                        onSelect={() => navigate(result.page.slug)}
                        className={cn(
                          'flex items-start gap-2 px-3 py-2 mx-1 rounded-md cursor-pointer',
                          'aria-selected:bg-subtle aria-selected:text-foreground',
                          'text-foreground-secondary text-sm',
                        )}
                      >
                        <FileText className="h-3.5 w-3.5 mt-0.5 text-foreground-tertiary shrink-0" />
                        <span className="flex-1 min-w-0">
                          <span className="block truncate font-medium text-foreground">
                            {result.page.title ?? result.page.slug}
                          </span>
                          {result.snippet && (
                            <span className="block text-xs text-foreground-tertiary line-clamp-1">
                              {result.snippet}
                            </span>
                          )}
                        </span>
                        <ArrowRight className="h-3 w-3 mt-0.5 text-foreground-tertiary shrink-0" />
                      </Command.Item>
                    ))}
                  </Command.Group>
                )}

                {showCommands && (
                  <Command.Group heading="Actions">
                    <Command.Item
                      value="ask-ai"
                      onSelect={() => {
                        openContextPanel('chat');
                        toggleCommandPalette();
                      }}
                      className="flex items-center gap-2 px-3 h-9 mx-1 rounded-md cursor-pointer aria-selected:bg-subtle text-sm text-foreground"
                    >
                      <Sparkles className="h-3.5 w-3.5 text-accent" />
                      <span className="flex-1">Ask your Wiki</span>
                      <Kbd>⌘J</Kbd>
                    </Command.Item>
                    <Command.Item
                      value="toggle-context-panel"
                      onSelect={() => {
                        toggleContextPanel();
                        toggleCommandPalette();
                      }}
                      className="flex items-center gap-2 px-3 h-9 mx-1 rounded-md cursor-pointer aria-selected:bg-subtle text-sm text-foreground"
                    >
                      <PanelRight className="h-3.5 w-3.5 text-foreground-tertiary" />
                      <span className="flex-1">Toggle Context Panel</span>
                    </Command.Item>
                    <Command.Item
                      value="toggle-dark-mode"
                      onSelect={() => {
                        toggleDarkMode();
                        toggleCommandPalette();
                      }}
                      className="flex items-center gap-2 px-3 h-9 mx-1 rounded-md cursor-pointer aria-selected:bg-subtle text-sm text-foreground"
                    >
                      <MessageCircle className="h-3.5 w-3.5 text-foreground-tertiary" />
                      <span className="flex-1">Toggle Dark Mode</span>
                    </Command.Item>
                  </Command.Group>
                )}
              </>
            )}

            {mode === 'ask' && askAnswer && <AskAnswerDisplay answer={askAnswer} />}
          </Command.List>

          {showCommands && (
            <div className="flex items-center gap-3 px-4 py-2 text-[11px] text-foreground-tertiary border-t border-border">
              <span className="flex items-center gap-1">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> navigate
              </span>
              <span className="flex items-center gap-1">
                <Kbd>↵</Kbd> open
              </span>
              <span className="flex items-center gap-1">
                <Kbd>/ask</Kbd> query AI
              </span>
            </div>
          )}
        </Command>
      </div>
    </div>
  );
}
