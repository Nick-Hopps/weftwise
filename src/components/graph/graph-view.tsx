'use client';
import { useEffect, useRef, useCallback, useState } from 'react';
import cytoscape from 'cytoscape';
import { useRouter } from 'next/navigation';
import { useUIStore } from '@/stores/ui-store';
import { apiFetch } from '@/lib/api-fetch';

export interface GraphNode {
  id: string;
  label: string;
  linkCount: number;
}

export interface GraphEdge {
  source: string;
  target: string;
}

interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface GraphViewProps {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
}

const MIN_NODE_SIZE = 24;
const MAX_NODE_SIZE = 80;

function buildStylesheet(darkMode: boolean): cytoscape.StylesheetStyle[] {
  const bg = darkMode ? '#1f2937' : '#ffffff';
  const nodeColor = darkMode ? '#93c5fd' : '#3b82f6';
  const orphanColor = darkMode ? '#f87171' : '#ef4444';
  const edgeColor = darkMode ? '#4b5563' : '#d1d5db';
  const labelColor = darkMode ? '#f9fafb' : '#111827';

  return [
    {
      selector: 'node',
      style: {
        'background-color': nodeColor,
        'background-opacity': 0.85,
        label: 'data(label)',
        'font-size': '10px',
        color: labelColor,
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 4,
        'text-outline-color': bg,
        'text-outline-width': 2,
        width: 'data(size)',
        height: 'data(size)',
        'border-width': 2,
        'border-color': darkMode ? '#60a5fa' : '#2563eb',
        'border-opacity': 0.6,
      },
    },
    {
      selector: 'node[orphan = 1]',
      style: {
        'background-color': orphanColor,
        'border-color': darkMode ? '#fca5a5' : '#dc2626',
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-width': 3,
        'border-color': darkMode ? '#fbbf24' : '#f59e0b',
        'border-opacity': 1,
      },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': edgeColor,
        'target-arrow-color': edgeColor,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.7,
        'curve-style': 'bezier',
        opacity: 0.7,
      },
    },
  ];
}

function computeNodeSize(linkCount: number, max: number): number {
  if (max === 0) return MIN_NODE_SIZE;
  return MIN_NODE_SIZE + ((linkCount / max) * (MAX_NODE_SIZE - MIN_NODE_SIZE));
}

// ---------------------------------------------------------------------------
// Lightweight continuous force simulation (no extra dependencies)
// ---------------------------------------------------------------------------

interface SimulationHandle {
  stop: () => void;
  reheat: () => void;
}

