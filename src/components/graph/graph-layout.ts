/**
 * 图布局参数与几何计算 —— 纯函数/常量，无 React 依赖。
 */

const MIN_NODE_SIZE = 14;
const MAX_NODE_SIZE = 34;

/** 根据链接数在 [MIN, MAX] 区间内线性插值节点尺寸。 */
export function computeNodeSize(linkCount: number, max: number): number {
  if (max === 0) return MIN_NODE_SIZE;
  return MIN_NODE_SIZE + (linkCount / max) * (MAX_NODE_SIZE - MIN_NODE_SIZE);
}

/** Layout parameters scale with viewport so the same graph breathes in both contexts. */
export interface LayoutPreset {
  idealEdgeLength: number;
  nodeRepulsion: number;
  gravity: number;
  padding: number;
  nodeDimensionsIncludeLabels: boolean;
}

// Single layout preset — fullscreen no longer re-runs cose; it just reuses
// the compact positions and adjusts zoom, so a second preset would be dead code.
export const LAYOUT_COMPACT: LayoutPreset = {
  idealEdgeLength: 140,
  nodeRepulsion: 12_000,
  gravity: 0.2,
  padding: 36,
  nodeDimensionsIncludeLabels: true,
};

/** 用户是否偏好减少动效（SSR 安全）。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
