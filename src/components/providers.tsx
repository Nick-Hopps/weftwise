'use client';

import { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUIStore } from '@/stores/ui-store';
import { GlobalJobTracker } from '@/components/shared/global-job-tracker';
import { CommandPalette } from '@/components/search/command-palette';
import { ContextPanelSheet } from '@/components/layout/context-panel-sheet';
import { SettingsDialog } from '@/components/layout/settings-dialog';

// Create QueryClient inside component to avoid cross-request sharing in SSR.
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60 * 1000,
        retry: 1,
      },
    },
  });
}

// Always sync dark mode class with store state (no `initialized` guard).
function DarkModeInitializer() {
  const darkMode = useUIStore((s) => s.darkMode);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    document.documentElement.setAttribute('data-color-mode', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  return null;
}

// Global ⌘J / Ctrl+J — toggles the ContextPanel chat tab. Formerly lived in
// GlobalChatDrawer; moved here so the hotkey survives after that component was
// merged into ContextPanel.
function GlobalHotkeys() {
  const toggleContextPanel = useUIStore((s) => s.toggleContextPanel);
  const setContextPanelTab = useUIStore((s) => s.setContextPanelTab);
  const openContextPanel = useUIStore((s) => s.openContextPanel);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        const { contextPanelOpen, contextPanelTab } = useUIStore.getState();
        if (contextPanelOpen && contextPanelTab === 'chat') {
          toggleContextPanel();
        } else {
          openContextPanel('chat');
          setContextPanelTab('chat');
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleContextPanel, setContextPanelTab, openContextPanel]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(makeQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <DarkModeInitializer />
      <GlobalHotkeys />
      {children}
      <CommandPalette />
      <ContextPanelSheet />
      <SettingsDialog />
      <GlobalJobTracker />
    </QueryClientProvider>
  );
}