function startForceSimulation(cy: cytoscape.Core): SimulationHandle {
  let rafId: number | null = null;
  let grabbedNodeId: string | null = null;
  let alpha = 1; // simulation "temperature", decays toward 0
  const ALPHA_DECAY = 0.006;
  const ALPHA_MIN = 0.001;
  const ALPHA_REHEAT = 0.3;
  const REPULSION = 4000;
  const IDEAL_EDGE_LEN = 120;
  const SPRING_K = 0.008;
  const GRAVITY = 0.004;
  const VELOCITY_DECAY = 0.55;

  cy.on('grab', 'node', (evt) => {
    grabbedNodeId = evt.target.id();
    alpha = Math.max(alpha, ALPHA_REHEAT);
  });
  cy.on('free', 'node', () => {
    grabbedNodeId = null;
    alpha = Math.max(alpha, ALPHA_REHEAT);
  });

  // Velocity per node
  const vel = new Map<string, { vx: number; vy: number }>();
  cy.nodes().forEach((n) => { vel.set(n.id(), { vx: 0, vy: 0 }); });

  function tick() {
    if (alpha < ALPHA_MIN) {
      // Cooled — idle until interaction reheats
      rafId = requestAnimationFrame(tick);
      return;
    }

    alpha *= 1 - ALPHA_DECAY;

    const nodes = cy.nodes();
    const bb = cy.extent();
    const centerX = (bb.x1 + bb.x2) / 2;
    const centerY = (bb.y1 + bb.y2) / 2;

    // Accumulate forces
    const forces = new Map<string, { fx: number; fy: number }>();
    nodes.forEach((n) => { forces.set(n.id(), { fx: 0, fy: 0 }); });

    // Node–node repulsion (Coulomb)
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const dx = b.position('x') - a.position('x');
        const dy = b.position('y') - a.position('y');
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 30);
        const strength = REPULSION / (dist * dist);
        const fx = (dx / dist) * strength;
        const fy = (dy / dist) * strength;
        const fa = forces.get(a.id())!;
        const fb = forces.get(b.id())!;
        fa.fx -= fx; fa.fy -= fy;
        fb.fx += fx; fb.fy += fy;
      }
    }

    // Edge spring attraction (Hooke)
    cy.edges().forEach((edge) => {
      const s = edge.source(), t = edge.target();
      const dx = t.position('x') - s.position('x');
      const dy = t.position('y') - s.position('y');
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const displacement = dist - IDEAL_EDGE_LEN;
      const strength = SPRING_K * displacement;
      const fx = (dx / dist) * strength;
      const fy = (dy / dist) * strength;
      const fs = forces.get(s.id())!;
      const ft = forces.get(t.id())!;
      fs.fx += fx; fs.fy += fy;
      ft.fx -= fx; ft.fy -= fy;
    });

    // Centering gravity
    nodes.forEach((n) => {
      const f = forces.get(n.id())!;
      f.fx += (centerX - n.position('x')) * GRAVITY;
      f.fy += (centerY - n.position('y')) * GRAVITY;
    });

    // Integrate velocities and update positions
    nodes.forEach((n) => {
      if (n.id() === grabbedNodeId) return;
      const v = vel.get(n.id());
      if (!v) return;
      const f = forces.get(n.id())!;
      v.vx = (v.vx + f.fx * alpha) * VELOCITY_DECAY;
      v.vy = (v.vy + f.fy * alpha) * VELOCITY_DECAY;
      n.position({
        x: n.position('x') + v.vx,
        y: n.position('y') + v.vy,
      });
    });

    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  return {
    stop: () => { if (rafId !== null) cancelAnimationFrame(rafId); rafId = null; },
    reheat: () => { alpha = 1; },
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GraphView({ nodes: propNodes, edges: propEdges }: GraphViewProps) {
  const router = useRouter();
  const darkMode = useUIStore((s) => s.darkMode);
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const simRef = useRef<SimulationHandle | null>(null);
  const [simActive, setSimActive] = useState(true);

  // M6 fix: remove darkMode from buildGraph deps — style-only changes handled by the separate effect below
  const buildGraph = useCallback(
    (data: GraphData) => {
      if (!containerRef.current) return;

      // Stop previous simulation and destroy existing instance
      simRef.current?.stop();
      simRef.current = null;
      cyRef.current?.destroy();

      const maxLinks = Math.max(...data.nodes.map((n) => n.linkCount), 0);
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
            data: {
              id: `e-${idx}`,
              source: e.source,
              target: e.target,
            },
          })),
      ];

      // Create cy WITHOUT a layout so we can register the layoutstop listener first
      const cy = cytoscape({
        container: containerRef.current,
        elements,
        style: buildStylesheet(darkMode),
        minZoom: 0.2,
        maxZoom: 4,
        userZoomingEnabled: true,
        userPanningEnabled: true,
        boxSelectionEnabled: false,
      });

      cy.on('tap', 'node', (evt) => {
        const nodeId = evt.target.id() as string;
        router.push(`/wiki/${nodeId}`);
      });

      // Cursor pointer on hover
      cy.on('mouseover', 'node', () => {
        if (containerRef.current) {
          containerRef.current.style.cursor = 'pointer';
        }
      });
      cy.on('mouseout', 'node', () => {
        if (containerRef.current) {
          containerRef.current.style.cursor = 'default';
        }
      });

      cyRef.current = cy;

      // Run the cose layout and start the force simulation once it finishes
      const layout = cy.layout({
        name: 'cose',
        animate: true,
        animationDuration: 600,
        randomize: true,
        nodeRepulsion: () => 8000,
        idealEdgeLength: () => 100,
        edgeElasticity: () => 100,
        gravity: 0.25,
        numIter: 1000,
        fit: true,
        padding: 40,
      } as cytoscape.LayoutOptions);
      layout.one('layoutstop', () => {
        if (simActive) {
          simRef.current = startForceSimulation(cy);
        }
      });
      layout.run();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [router]
  );

  // Load data: props or fetch
  useEffect(() => {
    if (propNodes !== undefined && propEdges !== undefined) {
      buildGraph({ nodes: propNodes, edges: propEdges });
      return;
    }

    let cancelled = false;

    apiFetch('/api/graph')
      .then((res) => res.json())
      .then((data: unknown) => {
        if (cancelled) return;
        const graphData = data as GraphData;
        buildGraph({
          nodes: graphData.nodes ?? [],
          edges: graphData.edges ?? [],
        });
      })
      .catch(() => {
        if (cancelled) return;
        buildGraph({ nodes: [], edges: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [propNodes, propEdges, buildGraph]);

  // Re-apply styles when dark mode changes without rebuilding
  useEffect(() => {
    if (!cyRef.current) return;
    cyRef.current.style(buildStylesheet(darkMode) as cytoscape.StylesheetStyle[]);
  }, [darkMode]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      simRef.current?.stop();
      simRef.current = null;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, []);

  const handleFitView = () => {
    cyRef.current?.fit(undefined, 40);
  };

  const handleZoomIn = () => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom(cy.zoom() * 1.3);
    cy.center();
  };

  const handleZoomOut = () => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.zoom(cy.zoom() * 0.7);
    cy.center();
  };

  const handleReLayout = () => {
    const cy = cyRef.current;
    if (!cy) return;
    // Stop existing simulation
    simRef.current?.stop();
    simRef.current = null;
    // Re-run cose layout from current positions
    const layout = cy.layout({
      name: 'cose',
      animate: true,
      animationDuration: 500,
      randomize: false,
      nodeRepulsion: () => 8000,
      idealEdgeLength: () => 100,
      edgeElasticity: () => 100,
      gravity: 0.25,
      numIter: 800,
      fit: true,
      padding: 40,
    } as cytoscape.LayoutOptions);
    layout.one('layoutstop', () => {
      if (simActive) {
        simRef.current = startForceSimulation(cy);
      }
    });
    layout.run();
  };

  const handleToggleSim = () => {
    const next = !simActive;
    setSimActive(next);
    if (next) {
      // Start simulation if we have a cy instance
      if (cyRef.current && !simRef.current) {
        simRef.current = startForceSimulation(cyRef.current);
      }
    } else {
      simRef.current?.stop();
      simRef.current = null;
    }
  };

  return (
    <div className="relative w-full h-full bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />

      {/* Controls */}
      <div className="absolute top-3 right-3 flex flex-col gap-1">
        <button
          onClick={handleZoomIn}
          className="w-8 h-8 rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 text-lg font-bold shadow-sm transition-colors"
          title="Zoom in"
        >
          +
        </button>
        <button
          onClick={handleZoomOut}
          className="w-8 h-8 rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 text-lg font-bold shadow-sm transition-colors"
          title="Zoom out"
        >
          −
        </button>
        <button
          onClick={handleFitView}
          className="w-8 h-8 rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 text-xs shadow-sm transition-colors"
          title="Fit view"
        >
          ⊡
        </button>
        <div className="w-8 h-px bg-zinc-200 dark:bg-zinc-700 my-0.5" />
        <button
          onClick={handleReLayout}
          className="w-8 h-8 rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 text-xs shadow-sm transition-colors"
          title="Re-layout graph"
        >
          ↻
        </button>
        <button
          onClick={handleToggleSim}
          className={`w-8 h-8 rounded-md border flex items-center justify-center text-xs shadow-sm transition-colors ${
            simActive
              ? 'bg-indigo-50 dark:bg-indigo-900/40 border-indigo-300 dark:border-indigo-600 text-indigo-600 dark:text-indigo-400'
              : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700'
          }`}
          title={simActive ? 'Pause force simulation' : 'Resume force simulation'}
        >
          {simActive ? '⏸' : '▶'}
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400 bg-white/80 dark:bg-zinc-800/80 backdrop-blur-sm rounded-md px-2 py-1.5">
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
          Page
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
          Orphan
        </span>
      </div>
    </div>
  );
}
