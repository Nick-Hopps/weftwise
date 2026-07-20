/**
 * Cytoscape 样式表构建与焦点高亮 —— 纯函数，无 React 依赖。
 */

import type cytoscape from 'cytoscape';
import type { ThemeSnapshot } from '@/lib/theme/read-theme-vars';

/**
 * Selector styles lean on three JS-applied classes to build a focal hierarchy
 * when a page is active:
 *   - `.focused` — the current page (one node)
 *   - `.neighbor` + `.incident` — directly connected nodes and edges
 *   - `.dimmed` — everything else, pushed into the background
 * When no slug is active we don't add any of these classes, so the graph
 * reverts to a neutral all-on-one-plane view.
 */
export function buildStylesheet(theme: ThemeSnapshot): cytoscape.StylesheetStyle[] {
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
export function applyHighlight(cy: cytoscape.Core, slug?: string): void {
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
