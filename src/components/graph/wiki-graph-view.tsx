'use client';

/**
 * WikiGraphView — displays the wikilink relationship graph.
 * Fetches from /api/graph?source=wiki and renders via GraphCanvas.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useUIStore } from '@/stores/ui-store';
import { apiFetch } from '@/lib/api-fetch';
import { GraphCanvas } from './graph-canvas';
import type cytoscape from 'cytoscape';

interface WikiGraphData {
  nodes: Array<{ id: string; label: string; linkCount: number }>;
  edges: Array<{ source: string; target: string }>;
}

const MIN_NODE_SIZE = 24;
const MAX_NODE_SIZE = 80;

function computeNodeSize(linkCount: number, max: number): number {
  if (max === 0) return MIN_NODE_SIZE;
  return MIN_NODE_SIZE + ((linkCount / max) * (MAX_NODE_SIZE - MIN_NODE_SIZE));
}

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

export function WikiGraphView() {
  const router = useRouter();
  const darkMode = useUIStore((s) => s.darkMode);
  const [elements, setElements] = useState<cytoscape.ElementDefinition[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    apiFetch('/api/graph?source=wiki')
      .then((res) => res.json())
      .then((data: WikiGraphData) => {
        if (cancelled) return;
        const maxLinks = Math.max(...data.nodes.map((n) => n.linkCount), 0);
        const nodeIds = new Set(data.nodes.map((n) => n.id));

        const els: cytoscape.ElementDefinition[] = [
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
        setElements(els);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) { setElements([]); setLoading(false); }
      });

    return () => { cancelled = true; };
  }, []);

  const handleNodeTap = (nodeId: string) => {
    router.push(`/wiki/${nodeId}`);
  };

  return (
    <div className="w-full h-full">
      <GraphCanvas
        elements={elements}
        stylesheet={buildStylesheet(darkMode)}
        onNodeTap={handleNodeTap}
        isLoading={loading}
      />
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
