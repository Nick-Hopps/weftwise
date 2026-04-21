'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ContextPanelTab = 'context' | 'chat';

export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 400;
export const SIDEBAR_WIDTH_DEFAULT = 240;
export const CONTEXT_PANEL_WIDTH = 360;

interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;

  /** Unified right-side drawer state (merged RightPanel + ChatDrawer + ChatFab). */
  contextPanelOpen: boolean;
  contextPanelTab: ContextPanelTab;

  activePageSlug: string | null;
  commandPaletteOpen: boolean;
  darkMode: boolean;
  settingsDialogOpen: boolean;

  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  resetSidebarWidth: () => void;

  /** Toggle the panel in-place on its current tab. */
  toggleContextPanel: () => void;
  /** Open the panel and (optionally) switch to a specific tab. */
  openContextPanel: (tab?: ContextPanelTab) => void;
  closeContextPanel: () => void;
  setContextPanelTab: (tab: ContextPanelTab) => void;

  setActivePageSlug: (slug: string | null) => void;
  toggleCommandPalette: () => void;
  toggleDarkMode: () => void;
  openSettingsDialog: () => void;
  closeSettingsDialog: () => void;
}

function applyDarkMode(enabled: boolean) {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.toggle('dark', enabled);
    document.documentElement.setAttribute('data-color-mode', enabled ? 'dark' : 'light');
  }
}

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width));
}

// Persist migration: v1 → v2 → v3.
// v1: rightPanelOpen/chatOpen/rightPanelWidth
// v2: contextPanelOpen/contextPanelTab/contextPanelWidth
// v3: drops contextPanelWidth (right panel is now fixed), adds sidebarWidth.
interface LegacyPersistedState {
  darkMode?: boolean;
  rightPanelOpen?: boolean;
  rightPanelWidth?: number;
  chatOpen?: boolean;
  contextPanelOpen?: boolean;
  contextPanelTab?: ContextPanelTab;
  contextPanelWidth?: number;
  sidebarWidth?: number;
}

function migratePersisted(persisted: unknown, version: number) {
  const prev = (persisted ?? {}) as LegacyPersistedState;

  if (version >= 3) {
    return {
      darkMode: !!prev.darkMode,
      contextPanelOpen: prev.contextPanelOpen ?? false,
      contextPanelTab: prev.contextPanelTab ?? 'context',
      sidebarWidth: clampSidebarWidth(prev.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT),
    };
  }

  if (version >= 2) {
    return {
      darkMode: !!prev.darkMode,
      contextPanelOpen: prev.contextPanelOpen ?? false,
      contextPanelTab: prev.contextPanelTab ?? 'context',
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
    };
  }

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
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  };
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      contextPanelOpen: false,
      contextPanelTab: 'context',
      activePageSlug: null,
      commandPaletteOpen: false,
      darkMode: false,
      settingsDialogOpen: false,

      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
      resetSidebarWidth: () => set({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT }),

      toggleContextPanel: () => set((s) => ({ contextPanelOpen: !s.contextPanelOpen })),
      openContextPanel: (tab) =>
        set((s) => ({
          contextPanelOpen: true,
          contextPanelTab: tab ?? s.contextPanelTab,
        })),
      closeContextPanel: () => set({ contextPanelOpen: false }),
      setContextPanelTab: (tab) => set({ contextPanelTab: tab }),

      setActivePageSlug: (slug) => set({ activePageSlug: slug }),
      toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
      toggleDarkMode: () =>
        set((s) => {
          const next = !s.darkMode;
          applyDarkMode(next);
          return { darkMode: next };
        }),
      openSettingsDialog: () => set({ settingsDialogOpen: true }),
      closeSettingsDialog: () => set({ settingsDialogOpen: false }),
    }),
    {
      name: 'ui-store',
      version: 3,
      migrate: migratePersisted,
      partialize: (s) => ({
        darkMode: s.darkMode,
        contextPanelOpen: s.contextPanelOpen,
        contextPanelTab: s.contextPanelTab,
        sidebarWidth: s.sidebarWidth,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) applyDarkMode(state.darkMode);
      },
    },
  ),
);
