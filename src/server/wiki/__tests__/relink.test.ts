import { describe, expect, it } from 'vitest';
import { rewriteBacklinkText } from '../relink';

const SUBJECT = 'general';

describe('rewriteBacklinkText', () => {
  it('重写 title-form [[Old Title]] → [[New Title]]', () => {
    const out = rewriteBacklinkText('see [[Old Title]] here', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('see [[New Title]] here');
  });

  it('小写 [[old title]] 也重写（忽略大小写匹配）', () => {
    const out = rewriteBacklinkText('[[old title]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[New Title]]');
  });

  it('保留别名 [[Old Title|看这里]] → [[New Title|看这里]]', () => {
    const out = rewriteBacklinkText('[[Old Title|看这里]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[New Title|看这里]]');
  });

  it('保留锚点 [[Old Title#用法]] → [[New Title#用法]]', () => {
    const out = rewriteBacklinkText('[[Old Title#用法]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[New Title#用法]]');
  });

  it('保留锚点+别名 [[Old Title#用法|看]] → [[New Title#用法|看]]', () => {
    const out = rewriteBacklinkText('[[Old Title#用法|看]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[New Title#用法|看]]');
  });

  it('slug-form [[old-title]] 不动（rawTitle 非旧标题）', () => {
    const out = rewriteBacklinkText('[[old-title]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[old-title]]');
  });

  it('跨主题前缀 [[other:Old Title]] 不动', () => {
    const out = rewriteBacklinkText('[[other:Old Title]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[other:Old Title]]');
  });

  it('显式本-subject 前缀 [[general:Old Title]] 重写并保留前缀', () => {
    const out = rewriteBacklinkText('[[general:Old Title]]', 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('[[general:New Title]]');
  });

  it('同段多处混合：title-form 改、slug-form 不改、多处不串位', () => {
    const input = 'A [[Old Title]] B [[old-title]] C [[Old Title|x]] D';
    const out = rewriteBacklinkText(input, 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('A [[New Title]] B [[old-title]] C [[New Title|x]] D');
  });

  it('code fence 内的 [[Old Title]] 不改', () => {
    const input = '```\n[[Old Title]]\n```\n[[Old Title]]';
    const out = rewriteBacklinkText(input, 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('```\n[[Old Title]]\n```\n[[New Title]]');
  });

  it('行内 code 内的 [[Old Title]] 不改', () => {
    const input = '`[[Old Title]]` and [[Old Title]]';
    const out = rewriteBacklinkText(input, 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe('`[[Old Title]]` and [[New Title]]');
  });

  it('无匹配返回原串', () => {
    const input = 'nothing to see [[Other Page]]';
    const out = rewriteBacklinkText(input, 'Old Title', 'New Title', SUBJECT);
    expect(out).toBe(input);
  });

  it('空旧标题返回原串', () => {
    const out = rewriteBacklinkText('[[Old Title]]', '   ', 'New Title', SUBJECT);
    expect(out).toBe('[[Old Title]]');
  });

  it('回归：target 文本等于 subject 前缀时只改 target 不动前缀', () => {
    const out = rewriteBacklinkText('[[general:general]]', 'general', 'New', SUBJECT);
    expect(out).toBe('[[general:New]]');
  });
});

import type { TitleResolver } from '@/lib/contracts';
import { repointLinksToPage } from '../relink';

describe('repointLinksToPage', () => {
  // 把 'B Title'（及小写）解析到 slug 'b'；其余按 normalizeSlug 兜底。
  const resolver: TitleResolver = (t) => (t.trim().toLowerCase() === 'b title' ? 'b' : undefined);

  it('title-form [[B Title]] → [[A Title]]', () => {
    expect(repointLinksToPage('see [[B Title]] x', 'b', 'A Title', 'general', resolver))
      .toBe('see [[A Title]] x');
  });

  it('slug-form [[b]] → [[A Title]]', () => {
    expect(repointLinksToPage('[[b]]', 'b', 'A Title', 'general', resolver))
      .toBe('[[A Title]]');
  });

  it('保留别名 [[B Title|看]] → [[A Title|看]]', () => {
    expect(repointLinksToPage('[[B Title|看]]', 'b', 'A Title', 'general', resolver))
      .toBe('[[A Title|看]]');
  });

  it('保留锚点 [[B Title#x]] → [[A Title#x]]', () => {
    expect(repointLinksToPage('[[B Title#x]]', 'b', 'A Title', 'general', resolver))
      .toBe('[[A Title#x]]');
  });

  it('不指向 B 的链接不动（[[Other]] / [[a]]）', () => {
    expect(repointLinksToPage('[[Other]] and [[a]]', 'b', 'A Title', 'general', resolver))
      .toBe('[[Other]] and [[a]]');
  });

  it('跨主题 [[other:B Title]] 不动', () => {
    expect(repointLinksToPage('[[other:B Title]]', 'b', 'A Title', 'general', resolver))
      .toBe('[[other:B Title]]');
  });

  it('同段多处混合、右起替换不串位', () => {
    expect(repointLinksToPage('A [[B Title]] B [[a]] C [[b|x]] D', 'b', 'A Title', 'general', resolver))
      .toBe('A [[A Title]] B [[a]] C [[A Title|x]] D');
  });

  it('code fence 内不动', () => {
    expect(repointLinksToPage('```\n[[b]]\n```\n[[b]]', 'b', 'A Title', 'general', resolver))
      .toBe('```\n[[b]]\n```\n[[A Title]]');
  });

  it('无匹配返回原串', () => {
    expect(repointLinksToPage('nothing [[zzz]]', 'b', 'A Title', 'general', resolver))
      .toBe('nothing [[zzz]]');
  });
});
