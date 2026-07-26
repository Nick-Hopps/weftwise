import { describe, it, expect } from 'vitest';
import type cytoscape from 'cytoscape';
import {
  applyMasteryData,
  clearMasteryData,
  summarizeMastery,
  type MasteryBySlug,
} from '../mastery-layer';
import type { MasteryState } from '@/lib/contracts';

const verdict = (state: MasteryState) => ({
  state,
  confidence: state === 'unknown' ? ('none' as const) : ('high' as const),
  evidenceCount: 1,
  lastEvidenceAt: '2026-07-26T00:00:00.000Z',
  expiresAt: null,
});

/** 最小 cy 替身：只实现图层用到的三个 API，并如实记录元素集是否被动过。 */
function fakeCy(ids: string[]) {
  const data = new Map(ids.map((id) => [id, {} as Record<string, unknown>]));
  let batches = 0;
  const nodes = ids.map((id) => ({
    id: () => id,
    data: (key: string, value?: unknown) => {
      if (value === undefined) return data.get(id)![key];
      data.get(id)![key] = value;
      return undefined;
    },
    removeData: (key: string) => {
      delete data.get(id)![key];
    },
  }));
  const cy = {
    batch: (fn: () => void) => { batches += 1; fn(); },
    nodes: () => ({
      forEach: (fn: (n: (typeof nodes)[number]) => void) => nodes.forEach(fn),
      map: <T,>(fn: (n: (typeof nodes)[number]) => T) => nodes.map(fn),
    }),
  } as unknown as cytoscape.Core;
  return { cy, data, batchCount: () => batches, elementCount: () => data.size };
}

describe('summarizeMastery', () => {
  it('unknown 由节点总数减去有证据的节点数推出', () => {
    // `/api/mastery` 只返回有证据的 slug——没有这条推算就永远统计不到
    // 「还没碰过的」那一大片，而那恰恰是最有信息量的数字。
    const map: MasteryBySlug = { a: verdict('mastered'), b: verdict('struggling') };
    expect(summarizeMastery(['a', 'b', 'c', 'd', 'e'], map)).toEqual({
      unknown: 3, exposed: 0, mastered: 1, struggling: 1,
    });
  });

  it('空图与空 map 都返回全 0', () => {
    expect(summarizeMastery([], {})).toEqual({ unknown: 0, exposed: 0, mastered: 0, struggling: 0 });
  });

  it('map 里有图上不存在的 slug 时不计入（页面已删但证据未清的窗口）', () => {
    const map: MasteryBySlug = { ghost: verdict('mastered') };
    expect(summarizeMastery(['a'], map)).toEqual({
      unknown: 1, exposed: 0, mastered: 0, struggling: 0,
    });
  });
});

describe('applyMasteryData —— 只写 data，绝不重建元素', () => {
  it('把 state / confidence 写进已存在的节点', () => {
    const { cy, data } = fakeCy(['a', 'b']);
    applyMasteryData(cy, { a: verdict('mastered') });

    expect(data.get('a')).toEqual({ mastery: 'mastered', confidence: 'high' });
  });

  it('元素数不变（改元素集会摧毁 cose 布局与力导向模拟）', () => {
    const layer = fakeCy(['a', 'b', 'c']);
    const before = layer.elementCount();
    applyMasteryData(layer.cy, { a: verdict('exposed') });
    expect(layer.elementCount()).toBe(before);
  });

  it('包在一次 cy.batch 里，不逐节点触发重绘', () => {
    const layer = fakeCy(['a', 'b', 'c']);
    applyMasteryData(layer.cy, { a: verdict('exposed') });
    expect(layer.batchCount()).toBe(1);
  });

  it('未命中的节点显式清空旧值 —— 否则纠错后仍显示成 mastered', () => {
    const { cy, data } = fakeCy(['a']);
    applyMasteryData(cy, { a: verdict('mastered') });
    applyMasteryData(cy, {});
    expect(data.get('a')).toEqual({});
  });
});

describe('clearMasteryData', () => {
  it('切回结构模式时清空，避免选择器残留命中', () => {
    const { cy, data } = fakeCy(['a', 'b']);
    applyMasteryData(cy, { a: verdict('mastered'), b: verdict('struggling') });
    clearMasteryData(cy);
    expect(data.get('a')).toEqual({});
    expect(data.get('b')).toEqual({});
  });
});
