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
      askAiPosition: null,
      contextPanelOpen: false,
      contextPanelTab: 'context',
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
    expect(s.contextPanelOpen).toBe(false);
  });

  it('opens from explicit entry without discarding the last dragged position', () => {
    useUIStore.getState().setAskAiPosition({ x: 480, y: 80 });
    useUIStore.getState().openAskAi();
    const state = useUIStore.getState();
    expect(state.askAiOpen).toBe(true);
    expect(state.askAiAnchor).toBeNull();
    expect(state.askAiPosition).toEqual({ x: 480, y: 80 });
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
