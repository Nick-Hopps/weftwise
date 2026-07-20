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
}

// Fullscreen no longer re-runs cose — it reuses the compact positions and
// adjusts zoom, so there is a single preset, scaled by graph size below.
const BASE_PRESET: LayoutPreset = {
  idealEdgeLength: 90,
  nodeRepulsion: 6000,
  gravity: 0.3,
  padding: 20,
};

// 结点数升档区间：40 以下保持基准手感，40→120 线性加大间距，120 以上封顶。
const SIZE_CROWDING_START = 40;
const SIZE_CROWDING_END = 120;
// 平均度升档区间：≤6（普通 wiki 互链密度）保持基准，6→16 线性升档。
const DEGREE_CROWDING_START = 6;
const DEGREE_CROWDING_END = 16;

function clamp01(v: number): number {
  return Math.min(Math.max(v, 0), 1);
}

/**
 * 按图的拥挤程度放大布局间距：结点数多、或边密度高（平均度大）时，
 * 理想边长与斥力升高、重力降低，避免聚合根附近挤成一团；小而稀疏的图参数不变。
 * 两个维度取更高档 —— 26 结点 212 边这类高密度小图同样需要摊开。
 */
export function computeLayoutPreset(nodeCount: number, edgeCount: number): LayoutPreset {
  const sizeCrowding = clamp01(
    (nodeCount - SIZE_CROWDING_START) / (SIZE_CROWDING_END - SIZE_CROWDING_START),
  );
  const avgDegree = nodeCount > 0 ? (2 * edgeCount) / nodeCount : 0;
  const degreeCrowding = clamp01(
    (avgDegree - DEGREE_CROWDING_START) / (DEGREE_CROWDING_END - DEGREE_CROWDING_START),
  );
  const crowding = Math.max(sizeCrowding, degreeCrowding);
  return {
    idealEdgeLength: Math.round(BASE_PRESET.idealEdgeLength + 40 * crowding),
    nodeRepulsion: Math.round(BASE_PRESET.nodeRepulsion + 5000 * crowding),
    gravity: BASE_PRESET.gravity - 0.12 * crowding,
    padding: BASE_PRESET.padding,
  };
}

/** 用户是否偏好减少动效（SSR 安全）。 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
