'use client';

/**
 * MiniGraphView — compact wiki-link graph shown inside the right panel and
 * expanded to a fullscreen overlay on click. The same Cytoscape instance is
 * reused across modes (no re-mount on fullscreen toggle), so node positions
 * and the force simulation survive the transition.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Compass, Maximize2, Minimize2, Network, Target } from 'lucide-react';
import cytoscape from 'cytoscape';
import { useUIStore } from '@/stores/ui-store';
import { apiFetch } from '@/lib/api-fetch';
import { readGraphTheme, type ThemeSnapshot } from '@/lib/theme/read-theme-vars';
import { IconButton } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/cn';

interface WikiGraphData {
  nodes: Array<{ id: string; label: string; linkCount: number }>;
  edges: Array<{ source: string; target: string }>;
}

interface MiniGraphViewProps {
  /** Slug of the page currently being viewed; highlighted and centered when present. */
  currentSlug?: string;
  /** When true, the graph fills its parent (h-full) instead of using the default h-60. */
  fill?: boolean;
}

const MIN_NODE_SIZE = 14;
const MAX_NODE_SIZE = 34;

function computeNodeSize(linkCount: number, max: number): number {
  if (max === 0) return MIN_NODE_SIZE;
  return MIN_NODE_SIZE + (linkCount / max) * (MAX_NODE_SIZE - MIN_NODE_SIZE);
}

/** Layout parameters scale with viewport so the same graph breathes in both contexts. */
interface LayoutPreset {
  idealEdgeLength: number;
  nodeRepulsion: number;
  gravity: number;
  padding: number;
}

// Single layout preset — fullscreen no longer re-runs cose; it just reuses
// the compact positions and adjusts zoom, so a second preset would be dead code.
const LAYOUT_COMPACT: LayoutPreset = {
  idealEdgeLength: 90,
  nodeRepulsion: 6000,
  gravity: 0.3,
  padding: 20,
};

/**
 * Selector styles lean on three JS-applied classes to build a focal hierarchy
 * when a page is active:
 *   - `.focused` — the current page (one node)
 *   - `.neighbor` + `.incident` — directly connected nodes and edges
 *   - `.dimmed` — everything else, pushed into the background
 * When no slug is active we don't add any of these classes, so the graph
 * reverts to a neutral all-on-one-plane view.
 */
function buildStylesheet(theme: ThemeSnapshot): cytoscape.StylesheetStyle[] {
  return [
    {
      selector: 'node',
      style: {
        'background-color': theme.node,
        'background-opacity': 0.9,
        label: 'data(label)',
        'font-size': '10px',
        'font-weight': 500,
        color: theme.label,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 8,
        'text-outline-color': theme.canvas,
        'text-outline-width': 3,
        'text-outline-opacity': 0.92,
        'text-opacity': 0.6,
        'text-max-width': '180',
        'text-wrap': 'ellipsis',
        width: 'data(size)',
        height: 'data(size)',
        'border-width': 1.5,
        'border-color': theme.nodeBorder,
        'border-opacity': 0.65,
        'z-index': 1,
      },
    },
    {
      selector: 'node[orphan = 1]',
      style: {
        'background-color': theme.orphan,
        'border-color': theme.orphan,
        'text-opacity': 0.35,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1.1,
        'line-color': theme.edge,
        'target-arrow-color': theme.edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.6,
        'curve-style': 'bezier',
        opacity: 0.65,
        'z-index': 1,
      },
    },
    {
      selector: 'node:hover, node.labelled, node.neighbor, node.focused',
      style: { 'text-opacity': 1 },
    },
    {
      selector: 'node.neighbor',
      style: {
        'border-color': theme.active,
        'border-opacity': 0.9,
        'border-width': 2,
        'z-index': 5,
      },
    },
    {
      selector: 'edge.incident',
      style: {
        'line-color': theme.active,
        'target-arrow-color': theme.active,
        opacity: 0.95,
        width: 1.8,
        'z-index': 5,
      },
    },
    {
      selector: 'node.focused',
      style: {
        'background-color': theme.active,
        'background-opacity': 1,
        'border-color': theme.active,
        'border-opacity': 1,
        'border-width': 3,
        'text-opacity': 1,
        'font-weight': 700,
        'z-index': 10,
      },
    },
    {
      selector: 'node.dimmed',
      style: {
        opacity: 0.22,
        'text-opacity': 0,
        'z-index': 0,
      },
    },
    {
      selector: 'edge.dimmed',
      style: {
        opacity: 0.08,
        'z-index': 0,
      },
    },
  ];
}

