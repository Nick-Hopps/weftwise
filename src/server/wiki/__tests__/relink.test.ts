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
});
