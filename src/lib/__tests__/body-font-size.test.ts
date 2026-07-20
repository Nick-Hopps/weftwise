import { describe, expect, it, vi } from 'vitest';
import {
  BODY_FONT_SIZE_CSS_VARIABLE,
  applyBodyFontSize,
  bodyFontSizeCssValue,
} from '../body-font-size';

describe('正文字号 CSS 同步', () => {
  it('把设置值转换为 px，并沿用统一变量名', () => {
    expect(BODY_FONT_SIZE_CSS_VARIABLE).toBe('--wiki-body-font-size');
    expect(bodyFontSizeCssValue(16)).toBe('16px');
    expect(bodyFontSizeCssValue(22)).toBe('22px');
  });

  it('把字号写入根元素样式', () => {
    const setProperty = vi.fn();
    applyBodyFontSize({ style: { setProperty } } as never, 20);

    expect(setProperty).toHaveBeenCalledWith('--wiki-body-font-size', '20px');
  });

  it('拒绝不符合契约的值', () => {
    expect(() => bodyFontSizeCssValue(23)).toThrow();
  });
});
