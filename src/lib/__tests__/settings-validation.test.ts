import { describe, expect, it } from 'vitest';
import { validateIntInRange } from '../settings-validation';
import { BodyFontSizeSchema, DEFAULT_BODY_FONT_SIZE } from '../contracts';

describe('validateIntInRange', () => {
  it('接受范围内整数', () => {
    expect(validateIntInRange('25', 1, 200)).toBe(25);
    expect(validateIntInRange('1', 1, 200)).toBe(1);
    expect(validateIntInRange('200', 1, 200)).toBe(200);
  });
  it('拒绝越界值', () => {
    expect(validateIntInRange('0', 1, 200)).toBeNull();
    expect(validateIntInRange('201', 1, 200)).toBeNull();
  });
  it('拒绝非整数与非数字', () => {
    expect(validateIntInRange('2.5', 1, 200)).toBeNull();
    expect(validateIntInRange('abc', 1, 200)).toBeNull();
    expect(validateIntInRange('', 1, 200)).toBeNull();
    expect(validateIntInRange('  ', 1, 200)).toBeNull();
  });
});

describe('BodyFontSizeSchema', () => {
  it('保留当前 16px 默认值并接受 14–22 的整数', () => {
    expect(DEFAULT_BODY_FONT_SIZE).toBe(16);
    expect(BodyFontSizeSchema.parse(14)).toBe(14);
    expect(BodyFontSizeSchema.parse(22)).toBe(22);
  });

  it('拒绝越界值与非整数', () => {
    expect(() => BodyFontSizeSchema.parse(13)).toThrow();
    expect(() => BodyFontSizeSchema.parse(23)).toThrow();
    expect(() => BodyFontSizeSchema.parse(16.5)).toThrow();
  });
});
