'use client';

/**
 * MiniGraphView — compact wiki-link graph shown inside the right panel and
 * expanded to a fullscreen overlay on click. The same Cytoscape instance is
 * reused across modes (no re-mount on fullscreen toggle), so node positions
 * and the force simulation survive the transition.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { Maximize2, X } from 'lucide-react';
import cytoscape from 'cytoscape';
import { useUIStore } from '@/stores/ui-store';
import { apiFetch } from '@/lib/api-fetch';
import { readGraphTheme, type ThemeSnapshot } from '@/lib/theme/read-theme-vars';
import { IconButton } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';

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

const MIN_NODE_SIZE = 18;
const MAX_NODE_SIZE = 52;

function computeNodeSize(linkCount: number, max: number): number {
  if (max === 0) return MIN_NODE_SIZE;
  return MIN_NODE_SIZE + (linkCount / max) * (MAX_NODE_SIZE - MIN_NODE_SIZE);
}

function buildStylesheet(theme: ThemeSnapshot, highlightSlug?: string): cytoscape.StylesheetStyle[] {
  const style: cytoscape.StylesheetStyle[] = [
    {
      selector: 'node',
      style: {
        'background-color': theme.node,
        'background-opacity': 0.9,
        label: 'data(label)',
        'font-size': '9px',
        color: theme.label,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 4,
        'text-outline-color': theme.canvas,
        'text-outline-width': 2,
        'text-opacity': 0,
        width: 'data(size)',
        height: 'data(size)',
        'border-width': 1.5,
        'border-color': theme.nodeBorder,
        'border-opacity': 0.65,
      },
    },
    {
      selector: 'node[orphan = 1]',
      style: {
        'background-color': theme.orphan,
        'border-color': theme.orphan,
      },
    },
    {
      selector: 'node:hover, node.labelled',
      style: { 'text-opacity': 1 },
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
      },
    },
  ];

  if (highlightSlug) {
    style.push({
      selector: `node[id = "${CSS.escape(highlightSlug)}"]`,
      style: {
        'background-color': theme.active,
        'border-color': theme.active,
        'border-width': 2.5,
        'text-opacity': 1,
        'font-weight': 'bold',
      },
    });
  }

  return style;
}

// ── Force simulation ─────────────────────────────────────────────────────────

interface SimulationHandle {
  stop: () => void;
}

function startForceSimulation(cy: cytoscape.Core): SimulationHandle {
  let rafId: number | null = null;
  let grabbedNodeId: string | null = null;
  let alpha = 1;
  const ALPHA_DECAY = 0.008;
  const ALPHA_MIN = 0.001;
  const ALPHA_REHEAT = 0.25;
  const REPULSION = 2400;
  const IDEAL_EDGE_LEN = 90;
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

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isEmpty, setIsEmpty] = useState(false);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

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

    apiFetch('/api/graph')
      .then((res) => res.json())
      .then((data: WikiGraphData) => {
        if (cancelled) return;
        if (!compactRef.current) return;

        const maxLinks = Math.max(0, ...data.nodes.map((n) => n.linkCount));
        const nodeIds = new Set(data.nodes.map((n) => n.id));

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
          style: buildStylesheet(readGraphTheme(), currentSlug),
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

        const layout = cy.layout({
          name: 'cose',
          animate: true,
          animationDuration: 500,
          randomize: true,
          nodeRepulsion: () => 5000,
          idealEdgeLength: () => 90,
          edgeElasticity: () => 80,
          gravity: 0.3,
          numIter: 800,
          fit: true,
          padding: 24,
        } as cytoscape.LayoutOptions);

        layout.one('layoutstop', () => {
          if (cancelled) return;
          simRef.current = startForceSimulation(cy);
          if (currentSlug && cy.getElementById(currentSlug).nonempty()) {
            cy.center(cy.getElementById(currentSlug));
          }
        });
        layout.run();

        setIsLoading(false);
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

  // Re-apply stylesheet on theme / highlight change without rebuilding
  useEffect(() => {
    if (!cyRef.current) return;
    cyRef.current.style(buildStylesheet(readGraphTheme(), currentSlug));
  }, [darkMode, currentSlug]);

  // Migrate the cy container between compact and fullscreen hosts.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    const nextHost = isFullscreen ? fullscreenRef.current : compactRef.current;
    if (!nextHost) return;
    cy.mount(nextHost);
    // Allow the new host to compute its size before telling cy to resize.
    const rafId = requestAnimationFrame(() => {
      cy.resize();
      cy.fit(undefined, isFullscreen ? 36 : 20);
    });
    return () => cancelAnimationFrame(rafId);
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

  return (
    <>
      <div
        className={`theme-graph relative w-full rounded-md overflow-hidden border border-border group ${fill ? 'h-full' : 'h-60'}`}
      >
        <div ref={compactRef} className={`w-full h-full ${isFullscreen ? 'invisible' : ''}`} />

        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-foreground-tertiary">
            Loading graph…
          </div>
        )}
        {!isLoading && isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center text-xs italic text-foreground-tertiary">
            No links yet
          </div>
        )}

        {!isLoading && !isEmpty && !isFullscreen && (
          <IconButton
            size="sm"
            intent="outline"
            onClick={openFullscreen}
            aria-label="Expand graph"
            title="Expand graph"
            className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity"
          >
            <Maximize2 />
          </IconButton>
        )}
      </div>

      {isFullscreen && portalTarget &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Wiki graph fullscreen"
            className="theme-graph fixed inset-0 z-overlay bg-canvas/95 backdrop-blur-sm flex"
          >
            <div ref={fullscreenRef} className="flex-1 min-w-0 min-h-0" />
            <IconButton
              size="lg"
              intent="outline"
              onClick={closeFullscreen}
              aria-label="Close fullscreen (Esc)"
              className="absolute top-4 right-4 shadow-sm"
            >
              <X />
            </IconButton>
            <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-foreground-tertiary flex items-center gap-2">
              <Kbd>Esc</Kbd>
              to close — click a node to open that page
            </p>
          </div>,
          portalTarget,
        )}
    </>
  );
}
