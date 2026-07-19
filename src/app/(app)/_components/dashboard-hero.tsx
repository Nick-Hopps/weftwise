'use client';

import { useEffect, useState } from 'react';
import { Search, Sparkles } from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import { useI18n } from '@/components/i18n-provider';
import type { TranslationFunction } from '@/lib/i18n/translator';

interface DashboardHeroProps {
  pageCount: number;
  /** compact: left-aligned single-row layout for the dashboard split view */
  compact?: boolean;
}

function timeGreeting(t: TranslationFunction): string {
  const h = new Date().getHours();
  if (h < 5) return t('dashboard.greeting.late');
  if (h < 12) return t('dashboard.greeting.morning');
  if (h < 18) return t('dashboard.greeting.afternoon');
  return t('dashboard.greeting.evening');
}

// Greeting depends on the local clock — render a neutral fallback on the
// server and replace it after hydration so SSR output matches the initial
// client render.
function useGreeting(t: TranslationFunction) {
  const [greeting, setGreeting] = useState(t('dashboard.greeting.welcome'));
  useEffect(() => {
    setGreeting(timeGreeting(t));
  }, [t]);
  return greeting;
}

export function DashboardHero({ pageCount, compact = false }: DashboardHeroProps) {
  const { t } = useI18n();
  const openAskAi = useUIStore((s) => s.openAskAi);
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);
  const greeting = useGreeting(t);

  const subtitle =
    pageCount === 0
      ? t('dashboard.emptySubtitle')
      : t('dashboard.subtitle');

  if (compact) {
    return (
      <section className="max-w-[560px] space-y-4">
        <div className="space-y-1.5">
          <h1 className="font-display text-3xl font-semibold tracking-normal text-foreground">
            {greeting}.
          </h1>
          <p className="text-sm leading-6 text-foreground-secondary">
            {subtitle}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            intent="primary"
            size="base"
            onClick={() => openAskAi()}
          >
            <Sparkles className="h-3.5 w-3.5" />
            <span>{t('dashboard.ask')}</span>
            <Kbd className="ml-1 bg-accent-hover/40 text-accent-fg border-transparent">⌘J</Kbd>
          </Button>

          <Button intent="outline" size="base" onClick={toggleCommandPalette}>
            <Search className="h-3.5 w-3.5" />
            <span>{t('dashboard.search')}</span>
            <Kbd className="ml-1">⌘K</Kbd>
          </Button>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-5 py-4">
      <div className="space-y-1.5">
        <h1 className="font-display text-3xl font-semibold tracking-normal text-foreground">
          {greeting}.
        </h1>
        <p className="text-sm leading-6 text-foreground-secondary">
          {subtitle}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          intent="primary"
          size="lg"
          onClick={() => openAskAi()}
        >
          <Sparkles className="h-4 w-4" />
          <span>{t('dashboard.ask')}</span>
          <Kbd className="ml-1 bg-accent-hover/40 text-accent-fg border-transparent">⌘J</Kbd>
        </Button>

        <Button intent="outline" size="lg" onClick={toggleCommandPalette}>
          <Search className="h-4 w-4" />
          <span>{t('dashboard.searchPages')}</span>
          <Kbd className="ml-1">⌘K</Kbd>
        </Button>
      </div>
    </section>
  );
}
