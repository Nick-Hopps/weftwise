import { describe, it, expect } from 'vitest';
import { decodeRouteSegment, decodeRouteSegments } from '../route-params';

describe('decodeRouteSegment', () => {
  it('解码百分号编码的中文 slug（Server Component params 的未解码形态）', () => {
    // `0-阅读顺序` 经浏览器编码后 Next.js 页面侧原样保留
    expect(decodeRouteSegment('0-%E9%98%85%E8%AF%BB%E9%A1%BA%E5%BA%8F')).toBe('0-阅读顺序');
  });

  it('对纯 ASCII 段幂等', () => {
    expect(decodeRouteSegment('trace')).toBe('trace');
    expect(decodeRouteSegment('linear-algebra-done-right')).toBe('linear-algebra-done-right');
  });

  it('对已解码的中文段幂等（无 % 序列，原样返回）', () => {
    expect(decodeRouteSegment('0-阅读顺序')).toBe('0-阅读顺序');
  });

  it('遇到非法百分号编码时回退原值而非抛错', () => {
    expect(decodeRouteSegment('100%done')).toBe('100%done');
  });
});

describe('decodeRouteSegments', () => {
  it('逐段解码 catch-all 后用 / 拼接', () => {
    expect(decodeRouteSegments(['0-%E9%98%85%E8%AF%BB%E9%A1%BA%E5%BA%8F'])).toBe('0-阅读顺序');
  });

  it('保留多段层级 slug', () => {
    expect(decodeRouteSegments(['parent', '%E5%AD%90%E9%A1%B5'])).toBe('parent/子页');
  });

  it('空数组得到空串', () => {
    expect(decodeRouteSegments([])).toBe('');
  });
});
