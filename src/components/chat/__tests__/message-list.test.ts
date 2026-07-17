import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UserMessageReferenceCapsule } from '@/components/chat/message-list';
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
