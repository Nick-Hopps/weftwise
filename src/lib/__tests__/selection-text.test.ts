import { describe, it, expect } from 'vitest';
import {
  MAX_SELECTION_CONTEXT_CHARS,
  normalizeSelectionText,
  truncateForContext,
  selectionRefId,
  findNearestHeadingText,
  findSelectionBlockRange,
  type HeadingScanNode,
  type SelectionBlockScanNode,
} from '@/lib/selection-text';

/** 构造一个最小假节点，便于在 node 环境下测试标题扫描。 */
function node(
  tagName: string,
  opts: { text?: string; prev?: HeadingScanNode | null; parent?: HeadingScanNode | null } = {},
): HeadingScanNode {
  return {
    tagName,
    textContent: opts.text ?? null,
    previousElementSibling: opts.prev ?? null,
    parentElement: opts.parent ?? null,
  };
}

describe('normalizeSelectionText', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeSelectionText('  hello  ')).toBe('hello');
  });
  it('returns null for empty or whitespace-only', () => {
    expect(normalizeSelectionText('')).toBeNull();
    expect(normalizeSelectionText('   \n\t ')).toBeNull();
  });
});

describe('truncateForContext', () => {
  it('leaves short text unchanged', () => {
    expect(truncateForContext('short')).toBe('short');
  });
  it('leaves text at the limit unchanged', () => {
    const atMax = 'a'.repeat(MAX_SELECTION_CONTEXT_CHARS);
    expect(truncateForContext(atMax)).toBe(atMax);
  });
  it('truncates and appends an ellipsis past the limit', () => {
    const long = 'a'.repeat(MAX_SELECTION_CONTEXT_CHARS + 500);
    const out = truncateForContext(long);
    expect(out.length).toBe(MAX_SELECTION_CONTEXT_CHARS + 1);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('selectionRefId', () => {
  it('is deterministic for the same text', () => {
    expect(selectionRefId('hello world')).toBe(selectionRefId('hello world'));
  });
  it('differs for different text', () => {
    expect(selectionRefId('a')).not.toBe(selectionRefId('b'));
  });
  it('is prefixed with sel-', () => {
    expect(selectionRefId('x').startsWith('sel-')).toBe(true);
  });
});

describe('findNearestHeadingText', () => {
  it('returns the nearest preceding heading among siblings', () => {
    const h2 = node('H2', { text: 'Topic' });
    const p = node('P', { text: 'body', prev: h2 });
    expect(findNearestHeadingText(p)).toBe('Topic');
  });
  it('climbs ancestors when no sibling heading exists', () => {
    const h1 = node('H1', { text: 'Title' });
    const article = node('ARTICLE', { prev: null });
    // section <div> sits after the <h1>; the <p> lives inside it.
    const section = node('DIV', { prev: h1, parent: article });
    const p = node('P', { text: 'deep', prev: null, parent: section });
    expect(findNearestHeadingText(p)).toBe('Title');
  });
  it('returns null when there is no heading anywhere', () => {
    const p = node('P', { text: 'lonely' });
    expect(findNearestHeadingText(p)).toBeNull();
  });
  it('returns null for an empty-text heading', () => {
    const h2 = node('H2', { text: '  ' });
    const p = node('P', { prev: h2 });
    expect(findNearestHeadingText(p)).toBeNull();
  });
  it('returns null for a null start node', () => {
    expect(findNearestHeadingText(null)).toBeNull();
  });
});

function blockNode(
  attrs: Record<string, string> = {},
  parentElement: SelectionBlockScanNode | null = null,
): SelectionBlockScanNode {
  return {
    parentElement,
    getAttribute: (name) => attrs[name] ?? null,
  };
}

describe('findSelectionBlockRange', () => {
  it('从 Range 两端向上找到顶层块，并合并为完整连续范围', () => {
    const startBlock = blockNode({
      'data-md-block-start': '10',
      'data-md-block-end': '24',
    });
    const endBlock = blockNode({
      'data-md-block-start': '30',
      'data-md-block-end': '48',
    });

    expect(findSelectionBlockRange(
      blockNode({}, startBlock),
      blockNode({}, endBlock),
    )).toEqual({ blockStart: 10, blockEnd: 48 });
  });

  it('同一块选区返回该块完整范围', () => {
    const block = blockNode({
      'data-md-block-start': '4',
      'data-md-block-end': '19',
    });
    expect(findSelectionBlockRange(blockNode({}, block), blockNode({}, block)))
      .toEqual({ blockStart: 4, blockEnd: 19 });
  });

  it('缺少块属性或首尾倒置时 fail closed', () => {
    const valid = blockNode({
      'data-md-block-start': '20',
      'data-md-block-end': '30',
    });
    const earlier = blockNode({
      'data-md-block-start': '2',
      'data-md-block-end': '10',
    });
    expect(findSelectionBlockRange(blockNode(), valid)).toBeNull();
    expect(findSelectionBlockRange(valid, earlier)).toBeNull();
  });
});
