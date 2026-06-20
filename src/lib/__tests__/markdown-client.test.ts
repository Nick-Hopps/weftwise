import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

// markdown-client 顶层 import 了 WikiLink（它又依赖 next/link、ui-store 等
// 浏览器/路由上下文）。这里把它替换成纯 <a>，让"公式+wikilink 共存"用例能在
// node 环境下渲染，并彻底避开真实组件的浏览器依赖链。
vi.mock('@/components/wiki/wiki-link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children }: { href?: string; children?: unknown }) =>
      React.createElement('a', { href }, children as React.ReactNode),
  };
});

import { renderMarkdown } from '../markdown-client';

const toHtml = (el: ReactElement) => renderToStaticMarkup(el);

describe('renderMarkdown — KaTeX 公式渲染', () => {
  it('math:true 时行内 $…$ 渲染为 KaTeX', () => {
    const html = toHtml(renderMarkdown('$E=mc^2$', undefined, { math: true }));
    expect(html).toContain('katex');
  });

  it('math:true 时块级 $$…$$（独占多行）渲染为 katex-display', () => {
    const html = toHtml(renderMarkdown('$$\nE=mc^2\n$$', undefined, { math: true }));
    expect(html).toContain('katex-display');
  });

  it('默认（math 关闭）时 $…$ 原样保留为文本，不出现 katex', () => {
    const html = toHtml(renderMarkdown('$E=mc^2$'));
    expect(html).toContain('$E=mc^2$');
    expect(html).not.toContain('katex');
  });

  it('math:true 时非法 LaTeX 不抛错（throwOnError:false 安全保证）', () => {
    expect(() =>
      toHtml(renderMarkdown('$\\frac{$', undefined, { math: true })),
    ).not.toThrow();
  });

  it('公式与 wikilink 共存：两者都正确渲染（验证插件顺序无冲突）', () => {
    const html = toHtml(
      renderMarkdown('[[Page]] 与 $x^2$', undefined, { math: true }),
    );
    expect(html).toContain('katex');
    expect(html).toContain('Page');
  });
});
