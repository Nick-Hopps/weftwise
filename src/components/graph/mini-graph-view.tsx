'use client';

/**
 * MiniGraphView — compact wiki-link graph shown inside the right panel and
 * expanded to a fullscreen overlay on click. The same Cytoscape instance is
 * reused across modes (no re-mount on fullscreen toggle), so node positions
 * and the force simulation survive the transition.
 *
 * 内聚块已拆分到同目录：
 *   - use-wiki-graph.ts   — cy 实例生命周期（数据拉取 / 布局 / 主题 / 清理）
 *   - graph-stylesheet.ts — cytoscape 样式表与焦点高亮（纯函数）
 *   - graph-layout.ts     — 布局预设与几何计算（纯函数）
 *   - force-simulation.ts — 力导向模拟
 *   - fullscreen-graph.tsx / empty-graph-state.tsx — 展示型子组件
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Compass, Maximize2, Target } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';
import { prefersReducedMotion } from './graph-layout';
import { useWikiGraph } from './use-wiki-graph';
import { FullscreenGraph } from './fullscreen-graph';
import { useI18n } from '@/components/i18n-provider';
import { EmptyGraphState } from './empty-graph-state';

interface MiniGraphViewProps {
  /** Slug of the page currently being viewed; highlighted and centered when present. */
  currentSlug?: string;
  /** When true, the graph fills its parent (h-full) instead of using the default h-60. */
  fill?: boolean;
}

