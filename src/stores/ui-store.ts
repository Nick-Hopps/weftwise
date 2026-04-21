'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ContextPanelTab = 'context' | 'chat';

interface UIState {
  sidebarOpen: boolean;

  /** Unified right-side drawer state (merged RightPanel + ChatDrawer + ChatFab). */
  contextPanelOpen: boolean;
  contextPanelTab: ContextPanelTab;
  contextPanelWidth: number;

  activePageSlug: string | null;
  commandPaletteOpen: boolean;
  darkMode: boolean;

  toggleSidebar: () => void;

  /** Toggle the panel in-place on its current tab. */
  toggleContextPanel: () => void;
  /** Open the panel and (optionally) switch to a specific tab. */
  openContextPanel: (tab?: ContextPanelTab) => void;
  closeContextPanel: () => void;
  setContextPanelTab: (tab: ContextPanelTab) => void;
  setContextPanelWidth: (width: number) => void;

  setActivePageSlug: (slug: string | null) => void;
  toggleCommandPalette: () => void;
  toggleDarkMode: () => void;
}

function applyDarkMode(enabled: boolean) {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', enabled);
    document.documentElement.setAttribute('data-color-mode', enabled ? 'dark' : 'light');
  }
}

function clampPanelWidth(width: number): number {
  return Math.min(600, Math.max(240, width));
}

// Persist migration: v1 → v2. Older clients used rightPanelOpen/chatOpen/rightPanelWidth.
// Merge into unified contextPanel* shape so returning users keep their layout.
interface LegacyPersistedState {
  darkMode?: boolean;
  rightPanelOpen?: boolean;
  rightPanelWidth?: number;
  chatOpen?: boolean;
  contextPanelOpen?: boolean;
  contextPanelTab?: ContextPanelTab;
  contextPanelWidth?: number;
}

function migratePersisted(persisted: unknown, version: number) {
  const prev = (persisted ?? {}) as LegacyPersistedState;

  if (version >= 2) {
    return {
      darkMode: !!prev.darkMode,
      contextPanelOpen: prev.contextPanelOpen ?? false,
      contextPanelTab: prev.contextPanelTab ?? 'context',
      contextPanelWidth: clampPanelWidth(prev.contextPanelWidth ?? 320),
    };
  }

  const width = clampPanelWidth(prev.rightPanelWidth ?? 320);
  let open = false;
  let tab: ContextPanelTab = 'context';

  if (prev.chatOpen) {
    open = true;
    tab = 'chat';
  } else if (prev.rightPanelOpen) {
    open = true;
    tab = 'context';
  }

  return {
    darkMode: !!prev.darkMode,
    contextPanelOpen: open,
    contextPanelTab: tab,
    contextPanelWidth: width,
  };
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      contextPanelOpen: false,
      contextPanelTab: 'context',
      contextPanelWidth: 320,
      activePageSlug: null,
      commandPaletteOpen: false,
      darkMode: false,

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),

      toggleContextPanel: () => set((s) => ({ contextPanelOpen: !s.contextPanelOpen })),
      openContextPanel: (tab) =>
        set((s) => ({
          contextPanelOpen: true,
          contextPanelTab: tab ?? s.contextPanelTab,
        })),
      closeContextPanel: () => set({ contextPanelOpen: false }),
      setContextPanelTab: (tab) => set({ contextPanelTab: tab }),
      setContextPanelWidth: (width) => set({ contextPanelWidth: clampPanelWidth(width) }),

      setActivePageSlug: (slug) => set({ activePageSlug: slug }),
      toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
      toggleDarkMode: () =>
        set((s) => {
          const next = !s.darkMode;
          applyDarkMode(next);
          return { darkMode: next };
        }),
    }),
    {
      name: 'ui-store',
      version: 2,
      migrate: migratePersisted,
      partialize: (s) => ({
        darkMode: s.darkMode,
        contextPanelOpen: s.contextPanelOpen,
        contextPanelTab: s.contextPanelTab,
        contextPanelWidth: s.contextPanelWidth,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyDarkMode(state.darkMode);
      },
    },
  ),
);
