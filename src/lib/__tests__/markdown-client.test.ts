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

describe('renderMarkdown — Callout 渲染', () => {
  it('[!type] blockquote 渲染为 Lucide 图标容器并剥离历史 emoji', () => {
    const md = '> [!intuition] 💡 直觉\n> 把 T 想成一次搅动。';
    const html = toHtml(renderMarkdown(md));
    expect(html).toContain('data-callout="intuition"');
    expect(html).toContain('callout-intuition');
    expect(html).toContain('data-callout-icon="intuition"');
    expect(html).toContain('直觉');
    expect(html).not.toContain('💡');
    expect(html).not.toContain('[!intuition]');
  });

  it('type 大小写归一化为小写', () => {
    const html = toHtml(renderMarkdown('> [!Quiz] ❓ 自测\n> 为什么？'));
    expect(html).toContain('data-callout="quiz"');
  });

  it('普通 blockquote 不被误判为 callout', () => {
    const html = toHtml(renderMarkdown('> 这是一句普通引用。'));
    expect(html).toContain('<blockquote');
    expect(html).not.toContain('data-callout');
  });

  it('callout 内的 [[wikilink]] 仍渲染', () => {
    const html = toHtml(renderMarkdown('> [!background] 🔗 背景\n> 见 [[Vectors]]'));
    expect(html).toContain('data-callout="background"');
    expect(html).toContain('Vectors');
  });

  it('只清理 callout 标题开头的已知 emoji，正文 emoji 保持不变', () => {
    const html = toHtml(renderMarkdown('> [!example] 📝 示例\n> 发射成功 🚀'));
    expect(html).not.toContain('📝');
    expect(html).toContain('发射成功 🚀');
  });

  it('未知 callout 类型使用通用图标并保留标题', () => {
    const html = toHtml(renderMarkdown('> [!custom] 自定义说明'));
    expect(html).toContain('data-callout-icon="custom"');
    expect(html).toContain('自定义说明');
  });
});

describe('renderMarkdown — Mermaid 渲染', () => {
  it('```mermaid 代码块渲染为 mermaid 容器并保留源码', () => {
    const md = '```mermaid\ngraph TD; A-->B\n```';
    const html = toHtml(renderMarkdown(md));
    expect(html).toContain('mermaid-diagram');
    expect(html).toContain('data-mermaid-src');
    expect(html).toContain('graph TD');
    expect(html).not.toContain('language-mermaid');
  });

  it('普通代码块不受影响', () => {
    const md = '```js\nconst a = 1;\n```';
    const html = toHtml(renderMarkdown(md));
    expect(html).toContain('<code');
    expect(html).not.toContain('mermaid-diagram');
  });
});

describe('renderMarkdown — GFM 表格渲染', () => {
  it('管道语法表格渲染为 table/th/td 结构', () => {
    const md = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |';
    const html = toHtml(renderMarkdown(md));
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
  });

  it('表格单元格内的 [[wikilink]] 仍正确渲染（验证插件顺序无冲突）', () => {
    const md = '| Name | Ref |\n| --- | --- |\n| foo | [[Page]] |';
    const html = toHtml(renderMarkdown(md));
    expect(html).toContain('<table');
    expect(html).toContain('Page');
    // 更强断言：必须是真正的链接元素，而不只是原样保留的 `[[Page]]` 纯文本
    // （纯文本形式同样包含字符串 "Page"，前两条断言无法区分两者）。
    expect(html).toMatch(/<a[^>]*>Page<\/a>/);
  });

  it('删除线语法随 remark-gfm 一起生效', () => {
    const html = toHtml(renderMarkdown('~~deleted~~'));
    expect(html).toContain('<del');
  });

  it('未启用表格语法前的普通竖线文本不受影响（非表格场景不误判）', () => {
    const html = toHtml(renderMarkdown('a | b | c'));
    expect(html).not.toContain('<table');
    expect(html).toContain('a | b | c');
  });
});

describe('renderMarkdown — 正文标题锚点', () => {
  it('默认不为复用渲染表面注入标题 ID', () => {
    const html = toHtml(renderMarkdown('## Overview'));
    expect(html).toContain('<h2>Overview</h2>');
  });

  it('显式开启后使用与目录一致的唯一标题 ID', () => {
    const html = toHtml(
      renderMarkdown('## 核心概念\n\n## 核心概念', undefined, {
        headingAnchors: true,
      }),
    );

    expect(html).toContain('<h2 id="核心概念">核心概念</h2>');
    expect(html).toContain('<h2 id="核心概念-2">核心概念</h2>');
  });
});

describe('renderMarkdown — 选区块源位置', () => {
  it('显式开启后为每个顶层 Markdown 块写入完整 UTF-16 offset', () => {
    const markdown = 'Alpha\n\n- one\n- two\n\n```js\nx\n```';
    const html = toHtml(renderMarkdown(markdown, undefined, {
      selectionBlocks: true,
    }));

    expect(html).toContain('data-md-block-start="0"');
    expect(html).toContain('data-md-block-end="5"');
    expect(html).toContain('data-md-block-start="7"');
    expect(html).toContain('data-md-block-end="18"');
    expect(html).toContain('data-md-block-start="20"');
    expect(html).toContain('data-md-block-end="31"');
  });

  it('默认不向其他 Markdown 渲染表面泄漏选区属性', () => {
    const html = toHtml(renderMarkdown('Alpha'));
    expect(html).not.toContain('data-md-block-start');
    expect(html).not.toContain('data-md-block-end');
  });
});
