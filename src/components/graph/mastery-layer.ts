/**
 * 掌握度图层的纯逻辑 —— 无 React、无 fetch，可完整单测。
 *
 * 硬约束（spec ② F2）：**只写 node data + 换 stylesheet，绝不重建元素集。**
 * `use-wiki-graph.ts` 的数据 effect 是 `[]` 一次性，改元素会摧毁 cose 布局位置与
 * 力导向模拟——用户拖过的节点会全部跳回去。
 */

import type cytoscape from 'cytoscape';
import type { MasteryState, MasteryVerdictLite } from '@/lib/contracts';

export type MasteryBySlug = Record<string, MasteryVerdictLite>;

export interface MasteryDistribution {
  unknown: number;
  exposed: number;
  mastered: number;
  struggling: number;
}

/**
 * 四态分布计数。
 *
 * `unknown` 由**节点总数减去有证据的节点数**得出——`/api/mastery` 只返回有证据的 slug，
 * 没有这条推算就永远统计不到「还没碰过的」那一大片，而那恰恰是最有信息量的数字。
 */
export function summarizeMastery(
  nodeIds: readonly string[],
  map: MasteryBySlug,
): MasteryDistribution {
  const dist: MasteryDistribution = { unknown: 0, exposed: 0, mastered: 0, struggling: 0 };
  for (const id of nodeIds) {
    const state: MasteryState = map[id]?.state ?? 'unknown';
    dist[state] += 1;
  }
  return dist;
}

/**
 * 把掌握度写进已存在节点的 data。**不新增、不删除任何元素。**
 *
 * 未命中的节点**显式清空** `mastery`——切 subject 或纠错后重新取数时，
 * 残留的旧值会让一个已经变成 unknown 的节点继续显示成 mastered。
 */
export function applyMasteryData(cy: cytoscape.Core, map: MasteryBySlug): void {
  cy.batch(() => {
    cy.nodes().forEach((node) => {
      const verdict = map[node.id()];
      if (verdict) {
        node.data('mastery', verdict.state);
        node.data('confidence', verdict.confidence);
      } else {
        node.removeData('mastery');
        node.removeData('confidence');
      }
    });
  });
}

/** 切回结构模式：清掉掌握度 data，避免选择器在下次切换前残留命中。 */
export function clearMasteryData(cy: cytoscape.Core): void {
  cy.batch(() => {
    cy.nodes().forEach((node) => {
      node.removeData('mastery');
      node.removeData('confidence');
    });
  });
}
