'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { selectionRefId } from '@/lib/selection-text';
import type { AskAiPoint } from '@/lib/ask-ai-floating-panel';

export type ContextPanelTab = 'context' | 'chat';

/** 选中正文文本「追问」时，按钮 → Ask AI 之间传递的引用片段。 */
export interface PendingChatReference {
  id: string;
  section: string | null;
  text: string;
}

export const SIDEBAR_WIDTH_MIN = 200;
export const SIDEBAR_WIDTH_MAX = 400;
export const SIDEBAR_WIDTH_DEFAULT = 264;
export const CONTEXT_PANEL_WIDTH = 400;

export const GENERAL_SUBJECT_SLUG = 'general';
export const SUBJECT_COOKIE_NAME = 'wiki_subject';

interface UIState {
  sidebarOpen: boolean;
  sidebarWidth: number;

  /** 页面 Context 检查器状态；不再承载 Ask AI。 */
  contextPanelOpen: boolean;
  contextPanelTab: ContextPanelTab;

  /** Ask AI 悬浮工作面的瞬态状态。 */
  askAiOpen: boolean;
  askAiAnchor: AskAiPoint | null;
  askAiPosition: AskAiPoint | null;

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

  /** 原位切换 Context 检查器。 */
  toggleContextPanel: () => void;
  /** 打开 Context 检查器；tab 参数仅为旧持久化状态兼容保留。 */
  openContextPanel: (tab?: ContextPanelTab) => void;
  closeContextPanel: () => void;
  setContextPanelTab: (tab: ContextPanelTab) => void;

  openAskAi: (anchor?: AskAiPoint) => void;
  closeAskAi: () => void;
  setAskAiPosition: (position: AskAiPoint) => void;

  toggleCommandPalette: () => void;
  toggleDarkMode: () => void;
  openSettingsDialog: () => void;
  closeSettingsDialog: () => void;
  openSubjectDialog: (args: { mode: 'create' } | { mode: 'edit'; subjectId: string }) => void;
  closeSubjectDialog: () => void;

  setCurrentConversation: (id: string | null) => void;
  /** 记录某 subject 的上次页面（调用方已用 isRememberablePath 判定）。*/
  rememberPage: (subjectId: string, path: string) => void;

  /** 选中正文文本点「追问」：写入信箱并打开 Ask AI 悬浮工作面。 */
  askAboutSelection: (
    payload: { section: string | null; text: string },
    anchor?: AskAiPoint,
  ) => void;
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
      // 桌面侧栏始终内嵌显示；该状态只控制移动端抽屉，首次进入不应遮住正文。
      sidebarOpen: false,
      sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
      contextPanelOpen: false,
      contextPanelTab: 'context',
      askAiOpen: false,
      askAiAnchor: null,
      askAiPosition: null,
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

      openAskAi: (anchor) =>
        set({
          askAiOpen: true,
          askAiAnchor: anchor ?? null,
        }),
      closeAskAi: () => set({ askAiOpen: false, askAiAnchor: null }),
      setAskAiPosition: (position) => set({ askAiPosition: position }),

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

      askAboutSelection: (payload, anchor) =>
        set({
          pendingChatReference: {
            id: selectionRefId(payload.text),
            section: payload.section,
            text: payload.text,
          },
          askAiOpen: true,
          askAiAnchor: anchor ?? null,
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
