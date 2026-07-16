import { describe, expect, it } from 'vitest';
import { extractArticleToc } from '@/lib/article-toc';

describe('extractArticleToc', () => {
  it('只收集二至四级标题并保留层级与格式化文本', () => {
    const markdown = [
      '# 页面标题',
      '## Getting **Started**',
      '### Use `npm run dev`',
      '#### [Advanced setup](https://example.com)',
      '##### 不应出现',
    ].join('\n\n');

    expect(extractArticleToc(markdown)).toEqual([
      { id: 'getting-started', text: 'Getting Started', depth: 2 },
      { id: 'use-npm-run-dev', text: 'Use npm run dev', depth: 3 },
      { id: 'advanced-setup', text: 'Advanced setup', depth: 4 },
    ]);
  });

  it('保留中文字符并为重复标题分配稳定唯一 ID', () => {
    const markdown = ['## 核心概念', '## 核心概念', '### 核心概念'].join('\n\n');

    expect(extractArticleToc(markdown)).toEqual([
      { id: '核心概念', text: '核心概念', depth: 2 },
      { id: '核心概念-2', text: '核心概念', depth: 2 },
      { id: '核心概念-3', text: '核心概念', depth: 3 },
    ]);
  });

  it('使用 wikilink 的可见文本，并为空标题提供 section 兜底', () => {
    const markdown = ['## [[Page|Shown label]]', '##'].join('\n\n');

    expect(extractArticleToc(markdown)).toEqual([
      { id: 'shown-label', text: 'Shown label', depth: 2 },
      { id: 'section', text: 'Section', depth: 2 },
    ]);
  });

  it('忽略 frontmatter，并且不把非法 subject 前缀从 wikilink 标题中截掉', () => {
    const markdown = [
      '---',
      'title: Fake heading',
      '---',
      '## [[A Title: With Colon]]',
      '## Actual section',
    ].join('\n');

    expect(extractArticleToc(markdown)).toEqual([
      { id: 'a-title-with-colon', text: 'A Title: With Colon', depth: 2 },
      { id: 'actual-section', text: 'Actual section', depth: 2 },
    ]);
  });
});
