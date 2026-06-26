import { describe, it, expect } from 'vitest';
import { computeCanonicalHash } from '../rendition-hash';

describe('computeCanonicalHash', () => {
  it('同输入稳定、不同输入不同', () => {
    expect(computeCanonicalHash('hello')).toBe(computeCanonicalHash('hello'));
    expect(computeCanonicalHash('hello')).not.toBe(computeCanonicalHash('world'));
  });
  it('输出 16 位 hex', () => {
    expect(computeCanonicalHash('x')).toMatch(/^[0-9a-f]{16}$/);
  });
});
