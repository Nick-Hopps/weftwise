'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { X } from 'lucide-react';
import { useUIStore, type ContextPanelTab } from '@/stores/ui-store';
import { IconButton } from '@/components/ui/icon-button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { cn } from '@/lib/cn';
import { ContextPanelContextTab } from './context-panel-context-tab';
import { ContextPanelChatTab } from './context-panel-chat-tab';

/**
 * Unified right-side panel combining the legacy RightPanel + ChatFab +
 * ChatDrawer into a single surface with two tabs: Context (page metadata +
 * backlinks + mini-graph) and Ask AI (chat).
 *
 * Layout rules:
 *  - Desktop (>=1024px): rendered inline as a sibling to `<main>` in Shell.
 *  - Mobile/Tablet (<1024px): wrapped by `ContextPanelSheet` as an overlay.
 *
 * Tab defaults:
 *  - Wiki routes (`/wiki/*`): allow both Context and Chat tabs
 *  - Other routes: force Chat tab, hide Context trigger
 */
interface ContextPanelProps {
  variant?: 'docked' | 'sheet';
}

export function ContextPanel({ variant = 'docked' }: ContextPanelProps) {
  const pathname = usePathname();
  const {
    contextPanelOpen,
    contextPanelTab,
    closeContextPanel,
    setContextPanelTab,
  } = useUIStore();

  const slugMatch = pathname?.match(/^\/wiki\/(.+)$/);
  const currentSlug = slugMatch ? slugMatch[1] : null;
  const isWikiRoute = !!currentSlug;

  // On non-wiki routes, force the chat tab since there is no page context.
  useEffect(() => {
    if (!isWikiRoute && contextPanelTab === 'context' && contextPanelOpen) {
      setContextPanelTab('chat');
    }
  }, [isWikiRoute, contextPanelTab, contextPanelOpen, setContextPanelTab]);

  // Keep chat tab mounted once opened so SSE streams survive tab switches.
  const [chatEverMounted, setChatEverMounted] = useState(false);
  useEffect(() => {
    if (contextPanelOpen && contextPanelTab === 'chat') setChatEverMounted(true);
  }, [contextPanelOpen, contextPanelTab]);

  // Return focus to the document when the sheet variant closes.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (variant !== 'sheet' || !contextPanelOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeContextPanel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [variant, contextPanelOpen, closeContextPanel]);

  const effectiveTab: ContextPanelTab = !isWikiRoute && contextPanelTab === 'context'
    ? 'chat'
    : contextPanelTab;

  const handleTabChange = (v: string) => {
    setContextPanelTab(v as ContextPanelTab);
  };

  return (
    <aside
      ref={rootRef}
      className={cn(
        'flex flex-col h-full w-full min-w-0 bg-surface',
        variant === 'docked' ? 'border-l border-border' : '',
      )}
      aria-label="Context panel"
    >
      {/* One shared <Tabs> scope so that TabsTrigger's aria-controls maps to
          the matching TabsContent id. */}
      <Tabs value={effectiveTab} onValueChange={handleTabChange} className="flex flex-col h-full">
        {/* On article pages the [Context | Ask AI] tab strip is meaningful. On
            other routes only the chat exists, so the lone "Ask AI" tab is
            redundant: drop the whole top bar on the desktop dock, but keep a
            minimal close button on the mobile sheet (a full-width sheet has no
            other always-visible way to close). */}
        {(isWikiRoute || variant === 'sheet') && (
          <header className="flex items-center justify-between gap-2 px-3 h-header border-b border-border shrink-0">
            {isWikiRoute && (
              <TabsList>
                <TabsTrigger value="context">Context</TabsTrigger>
                <TabsTrigger value="chat">Ask AI</TabsTrigger>
              </TabsList>
            )}
            <IconButton size="sm" className="ml-auto" aria-label="Close panel" onClick={closeContextPanel}>
              <X />
            </IconButton>
          </header>
        )}

        <div className="flex-1 min-h-0 relative">
          {isWikiRoute && (
            <TabsContent value="context" className="h-full">
              <ContextPanelContextTab slug={currentSlug} />
            </TabsContent>
          )}
          <TabsContent value="chat" className="h-full" keepMounted={chatEverMounted}>
            <ContextPanelChatTab />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}
