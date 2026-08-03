import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// MessageCitations 的 wiki 行用 router.push 跳转；静态渲染只需要一个可用的 router 对象。
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
import {
  MarkdownText,
  MessageCitations,
  UserMessageReferenceCapsule,
} from '@/components/chat/message-list';
import type { UserMessageReference } from '@/lib/contracts';

const references: UserMessageReference[] = [
  {
    pageSlug: 'page-a',
    pageTitle: 'Page A',
    subjectSlug: 'general',
    section: '原理',
    excerpt: '第一段引用原文',
  },
  {
    pageSlug: 'page-b',
    pageTitle: 'Page B',
    subjectSlug: 'notes',
    section: '细节',
    excerpt: '第二段引用原文',
  },
];

describe('UserMessageReferenceCapsule', () => {
  it('renders one compact page link with the page title and section summary', () => {
    const html = renderToStaticMarkup(
      React.createElement(UserMessageReferenceCapsule, { references }),
    );

    expect(html.match(/<a\b/g)).toHaveLength(1);
    expect(html).toContain('href="/wiki/page-a?s=general"');
    expect(html).toContain('Page A');
    expect(html).toContain('原理');
    expect(html).toContain('aria-label="Open referenced page"');
    expect(html).not.toContain('第一段引用原文');
    expect(html).not.toContain('Page B');
    expect(html).not.toContain('细节');
    expect(html).not.toContain('第二段引用原文');
  });

  it('uses a short excerpt summary when the section is unavailable', () => {
    const excerpt = '这是一段没有章节标题的引用内容，它足够长，因此胶囊只能显示经过截断的短摘要而不能展示全部选中文字。';
    const html = renderToStaticMarkup(
      React.createElement(UserMessageReferenceCapsule, {
        references: [{
          pageSlug: 'fallback-page',
          pageTitle: 'Fallback Page',
          subjectSlug: 'general',
          section: null,
          excerpt,
        }],
      }),
    );

    expect(html).toContain('Fallback Page');
    expect(html).toContain('这是一段没有章节标题的引用内容');
    expect(html).toContain('…');
    expect(html).not.toContain(excerpt);
  });

  it('renders nothing when the message has no references', () => {
    expect(renderToStaticMarkup(
      React.createElement(UserMessageReferenceCapsule, { references: [] }),
    )).toBe('');
  });
});

describe('MarkdownText', () => {
  it('keeps GFM tables inside a stable horizontally scrollable message surface', () => {
    const html = renderToStaticMarkup(React.createElement(MarkdownText, {
      content: '| Name | Value |\n| --- | --- |\n| Alpha | A long value |',
    }));

    expect(html).toContain('<table>');
    expect(html).toContain('overflow-x-auto');
    expect(html).toContain('[&amp;&gt;table]:table-fixed');
  });
});

describe('MessageCitations', () => {
  const wiki = [{ pageSlug: 'page-a', excerpt: '页面证据' }];
  const web = [
    { url: 'https://sqlite.org/wal.html', title: 'WAL 官方文档' },
    { url: 'https://example.com/perf', title: 'Perf notes' },
  ];

  it('wiki 与 web 条目同区呈现，计数为两者之和', () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageCitations, { citations: wiki, webCitations: web }),
    );

    expect(html).toContain('page-a');
    expect(html).toContain('WAL 官方文档');
    expect(html).toContain('Perf notes');
    // 计数徽标：1 个 wiki + 2 个 web
    expect(html).toMatch(/>3</);
  });

  it('web 条目是新标签页打开的安全外链，并显示域名', () => {
    const html = renderToStaticMarkup(
      React.createElement(MessageCitations, { citations: [], webCitations: web }),
    );

    expect(html).toContain('href="https://sqlite.org/wal.html"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('sqlite.org');
  });

  it('总数 ≤3 默认展开、>3 默认折叠（按 wiki+web 总数判断）', () => {
    const expanded = renderToStaticMarkup(
      React.createElement(MessageCitations, { citations: wiki, webCitations: web }),
    );
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain('WAL 官方文档');

    const collapsed = renderToStaticMarkup(
      React.createElement(MessageCitations, {
        citations: [...wiki, { pageSlug: 'page-b', excerpt: 'x' }],
        webCitations: web,
      }),
    );
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).not.toContain('WAL 官方文档');
  });
});
