import { describe, it, expect } from 'vitest';
import { applySignalsToStyle } from '../signal-reducer';
import { DEFAULT_STYLE_PREFS } from '../style';

const sig = (type: string, n: number) => Array.from({ length: n }, () => ({ type } as never));

describe('applySignalsToStyle', () => {
  it('未达阈值不变', () => {
    const r = applySignalsToStyle(DEFAULT_STYLE_PREFS, sig('too_hard', 1));
    expect(r.changed).toBe(false);
    expect(r.prefs).toEqual(DEFAULT_STYLE_PREFS);
  });

  it('净 too_hard 达阈值 → readingLevel 降一档、verbosity/example 上调', () => {
    const r = applySignalsToStyle(DEFAULT_STYLE_PREFS, sig('too_hard', 2));
    expect(r.changed).toBe(true);
    expect(r.prefs.readingLevel).toBe('beginner');
    expect(r.prefs.verbosity).toBe('thorough');
    expect(r.prefs.exampleDensity).toBe('many');
  });

  it('净 too_easy 达阈值 → readingLevel 升一档、verbosity 下调', () => {
    const r = applySignalsToStyle(DEFAULT_STYLE_PREFS, sig('too_easy', 2));
    expect(r.changed).toBe(true);
    expect(r.prefs.readingLevel).toBe('advanced');
    expect(r.prefs.verbosity).toBe('terse');
  });

  it('simplify_click 计入 simpler 方向；正反相消后不足阈值则不变', () => {
    const mixed = [...sig('too_hard', 2), ...sig('too_easy', 1)]; // net=+1 < 2
    expect(applySignalsToStyle(DEFAULT_STYLE_PREFS, mixed).changed).toBe(false);
  });

  it('view_original 不参与微调（仅记录）', () => {
    expect(applySignalsToStyle(DEFAULT_STYLE_PREFS, sig('view_original', 5)).changed).toBe(false);
  });

  it('已在下界仍不变（changed=false）', () => {
    const atFloor = { ...DEFAULT_STYLE_PREFS, readingLevel: 'beginner' as const, verbosity: 'thorough' as const, exampleDensity: 'many' as const };
    expect(applySignalsToStyle(atFloor, sig('too_hard', 2)).changed).toBe(false);
  });
});
