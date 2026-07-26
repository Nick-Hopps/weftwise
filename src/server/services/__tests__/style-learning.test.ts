import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockListStyleEvidence = vi.fn();
const mockGetProfile = vi.fn();
const mockUpsert = vi.fn();

vi.mock('@/server/db/repos/evidence-repo', () => ({
  listStyleEvidence: (...a: unknown[]) => mockListStyleEvidence(...a),
}));
vi.mock('@/server/db/repos/profiles-repo', () => ({
  getProfile: (...a: unknown[]) => mockGetProfile(...a),
  upsertProfile: (...a: unknown[]) => mockUpsert(...a),
}));

import { learnStyleFromEvidence } from '../style-learning';
import { DEFAULT_STYLE_PREFS } from '@/server/profile/style';

const PROFILE = {
  userId: 'local',
  backgroundSummary: '',
  stylePrefs: DEFAULT_STYLE_PREFS,
  version: 1,
  onboardedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  stylePrefsUpdatedAt: null as string | null,
};

const hard = () => ({
  kind: 'self-report-hard' as const,
  polarity: 'negative' as const,
  strength: 'strong' as const,
  anchor: null,
  createdAt: new Date().toISOString(),
});

beforeEach(() => {
  mockListStyleEvidence.mockReset().mockReturnValue([]);
  mockGetProfile.mockReset().mockReturnValue({ ...PROFILE });
  mockUpsert.mockReset().mockReturnValue({ version: 2 });
});

describe('learnStyleFromEvidence', () => {
  it('按消费边界取证据，不再裸取最近 N 条信号', () => {
    mockGetProfile.mockReturnValue({ ...PROFILE, stylePrefsUpdatedAt: '2026-07-01T00:00:00.000Z' });
    learnStyleFromEvidence('local');
    expect(mockListStyleEvidence).toHaveBeenCalledWith('local', '2026-07-01T00:00:00.000Z');
  });

  it('未达阈值不写画像', () => {
    mockListStyleEvidence.mockReturnValue([hard()]);
    expect(learnStyleFromEvidence('local')).toEqual({ changed: false, version: 1 });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('达阈值才 upsert，并回传新 version', () => {
    mockListStyleEvidence.mockReturnValue([hard(), hard()]);
    expect(learnStyleFromEvidence('local')).toEqual({ changed: true, version: 2 });
    expect(mockUpsert).toHaveBeenCalledWith('local', {
      stylePrefs: expect.objectContaining({ readingLevel: 'beginner' }),
    });
  });
});

describe('A6：尚无画像行的用户跳过 upsertProfile', () => {
  it('不写画像 —— 否则 version 涨到 1 而 onboardedAt 仍为 null，onboarding 弹窗会持续弹', () => {
    mockGetProfile.mockReturnValue(null);
    mockListStyleEvidence.mockReturnValue([hard(), hard()]);

    expect(learnStyleFromEvidence('local')).toEqual({ changed: false, version: 0 });
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('连证据都不读——没有画像可调，读了也没用', () => {
    mockGetProfile.mockReturnValue(null);
    learnStyleFromEvidence('local');
    expect(mockListStyleEvidence).not.toHaveBeenCalled();
  });
});
