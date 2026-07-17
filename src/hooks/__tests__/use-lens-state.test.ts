import { describe, expect, it } from 'vitest';
import { cancelLensRequest, loadSavedLens } from '../use-lens';

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

describe('loadSavedLens', () => {
  it('进入页面时通过 GET 恢复已保存版本', async () => {
    const saved = {
      renderedMd: '保存版',
      source: 'saved' as const,
      stale: false,
    };
    const apiFetch = async (_path: string, init?: RequestInit) => {
      expect(init?.method).toBeUndefined();
      return Response.json(saved);
    };

    await expect(loadSavedLens(apiFetch, 'general', 'nested/page'))
      .resolves.toEqual(saved);
  });

  it('没有保存版本时保持 canonical，不自动生成', async () => {
    const apiFetch = async () => Response.json({
      renderedMd: '原文',
      source: 'canonical',
      stale: false,
    });

    await expect(loadSavedLens(apiFetch, 'general', 'page'))
      .resolves.toBeNull();
  });
});
