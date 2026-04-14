'use client';

import { useState, useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useUIStore } from '@/stores/ui-store';
import { GlobalJobTracker } from '@/components/shared/global-job-tracker';
import { CommandPalette } from '@/components/search/command-palette';

// M3 fix: create QueryClient inside component to avoid cross-request sharing in SSR
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

// M4 fix: always sync dark mode class with store state (no `initialized` guard)
function DarkModeInitializer() {
  const darkMode = useUIStore((s) => s.darkMode);

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    document.documentElement.setAttribute('data-color-mode', darkMode ? 'dark' : 'light');
  }, [darkMode]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(makeQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <DarkModeInitializer />
      {children}
      <CommandPalette />
      <GlobalJobTracker />
    </QueryClientProvider>
  );
}
