import { describe, expect, it } from 'vitest';
import { buildUserMessageReferences } from '@/lib/chat-reference';

describe('buildUserMessageReferences', () => {
  it('binds sent passages to the current subject and page', () => {
    expect(buildUserMessageReferences(
      [
        { section: '原理', text: '第一段原文' },
        { section: '限制', text: '第二段原文' },
      ],
      { pageSlug: 'coordinate-system', pageTitle: '坐标系统', subjectSlug: 'general' },
    )).toEqual([
      {
        pageSlug: 'coordinate-system',
        pageTitle: '坐标系统',
        subjectSlug: 'general',
        section: '原理',
        excerpt: '第一段原文',
      },
      {
        pageSlug: 'coordinate-system',
        pageTitle: '坐标系统',
        subjectSlug: 'general',
        section: '限制',
        excerpt: '第二段原文',
      },
    ]);
  });

  it('drops empty excerpts instead of creating blank reference cards', () => {
    expect(buildUserMessageReferences(
      [
        { section: 'Empty', text: '   ' },
        { section: null, text: ' kept ' },
      ],
      { pageSlug: 'page-a', pageTitle: 'Page A', subjectSlug: 'notes' },
    )).toEqual([
      {
        pageSlug: 'page-a',
        pageTitle: 'Page A',
        subjectSlug: 'notes',
        section: null,
        excerpt: 'kept',
      },
    ]);
  });
});
