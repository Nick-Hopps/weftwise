'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIState {
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  activePageSlug: string | null;
  commandPaletteOpen: boolean;
  darkMode: boolean;
  toggleSidebar: () => void;
  toggleRightPanel: () => void;
  setRightPanelWidth: (width: number) => void;
  setActivePageSlug: (slug: string | null) => void;
  toggleCommandPalette: () => void;
  toggleDarkMode: () => void;
}

function applyDarkMode(enabled: boolean) {
  if (typeof document !== 'undefined') {
    if (enabled) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    document.documentElement.setAttribute('data-color-mode', enabled ? 'dark' : 'light');
  }
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      sidebarOpen: true,
      rightPanelOpen: true,
      rightPanelWidth: 320,
      activePageSlug: null,
      commandPaletteOpen: false,
      darkMode: false,

      toggleSidebar: () =>
        set((state) => ({ sidebarOpen: !state.sidebarOpen })),

      toggleRightPanel: () =>
        set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),

      setRightPanelWidth: (width) =>
        set({ rightPanelWidth: Math.min(600, Math.max(240, width)) }),

      setActivePageSlug: (slug) => set({ activePageSlug: slug }),

      toggleCommandPalette: () =>
        set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),

      toggleDarkMode: () =>
        set((state) => {
          const next = !state.darkMode;
          applyDarkMode(next);
          return { darkMode: next };
        }),
    }),
    {
      name: 'ui-store',
      partialize: (state) => ({ darkMode: state.darkMode, rightPanelWidth: state.rightPanelWidth }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyDarkMode(state.darkMode);
        }
      },
    }
  )
);