/**
 * Apply three-tier highlight classes based on the currently focused slug.
 * Always clears prior classes first so toggling between pages is clean.
 */
function applyHighlight(cy: cytoscape.Core, slug?: string): void {
  cy.batch(() => {
    cy.elements().removeClass('focused neighbor incident dimmed');
    if (!slug) return;
    const current = cy.getElementById(slug);
    if (current.empty()) return;

    const neighbors = current.neighborhood('node');
    const incident = current.connectedEdges();

    current.addClass('focused');
    neighbors.addClass('neighbor');
    incident.addClass('incident');

    const focusSet = current.union(neighbors);
    cy.nodes().difference(focusSet).addClass('dimmed');
    cy.edges().difference(incident).addClass('dimmed');
  });
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ── Force simulation ─────────────────────────────────────────────────────────

interface SimulationHandle {
  stop: () => void;
  /**
   * Drive alpha to 0 so the tick loop runs but stops applying force/velocity.
   * Used when the viewport is about to be resized — without this, the gravity
   * term (which pulls toward cy.extent()'s center) would drag nodes back
   * toward the new center of the enlarged fullscreen canvas, violating the
   * "positions must not change when switching views" contract. Natural
   * reheating via grab/free is preserved, so user interaction still feels alive.
   */
  freeze: () => void;
}

interface ForceParams {
  repulsion: number;
  idealEdgeLen: number;
}

function startForceSimulation(cy: cytoscape.Core, params: ForceParams): SimulationHandle {
  let rafId: number | null = null;
  let grabbedNodeId: string | null = null;
  let alpha = 1;
  const ALPHA_DECAY = 0.008;
  const ALPHA_MIN = 0.001;
  const ALPHA_REHEAT = 0.25;
  const REPULSION = params.repulsion;
  const IDEAL_EDGE_LEN = params.idealEdgeLen;
  const SPRING_K = 0.01;
  const GRAVITY = 0.005;
  const VELOCITY_DECAY = 0.6;

  cy.on('grab', 'node', (evt) => {
    grabbedNodeId = evt.target.id();
    alpha = Math.max(alpha, ALPHA_REHEAT);
  });
  cy.on('free', 'node', () => {
    grabbedNodeId = null;
    alpha = Math.max(alpha, ALPHA_REHEAT);
  });

  const vel = new Map<string, { vx: number; vy: number }>();
  cy.nodes().forEach((n) => {
    vel.set(n.id(), { vx: 0, vy: 0 });
  });

  function tick() {
    if (alpha < ALPHA_MIN) {
      rafId = requestAnimationFrame(tick);
      return;
    }
    alpha *= 1 - ALPHA_DECAY;

    const nodes = cy.nodes();
    const bb = cy.extent();
    const centerX = (bb.x1 + bb.x2) / 2;
    const centerY = (bb.y1 + bb.y2) / 2;

    const forces = new Map<string, { fx: number; fy: number }>();
    nodes.forEach((n) => {
      forces.set(n.id(), { fx: 0, fy: 0 });
    });

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = b.position('x') - a.position('x');
        const dy = b.position('y') - a.position('y');
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 24);
        const strength = REPULSION / (dist * dist);
        const fx = (dx / dist) * strength;
        const fy = (dy / dist) * strength;
        forces.get(a.id())!.fx -= fx;
        forces.get(a.id())!.fy -= fy;
        forces.get(b.id())!.fx += fx;
        forces.get(b.id())!.fy += fy;
      }
    }

    cy.edges().forEach((edge) => {
      const s = edge.source();
      const t = edge.target();
      const dx = t.position('x') - s.position('x');
      const dy = t.position('y') - s.position('y');
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const displacement = dist - IDEAL_EDGE_LEN;
      const strength = SPRING_K * displacement;
      const fx = (dx / dist) * strength;
      const fy = (dy / dist) * strength;
      forces.get(s.id())!.fx += fx;
      forces.get(s.id())!.fy += fy;
      forces.get(t.id())!.fx -= fx;
      forces.get(t.id())!.fy -= fy;
    });

    nodes.forEach((n) => {
      const f = forces.get(n.id())!;
      f.fx += (centerX - n.position('x')) * GRAVITY;
      f.fy += (centerY - n.position('y')) * GRAVITY;
    });

    nodes.forEach((n) => {
      if (n.id() === grabbedNodeId) return;
      const v = vel.get(n.id());
      if (!v) return;
      const f = forces.get(n.id())!;
      v.vx = (v.vx + f.fx * alpha) * VELOCITY_DECAY;
      v.vy = (v.vy + f.fy * alpha) * VELOCITY_DECAY;
      n.position({ x: n.position('x') + v.vx, y: n.position('y') + v.vy });
    });

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  return {
    stop: () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
    },
    freeze: () => {
      alpha = 0;
    },
  };
}

