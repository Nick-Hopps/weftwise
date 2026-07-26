import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAppendSignal = vi.fn();
const mockRecentSignals = vi.fn();
const mockAppendEvidence = vi.fn();
const mockGetProfile = vi.fn();
const mockUpsert = vi.fn();

vi.mock('@/server/db/repos/signals-repo', () => ({
  appendSignal: (...a: unknown[]) => mockAppendSignal(...a),
  recentSignals: (...a: unknown[]) => mockRecentSignals(...a),
}));
vi.mock('@/server/db/repos/evidence-repo', () => ({
  appendEvidence: (...a: unknown[]) => mockAppendEvidence(...a),
}));
vi.mock('@/server/db/repos/profiles-repo', () => ({
  getProfileOrDefault: (...a: unknown[]) => mockGetProfile(...a),
  upsertProfile: (...a: unknown[]) => mockUpsert(...a),
}));

import { applySignal } from '../apply-signal';

const CTX = { subjectId: 's1', slug: 'backprop' };

beforeEach(() => {
  mockAppendSignal.mockReset();
  mockRecentSignals.mockReset().mockReturnValue([]);
  mockAppendEvidence.mockReset();
  mockGetProfile.mockReset().mockReturnValue({ stylePrefs: {}, version: 1 });
  mockUpsert.mockReset().mockReturnValue({ version: 2 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('applySignal 并存期双写', () => {
  it('继续写 profile_signals（reducer 此时仍读旧表，行为不变）', () => {
    applySignal('local', 'too_hard', CTX);
    expect(mockAppendSignal).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'local', type: 'too_hard', slug: 'backprop' }),
    );
  });

  it('同时把 style-bearing 信号写一份 page_evidence', () => {
    applySignal('local', 'too_hard', CTX);
    expect(mockAppendEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'local',
        subjectId: 's1',
        slug: 'backprop',
        kind: 'self-report-hard',
      }),
    );

    mockAppendEvidence.mockClear();
    applySignal('local', 'too_easy', CTX);
    expect(mockAppendEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'self-report-easy' }),
    );
  });

  it('非 style-bearing 信号只进旧表，不产生证据', () => {
    // view_original 是归因埋点，不是「讲法太难/太浅」——它进不了掌握度语义，
    // 也不该在证据表里占一行。simplify/deepen 同理（入口本就从未实现）。
    for (const type of ['view_original', 'simplify_click', 'deepen_click'] as const) {
      applySignal('local', type, CTX);
    }
    expect(mockAppendSignal).toHaveBeenCalledTimes(3);
    expect(mockAppendEvidence).not.toHaveBeenCalled();
  });

  it('缺 subjectId 或 slug 时不写证据（证据必须能归属到确定的页）', () => {
    applySignal('local', 'too_hard', { subjectId: null, slug: 'backprop' });
    applySignal('local', 'too_hard', { subjectId: 's1', slug: null });
    applySignal('local', 'too_hard');
    expect(mockAppendSignal).toHaveBeenCalledTimes(3);
    expect(mockAppendEvidence).not.toHaveBeenCalled();
  });

  it('证据写入失败不影响信号主流程与返回值', () => {
    mockAppendEvidence.mockImplementation(() => { throw new Error('db locked'); });
    mockRecentSignals.mockReturnValue([{ type: 'too_hard' }, { type: 'too_hard' }]);
    mockGetProfile.mockReturnValue({
      stylePrefs: {
        readingLevel: 'advanced', verbosity: 'terse', exampleDensity: 'few', formality: 'neutral',
      },
      version: 1,
    });
    const result = applySignal('local', 'too_hard', CTX);
    expect(result).toEqual({ changed: true, version: 2 });
  });
});
