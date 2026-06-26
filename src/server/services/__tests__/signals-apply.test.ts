import { describe, it, expect, vi, beforeEach } from 'vitest';

const append = vi.fn();
const recent = vi.fn();
const getOrDefault = vi.fn();
const upsert = vi.fn();

vi.mock('@/server/db/repos/signals-repo', () => ({
  appendSignal: (...a: unknown[]) => append(...a),
  recentSignals: (...a: unknown[]) => recent(...a),
}));
vi.mock('@/server/db/repos/profiles-repo', () => ({
  getProfileOrDefault: (...a: unknown[]) => getOrDefault(...a),
  upsertProfile: (...a: unknown[]) => upsert(...a),
}));

beforeEach(() => {
  append.mockReset();
  recent.mockReset();
  getOrDefault.mockReset();
  upsert.mockReset();
});

const PREFS = { readingLevel: 'intermediate', verbosity: 'balanced', exampleDensity: 'some', formality: 'neutral' };

describe('applySignal', () => {
  it('未达阈值：append 但不 upsert', async () => {
    recent.mockReturnValue([{ type: 'too_hard' }]); // 1 条 < 阈值
    getOrDefault.mockReturnValue({ stylePrefs: PREFS, version: 3 });
    const { applySignal } = await import('../apply-signal');
    const r = applySignal('local', 'too_hard');
    expect(append).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
    expect(r.changed).toBe(false);
    expect(r.version).toBe(3);
  });

  it('达阈值：upsert 新画像，version 自增', async () => {
    recent.mockReturnValue([{ type: 'too_hard' }, { type: 'too_hard' }]);
    getOrDefault.mockReturnValue({ stylePrefs: PREFS, version: 3 });
    upsert.mockReturnValue({ version: 4 });
    const { applySignal } = await import('../apply-signal');
    const r = applySignal('local', 'too_hard');
    expect(upsert).toHaveBeenCalledOnce();
    expect(r.changed).toBe(true);
    expect(r.version).toBe(4);
  });
});
