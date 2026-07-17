import { describe, it, expect, beforeEach } from 'vitest';

// node 环境无 localStorage——给 zustand persist 一个最小桩，避免写入告警/异常。
if (typeof (globalThis as { localStorage?: unknown }).localStorage === 'undefined') {
  const mem = new Map<string, string>();
  (globalThis as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
    clear: () => mem.clear(),
  };
}

import { useUIStore } from '@/stores/ui-store';

describe('ui-store pendingChatReference mailbox', () => {
  beforeEach(() => {
    useUIStore.setState({
      pendingChatReference: null,
      askAiOpen: false,
      askAiAnchor: null,
      askAiAnchorMode: null,
      askAiPosition: null,
      askAiInvocationId: 0,
      contextPanelOpen: false,
      contextPanelTab: 'context',
      currentConversationId: 'conversation-old',
    });
  });

  it('askAboutSelection writes a derived ref and opens Ask AI at the selection', () => {
    useUIStore.getState().askAboutSelection(
      {
        section: 'Intro',
        text: 'hello world',
        selection: {
          sourceKind: 'canonical',
          quote: 'hello world',
          section: 'Intro',
          blockStart: 12,
          blockEnd: 42,
        },
      },
      { x: 320, y: 240 },
    );
    const s = useUIStore.getState();
    expect(s.pendingChatReference).toEqual({
      id: expect.stringMatching(/^sel-/),
      section: 'Intro',
      text: 'hello world',
      selection: {
        sourceKind: 'canonical',
        quote: 'hello world',
        section: 'Intro',
        blockStart: 12,
        blockEnd: 42,
      },
    });
    expect(s.askAiOpen).toBe(true);
    expect(s.askAiAnchor).toEqual({ x: 320, y: 240 });
    expect(s.askAiAnchorMode).toBe('selection');
    expect(s.askAiInvocationId).toBe(1);
    expect(s.currentConversationId).toBeNull();
    expect(s.contextPanelOpen).toBe(false);
  });

  it('opens from explicit entry without discarding the last dragged position', () => {
    useUIStore.getState().setAskAiPosition({ x: 480, y: 80 });
    useUIStore.getState().openAskAi();
    const state = useUIStore.getState();
    expect(state.askAiOpen).toBe(true);
    expect(state.askAiAnchor).toBeNull();
    expect(state.askAiAnchorMode).toBeNull();
    expect(state.askAiPosition).toEqual({ x: 480, y: 80 });
    expect(state.currentConversationId).toBeNull();
  });

  it('opens a new chat invocation at an explicit double-click trigger', () => {
    useUIStore.getState().openAskAi({ x: 240, y: 180 });
    const first = useUIStore.getState();
    expect(first.askAiAnchor).toEqual({ x: 240, y: 180 });
    expect(first.askAiAnchorMode).toBe('trigger');
    expect(first.askAiInvocationId).toBe(1);

    useUIStore.getState().setCurrentConversation('conversation-next');
    useUIStore.getState().openAskAi({ x: 260, y: 200 });
    const second = useUIStore.getState();
    expect(second.askAiInvocationId).toBe(2);
    expect(second.currentConversationId).toBeNull();
  });

  it('drops a stale unconsumed selection on an ordinary trigger', () => {
    useUIStore.getState().askAboutSelection({ section: null, text: 'old selection' });
    useUIStore.getState().openAskAi();
    expect(useUIStore.getState().pendingChatReference).toBeNull();
  });

  it('derives a stable id for identical text', () => {
    useUIStore.getState().askAboutSelection({ section: null, text: 'same' });
    const a = useUIStore.getState().pendingChatReference?.id;
    useUIStore.getState().askAboutSelection({ section: null, text: 'same' });
    const b = useUIStore.getState().pendingChatReference?.id;
    expect(a).toBe(b);
  });

  it('consumePendingChatReference returns the value then clears it', () => {
    useUIStore.getState().askAboutSelection({ section: null, text: 'pick me' });
    const taken = useUIStore.getState().consumePendingChatReference();
    expect(taken?.text).toBe('pick me');
    expect(useUIStore.getState().pendingChatReference).toBeNull();
    expect(useUIStore.getState().consumePendingChatReference()).toBeNull();
  });
});

describe('ui-store layout defaults', () => {
  it('keeps the mobile navigation closed on first load', () => {
    expect(useUIStore.getInitialState().sidebarOpen).toBe(false);
  });
});
