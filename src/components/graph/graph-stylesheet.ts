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
export type GraphMode = 'structure' | 'mastery';

/**
 * `mode='mastery'` 时叠一层掌握度着色。**只换 stylesheet，不动元素集**——
 * `use-wiki-graph.ts` 的数据 effect 是 `[]` 一次性，改元素会摧毁 cose 布局与力导向模拟。
 */
export function buildStylesheet(
  theme: ThemeSnapshot,
  mode: GraphMode = 'structure',
): cytoscape.StylesheetStyle[] {
  const mastery = mode === 'mastery';
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
    // 孤儿是**结构属性**，归结构模式；掌握度模式下把填充色让给四态 ramp。
    ...(mastery
      ? []
      : [{
          selector: 'node[orphan = 1]',
          style: {
            'background-color': theme.orphan,
            'border-color': theme.orphan,
            'text-opacity': 0.35,
          },
        } as cytoscape.StylesheetStyle]),
    ...(mastery ? masteryStyles(theme) : []),
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
      // 掌握度模式下焦点层级降级为**仅描边加粗**：填充色已经承载四态语义，
      // 再让焦点抢过去，被选中的节点就看不出它是什么状态了。
      style: mastery
        ? {
            'border-color': theme.active,
            'border-opacity': 1,
            'border-width': 3,
            'text-opacity': 1,
            'font-weight': 700,
            'z-index': 10,
          }
        : {
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
 * 掌握度四态着色。
 *
 * `unknown → exposed → mastered` 是**有序**的，用同一色相（warp）的明度阶梯；
 * `struggling` 不是这个梯子的一端（「试过并卡住了」≠「更不懂」），走 danger 描边
 * 作 categorical outlier。
 *
 * `node[!mastery]` 的兜底不能省：`/api/mastery` 只返回**有证据**的 slug，
 * 绝大多数节点根本没有这个字段，没有兜底会渲染成默认色，看起来像「全都掌握了」。
 */
function masteryStyles(theme: ThemeSnapshot): cytoscape.StylesheetStyle[] {
  return [
    {
      // unknown（无证据）压暗，复用 .dimmed 的 0.22 思路：有证据的子图自然浮出来，
      // 但整张图的形状仍在——「我的已知区域在整体中占多大」本身就是信息。
      selector: 'node[!mastery]',
      style: {
        'background-color': theme.orphan,
        'background-opacity': 0.22,
        'border-color': theme.orphan,
        'border-opacity': 0.3,
        'text-opacity': 0.25,
      },
    },
    {
      selector: 'node[mastery = "exposed"]',
      style: {
        'background-color': theme.masteryExposed,
        'background-opacity': 0.95,
        'border-color': theme.masteryExposed,
        'border-opacity': 0.9,
      },
    },
    {
      selector: 'node[mastery = "mastered"]',
      style: {
        'background-color': theme.masteryMastered,
        'background-opacity': 1,
        'border-color': theme.masteryMastered,
        'border-opacity': 1,
        'text-opacity': 0.9,
      },
    },
    {
      selector: 'node[mastery = "struggling"]',
      style: {
        'background-color': theme.canvas,
        'background-opacity': 1,
        'border-color': theme.masteryStruggling,
        'border-opacity': 1,
        'border-width': 3,
        'text-opacity': 0.9,
        'z-index': 4,
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
