'use client';

import { useEffect } from 'react';

/**
 * 浮层式自动隐藏滚动条。
 *
 * 原生竖向滚动条已在 globals.css 隐藏；这里维护一个共享的 `.sb-thumb` DOM 元素
 * （fixed 定位），监听捕获阶段的所有滚动事件，把 thumb 覆盖到「正在滚动」的容器
 * 右缘并 `opacity` 渐显；静止超过 IDLE_MS 渐隐。thumb 是真实元素，opacity 可过渡，
 * 所以能真正淡入淡出（原生 ::-webkit-scrollbar-thumb 做不到）。thumb 可拖拽。
 *
 * 渲染 null——纯副作用组件，挂在 <Providers> 内。
 */
const IDLE_MS = 800;
const INSET = 2; // 轨道上下留白
const MIN_THUMB = 28; // thumb 最小高度
const WIDTH = 8; // 与 .sb-thumb 宽度一致
const GAP = 2; // 距容器右缘

interface Metrics {
  top: number;
  left: number;
  thumbH: number;
  maxTravel: number;
  scrollRange: number;
}

export function ScrollbarAutohide() {
  useEffect(() => {
    const thumb = document.createElement('div');
    thumb.className = 'sb-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    document.body.appendChild(thumb);

    let activeEl: Element | null = null;
    let idleTimer = 0;
    let dragging = false;
    let hovering = false;
    let dragStartY = 0;
    let dragStartScrollTop = 0;
    let dragMetrics: Metrics | null = null;

    // 计算某容器的竖向滚动度量；不可滚动返回 null。
    const measure = (el: Element): Metrics | null => {
      const scrollH = el.scrollHeight;
      const clientH = el.clientHeight;
      const scrollRange = scrollH - clientH;
      if (scrollRange <= 1) return null;

      const isRoot =
        el === document.scrollingElement || el === document.documentElement || el === document.body;
      const rect = isRoot
        ? { top: 0, right: window.innerWidth, height: window.innerHeight }
        : (() => {
            const r = el.getBoundingClientRect();
            return { top: r.top, right: r.right, height: r.height };
          })();

      const trackH = rect.height - INSET * 2;
      const thumbH = Math.max(MIN_THUMB, Math.min(trackH, (clientH / scrollH) * trackH));
      const maxTravel = trackH - thumbH;
      const ratio = scrollRange > 0 ? el.scrollTop / scrollRange : 0;
      return {
        top: rect.top + INSET + ratio * maxTravel,
        left: rect.right - WIDTH - GAP,
        thumbH,
        maxTravel,
        scrollRange,
      };
    };

    const draw = (m: Metrics) => {
      thumb.style.height = `${m.thumbH}px`;
      thumb.style.top = `${m.top}px`;
      thumb.style.left = `${m.left}px`;
    };

    const hide = () => {
      thumb.removeAttribute('data-show');
      activeEl = null;
    };

    const armIdle = () => {
      if (idleTimer) window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        if (!dragging && !hovering) hide();
      }, IDLE_MS);
    };

    const onScroll = (e: Event) => {
      if (dragging) return; // 拖拽时由 pointer 逻辑驱动
      const node = e.target;
      const el =
        node instanceof Element ? node : document.scrollingElement ?? document.documentElement;
      if (!(el instanceof Element)) return;
      const m = measure(el);
      if (!m) return;
      activeEl = el;
      draw(m);
      thumb.setAttribute('data-show', '1');
      armIdle();
    };

    const onThumbEnter = () => {
      hovering = true;
      if (idleTimer) window.clearTimeout(idleTimer);
    };
    const onThumbLeave = () => {
      hovering = false;
      armIdle();
    };

    const onPointerDown = (e: PointerEvent) => {
      if (!activeEl) return;
      const m = measure(activeEl);
      if (!m) return;
      dragging = true;
      dragMetrics = m;
      dragStartY = e.clientY;
      dragStartScrollTop = activeEl.scrollTop;
      thumb.setAttribute('data-drag', '1');
      try {
        thumb.setPointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      e.preventDefault();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!dragging || !activeEl || !dragMetrics) return;
      const ratio = dragMetrics.maxTravel > 0 ? (e.clientY - dragStartY) / dragMetrics.maxTravel : 0;
      activeEl.scrollTop = dragStartScrollTop + ratio * dragMetrics.scrollRange;
      const m = measure(activeEl);
      if (m) draw(m);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      dragMetrics = null;
      thumb.removeAttribute('data-drag');
      try {
        thumb.releasePointerCapture(e.pointerId);
      } catch {
        /* noop */
      }
      armIdle();
    };

    // capture=true 才能捕获到内层滚动容器（scroll 不冒泡），passive 避免阻塞滚动。
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    thumb.addEventListener('pointerenter', onThumbEnter);
    thumb.addEventListener('pointerleave', onThumbLeave);
    thumb.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      document.removeEventListener('scroll', onScroll, { capture: true });
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      if (idleTimer) window.clearTimeout(idleTimer);
      thumb.remove();
    };
  }, []);

  return null;
}
