'use client';

import { useEffect, useRef, type RefObject } from 'react';
import { calculateReadingProgress } from './reading-progress';
import { useAppendEvidence } from '@/hooks/use-evidence';

/**
 * D5 读完埋点。
 *
 * **不改 `reading-progress.tsx`**：它只有 `containerRef` / `useContainerScroll` 两个 prop，
 * 是纯展示组件（渲染一根进度条），没有也不该有 `slug` / `subjectSlug`——为了埋点给它加
 * 页面身份，会把展示层变成有 IO 的组件（决策 9 的第二个实例）。这里只复用它已导出的
 * 纯函数 `calculateReadingProgress` 做到底判定。
 */

/** 「滚动到底」的判定线。留 2% 余量：不同浏览器的 scrollHeight 舍入不总能到 100。 */
export const READ_PROGRESS_THRESHOLD = 98;

/** 「停留」的判定线。两个条件都要满足才算接触，避免把扫一眼当读过（已定决策 3）。 */
export const READ_DWELL_MS = 30_000;

export interface ReadBeaconState {
  /** 仅统计**页面可见**时的停留：后台标签页挂一小时不算读过。 */
  visibleMs: number;
  reachedBottom: boolean;
}

export function initialReadBeaconState(): ReadBeaconState {
  return { visibleMs: 0, reachedBottom: false };
}

export function advanceReadBeacon(
  state: ReadBeaconState,
  tick: { visibleMsDelta?: number; progress?: number },
): ReadBeaconState {
  return {
    visibleMs: state.visibleMs + (tick.visibleMsDelta ?? 0),
    // 到过底就算数：读完后往回翻不该把它撤销。
    reachedBottom:
      state.reachedBottom ||
      (tick.progress !== undefined && tick.progress >= READ_PROGRESS_THRESHOLD),
  };
}

export function shouldFireReadBeacon(state: ReadBeaconState): boolean {
  return state.reachedBottom && state.visibleMs >= READ_DWELL_MS;
}

export function readBeaconKey(subjectSlug: string, slug: string): string {
  return `${subjectSlug}:${slug}`;
}

/**
 * 会话内去重。模块级 Set 的生命周期就是「一次会话」——刷新页面即重置，
 * 与「同页一次会话只记一条 page-read」的语义正好对齐。
 *
 * @returns 本次是否是首次标记（false 表示这一页本会话已经记过了）
 */
const firedThisSession = new Set<string>();

export function markPageReadOnce(key: string): boolean {
  if (firedThisSession.has(key)) return false;
  firedThisSession.add(key);
  return true;
}

const TICK_MS = 1_000;

export interface PageReadBeaconOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  /** 与 `ReadingProgress` 同口径：分栏模式监听左栏容器，否则监听主滚动区。 */
  useContainerScroll?: boolean;
  slug: string;
  subjectSlug: string;
}

export function usePageReadBeacon({
  containerRef,
  useContainerScroll = false,
  slug,
  subjectSlug,
}: PageReadBeaconOptions): void {
  const appendEvidence = useAppendEvidence();
  // 用 ref 持有，避免 appendEvidence 的身份变化重启计时。
  const appendRef = useRef(appendEvidence);
  appendRef.current = appendEvidence;

  useEffect(() => {
    const key = readBeaconKey(subjectSlug, slug);
    if (firedThisSession.has(key)) return;

    const article = containerRef.current;
    const scroller = useContainerScroll ? article : document.getElementById('main-content');
    if (!article || !scroller) return;

    let state = initialReadBeaconState();
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };

    const fireIfReady = () => {
      if (!shouldFireReadBeacon(state)) return;
      stop();
      if (!markPageReadOnce(key)) return;
      appendRef.current({ slug, kind: 'page-read' });
    };

    const onScroll = () => {
      state = advanceReadBeacon(state, {
        progress: calculateReadingProgress(
          scroller.scrollTop,
          scroller.scrollHeight,
          scroller.clientHeight,
        ),
      });
      fireIfReady();
    };

    // 首帧就判一次：短页面一进来就已经「到底」了。
    onScroll();

    timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      state = advanceReadBeacon(state, { visibleMsDelta: TICK_MS });
      fireIfReady();
    }, TICK_MS);

    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      stop();
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [containerRef, useContainerScroll, slug, subjectSlug]);
}
