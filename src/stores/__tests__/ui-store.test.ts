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
      contextPanelOpen: false,
      contextPanelTab: 'context',
    });
  });

  it('askAboutSelection writes a derived ref and opens the chat tab', () => {
    useUIStore.getState().askAboutSelection({ section: 'Intro', text: 'hello world' });
    const s = useUIStore.getState();
    expect(s.pendingChatReference).toEqual({
      id: expect.stringMatching(/^sel-/),
      section: 'Intro',
      text: 'hello world',
    });
    expect(s.contextPanelOpen).toBe(true);
    expect(s.contextPanelTab).toBe('chat');
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
