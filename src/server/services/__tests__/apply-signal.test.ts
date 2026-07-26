import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockAppendSignal = vi.fn();
const mockAppendEvidence = vi.fn();
const mockListStyleEvidence = vi.fn();
const mockGetProfile = vi.fn();
const mockGetProfileOrDefault = vi.fn();
const mockUpsert = vi.fn();

vi.mock('@/server/db/repos/signals-repo', () => ({
  appendSignal: (...a: unknown[]) => mockAppendSignal(...a),
}));
vi.mock('@/server/db/repos/evidence-repo', () => ({
  appendEvidence: (...a: unknown[]) => mockAppendEvidence(...a),
  listStyleEvidence: (...a: unknown[]) => mockListStyleEvidence(...a),
}));
vi.mock('@/server/db/repos/profiles-repo', () => ({
  getProfile: (...a: unknown[]) => mockGetProfile(...a),
  getProfileOrDefault: (...a: unknown[]) => mockGetProfileOrDefault(...a),
  upsertProfile: (...a: unknown[]) => mockUpsert(...a),
}));

import { applySignal } from '../apply-signal';
import { DEFAULT_STYLE_PREFS } from '@/server/profile/style';

const CTX = { subjectId: 's1', slug: 'backprop' };

const PROFILE = {
  userId: 'local',
  backgroundSummary: '',
  stylePrefs: DEFAULT_STYLE_PREFS,
  version: 1,
  onboardedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  stylePrefsUpdatedAt: null as string | null,
};

const hard = (createdAt: string) => ({
  kind: 'self-report-hard' as const,
  polarity: 'negative' as const,
  strength: 'strong' as const,
  anchor: null,
  createdAt,
});

beforeEach(() => {
  mockAppendSignal.mockReset();
  mockAppendEvidence.mockReset();
  mockListStyleEvidence.mockReset().mockReturnValue([]);
  mockGetProfile.mockReset().mockReturnValue({ ...PROFILE });
  mockGetProfileOrDefault.mockReset().mockReturnValue({ ...PROFILE, version: 0 });
  mockUpsert.mockReset().mockReturnValue({ version: 2 });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('applySignal 写入路径', () => {
  it('style-bearing 信号写一份 page_evidence', () => {
    applySignal('local', 'too_hard', CTX);
    expect(mockAppendEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'local', subjectId: 's1', slug: 'backprop', kind: 'self-report-hard' }),
    );

    mockAppendEvidence.mockClear();
    applySignal('local', 'too_easy', CTX);
    expect(mockAppendEvidence).toHaveBeenCalledWith(expect.objectContaining({ kind: 'self-report-easy' }));
  });

  it('并存期仍写 profile_signals（三步替换：已切读，未删旧）', () => {
    applySignal('local', 'too_hard', CTX);
    expect(mockAppendSignal).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'local', type: 'too_hard', slug: 'backprop' }),
    );
  });

  it('非 style-bearing 信号只进旧表，不产生证据', () => {
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
    expect(mockAppendEvidence).not.toHaveBeenCalled();
  });

  it('证据写入失败不影响主流程与返回值', () => {
    mockAppendEvidence.mockImplementation(() => { throw new Error('db locked'); });
    mockListStyleEvidence.mockReturnValue([hard(new Date().toISOString()), hard(new Date().toISOString())]);
    expect(applySignal('local', 'too_hard', CTX)).toEqual({ changed: true, version: 2 });
  });
});

describe('applySignal 读取路径已切到证据流', () => {
  it('按消费边界取证据，不再裸取最近 N 条信号', () => {
    mockGetProfile.mockReturnValue({ ...PROFILE, stylePrefsUpdatedAt: '2026-07-01T00:00:00.000Z' });
    applySignal('local', 'too_hard', CTX);
    expect(mockListStyleEvidence).toHaveBeenCalledWith('local', '2026-07-01T00:00:00.000Z');
  });

  it('未达阈值不写画像', () => {
    mockListStyleEvidence.mockReturnValue([hard(new Date().toISOString())]);
    expect(applySignal('local', 'too_hard', CTX)).toEqual({ changed: false, version: 1 });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('达阈值才 upsert，并回传新 version', () => {
    const now = new Date().toISOString();
    expect(mockListStyleEvidence).toBeDefined();
    mockListStyleEvidence.mockReturnValue([hard(now), hard(now)]);
    expect(applySignal('local', 'too_hard', CTX)).toEqual({ changed: true, version: 2 });
    expect(mockUpsert).toHaveBeenCalledWith('local', {
      stylePrefs: expect.objectContaining({ readingLevel: 'beginner' }),
    });
  });
});

describe('A6：尚无画像行的用户只落证据，跳过 upsertProfile', () => {
  it('不写画像 —— 否则 version 涨到 1 而 onboardedAt 仍为 null，onboarding 弹窗会持续弹', () => {
    mockGetProfile.mockReturnValue(null);
    const now = new Date().toISOString();
    mockListStyleEvidence.mockReturnValue([hard(now), hard(now)]);

    const result = applySignal('local', 'too_hard', CTX);

    expect(mockUpsert).not.toHaveBeenCalled();
    expect(result).toEqual({ changed: false, version: 0 });
  });

  it('证据不丢：仍然落库，等用户完成 onboarding 后由 reducer 自然消费', () => {
    mockGetProfile.mockReturnValue(null);
    applySignal('local', 'too_hard', CTX);
    expect(mockAppendEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'self-report-hard' }),
    );
  });
});
