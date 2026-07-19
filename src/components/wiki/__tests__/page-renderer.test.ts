import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

Object.assign(globalThis, { React });

vi.mock('@/components/wiki/wiki-link', () => ({
  default: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
    React.createElement('a', { href }, children),
}));

vi.mock('../frontmatter-display', () => ({
  default: () => React.createElement('header'),
}));

import PageRenderer from '../page-renderer';

describe('PageRenderer 正文图片排版', () => {
  it('保持原比例并在正文内居中限制最大宽高', () => {
    const html = renderToStaticMarkup(React.createElement(PageRenderer, {
      content: '![示意图](/api/assets/general/example.png)',
      slug: 'example',
    })).replaceAll('&amp;', '&');

    expect(html).toContain('<img src="/api/assets/general/example.png" alt="示意图"');
    expect(html).toContain('[&_img]:mx-auto');
    expect(html).toContain('[&_img]:h-auto');
    expect(html).toContain('[&_img]:w-auto');
    expect(html).toContain('[&_img]:max-w-full');
    expect(html).toContain('[&_img]:max-h-[min(32rem,70vh)]');
    expect(html).toContain('[&_img]:object-contain');
  });
});
