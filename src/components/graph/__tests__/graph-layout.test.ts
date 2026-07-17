import { describe, expect, it } from 'vitest';
import type { ThemeSnapshot } from '@/lib/theme/read-theme-vars';
import { LAYOUT_COMPACT } from '../graph-layout';
import { buildStylesheet } from '../graph-stylesheet';

const THEME: ThemeSnapshot = {
  canvas: '#111111',
  node: '#334455',
  nodeBorder: '#556677',
  orphan: '#777777',
  edge: '#888888',
  label: '#ffffff',
  active: '#ff5533',
  accent: '#ff5533',
  border: '#333333',
};

describe('Wiki Graph 可读性参数', () => {
  it('为密集图保留足够的边长、斥力和画布留白', () => {
    expect(LAYOUT_COMPACT.idealEdgeLength).toBeGreaterThanOrEqual(140);
    expect(LAYOUT_COMPACT.nodeRepulsion).toBeGreaterThanOrEqual(12_000);
    expect(LAYOUT_COMPACT.gravity).toBeLessThanOrEqual(0.2);
    expect(LAYOUT_COMPACT.padding).toBeGreaterThanOrEqual(36);
    expect(LAYOUT_COMPACT.nodeDimensionsIncludeLabels).toBe(true);
  });

  it('标签在默认状态下仍保持可扫描的字号、对比度和宽度', () => {
    const stylesheet = buildStylesheet(THEME);
    const nodeRule = stylesheet.find((rule) => rule.selector === 'node');
    const edgeRule = stylesheet.find((rule) => rule.selector === 'edge');
    const style = nodeRule?.style as Record<string, unknown> | undefined;
    const edgeStyle = edgeRule?.style as Record<string, unknown> | undefined;

    expect(style?.['font-size']).toBe('11px');
    expect(style?.['text-opacity']).toBeGreaterThanOrEqual(0.75);
    expect(style?.['text-max-width']).toBe('220');
    expect(edgeStyle?.opacity).toBeLessThanOrEqual(0.35);
  });
});
