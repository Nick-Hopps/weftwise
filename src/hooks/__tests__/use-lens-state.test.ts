import { describe, expect, it } from 'vitest';
import { cancelLensRequest } from '../use-lens';

describe('cancelLensRequest', () => {
  it('首次生成取消时中止请求并回到 idle', () => {
    const controller = new AbortController();
    expect(cancelLensRequest(controller, false)).toBe('idle');
    expect(controller.signal.aborted).toBe(true);
  });

  it('刷新取消时中止请求并保留已保存版本状态', () => {
    const controller = new AbortController();
    expect(cancelLensRequest(controller, true)).toBe('ready');
    expect(controller.signal.aborted).toBe(true);
  });
});
