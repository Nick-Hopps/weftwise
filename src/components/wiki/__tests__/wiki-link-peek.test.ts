import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import WikiLinkPeek from '../wiki-link-peek';

// 正文 wikilink 永远处在段落里（`<p>`，callout 内也一样），而 `<p>` 只接受
// phrasing content。悬浮卡一旦渲染 `<div>` / `<p>`，浏览器会就地截断段落，
// React 直接报 "In HTML, <div> cannot be a descendant of <p>" 并判定 hydration 失败。
// 因此这里锁的是「卡片只用行内元素」这条硬约束，而不是某几个 class。
const BLOCK_TAG = /<(div|p|ul|ol|li|section|h[1-6])[\s>]/;

const render = (props: Parameters<typeof WikiLinkPeek>[0]) =>
  renderToStaticMarkup(createElement(WikiLinkPeek, props));

const noop = () => {};

const baseProps = {
  loading: false,
  preview: null,
  noPreviewLabel: 'No preview',
  onMouseEnter: noop,
  onMouseLeave: noop,
};

describe('WikiLinkPeek', () => {
  it('只用行内元素渲染有摘要的预览', () => {
    const html = render({
      ...baseProps,
      preview: { title: '蒙古帝国', summary: '疆域最辽阔的连续陆地帝国。' },
    });

    expect(html).not.toMatch(BLOCK_TAG);
    expect(html).toContain('蒙古帝国');
    expect(html).toContain('疆域最辽阔的连续陆地帝国。');
  });

  it('只用行内元素渲染加载态', () => {
    expect(render({ ...baseProps, loading: true })).not.toMatch(BLOCK_TAG);
  });

  it('只用行内元素渲染无预览兜底', () => {
    const html = render(baseProps);

    expect(html).not.toMatch(BLOCK_TAG);
    expect(html).toContain('No preview');
  });

  it('摘要为空时不渲染摘要行', () => {
    const html = render({ ...baseProps, preview: { title: '蒙古帝国', summary: '' } });

    expect(html).not.toMatch(BLOCK_TAG);
    expect(html).toContain('蒙古帝国');
    expect(html).not.toContain('line-clamp-3');
  });
});
