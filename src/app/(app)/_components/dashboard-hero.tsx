'use client';

import { useEffect, useState } from 'react';
import { Search, Sparkles } from 'lucide-react';
import { useUIStore } from '@/stores/ui-store';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';

interface DashboardHeroProps {
  pageCount: number;
  /** compact: left-aligned single-row layout for the dashboard split view */
  compact?: boolean;
}

function timeGreeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// Greeting depends on the local clock — render a neutral fallback on the
// server and replace it after hydration so SSR output matches the initial
// client render.
function useGreeting() {
  const [greeting, setGreeting] = useState('Welcome');
  useEffect(() => {
    setGreeting(timeGreeting());
  }, []);
  return greeting;
}

export function DashboardHero({ pageCount, compact = false }: DashboardHeroProps) {
  const openAskAi = useUIStore((s) => s.openAskAi);
  const toggleCommandPalette = useUIStore((s) => s.toggleCommandPalette);
  const greeting = useGreeting();

  const subtitle =
    pageCount === 0
      ? 'Your knowledge base is waiting. Ingest your first source to begin.'
      : 'Search the collection, ask across your sources, or continue from recent work.';

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
            <span>Ask your Wiki</span>
            <Kbd className="ml-1 bg-accent-hover/40 text-accent-fg border-transparent">⌘J</Kbd>
          </Button>

          <Button intent="outline" size="base" onClick={toggleCommandPalette}>
            <Search className="h-3.5 w-3.5" />
            <span>Search</span>
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
          <span>Ask your Wiki</span>
          <Kbd className="ml-1 bg-accent-hover/40 text-accent-fg border-transparent">⌘J</Kbd>
        </Button>

        <Button intent="outline" size="lg" onClick={toggleCommandPalette}>
          <Search className="h-4 w-4" />
          <span>Search pages</span>
          <Kbd className="ml-1">⌘K</Kbd>
        </Button>
      </div>
    </section>
  );
}
