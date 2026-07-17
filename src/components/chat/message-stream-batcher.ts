export interface MessageStreamScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

const browserFrameScheduler: MessageStreamScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

export interface MessageStreamBatcher {
  push(content: string): void;
  flush(): void;
  cancel(): void;
}

/** 把同一绘制周期内的流式文本合并为一次 React 状态提交。 */
export function createMessageStreamBatcher(
  commit: (content: string) => void,
  scheduler: MessageStreamScheduler = browserFrameScheduler,
): MessageStreamBatcher {
  let handle: number | null = null;
  let latest = '';
  let pending = false;
  let cancelled = false;

  const commitLatest = () => {
    handle = null;
    if (cancelled || !pending) return;
    pending = false;
    commit(latest);
  };

  return {
    push(content) {
      if (cancelled) return;
      latest = content;
      pending = true;
      if (handle === null) handle = scheduler.request(commitLatest);
    },
    flush() {
      if (cancelled || !pending) return;
      if (handle !== null) scheduler.cancel(handle);
      handle = null;
      pending = false;
      commit(latest);
    },
    cancel() {
      cancelled = true;
      pending = false;
      if (handle !== null) scheduler.cancel(handle);
      handle = null;
    },
  };
}
