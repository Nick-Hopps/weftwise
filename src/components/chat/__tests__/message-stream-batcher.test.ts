import { describe, expect, it, vi } from 'vitest';
import { createMessageStreamBatcher } from '@/components/chat/message-stream-batcher';

function createScheduler() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  return {
    scheduler: {
      request(callback: () => void) {
        const id = nextId++;
        callbacks.set(id, callback);
        return id;
      },
      cancel(id: number) {
        callbacks.delete(id);
      },
    },
    runFrame() {
      const queued = [...callbacks.values()];
      callbacks.clear();
      queued.forEach((callback) => callback());
    },
    pendingCount() {
      return callbacks.size;
    },
  };
}

describe('createMessageStreamBatcher', () => {
  it('coalesces synchronous deltas into the latest content for one frame', () => {
    const commit = vi.fn();
    const frame = createScheduler();
    const batcher = createMessageStreamBatcher(commit, frame.scheduler);

    batcher.push('A');
    batcher.push('AB');
    batcher.push('ABC');

    expect(frame.pendingCount()).toBe(1);
    expect(commit).not.toHaveBeenCalled();
    frame.runFrame();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenLastCalledWith('ABC');
  });

  it('flushes the latest content immediately and cancels the pending frame', () => {
    const commit = vi.fn();
    const frame = createScheduler();
    const batcher = createMessageStreamBatcher(commit, frame.scheduler);

    batcher.push('complete answer');
    batcher.flush();

    expect(commit).toHaveBeenCalledWith('complete answer');
    expect(frame.pendingCount()).toBe(0);
  });

  it('cancels without committing after the chat instance is discarded', () => {
    const commit = vi.fn();
    const frame = createScheduler();
    const batcher = createMessageStreamBatcher(commit, frame.scheduler);

    batcher.push('stale answer');
    batcher.cancel();
    frame.runFrame();

    expect(commit).not.toHaveBeenCalled();
  });
});
