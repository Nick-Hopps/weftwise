import { describe, expect, it } from 'vitest';
import {
  createMarkdownBlockAnchor,
  resolveMarkdownBlockAnchor,
} from '../markdown-block-anchor';

describe('Markdown 块锚点', () => {
  it('把段内选区规范化为完整顶层段落', () => {
    const body = 'Alpha **bold** text.\n\nSecond paragraph.';
    const end = body.indexOf('\n\n');
    const anchor = createMarkdownBlockAnchor(body, {
      sourceKind: 'canonical',
      quote: 'bold',
      section: 'Intro',
      blockStart: 0,
      blockEnd: end,
    });

    expect(anchor).toMatchObject({
      start: 0,
      end,
      markdown: 'Alpha **bold** text.',
      quote: 'bold',
      section: 'Intro',
    });
  });

  it('允许跨多个完整顶层块，并保留列表、表格、代码和 callout 容器', () => {
    const blocks = [
      '- one\n- two',
      '| A | B |\n| - | - |\n| 1 | 2 |',
      '```ts\nconst x = 1;\n```',
      '> [!diagram]\n> Existing diagram',
    ];
    const body = blocks.join('\n\n');
    const start = body.indexOf(blocks[0]);
    const end = body.indexOf(blocks[3]) + blocks[3].length;

    const anchor = createMarkdownBlockAnchor(body, {
      sourceKind: 'canonical',
      quote: 'one Existing diagram',
      section: null,
      blockStart: start,
      blockEnd: end,
    });

    expect(anchor.markdown).toBe(body);
    expect(resolveMarkdownBlockAnchor(body, anchor)).toEqual({ start, end });
  });

  it('正文前方插入其他块后可按完整块文本唯一重定位', () => {
    const body = 'Target paragraph.\n\nTail.';
    const targetEnd = body.indexOf('\n\n');
    const anchor = createMarkdownBlockAnchor(body, {
      sourceKind: 'canonical',
      quote: 'Target',
      section: null,
      blockStart: 0,
      blockEnd: targetEnd,
    });
    const current = `New preface.\n\n${body}`;

    expect(resolveMarkdownBlockAnchor(current, anchor)).toEqual({
      start: current.indexOf('Target paragraph.'),
      end: current.indexOf('Target paragraph.') + 'Target paragraph.'.length,
    });
  });

  it('客户端范围不是完整顶层块时拒绝', () => {
    expect(() => createMarkdownBlockAnchor('Whole paragraph.', {
      sourceKind: 'canonical',
      quote: 'paragraph',
      section: null,
      blockStart: 6,
      blockEnd: 15,
    })).toThrow(/block boundary/i);
  });

  it('Reshape 选区不能生成 canonical 写入锚点', () => {
    expect(() => createMarkdownBlockAnchor('Whole paragraph.', {
      sourceKind: 'reshape',
      quote: 'paragraph',
      section: null,
      blockStart: 0,
      blockEnd: 16,
    })).toThrow(/original/i);
  });

  it('原位置失效且出现多个相同块时 fail closed', () => {
    const body = 'Same paragraph.';
    const anchor = createMarkdownBlockAnchor(body, {
      sourceKind: 'canonical',
      quote: 'Same',
      section: null,
      blockStart: 0,
      blockEnd: body.length,
    });
    const current = 'Preface.\n\nSame paragraph.\n\nSame paragraph.';

    expect(() => resolveMarkdownBlockAnchor(current, anchor)).toThrow(/unique/i);
  });
});
