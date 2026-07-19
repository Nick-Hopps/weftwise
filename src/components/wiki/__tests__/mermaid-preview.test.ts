import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createI18n } from '@/lib/i18n/translator';

Object.assign(globalThis, { React });

vi.mock('@/components/i18n-provider', () => {
  const i18n = createI18n('en');
  return {
    useI18n: () => ({
      ...i18n,
      setLocale: vi.fn(),
      isLocalePending: false,
    }),
  };
});

import {
  DiagramPreviewToolbar,
  clampDiagramZoom,
  stepDiagramZoom,
} from '../mermaid-preview';

describe('Mermaid diagram preview', () => {
  it('缩放保持在 50% 到 200%，每次步进 25%', () => {
    expect(stepDiagramZoom(1, 1)).toBe(1.25);
    expect(stepDiagramZoom(1, -1)).toBe(0.75);
    expect(stepDiagramZoom(2, 1)).toBe(2);
    expect(stepDiagramZoom(0.5, -1)).toBe(0.5);
    expect(clampDiagramZoom(9)).toBe(2);
  });

  it('工具栏暴露缩小、复位、放大和关闭动作', () => {
    const html = renderToStaticMarkup(React.createElement(DiagramPreviewToolbar, {
      zoom: 1.25,
      onZoomOut: vi.fn(),
      onReset: vi.fn(),
      onZoomIn: vi.fn(),
      onClose: vi.fn(),
    }));

    expect(html).toContain('aria-label="Zoom out"');
    expect(html).toContain('aria-label="Reset zoom"');
    expect(html).toContain('125%');
    expect(html).toContain('aria-label="Zoom in"');
    expect(html).toContain('aria-label="Close diagram preview"');
  });
});
