import { describe, expect, it } from 'vitest';
import type { LinkEnsureInput } from '@/lib/contracts';
import { buildLinkEnsureEdit } from '../narrow-write';

function edit(body: string, input: Omit<LinkEnsureInput, 'sourceSlug'>): string {
  const planned = buildLinkEnsureEdit(body, { sourceSlug: 'source', ...input }, 'general');
  return body.replace(planned.oldString, planned.newString);
}

describe('buildLinkEnsureEdit link', () => {
  it('oldString 唯一且可带上下文；displayText 只包装既有唯一子串', () => {
    const body = 'Read the Eigenvalue article today.';
    expect(edit(body, {
      mode: 'link', targetSlug: 'eigenvalue',
      oldString: 'the Eigenvalue article', displayText: ' Eigenvalue ',
    })).toBe('Read the [[eigenvalue|Eigenvalue]] article today.');
    expect(edit('A natural anchor here.', {
      mode: 'link', targetSlug: 'target', oldString: 'natural anchor',
    })).toBe('A [[target|natural anchor]] here.');
  });

  it('拒绝 oldString 多处命中与 displayText 在 oldString 内多处命中', () => {
    expect(() => edit('anchor and anchor', {
      mode: 'link', targetSlug: 'target', oldString: 'anchor',
    })).toThrow(/matches 2 locations/i);
    expect(() => edit('anchor anchor', {
      mode: 'link', targetSlug: 'target', oldString: 'anchor anchor', displayText: 'anchor',
    })).toThrow(/displayText.*2 locations/i);
  });

  it.each([
    ['fenced code', '```md\nanchor\n```'],
    ['inline code', 'Use `anchor` here.'],
    ['existing wikilink', 'Use [[old-page|anchor]] here.'],
    ['Markdown link', 'Use [anchor](https://example.com) here.'],
    ['Markdown image', 'Use ![anchor](image.png) here.'],
  ])('拒绝 %s 内的自然锚点', (_label, body) => {
    expect(() => edit(body, {
      mode: 'link', targetSlug: 'target', oldString: 'anchor',
    })).toThrow(/visible prose|anchor context/i);
  });

  it.each([
    ['双右方括号', 'label]]tail'],
    ['双左方括号', 'label[[tail'],
    ['单左方括号', 'label[tail'],
    ['单右方括号', 'label]tail'],
  ])('拒绝会破坏 wikilink token 完整性的 %s displayText', (_label, anchor) => {
    expect(() => edit(`Before ${anchor} after.`, {
      mode: 'link', targetSlug: 'target', oldString: anchor, displayText: anchor,
    })).toThrow(/complete stable wikilink/i);
  });

  it('默认锚点同样拒绝破坏 token 的方括号，但保留普通圆括号文本', () => {
    expect(() => edit('Before raw]]anchor after.', {
      mode: 'link', targetSlug: 'target', oldString: 'raw]]anchor',
    })).toThrow(/complete stable wikilink/i);
    expect(edit('Call function(arg) now.', {
      mode: 'link', targetSlug: 'target', oldString: 'function(arg)',
    })).toBe('Call [[target|function(arg)]] now.');
  });

  it.each([
    ['命名实体', '&amp;', 'amp'],
    ['十进制实体', '&#38;', '38'],
    ['十六进制实体', '&#x26;', 'x26'],
  ])('拒绝把 CommonMark %s 的源码片段当作可见锚点', (_label, source, anchor) => {
    expect(() => edit(`Before ${source} after.`, {
      mode: 'link', targetSlug: 'target', oldString: source, displayText: anchor,
    })).toThrow(/character reference|source escape/i);
  });

  it('拒绝与反斜杠转义重叠的锚点，但同 text node 的普通文字仍可 link', () => {
    expect(() => edit('Use \\* marker.', {
      mode: 'link', targetSlug: 'target', oldString: '\\*', displayText: '*',
    })).toThrow(/backslash escape|source escape/i);
    expect(edit('Use &amp; and ordinary.', {
      mode: 'link', targetSlug: 'target', oldString: '&amp; and ordinary',
      displayText: 'ordinary',
    })).toBe('Use &amp; and [[target|ordinary]].');
  });
});

describe('buildLinkEnsureEdit unlink/retarget', () => {
  it('unlink 拒绝跨越 token 起点的反斜杠转义', () => {
    expect(() => edit('\\[[old]]', {
      mode: 'unlink', targetSlug: 'old', oldString: '[[old]]',
    })).toThrow(/source escape|token start|token boundary/i);
  });

  it('unlink 不误伤 token 内合法 alias 的 entity/escape', () => {
    expect(edit('See [[old|A &amp; escaped \\* marker]].', {
      mode: 'unlink', targetSlug: 'old',
      oldString: '[[old|A &amp; escaped \\* marker]]',
    })).toBe('See A &amp; escaped \\* marker.');
  });

  it('unlink 允许 broken target，校验旧 token target，并保留上下文与显示文本', () => {
    const body = 'Before [[missing-page|Missing Page]] after.';
    expect(edit(body, {
      mode: 'unlink', targetSlug: 'missing-page',
      oldString: 'Before [[missing-page|Missing Page]] after.',
      displayText: ' Missing Page ',
    })).toBe('Before Missing Page after.');
    expect(() => edit(body, {
      mode: 'unlink', targetSlug: 'other-page', oldString: '[[missing-page|Missing Page]]',
    })).toThrow(/target.*does not match/i);
  });

  it('unlink/retarget 要求 oldString 恰含一个有效 wikilink，displayText 仅作断言', () => {
    expect(() => edit('[[a]] and [[b]]', {
      mode: 'unlink', targetSlug: 'a', oldString: '[[a]] and [[b]]',
    })).toThrow(/exactly one valid wikilink/i);
    expect(() => edit('See [[old-page|Shown]].', {
      mode: 'retarget', targetSlug: 'new-page', oldString: '[[old-page|Shown]]',
      displayText: 'Different',
    })).toThrow(/displayText.*does not match/i);
  });

  it('retarget 生成稳定跨主题 slug token并保留当前显示文本', () => {
    expect(edit('See [[old-page|Shown]] now.', {
      mode: 'retarget', targetSubjectSlug: 'other', targetSlug: 'New Page',
      oldString: 'See [[old-page|Shown]] now.',
    })).toBe('See [[other:new-page|Shown]] now.');
  });

  it('retarget 新旧 token 完全相同时拒绝空操作', () => {
    expect(() => edit('See [[new-page|Shown]].', {
      mode: 'retarget', targetSlug: 'new-page', oldString: '[[new-page|Shown]]',
    })).toThrow(/no actual link change/i);
  });

  it.each([
    ['Markdown link destination', '[site](https://x/[[old]])'],
    ['Markdown image destination', '![site](https://x/[[old]])'],
    ['raw HTML attribute', '<a href="[[old]]">site</a>'],
  ])('拒绝 %s 内 token 的 unlink/retarget', (_label, body) => {
    expect(() => edit(body, {
      mode: 'unlink', targetSlug: 'old', oldString: body,
    })).toThrow(/visible prose|token context/i);
    expect(() => edit(body, {
      mode: 'retarget', targetSlug: 'new', oldString: body,
    })).toThrow(/visible prose|token context/i);
  });
});
