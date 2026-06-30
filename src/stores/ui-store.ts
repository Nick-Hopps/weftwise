'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { selectionRefId } from '@/lib/selection-text';

export type ContextPanelTab = 'context' | 'chat';

/** 选中正文文本「追问」时，按钮 → chat 之间传递的引用片段。 */
export interface PendingChatReference {
  id: string;
  section: string | null;
  text: string;
}

export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 400;
export const SIDEBAR_WIDTH_DEFAULT = 240;
export const CONTEXT_PANEL_WIDTH = 460;

export const GENERAL_SUBJECT_SLUG = 'general';
export const SUBJECT_COOKIE_NAME = 'wiki_subject';

interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;

  /** Unified right-side drawer state (merged RightPanel + ChatDrawer + ChatFab). */
  contextPanelOpen: boolean;
  contextPanelTab: ContextPanelTab;

  commandPaletteOpen: boolean;
  darkMode: boolean;
  settingsDialogOpen: boolean;
  /** 创建/编辑 subject 弹窗的瞬态状态（不持久化）。*/
  subjectDialog: { open: boolean; mode: 'create' | 'edit'; subjectId: string | null };
  /** 选中正文文本后「追问」的瞬态信箱（不持久化）。*/
  pendingChatReference: PendingChatReference | null;

  /**
   * Currently selected subject. `null` until a subject is chosen or rehydrated;
   * `currentSubjectSlug` defaults to "general" so server requests have a sane
   * fallback before the bootstrap query resolves.
   */
  currentSubjectId: string | null;
  currentSubjectSlug: string;

  currentConversationId: string | null;
  /** subjectId -> 该 subject 上次打开的可记忆路径（仅 pathname）。*/
  lastPageBySubject: Record<string, string>;

  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  resetSidebarWidth: () => void;

  /** Toggle the panel in-place on its current tab. */
  toggleContextPanel: () => void;
  /** Open the panel and (optionally) switch to a specific tab. */
  openContextPanel: (tab?: ContextPanelTab) => void;
  closeContextPanel: () => void;
  setContextPanelTab: (tab: ContextPanelTab) => void;

  toggleCommandPalette: () => void;
  toggleDarkMode: () => void;
  openSettingsDialog: () => void;
  closeSettingsDialog: () => void;
  openSubjectDialog: (args: { mode: 'create' } | { mode: 'edit'; subjectId: string }) => void;
  closeSubjectDialog: () => void;

  setCurrentConversation: (id: string | null) => void;
  /** 记录某 subject 的上次页面（调用方已用 isRememberablePath 判定）。*/
  rememberPage: (subjectId: string, path: string) => void;

  /** 选中正文文本点「追问」：写入信箱并打开 chat tab。 */
  askAboutSelection: (payload: { section: string | null; text: string }) => void;
  /** 读出并清空信箱（chat 挂载后消费一次）。 */
  consumePendingChatReference: () => PendingChatReference | null;

  setCurrentSubject: (subject: { id: string; slug: string }) => void;
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

