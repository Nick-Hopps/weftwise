import { describe, expect, it, vi } from 'vitest';
import {
  fetchHealthSnapshot,
  parseHealthSnapshot,
} from '../health-snapshot';

const finding = {
  id: 'a'.repeat(64),
  subjectId: 's1',
  subjectSlug: 'general',
  type: 'broken-link',
  severity: 'warning',
  pageSlug: 'page-a',
  description: 'Broken link',
  suggestedFix: null,
};

const legacySnapshot = {
  jobId: 'lint-1',
  ranAt: '2026-07-13T12:00:00.000Z',
  bySeverity: { critical: 0, warning: 1, info: 0 },
  findings: [finding],
};

const fullSnapshot = {
  ...legacySnapshot,
  remediations: {
    [finding.id]: {
      findingId: finding.id,
      workflow: 'fix',
      status: 'awaiting-approval',
      actions: [
        {
          type: 'fix',
          label: 'Fix issue',
          destructive: false,
        },
      ],
      reason: 'Safe fix available.',
    },
  },
  recentOutcomes: { resolved: 'fixed' },
};

describe('parseHealthSnapshot', () => {
  it('兼容旧版 200 响应并补齐空处置字段', () => {
    expect(parseHealthSnapshot(legacySnapshot)).toEqual({
      ...legacySnapshot,
      remediations: {},
      recentOutcomes: {},
    });
    expect(legacySnapshot).not.toHaveProperty('remediations');
  });

  it('校验并保留完整 HealthSnapshot', () => {
    expect(parseHealthSnapshot(fullSnapshot)).toEqual(fullSnapshot);
  });

  it.each([
    ['null', null],
    ['数组', []],
    ['jobId 类型错误', { ...legacySnapshot, jobId: 1 }],
    ['ranAt 类型错误', { ...legacySnapshot, ranAt: 1 }],
    ['severity 计数非法', {
      ...legacySnapshot,
      bySeverity: { critical: 0, warning: -1, info: 0 },
    }],
    ['findings 非数组', { ...legacySnapshot, findings: {} }],
    ['finding 缺少稳定 ID', {
      ...legacySnapshot,
      findings: [{ ...finding, id: undefined }],
    }],
    ['finding 类型非法', {
      ...legacySnapshot,
      findings: [{ ...finding, type: 'unknown' }],
    }],
    ['remediations 非对象', { ...legacySnapshot, remediations: [] }],
    ['plan 状态非法', {
      ...fullSnapshot,
      remediations: {
        [finding.id]: {
          ...fullSnapshot.remediations[finding.id],
          status: 'unknown',
        },
      },
    }],
    ['action 结构非法', {
      ...fullSnapshot,
      remediations: {
        [finding.id]: {
          ...fullSnapshot.remediations[finding.id],
          actions: [{ type: 'fix', label: 'Fix', destructive: true }],
        },
      },
    }],
    ['recent outcome 非法', {
      ...fullSnapshot,
      recentOutcomes: { resolved: 'unknown' },
    }],
  ])('拒绝畸形响应：%s', (_name, value) => {
    expect(() => parseHealthSnapshot(value)).toThrow(/HealthSnapshot/);
  });
});

describe('fetchHealthSnapshot', () => {
  it('非 2xx 响应抛出带 status 的错误', async () => {
    const apiFetch = vi.fn(async () => new Response('Unauthorized', { status: 401 }));

    await expect(fetchHealthSnapshot(apiFetch, '/api/lint/latest')).rejects
      .toMatchObject({ status: 401 });
  });

  it('有效响应经运行时解析后返回', async () => {
    const apiFetch = vi.fn(async () => Response.json(fullSnapshot));

    await expect(fetchHealthSnapshot(apiFetch, '/api/lint/latest')).resolves
      .toEqual(fullSnapshot);
  });

  it('200 畸形对象进入错误态', async () => {
    const apiFetch = vi.fn(async () => Response.json({ ok: true }));

    await expect(fetchHealthSnapshot(apiFetch, '/api/lint/latest')).rejects
      .toThrow(/HealthSnapshot/);
  });

  it('200 非法 JSON 进入错误态', async () => {
    const apiFetch = vi.fn(async () => new Response('{', { status: 200 }));

    await expect(fetchHealthSnapshot(apiFetch, '/api/lint/latest')).rejects
      .toBeInstanceOf(SyntaxError);
  });
});
