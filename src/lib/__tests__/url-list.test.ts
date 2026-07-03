import { describe, it, expect } from 'vitest';
import { parseUrlLines } from '../url-list';

describe('parseUrlLines', () => {
  it('按行拆分、trim、去空、去重', () => {
    const r = parseUrlLines(' https://a.com \n\nhttps://b.com\nhttps://a.com');
    expect(r.urls).toEqual(['https://a.com', 'https://b.com']);
    expect(r.invalid).toEqual([]);
  });
  it('非 https?:// 前缀的行归入 invalid', () => {
    const r = parseUrlLines('https://ok.com\nftp://bad\nnot a url');
    expect(r.urls).toEqual(['https://ok.com']);
    expect(r.invalid).toEqual(['ftp://bad', 'not a url']);
  });
  it('全空输入返回双空数组', () => {
    expect(parseUrlLines('  \n ')).toEqual({ urls: [], invalid: [] });
  });
});
