import { describe, expect, it } from 'vitest';
import { computeLayoutPreset } from '../graph-layout';

describe('computeLayoutPreset', () => {
  it('小而稀疏的图保持基准参数不变', () => {
    const base = computeLayoutPreset(10, 8);
    expect(base.idealEdgeLength).toBe(90);
    expect(base.nodeRepulsion).toBe(6000);
    expect(base.gravity).toBeCloseTo(0.3);
    expect(computeLayoutPreset(40, 100)).toEqual(base);
  });

  it('结点越多间距参数越大、重力越小（单调）', () => {
    const mid = computeLayoutPreset(80, 100);
    const big = computeLayoutPreset(120, 150);
    expect(mid.idealEdgeLength).toBeGreaterThan(90);
    expect(big.idealEdgeLength).toBeGreaterThan(mid.idealEdgeLength);
    expect(mid.nodeRepulsion).toBeGreaterThan(6000);
    expect(big.nodeRepulsion).toBeGreaterThan(mid.nodeRepulsion);
    expect(mid.gravity).toBeLessThan(0.3);
    expect(big.gravity).toBeLessThan(mid.gravity);
  });

  it('结点不多但边密度高的图同样升档（如 26 结点 212 边）', () => {
    const dense = computeLayoutPreset(26, 212);
    expect(dense.idealEdgeLength).toBeGreaterThan(90);
    expect(dense.nodeRepulsion).toBeGreaterThan(6000);
  });

  it('升档有封顶，不随规模无限放大', () => {
    expect(computeLayoutPreset(500, 5000)).toEqual(computeLayoutPreset(120, 600));
  });

  it('空图不除零', () => {
    expect(() => computeLayoutPreset(0, 0)).not.toThrow();
  });
});