function syncSubjectCookie(slug: string): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${SUBJECT_COOKIE_NAME}=${encodeURIComponent(slug)}; path=/; SameSite=Lax; max-age=31536000`;
}

// Persist migration: v1 → v2 → v3 → v4 → v5 → v6.
// v1: rightPanelOpen/chatOpen/rightPanelWidth
// v2: contextPanelOpen/contextPanelTab/contextPanelWidth
// v3: drops contextPanelWidth (right panel is now fixed), adds sidebarWidth.
// v4: adds currentSubjectId/currentSubjectSlug for first-class subjects.
// v5: adds currentConversationId (reset on subject change).
// v6: adds lastPageBySubject (per-subject 上次打开的页面，跨刷新恢复)。
interface LegacyPersistedState {
  darkMode?: boolean;
  rightPanelOpen?: boolean;
  rightPanelWidth?: number;
  chatOpen?: boolean;
  contextPanelOpen?: boolean;
  contextPanelTab?: ContextPanelTab;
  contextPanelWidth?: number;
  sidebarWidth?: number;
  currentSubjectId?: string | null;
  currentSubjectSlug?: string;
  currentConversationId?: string | null;
  lastPageBySubject?: Record<string, string>;
}

function migratePersisted(persisted: unknown, version: number) {
  const prev = (persisted ?? {}) as LegacyPersistedState;

  const baseV3 = {
    darkMode: !!prev.darkMode,
    contextPanelOpen: prev.contextPanelOpen ?? false,
    contextPanelTab: prev.contextPanelTab ?? 'context',
    sidebarWidth: clampSidebarWidth(prev.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT),
  };

  if (version >= 4) {
    return {
      ...baseV3,
      currentSubjectId: prev.currentSubjectId ?? null,
      currentSubjectSlug: prev.currentSubjectSlug ?? GENERAL_SUBJECT_SLUG,
      currentConversationId: prev.currentConversationId ?? null,
      lastPageBySubject: prev.lastPageBySubject ?? {},
    };
  }

  if (version >= 3) {
    return {
      ...baseV3,
      currentSubjectId: null,
      currentSubjectSlug: GENERAL_SUBJECT_SLUG,
      currentConversationId: null,
    };
  }

  if (version >= 2) {
    return {
      darkMode: !!prev.darkMode,
      contextPanelOpen: prev.contextPanelOpen ?? false,
      contextPanelTab: prev.contextPanelTab ?? 'context',
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      currentSubjectId: null,
      currentSubjectSlug: GENERAL_SUBJECT_SLUG,
      currentConversationId: null,
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
    currentSubjectId: null,
    currentSubjectSlug: GENERAL_SUBJECT_SLUG,
    currentConversationId: null,
  };
}

export const useUIStore = create<UIState>()(
  persist(
    (set, get) => ({
      sidebarOpen: true,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      contextPanelOpen: false,
      contextPanelTab: 'context',
      commandPaletteOpen: false,
      darkMode: false,
      settingsDialogOpen: false,
      subjectDialog: { open: false, mode: 'create', subjectId: null },
      pendingChatReference: null,
      currentSubjectId: null,
      currentSubjectSlug: GENERAL_SUBJECT_SLUG,
      currentConversationId: null,
      lastPageBySubject: {},

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

      toggleCommandPalette: () => set((s) => ({ commandPaletteOpen: !s.commandPaletteOpen })),
      toggleDarkMode: () =>
        set((s) => {
          const next = !s.darkMode;
          applyDarkMode(next);
          return { darkMode: next };
        }),
      openSettingsDialog: () => set({ settingsDialogOpen: true }),
      closeSettingsDialog: () => set({ settingsDialogOpen: false }),
      openSubjectDialog: (args) =>
        set({
          subjectDialog: {
            open: true,
            mode: args.mode,
            subjectId: args.mode === 'edit' ? args.subjectId : null,
          },
        }),
      closeSubjectDialog: () =>
        set((s) => ({ subjectDialog: { ...s.subjectDialog, open: false } })),

      askAboutSelection: (payload) =>
        set({
          pendingChatReference: {
            id: selectionRefId(payload.text),
            section: payload.section,
            text: payload.text,
          },
          contextPanelOpen: true,
          contextPanelTab: 'chat',
        }),
      consumePendingChatReference: () => {
        const current = get().pendingChatReference;
        if (current) set({ pendingChatReference: null });
        return current;
      },

      setCurrentConversation: (id) => set({ currentConversationId: id }),
      rememberPage: (subjectId, path) =>
        set((s) => ({ lastPageBySubject: { ...s.lastPageBySubject, [subjectId]: path } })),

      setCurrentSubject: (subject) => {
        set({
          currentSubjectId: subject.id,
          currentSubjectSlug: subject.slug,
          currentConversationId: null,
        });
        syncSubjectCookie(subject.slug);
      },
    }),
    {
      name: 'ui-store',
      version: 6,
      migrate: migratePersisted,
      partialize: (s) => ({
        darkMode: s.darkMode,
        contextPanelOpen: s.contextPanelOpen,
        contextPanelTab: s.contextPanelTab,
        sidebarWidth: s.sidebarWidth,
        currentSubjectId: s.currentSubjectId,
        currentSubjectSlug: s.currentSubjectSlug,
        currentConversationId: s.currentConversationId,
        lastPageBySubject: s.lastPageBySubject,
      }),
      onRehydrateStorage: () => (state) => {
        if (state) {
          applyDarkMode(state.darkMode);
          syncSubjectCookie(state.currentSubjectSlug);
        }
      },
    },
  ),
);