export function MiniGraphView({ currentSlug, fill = false }: MiniGraphViewProps) {
  const { t } = useI18n();
  const compactRef = useRef<HTMLDivElement | null>(null);
  const fullscreenRef = useRef<HTMLDivElement | null>(null);
  // Snapshot captured on entering fullscreen, consumed on exiting. Storing the
  // pre-fullscreen zoom lets us restore it verbatim instead of reverse-scaling
  // (1/0.85) — user zoom interactions inside fullscreen would otherwise cause
  // accumulated drift on repeated toggles.
  const preFullscreenZoomRef = useRef<number | null>(null);

  const { cyRef, simRef, isLoading, isEmpty, stats } = useWikiGraph(compactRef, currentSlug);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (typeof document !== 'undefined') {
      setPortalTarget(document.body);
    }
  }, []);

  // Migrate the cy container between compact and fullscreen hosts without
  // re-running the layout — node positions (including user-dragged ones) are
  // preserved verbatim. useLayoutEffect runs synchronously after the Portal
  // commits but before paint, so cy.mount sees the fullscreen container
  // already in the DOM and cy.resize reads post-reflow dimensions. Doing this
  // in a plain useEffect + rAF would leave a frame where the container is
  // 0×0 and the subsequent zoom animation starts from a degenerate state.
  //
  // Before touching the viewport we freeze the force simulation: cy.resize()
  // changes cy.extent() and thus the gravity center, which would otherwise
  // drag every node toward the new center until alpha decays. Freezing pins
  // alpha at 0; the grab/free listeners still reheat it on user interaction.
  //
  // Zoom is *snapshotted* on enter and restored on exit, not reverse-scaled.
  // Scroll-wheel zoom inside fullscreen must not leak back into the compact
  // footprint as unpredictable scale drift.
  //
  // This effect's body is skipped on the initial mount because cy is still
  // null at that point (created asynchronously after the /api/graph fetch).
  useLayoutEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const nextHost = isFullscreen ? fullscreenRef.current : compactRef.current;
    if (!nextHost) return;

    simRef.current?.freeze();

    cy.mount(nextHost);
    cy.resize();

    let targetZoom: number;
    if (isFullscreen) {
      preFullscreenZoomRef.current = cy.zoom();
      targetZoom = cy.zoom() * 2;
    } else if (preFullscreenZoomRef.current !== null) {
      targetZoom = preFullscreenZoomRef.current;
      preFullscreenZoomRef.current = null;
    } else {
      // Never entered fullscreen (or snapshot already consumed) — nothing to do.
      return;
    }

    const clamped = Math.min(Math.max(targetZoom, cy.minZoom()), cy.maxZoom());

    // Center the whole graph in the new viewport AND set zoom in one pass.
    // Using `center: { eles }` overrides pan so the graph bounding box is
    // centered; otherwise the pan carried over from the compact container
    // leaves the cluster hugging the left edge of the fullscreen canvas.
    if (prefersReducedMotion()) {
      cy.zoom(clamped);
      cy.center(cy.elements());
      return;
    }

    cy.animate(
      { zoom: clamped, center: { eles: cy.elements() } },
      { duration: 240, easing: 'ease-out' },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFullscreen]);

  // Esc to exit fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isFullscreen]);

  const openFullscreen = useCallback(() => setIsFullscreen(true), []);
  const closeFullscreen = useCallback(() => setIsFullscreen(false), []);

  const recenter = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    if (currentSlug) {
      const target = cy.getElementById(currentSlug);
      if (target.nonempty()) {
        cy.animate(
          {
            center: { eles: target },
            zoom: 1.2,
          },
          { duration: 240, easing: 'ease-in-out' },
        );
        return;
      }
    }
    cy.animate({ fit: { eles: cy.elements(), padding: 36 } }, { duration: 240, easing: 'ease-in-out' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSlug]);

  return (
    <>
      <div
        className={cn(
          'theme-graph relative w-full overflow-hidden isolate',
          'rounded-lg bg-[rgb(var(--color-graph-canvas))]',
          'ring-1 ring-border/70',
          fill ? 'h-full' : 'h-60',
        )}
      >
        {/* Soft radial depth; not decorative chrome. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              'radial-gradient(120% 80% at 50% 0%, rgb(var(--color-accent-subtle) / 0.35) 0%, transparent 60%)',
          }}
        />

        {/* Canvas starts hidden and fades in once cose settles — the
            synchronous layout burst happens under the overlay, so users
            never see nodes jump from random positions into place. */}
        <div
          ref={compactRef}
          className={cn(
            'w-full h-full relative z-0 motion-safe:transition-opacity motion-safe:duration-300',
            isLoading ? 'opacity-0' : 'opacity-100',
            isFullscreen && 'invisible',
          )}
        />

        {isLoading && (
          <div
            role="status"
            aria-live="polite"
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-xs text-foreground-tertiary z-10 motion-safe:animate-fade-in"
          >
            <span className="relative inline-flex h-2 w-2">
              <span className="absolute inset-0 rounded-full bg-accent motion-safe:animate-ping opacity-60" />
              <span className="relative inline-block h-2 w-2 rounded-full bg-accent" />
            </span>
            <span className="tracking-wide">{t('graph.drawing')}</span>
          </div>
        )}

        {!isLoading && isEmpty && (
          <EmptyGraphState />
        )}

        {!isLoading && !isEmpty && !isFullscreen && (
          <>
            {/* Stats badge — top-left, compact */}
            <span className="pointer-events-none absolute top-2 left-2 z-10 text-[10px] font-medium uppercase tracking-wider text-foreground-tertiary tabular-nums">
              {stats.nodes} · {stats.edges}
            </span>

            {/* Controls — top-right, floating pill */}
            <div className="absolute top-2 right-2 z-10 flex items-center gap-0.5 p-0.5 rounded-md bg-surface/90 ring-1 ring-border/60 shadow-xs">
              <IconButton
                size="sm"
                onClick={recenter}
                aria-label={currentSlug ? 'Center on current page' : 'Fit graph to view'}
                data-tip={currentSlug ? 'Center on current page' : 'Fit to view'}
                className="tip tip-l"
              >
                {currentSlug ? <Target /> : <Compass />}
              </IconButton>
              <IconButton
                size="sm"
                onClick={openFullscreen}
                aria-label={t('graph.expand')}
                data-tip={t('graph.expand')}
                className="tip tip-l"
              >
                <Maximize2 />
              </IconButton>
            </div>
          </>
        )}
      </div>

      {isFullscreen && portalTarget &&
        createPortal(
          <FullscreenGraph
            fullscreenRef={fullscreenRef}
            stats={stats}
            hasCurrent={!!currentSlug}
            onRecenter={recenter}
            onClose={closeFullscreen}
          />,
          portalTarget,
        )}
    </>
  );
}