// ── Component ────────────────────────────────────────────────────────────────

export function MiniGraphView({ currentSlug, fill = false }: MiniGraphViewProps) {
  const router = useRouter();
  const darkMode = useUIStore((s) => s.darkMode);

  const compactRef = useRef<HTMLDivElement | null>(null);
  const fullscreenRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const simRef = useRef<SimulationHandle | null>(null);
  // Snapshot captured on entering fullscreen, consumed on exiting. Storing the
  // pre-fullscreen zoom lets us restore it verbatim instead of reverse-scaling
  // (1/0.85) — user zoom interactions inside fullscreen would otherwise cause
  // accumulated drift on repeated toggles.
  const preFullscreenZoomRef = useRef<number | null>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isEmpty, setIsEmpty] = useState(false);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [stats, setStats] = useState<{ nodes: number; edges: number; orphans: number }>(
    { nodes: 0, edges: 0, orphans: 0 },
  );

  useEffect(() => {
    if (typeof document !== 'undefined') {
      setPortalTarget(document.body);
    }
  }, []);

  // Build cy instance once data arrives. Mount into the compact container by
  // default; we migrate the underlying DOM between compact / fullscreen hosts
  // without destroying cy so layout and user-dragged positions are preserved.
  // Note: this effect intentionally runs only once per mount — the highlight
  // and theme updates are handled via a dedicated `cy.style()` effect below so
  // we never rebuild the simulation on currentSlug changes.
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);

    const subjectId = useUIStore.getState().currentSubjectId;
    const graphUrl = subjectId
      ? `/api/graph?subjectId=${encodeURIComponent(subjectId)}`
      : '/api/graph';

    apiFetch(graphUrl)
      .then((res) => res.json())
      .then((data: WikiGraphData) => {
        if (cancelled) return;
        if (!compactRef.current) return;

        const maxLinks = Math.max(0, ...data.nodes.map((n) => n.linkCount));
        const nodeIds = new Set(data.nodes.map((n) => n.id));
        const orphans = data.nodes.filter((n) => n.linkCount === 0).length;
        setStats({ nodes: data.nodes.length, edges: data.edges.length, orphans });

        const elements: cytoscape.ElementDefinition[] = [
          ...data.nodes.map((n) => ({
            data: {
              id: n.id,
              label: n.label,
              size: computeNodeSize(n.linkCount, maxLinks),
              orphan: n.linkCount === 0 ? 1 : 0,
            },
          })),
          ...data.edges
            .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
            .map((e, idx) => ({
              data: { id: `e-${idx}`, source: e.source, target: e.target },
            })),
        ];

        setIsEmpty(elements.length === 0);

        const cy = cytoscape({
          container: compactRef.current,
          elements,
          style: buildStylesheet(readGraphTheme()),
          minZoom: 0.25,
          maxZoom: 4,
          userZoomingEnabled: true,
          userPanningEnabled: true,
          boxSelectionEnabled: false,
          autoungrabify: false,
        });

        cyRef.current = cy;

        cy.on('tap', 'node', (evt) => {
          const slug = evt.target.id();
          router.push(`/wiki/${slug}`);
        });

        cy.on('mouseover', 'node', (evt) => {
          evt.target.addClass('labelled');
          const host = evt.cy.container();
          if (host instanceof HTMLElement) host.style.cursor = 'pointer';
        });
        cy.on('mouseout', 'node', (evt) => {
          evt.target.removeClass('labelled');
          const host = evt.cy.container();
          if (host instanceof HTMLElement) host.style.cursor = 'default';
        });

        const preset = LAYOUT_COMPACT;
        // animate:false — run cose synchronously so the initial jump is invisible.
        // The loading overlay stays until layoutstop, then the canvas fades in.
        const layout = cy.layout({
          name: 'cose',
          animate: false,
          randomize: true,
          nodeRepulsion: () => preset.nodeRepulsion,
          idealEdgeLength: () => preset.idealEdgeLength,
          edgeElasticity: () => 80,
          gravity: preset.gravity,
          numIter: 800,
          fit: true,
          padding: preset.padding,
        } as cytoscape.LayoutOptions);

        layout.one('layoutstop', () => {
          if (cancelled) return;
          simRef.current = startForceSimulation(cy, {
            repulsion: preset.nodeRepulsion / 2.5,
            idealEdgeLen: preset.idealEdgeLength,
          });
          if (currentSlug && cy.getElementById(currentSlug).nonempty()) {
            cy.center(cy.getElementById(currentSlug));
          }
          applyHighlight(cy, currentSlug);
          // Hand control to the fade-in overlay now that positions are final.
          setIsLoading(false);
        });
        layout.run();
      })
      .catch(() => {
        if (cancelled) return;
        setIsEmpty(true);
        setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-apply stylesheet on theme change; refresh focus classes on any trigger.
  // isLoading is a dep so that when layoutstop flips it to false we re-run
  // with the *current* slug — the closure inside the data-fetch effect would
  // otherwise pin to the slug at mount time, leaving a user who navigated
  // during load looking at the wrong node highlighted.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy || isLoading) return;
    cy.style(buildStylesheet(readGraphTheme()));
    applyHighlight(cy, currentSlug);
  }, [darkMode, currentSlug, isLoading]);

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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      simRef.current?.stop();
      simRef.current = null;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, []);

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
            <span className="tracking-wide">Drawing graph</span>
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
                title={currentSlug ? 'Center on current page' : 'Fit to view'}
              >
                {currentSlug ? <Target /> : <Compass />}
              </IconButton>
              <IconButton
                size="sm"
                onClick={openFullscreen}
                aria-label="Expand graph to fullscreen"
                title="Expand"
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

