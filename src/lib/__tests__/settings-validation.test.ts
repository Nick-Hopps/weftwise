import { describe, expect, it } from 'vitest';
import { validateIntInRange } from '../settings-validation';

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
