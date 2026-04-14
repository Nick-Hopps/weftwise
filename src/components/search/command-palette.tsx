'use client';
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from 'react';
import { useRouter } from 'next/navigation';
import { useUIStore } from '@/stores/ui-store';
import { useWikiSearch } from '@/hooks/use-wiki-search';
import { apiFetch } from '@/lib/api-fetch';
import { renderMarkdown } from '@/lib/markdown-client';

type PaletteMode = 'search' | 'ask';

function AskAnswerDisplay({ answer }: { answer: string }) {
  const rendered = useMemo(() => renderMarkdown(answer), [answer]);
  return (
    <div className="max-h-80 overflow-y-auto px-4 py-4">
      <div className="text-sm text-zinc-800 dark:text-zinc-200 leading-relaxed prose-wiki [&_a]:text-indigo-600 [&_a]:dark:text-indigo-400 [&_code]:text-xs [&_code]:bg-zinc-100 [&_code]:dark:bg-zinc-800 [&_code]:rounded [&_code]:px-1">
        {rendered}
      </div>
    </div>
  );
}

export function CommandPalette() {
  const router = useRouter();
  const isOpen = useUIStore((s) => s.commandPaletteOpen);
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<PaletteMode>('search');
  const [askLoading, setAskLoading] = useState(false);
  const [askAnswer, setAskAnswer] = useState<string | null>(null);

  // Only search when in search mode
  const searchQuery = mode === 'search' ? query : '';
  const { results, isLoading } = useWikiSearch(searchQuery);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Global Ctrl+K / Cmd+K shortcut
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        toggleCommandPalette();
      }
    };
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, [toggleCommandPalette]);

  // Reset state when opening
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setMode('search');
      setAskAnswer(null);
      setTimeout(() => inputRef.current?.focus(), 50);
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

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0);
  }, [results]);

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const navigate = useCallback(
    (slug: string) => {
      router.push(`/wiki/${slug}`);
      toggleCommandPalette();
      setQuery('');
    },
    [router, toggleCommandPalette]
  );

  const askAbortRef = useRef<AbortController | null>(null);

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

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.delta) {
                  fullAnswer += data.delta;
                  setAskAnswer(fullAnswer);
                }
              } catch { /* partial line */ }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!fullAnswer) setAskAnswer('No answer');
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setAskAnswer('Network error');
      }
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

    if (mode === 'ask') {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleAsk();
      }
      return;
    }

    if (results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const result = results[selectedIndex];
      if (result) navigate(result.page.slug);
    }
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      toggleCommandPalette();
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh] bg-black/40 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        className="w-full max-w-xl mx-4 bg-white dark:bg-zinc-900 rounded-xl shadow-2xl border border-zinc-200 dark:border-zinc-700 overflow-hidden animate-in fade-in slide-in-from-top-4 duration-200"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
          {mode === 'search' ? (
            <svg
              className="w-4 h-4 text-zinc-400 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          ) : (
            <svg
              className="w-4 h-4 text-emerald-500 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === 'ask' ? 'Ask a question...' : 'Search pages... (type /ask to query)'}
            className="flex-1 bg-transparent text-sm text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none"
          />
          {(isLoading || askLoading) && (
            <span className="text-xs text-zinc-400 animate-pulse">
              {askLoading ? 'Thinking...' : 'Searching...'}
            </span>
          )}
          {mode === 'ask' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 font-medium">
              ASK
            </span>
          )}
          <kbd className="hidden sm:flex items-center px-1.5 py-0.5 rounded text-xs font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-500 border border-zinc-300 dark:border-zinc-600">
            esc
          </kbd>
        </div>

        {/* Search Results */}
        {mode === 'search' && query.trim() && (
          <div className="max-h-80 overflow-y-auto">
            {results.length === 0 && !isLoading ? (
              <div className="px-4 py-6 text-center text-sm text-zinc-400 dark:text-zinc-500">
                No pages found for &quot;{query}&quot;
              </div>
            ) : (
              <ul ref={listRef} role="listbox">
                {results.map((result, idx) => (
                  <li
                    key={result.page.slug}
                    role="option"
                    aria-selected={idx === selectedIndex}
                    onClick={() => navigate(result.page.slug)}
                    onMouseEnter={() => setSelectedIndex(idx)}
                    className={`flex flex-col gap-0.5 px-4 py-3 cursor-pointer transition-colors ${
                      idx === selectedIndex
                        ? 'bg-blue-50 dark:bg-blue-950/40'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <svg
                        className="w-3.5 h-3.5 text-zinc-400 flex-shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                      </svg>
                      <span
                        className={`text-sm font-medium ${
                          idx === selectedIndex
                            ? 'text-blue-700 dark:text-blue-300'
                            : 'text-zinc-900 dark:text-slate-100'
                        }`}
                      >
                        {result.page.title ?? result.page.slug}
                      </span>
                    </div>
                    {result.snippet && (
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 line-clamp-1 pl-5">
                        {result.snippet}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Ask Answer */}
        {mode === 'ask' && askAnswer && (
          <AskAnswerDisplay answer={askAnswer} />
        )}

        {/* Footer hint */}
        {!query.trim() && (
          <div className="px-4 py-3 text-xs text-zinc-400 dark:text-zinc-500 flex items-center gap-4">
            <span>
              <kbd className="font-mono">↑↓</kbd> navigate
            </span>
            <span>
              <kbd className="font-mono">↵</kbd> open
            </span>
            <span>
              <kbd className="font-mono">/ask</kbd> query LLM
            </span>
            <span>
              <kbd className="font-mono">esc</kbd> close
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
