'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Command } from 'cmdk';
import { ArrowRight, FileText, Search } from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { useWikiSearch } from '@/hooks/use-wiki-search';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/cn';
import { parseSearchSnippet } from '@/lib/search-snippet';
import { useI18n } from '@/components/i18n-provider';

export function CommandPalette() {
  const { t } = useI18n();
  const router = useRouter();
  const isOpen = useUIStore((s) => s.commandPaletteOpen);
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);

  const [query, setQuery] = useState('');
  const { results, isLoading } = useWikiSearch(query);

  // Global ⌘K / Ctrl+K shortcut.
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
    if (isOpen) setQuery('');
  }, [isOpen]);

  const navigate = useCallback(
    (slug: string) => {
      router.push(`/wiki/${slug}`);
      toggleCommandPalette();
      setQuery('');
    },
    [router, toggleCommandPalette],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') toggleCommandPalette();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) toggleCommandPalette();
  };

  if (!isOpen) return null;

  const q = query.trim();

  return (
    <div
      className="fixed inset-0 z-command flex items-start justify-center pt-[15vh] bg-overlay/40 backdrop-blur-sm animate-fade-in"
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('search.dialog')}
        className="w-full max-w-xl mx-4 bg-surface rounded-lg shadow-lg border border-border overflow-hidden animate-slide-down"
      >
        <Command label={t('search.dialog')} shouldFilter={false}>
          <div className="flex items-center gap-3 px-4 h-12 border-b border-border">
            <Search className="h-4 w-4 text-foreground-tertiary shrink-0" />
            <Command.Input
              autoFocus
              value={query}
              onValueChange={setQuery}
              onKeyDown={handleKeyDown}
              placeholder={t('search.placeholder')}
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-foreground-tertiary focus:outline-none"
            />
            <Kbd>ESC</Kbd>
          </div>

          <Command.List className="max-h-80 overflow-y-auto py-1">
            {!q ? (
              <p className="px-4 py-6 text-center text-sm text-foreground-tertiary">
                {t('search.start')}
              </p>
            ) : results.length === 0 && !isLoading ? (
              <p className="px-4 py-6 text-center text-sm text-foreground-tertiary">
                {t('search.empty', { query })}
              </p>
            ) : (
              results.length > 0 && (
                <Command.Group
                  heading={t('search.pages')}
                  className="[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-foreground-tertiary"
                >
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
                          <span className="mt-0.5 text-xs leading-5 text-foreground-tertiary line-clamp-2">
                            {parseSearchSnippet(result.snippet).map((segment, index) =>
                              segment.highlighted ? (
                                <mark
                                  key={index}
                                  className="rounded-sm bg-accent-subtle px-0.5 font-medium text-accent-strong"
                                >
                                  {segment.text}
                                </mark>
                              ) : (
                                <span key={index}>{segment.text}</span>
                              ),
                            )}
                          </span>
                        )}
                      </span>
                      <ArrowRight className="h-3 w-3 mt-0.5 text-foreground-tertiary shrink-0" />
                    </Command.Item>
                  ))}
                </Command.Group>
              )
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
