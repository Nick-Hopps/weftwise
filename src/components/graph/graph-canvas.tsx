'use client';

/**
 * GraphCanvas — low-level Cytoscape.js wrapper extracted from graph-view.tsx.
 *
 * Handles DOM mounting, zoom/pan controls, force simulation, and dark-mode
 * style switching. Business logic (data fetching, node navigation) lives
 * in the consuming view component.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import cytoscape from 'cytoscape';
import { useUIStore } from '@/stores/ui-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GraphCanvasProps {
  elements: cytoscape.ElementDefinition[];
  stylesheet: cytoscape.StylesheetStyle[];
  onNodeTap?: (nodeId: string, nodeData: Record<string, unknown>) => void;
  layoutName?: string;
  layoutOptions?: Record<string, unknown>;
  enableForceSimulation?: boolean;
  isLoading?: boolean;
}

// ---------------------------------------------------------------------------
// Force simulation (identical to original graph-view)
// ---------------------------------------------------------------------------

interface SimulationHandle {
  stop: () => void;
  reheat: () => void;
}

function startForceSimulation(cy: cytoscape.Core): SimulationHandle {
  let rafId: number | null = null;
  let grabbedNodeId: string | null = null;
  let alpha = 1;
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

  const vel = new Map<string, { vx: number; vy: number }>();
  cy.nodes().forEach((n) => { vel.set(n.id(), { vx: 0, vy: 0 }); });

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
    nodes.forEach((n) => { forces.set(n.id(), { fx: 0, fy: 0 }); });

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

export function GraphCanvas({
  elements,
  stylesheet,
  onNodeTap,
  layoutName = 'cose',
  layoutOptions,
  enableForceSimulation = true,
  isLoading = false,
}: GraphCanvasProps) {
  const darkMode = useUIStore((s) => s.darkMode);
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<cytoscape.Core | null>(null);
  const simRef = useRef<SimulationHandle | null>(null);
  const [simActive, setSimActive] = useState(enableForceSimulation);

  const buildGraph = useCallback(() => {
    if (!containerRef.current || elements.length === 0) return;

    simRef.current?.stop();
    simRef.current = null;
    cyRef.current?.destroy();

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: stylesheet,
      minZoom: 0.2,
      maxZoom: 4,
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
    });

    if (onNodeTap) {
      cy.on('tap', 'node', (evt) => {
        onNodeTap(evt.target.id(), evt.target.data());
      });
    }

    cy.on('mouseover', 'node', () => {
      if (containerRef.current) containerRef.current.style.cursor = 'pointer';
    });
    cy.on('mouseout', 'node', () => {
      if (containerRef.current) containerRef.current.style.cursor = 'default';
    });

    cyRef.current = cy;

    const layout = cy.layout({
      name: layoutName,
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
      ...layoutOptions,
    } as cytoscape.LayoutOptions);

    layout.one('layoutstop', () => {
      if (simActive && enableForceSimulation) {
        simRef.current = startForceSimulation(cy);
      }
    });
    layout.run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elements, stylesheet, layoutName]);

  useEffect(() => {
    buildGraph();
  }, [buildGraph]);

  // Re-apply styles when dark mode changes
  useEffect(() => {
    if (!cyRef.current) return;
    cyRef.current.style(stylesheet);
  }, [darkMode, stylesheet]);

  // Cleanup
  useEffect(() => {
    return () => {
      simRef.current?.stop();
      simRef.current = null;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, []);

  const handleFitView = () => cyRef.current?.fit(undefined, 40);
  const handleZoomIn = () => {
    const cy = cyRef.current;
    if (cy) { cy.zoom(cy.zoom() * 1.3); cy.center(); }
  };
  const handleZoomOut = () => {
    const cy = cyRef.current;
    if (cy) { cy.zoom(cy.zoom() * 0.7); cy.center(); }
  };
  const handleReLayout = () => {
    const cy = cyRef.current;
    if (!cy) return;
    simRef.current?.stop();
    simRef.current = null;
    const layout = cy.layout({
      name: layoutName,
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
      ...layoutOptions,
    } as cytoscape.LayoutOptions);
    layout.one('layoutstop', () => {
      if (simActive && enableForceSimulation) {
        simRef.current = startForceSimulation(cy);
      }
    });
    layout.run();
  };
  const handleToggleSim = () => {
    const next = !simActive;
    setSimActive(next);
    if (next) {
      if (cyRef.current && !simRef.current) {
        simRef.current = startForceSimulation(cyRef.current);
      }
    } else {
      simRef.current?.stop();
      simRef.current = null;
    }
  };

  if (isLoading) {
    return (
      <div className="w-full h-full flex items-center justify-center bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700">
        <div className="text-zinc-400 dark:text-zinc-500 text-sm">Loading graph...</div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-full bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700 overflow-hidden">
      <div ref={containerRef} className="w-full h-full" />

      {/* Controls */}
      <div className="absolute top-3 right-3 flex flex-col gap-1">
        <button onClick={handleZoomIn} className="w-8 h-8 rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 text-lg font-bold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" title="Zoom in">+</button>
        <button onClick={handleZoomOut} className="w-8 h-8 rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 text-lg font-bold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" title="Zoom out">-</button>
        <button onClick={handleFitView} className="w-8 h-8 rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" title="Fit view">Fit</button>
        <div className="w-8 h-px bg-zinc-200 dark:bg-zinc-700 my-0.5" />
        <button onClick={handleReLayout} className="w-8 h-8 rounded-md bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-600 flex items-center justify-center text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700 text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500" title="Re-layout">Re</button>
        {enableForceSimulation && (
          <button
            onClick={handleToggleSim}
            className={`w-8 h-8 rounded-md border flex items-center justify-center text-xs shadow-sm transition-colors ${
              simActive
                ? 'bg-indigo-50 dark:bg-indigo-900/40 border-indigo-300 dark:border-indigo-600 text-indigo-600 dark:text-indigo-400'
                : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-600 text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-700'
            }`}
            title={simActive ? 'Pause force simulation' : 'Resume force simulation'}
          >
            {simActive ? 'II' : 'P'}
          </button>
        )}
      </div>
    </div>
  );
}
