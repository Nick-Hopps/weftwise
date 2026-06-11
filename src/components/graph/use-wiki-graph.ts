'use client';

/**
 * useWikiGraph —— 持有 cytoscape 实例的完整生命周期：
 * 拉取 /api/graph 数据 → 构建 cy → 同步 cose 布局 → 启动力导向模拟 →
 * 主题/焦点高亮随依赖刷新 → 卸载时清理。
 * 容器间迁移（全屏切换）仍由 MiniGraphView 负责。
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import cytoscape from 'cytoscape';
import { useUIStore } from '@/stores/ui-store';
import { apiFetch } from '@/lib/api-fetch';
import { readGraphTheme } from '@/lib/theme/read-theme-vars';
import { buildStylesheet, applyHighlight } from './graph-stylesheet';
import { computeNodeSize, LAYOUT_COMPACT } from './graph-layout';
import { startForceSimulation, type SimulationHandle } from './force-simulation';

interface WikiGraphData {
  nodes: Array<{ id: string; label: string; linkCount: number }>;
  edges: Array<{ source: string; target: string }>;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  orphans: number;
}

export function useWikiGraph(
  compactRef: React.RefObject<HTMLDivElement | null>,
  currentSlug?: string,
) {
  const router = useRouter();
  const darkMode = useUIStore((s) => s.darkMode);

  const cyRef = useRef<cytoscape.Core | null>(null);
  const simRef = useRef<SimulationHandle | null>(null);

  const [isLoading, setIsLoading] = useState(true);
  const [isEmpty, setIsEmpty] = useState(false);
  const [stats, setStats] = useState<GraphStats>({ nodes: 0, edges: 0, orphans: 0 });

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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      simRef.current?.stop();
      simRef.current = null;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, []);

  return { cyRef, simRef, isLoading, isEmpty, stats };
}
