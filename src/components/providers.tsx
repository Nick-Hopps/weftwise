'use client';

import { useState, useEffect } from 'react';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { GENERAL_SUBJECT_SLUG, useUIStore } from '@/stores/ui-store';
import { apiFetch } from '@/lib/api-fetch';
import type { SubjectListEntry } from '@/lib/contracts';
import { GlobalJobTracker } from '@/components/shared/global-job-tracker';
import { ScrollbarAutohide } from '@/components/shared/scrollbar-autohide';
import { CommandPalette } from '@/components/search/command-palette';
import { ContextPanelSheet } from '@/components/layout/context-panel-sheet';
import { SettingsDialog } from '@/components/layout/settings-dialog';
import { SubjectDialog } from '@/components/subjects/subject-dialog';
import { CognitiveLensOnboarding } from '@/components/layout/cognitive-lens-onboarding';
import { I18nProvider } from '@/components/i18n-provider';
import type { Locale } from '@/lib/i18n/config';

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

// 全局 ⌘J / Ctrl+J：切换 Ask AI 悬浮工作面。
function GlobalHotkeys() {
  const openAskAi = useUIStore((s) => s.openAskAi);
  const closeAskAi = useUIStore((s) => s.closeAskAi);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        if (useUIStore.getState().askAiOpen) {
          closeAskAi();
        } else {
          openAskAi();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [closeAskAi, openAskAi]);

  return null;
}

async function fetchSubjects(): Promise<SubjectListEntry[]> {
  const res = await apiFetch('/api/subjects');
  if (!res.ok) return [];
  return res.json();
}

/**
 * Reconcile the persisted subject with the server's truth on boot.
 *
 * - Persists the `subjects` query under the same key SubjectSwitcher uses, so
 *   the dropdown opens with no spinner.
 * - If the persisted `currentSubjectId` is missing on the server (deleted
 *   elsewhere), fall back to "general"; otherwise leave the persisted choice
 *   untouched.
 * - Always rewrites the store with a canonical `{id, slug}` so the cookie
 *   used by server middleware stays in sync.
 */
function SubjectsBootstrap() {
  const setCurrentSubject = useUIStore((s) => s.setCurrentSubject);
  const currentSubjectId = useUIStore((s) => s.currentSubjectId);
  const currentSubjectSlug = useUIStore((s) => s.currentSubjectSlug);

  const { data: subjects } = useQuery({
    queryKey: ['subjects'],
    queryFn: fetchSubjects,
    staleTime: 30_000,
  });

  useEffect(() => {
    if (!subjects || subjects.length === 0) return;

    // Cross-subject deep links (e.g. `/wiki/foo?s=frontend`) win over the
    // persisted choice — the SSR pages already use `?s` to pick a subject, so
    // the client store has to follow or sidebar/graph/search drift apart.
    // Read window.location directly so we don't drag the whole tree into a
    // useSearchParams Suspense boundary.
    const overrideSlug =
      typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('s')
        : null;
    const override = overrideSlug
      ? subjects.find((s) => s.slug === overrideSlug)
      : null;

    const persistedMatch = currentSubjectId
      ? subjects.find((s) => s.id === currentSubjectId)
      : null;

    const target =
      override ??
      persistedMatch ??
      subjects.find((s) => s.slug === GENERAL_SUBJECT_SLUG) ??
      subjects[0];

    // Skip the no-op case so we don't churn the cookie (and any downstream
    // listeners) on every render that subscribes to the same subject.
    if (target.id === currentSubjectId && target.slug === currentSubjectSlug) {
      return;
    }
    setCurrentSubject({ id: target.id, slug: target.slug });
  }, [subjects, currentSubjectId, currentSubjectSlug, setCurrentSubject]);

  return null;
}

export function Providers({ children, initialLocale }: { children: React.ReactNode; initialLocale: Locale }) {
  const [queryClient] = useState(makeQueryClient);

  return (
    <I18nProvider initialLocale={initialLocale}>
      <QueryClientProvider client={queryClient}>
        <DarkModeInitializer />
        <ScrollbarAutohide />
        <GlobalHotkeys />
        <SubjectsBootstrap />
        {children}
        <CommandPalette />
        <ContextPanelSheet />
        <SettingsDialog />
        <SubjectDialog />
        <CognitiveLensOnboarding />
        <GlobalJobTracker />
      </QueryClientProvider>
    </I18nProvider>
  );
}