// ── Empty state — teaches the interface rather than just says "nothing" ──────

function EmptyGraphState() {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <Network
        aria-hidden
        className="h-7 w-7 text-foreground-tertiary/70"
        strokeWidth={1.3}
      />
      <p className="text-xs font-medium text-foreground-secondary">
        No connections yet
      </p>
      <p className="text-[11px] leading-relaxed text-foreground-tertiary max-w-[220px]">
        Add <code className="font-mono text-[10px] px-1 py-[1px] rounded bg-subtle text-foreground-secondary">[[page name]]</code> links in your notes to build this map.
      </p>
    </div>
  );
}

// ── Fullscreen shell ─────────────────────────────────────────────────────────

interface FullscreenGraphProps {
  fullscreenRef: React.RefObject<HTMLDivElement | null>;
  stats: { nodes: number; edges: number; orphans: number };
  hasCurrent: boolean;
  onRecenter: () => void;
  onClose: () => void;
}

function FullscreenGraph({
  fullscreenRef,
  stats,
  hasCurrent,
  onRecenter,
  onClose,
}: FullscreenGraphProps) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Wiki graph fullscreen"
      className="theme-graph fixed inset-0 z-overlay flex flex-col bg-canvas animate-fade-in"
      style={{
        backgroundImage:
          'radial-gradient(1100px 560px at 50% -10%, rgb(var(--color-accent-subtle) / 0.55) 0%, transparent 55%)',
      }}
    >
      {/* Top bar */}
      <header className="relative z-10 flex items-center justify-between gap-4 px-5 h-12 border-b border-border/60 bg-surface/40 backdrop-blur-[1px]">
        <div className="flex items-baseline gap-3 min-w-0">
          <h2 className="text-sm font-semibold text-foreground tracking-tight">
            Wiki Graph
          </h2>
          <span className="text-xs text-foreground-tertiary tabular-nums whitespace-nowrap">
            {stats.nodes} nodes
            <span className="mx-1.5 text-foreground-disabled">·</span>
            {stats.edges} links
            {stats.orphans > 0 && (
              <>
                <span className="mx-1.5 text-foreground-disabled">·</span>
                <span className="text-foreground-tertiary">{stats.orphans} orphan{stats.orphans === 1 ? '' : 's'}</span>
              </>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <IconButton
            size="base"
            onClick={onRecenter}
            aria-label={hasCurrent ? 'Center on current page' : 'Fit graph to view'}
            title={hasCurrent ? 'Center on current page' : 'Fit to view'}
          >
            {hasCurrent ? <Target /> : <Compass />}
          </IconButton>
          <IconButton
            size="base"
            onClick={onClose}
            aria-label="Close fullscreen (Esc)"
            title="Exit fullscreen"
          >
            <Minimize2 />
          </IconButton>
        </div>
      </header>

      {/* Canvas */}
      <div ref={fullscreenRef} className="flex-1 min-w-0 min-h-0 relative" />

      {/* Floating legend — top-right of canvas area (avoids dev overlay + profile badge) */}
      <div className="pointer-events-none absolute top-16 right-5 z-10 flex flex-col gap-1.5 px-3 py-2 rounded-md bg-surface/90 ring-1 ring-border/60 shadow-sm text-[11px]">
        <span className="text-[9px] uppercase tracking-wider font-medium text-foreground-tertiary">Legend</span>
        <LegendRow color="var(--color-graph-active)" label={hasCurrent ? 'Current page' : 'Active'} ring />
        <LegendRow color="var(--color-graph-node)" label="Linked page" />
        <LegendRow color="var(--color-graph-orphan)" label="Orphan (no links)" />
      </div>

      {/* Operation hint — bottom-right */}
      <div className="pointer-events-none absolute bottom-4 right-5 z-10 flex items-center gap-3 text-[11px] text-foreground-tertiary">
        <HintChip>
          <Kbd>Drag</Kbd>
          <span>rearrange</span>
        </HintChip>
        <HintChip>
          <Kbd>Click</Kbd>
          <span>open page</span>
        </HintChip>
        <HintChip>
          <Kbd>Esc</Kbd>
          <span>close</span>
        </HintChip>
      </div>
    </div>
  );
}

function LegendRow({ color, label, ring }: { color: string; label: string; ring?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-foreground-secondary">
      <span
        aria-hidden
        className={cn('h-2.5 w-2.5 rounded-full', ring && 'ring-2 ring-offset-1 ring-offset-surface')}
        style={{ backgroundColor: `rgb(${color})`, boxShadow: ring ? `0 0 0 1.5px rgb(${color})` : undefined }}
      />
      <span>{label}</span>
    </div>
  );
}

function HintChip({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5">{children}</span>;
}
