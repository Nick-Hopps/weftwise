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
  /**
   * **粘性**：在可滚动的容器里滚到过底部。这是一个**已发生的事实**，
   * 读完往回翻不该把它撤销。
   */
  scrolledToBottom: boolean;
  /**
   * **非粘性**：当前内容不足一屏（一眼看完）。这是一个**当下的属性**——
   * 图片 / mermaid / KaTeX 布局完成后页面变长，它就不再成立，必须每次重算。
   *
   * 与 `scrolledToBottom` 分开是本 hook 的关键：`calculateReadingProgress` 对不可滚动
   * 的容器返回 100，若把它也并进粘性变量，首帧尚未布局完的长页会被永久标记「读完」，
   * 用户只看了开头也照发 `page-read`。
   */
  fitsInViewport: boolean;
}

/** 一次观测：容器当前是否可滚动，以及滚动进度。由调用方从 DOM 读，纯函数不碰 DOM。 */
export interface ReadBeaconTick {
  visibleMsDelta?: number;
  scrollable?: boolean;
  progress?: number;
}

export function initialReadBeaconState(): ReadBeaconState {
  return { visibleMs: 0, scrolledToBottom: false, fitsInViewport: false };
}

export function advanceReadBeacon(
  state: ReadBeaconState,
  tick: ReadBeaconTick,
): ReadBeaconState {
  const next: ReadBeaconState = {
    ...state,
    visibleMs: state.visibleMs + (tick.visibleMsDelta ?? 0),
  };
  if (tick.scrollable === undefined) return next;

  if (tick.scrollable) {
    next.fitsInViewport = false;
    if ((tick.progress ?? 0) >= READ_PROGRESS_THRESHOLD) next.scrolledToBottom = true;
  } else {
    next.fitsInViewport = true;
  }
  return next;
}

export function shouldFireReadBeacon(state: ReadBeaconState): boolean {
  return (
    (state.scrolledToBottom || state.fitsInViewport) && state.visibleMs >= READ_DWELL_MS
  );
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

/** 从滚动容器读一次观测。`scrollable:false` 表示内容不足一屏、根本无从滚动。 */
function observeScroller(el: HTMLElement): { scrollable: boolean; progress: number } {
  return {
    scrollable: el.scrollHeight > el.clientHeight,
    progress: calculateReadingProgress(el.scrollTop, el.scrollHeight, el.clientHeight),
  };
}

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
      state = advanceReadBeacon(state, observeScroller(scroller));
      fireIfReady();
    };

    // 首帧就判一次：短页面一进来就已经「到底」了。
    onScroll();

    timer = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      // **每 tick 重新观测**，不只累加停留：图片 / mermaid / KaTeX 布局完成会让页面变长，
      // 而这件事可能在用户完全没滚动的情况下发生——只监听 scroll 事件感知不到。
      state = advanceReadBeacon(state, {
        ...observeScroller(scroller),
        visibleMsDelta: TICK_MS,
      });
      fireIfReady();
    }, TICK_MS);

    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      stop();
      scroller.removeEventListener('scroll', onScroll);
    };
  }, [containerRef, useContainerScroll, slug, subjectSlug]);
}
