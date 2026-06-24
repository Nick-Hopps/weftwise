import { describe, it, expect } from 'vitest';
import { encodeVector, decodeVector, cosineSimilarity, rrfMerge } from '../vector-math';

describe('vector-math', () => {
  it('encode/decode round-trip（Float32 精度）', () => {
    const v = [0.1, -0.5, 1.0, 0.3333333];
    const out = Array.from(decodeVector(encodeVector(v)));
    expect(out).toHaveLength(4);
    out.forEach((x, i) => expect(x).toBeCloseTo(v[i], 5));
  });

  it('decode 处理非 4 字节对齐的 Buffer（共享池偏移）也能正确还原', () => {
    const f32 = Float32Array.from([1, 2, 3]);
    const src = Buffer.from(f32.buffer);
    // 构造一个 byteOffset 为奇数（必然非 4 字节对齐）的 Buffer 视图
    const big = Buffer.allocUnsafe(src.length + 1);
    const unaligned = big.subarray(1);
    src.copy(unaligned);
    expect(unaligned.byteOffset % 4).not.toBe(0); // 前置断言：确实未对齐
    expect(Array.from(decodeVector(unaligned))).toEqual([1, 2, 3]);
  });

  it('cosine 同向≈1 / 正交=0 / 反向≈-1', () => {
    expect(cosineSimilarity([1, 0], [2, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 6);
  });

  it('cosine 维度不等 → 0；零向量 → 0', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('rrfMerge 融合两路排名 + 去重 + topN', () => {
    // a 中 x 排第 0、y 第 1；b 中 y 第 0、z 第 1 → y 双榜得分最高
    const merged = rrfMerge(['x', 'y'], ['y', 'z'], 60, 3);
    expect(merged[0]).toBe('y');
    expect(new Set(merged).size).toBe(merged.length); // 去重
    expect(merged.length).toBeLessThanOrEqual(3);
  });

  it('rrfMerge 一路为空 → 退化为另一路顺序', () => {
    expect(rrfMerge(['a', 'b', 'c'], [], 60, 2)).toEqual(['a', 'b']);
    expect(rrfMerge([], ['a', 'b', 'c'], 60, 2)).toEqual(['a', 'b']);
  });
});
