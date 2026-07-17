'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiFetch } from '@/lib/api-fetch';

export interface LensResult {
  renderedMd: string;
  source: 'saved' | 'generated' | 'canonical';
  stale: boolean;
}

export type LensRequestState = 'idle' | 'loading' | 'refreshing' | 'ready' | 'unavailable';

export function cancelLensRequest(
  controller: AbortController | null,
  hasSavedVersion: boolean,
): LensRequestState {
  controller?.abort();
  return hasSavedVersion ? 'ready' : 'idle';
}

function lensPath(subjectSlug: string, slug: string): string {
  const pagePath = slug.split('/').map(encodeURIComponent).join('/');
  return `/api/lens/${pagePath}?s=${encodeURIComponent(subjectSlug)}`;
}

type LensApiFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** 只读取已保存版本；无版本时返回 null，绝不触发 POST 生成。 */
export async function loadSavedLens(
  apiFetch: LensApiFetch,
  subjectSlug: string,
  slug: string,
  signal?: AbortSignal,
): Promise<LensResult | null> {
  const response = await apiFetch(lensPath(subjectSlug, slug), { signal });
  if (!response.ok) throw new Error(`lens ${response.status}`);
  const result = await response.json() as LensResult;
  return result.source === 'canonical' ? null : result;
}

/** 进入页面恢复持久化版本，并管理强制生成、刷新和浏览器侧取消。 */
export function useLens(subjectSlug: string, slug: string) {
  const apiFetch = useApiFetch();
  const controllerRef = useRef<AbortController | null>(null);
  const [data, setData] = useState<LensResult | null>(null);
  const [state, setState] = useState<LensRequestState>('idle');

  const generate = useCallback(async (refreshing: boolean) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState(refreshing ? 'refreshing' : 'loading');
    try {
      const response = await apiFetch(lensPath(subjectSlug, slug), { method: 'POST', signal: controller.signal });
      if (!response.ok) throw new Error(`lens ${response.status}`);
      const result = await response.json() as LensResult;
      if (controllerRef.current !== controller) return;
      setData(result);
      setState('ready');
    } catch {
      if (controller.signal.aborted) return;
      setState(data ? 'ready' : 'unavailable');
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [apiFetch, data, slug, subjectSlug]);

  const request = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState('loading');
    try {
      const response = await apiFetch(lensPath(subjectSlug, slug), { signal: controller.signal });
      if (!response.ok) throw new Error(`lens ${response.status}`);
      const saved = await response.json() as LensResult;
      if (controllerRef.current !== controller) return;
      if (saved.source !== 'canonical') {
        setData(saved);
        setState('ready');
        controllerRef.current = null;
        return;
      }
      controllerRef.current = null;
      await generate(false);
    } catch {
      if (controller.signal.aborted) return;
      setState('unavailable');
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  }, [apiFetch, generate, slug, subjectSlug]);

  const refresh = useCallback(() => generate(data !== null), [data, generate]);

  const cancel = useCallback(() => {
    const nextState = cancelLensRequest(controllerRef.current, data !== null);
    controllerRef.current = null;
    setState(nextState);
  }, [data]);

  useEffect(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setData(null);
    setState('idle');
    void loadSavedLens(apiFetch, subjectSlug, slug, controller.signal)
      .then((saved) => {
        if (!saved || controllerRef.current !== controller) return;
        setData(saved);
        setState('ready');
      })
      .catch(() => {
        // 静默恢复失败不影响 canonical 阅读；显式点击仍可重试。
      })
      .finally(() => {
        if (controllerRef.current === controller) controllerRef.current = null;
      });
    return () => {
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [apiFetch, subjectSlug, slug]);

  return { data, state, request, refresh, cancel };
}
