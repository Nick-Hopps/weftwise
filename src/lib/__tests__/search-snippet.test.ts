import { describe, expect, it } from 'vitest';
import { parseSearchSnippet } from '@/lib/search-snippet';

describe('parseSearchSnippet', () => {
  it('将多个受控 mark 对拆为普通文本和高亮文本', () => {
    expect(parseSearchSnippet('前文 <mark>第一处</mark> 中间 <mark>第二处</mark> 后文'))
      .toEqual([
        { text: '前文 ', highlighted: false },
        { text: '第一处', highlighted: true },
        { text: ' 中间 ', highlighted: false },
        { text: '第二处', highlighted: true },
        { text: ' 后文', highlighted: false },
      ]);
  });

  it('把其他 HTML 保留为普通文本，只识别受控 mark 对', () => {
    expect(parseSearchSnippet('<img src=x onerror=alert(1)> <mark>命中</mark>'))
      .toEqual([
        { text: '<img src=x onerror=alert(1)> ', highlighted: false },
        { text: '命中', highlighted: true },
      ]);
  });

  it('未闭合或反向标记降级为普通文本', () => {
    expect(parseSearchSnippet('前文 <mark>未闭合')).toEqual([
      { text: '前文 <mark>未闭合', highlighted: false },
    ]);
    expect(parseSearchSnippet('前文 </mark> 反向')).toEqual([
      { text: '前文 </mark> 反向', highlighted: false },
    ]);
  });

  it('空片段不产生渲染段', () => {
    expect(parseSearchSnippet('')).toEqual([]);
  });
});
