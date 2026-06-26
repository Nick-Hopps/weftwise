import { describe, it, expect } from 'vitest';
import {
  DEFAULT_STYLE_PREFS, StylePrefsSchema, READING_LEVELS, stepLevel,
} from '../style';

describe('style', () => {
  it('DEFAULT_STYLE_PREFS 通过 schema', () => {
    expect(() => StylePrefsSchema.parse(DEFAULT_STYLE_PREFS)).not.toThrow();
    expect(DEFAULT_STYLE_PREFS.readingLevel).toBe('intermediate');
  });

  it('schema 拒绝非法枚举', () => {
    expect(() => StylePrefsSchema.parse({ ...DEFAULT_STYLE_PREFS, readingLevel: 'expert' })).toThrow();
  });

  it('stepLevel 在边界钳制、按 delta 移动', () => {
    expect(stepLevel(READING_LEVELS, 'beginner', -1)).toBe('beginner'); // 下界钳制
    expect(stepLevel(READING_LEVELS, 'beginner', +1)).toBe('intermediate');
    expect(stepLevel(READING_LEVELS, 'advanced', +1)).toBe('advanced');  // 上界钳制
    expect(stepLevel(READING_LEVELS, 'nope' as never, +1)).toBe('nope'); // 未知值原样返回
  });
});
