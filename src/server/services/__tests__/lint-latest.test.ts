import { describe, it, expect } from 'vitest';
import { selectLatestFindings } from '../lint-latest';
import type { Job } from '@/lib/contracts';

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    type: 'lint',
    status: 'completed',
    subjectId: 's1',
    paramsJson: '{}',
    resultJson: JSON.stringify({ findings: [] }),
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    completedAt: '2026-01-01T00:01:00.000Z',
    leaseExpiresAt: null,
    heartbeatAt: null,
    attemptCount: 0,
    ...over,
  };
}

const finding = (severity: 'critical' | 'warning' | 'info') => ({
  type: 'broken-link',
  severity,
  pageSlug: 'p',
  description: 'd',
  suggestedFix: null,
  subjectId: 's1',
  subjectSlug: 'general',
} as const);

describe('selectLatestFindings', () => {
  it('空列表返回空结构', () => {
    expect(selectLatestFindings([])).toEqual({
      jobId: null,
      ranAt: null,
      bySeverity: { critical: 0, warning: 0, info: 0 },
      findings: [],
    });
  });

  it('多个 completed job 取 completedAt 最新的一条', () => {
    const older = job({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = job({
      id: 'new',
      createdAt: '2026-02-01T00:00:00.000Z',
      completedAt: '2026-02-01T00:05:00.000Z',
      resultJson: JSON.stringify({
        findings: [finding('critical'), { ...finding('info'), pageSlug: 'p2' }],
      }),
    });
    const res = selectLatestFindings([older, newer]);
    expect(res.jobId).toBe('new');
    expect(res.ranAt).toBe('2026-02-01T00:05:00.000Z');
    expect(res.findings).toHaveLength(2);
    expect(res.bySeverity).toEqual({ critical: 1, warning: 0, info: 1 });
  });

  it('忽略乱序输入，按 completedAt 取最新', () => {
    const a = job({ id: 'a', completedAt: '2026-03-01T00:05:00.000Z' });
    const b = job({ id: 'b', completedAt: '2026-01-01T00:05:00.000Z' });
    expect(selectLatestFindings([a, b]).jobId).toBe('a');
  });

  it('completedAt 相同时按 id DESC 稳定决胜且不依赖输入顺序', () => {
    const a = job({ id: 'lint-a', completedAt: '2026-03-01T00:05:00.000Z' });
    const z = job({ id: 'lint-z', completedAt: '2026-03-01T00:05:00.000Z' });

    expect(selectLatestFindings([a, z]).jobId).toBe('lint-z');
    expect(selectLatestFindings([z, a]).jobId).toBe('lint-z');
  });

  it('忽略非 completed 的 job', () => {
    const running = job({ id: 'run', status: 'running', createdAt: '2026-09-01T00:00:00.000Z' });
    const done = job({ id: 'done', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(selectLatestFindings([running, done]).jobId).toBe('done');
  });

  it('resultJson 损坏时 findings 退化为空但保留 jobId', () => {
    const broken = job({ id: 'x', resultJson: 'not json' });
    const res = selectLatestFindings([broken]);
    expect(res.jobId).toBe('x');
    expect(res.findings).toEqual([]);
    expect(res.bySeverity).toEqual({ critical: 0, warning: 0, info: 0 });
  });

  it('resultJson 为 null 时 findings 为空但保留 jobId', () => {
    const nullResult = job({ id: 'nullres', resultJson: null });
    const res = selectLatestFindings([nullResult]);
    expect(res.jobId).toBe('nullres');
    expect(res.findings).toEqual([]);
    expect(res.bySeverity).toEqual({ critical: 0, warning: 0, info: 0 });
  });

  it('重新计算旧快照 finding ID，覆盖伪造 ID 并按规范 ID 去重', () => {
    const original = finding('warning');
    const legacy = job({
      id: 'legacy',
      resultJson: JSON.stringify({
        findings: [
          { ...original, id: 'forged-id' },
          { ...original, description: '  d\r\n\t' },
        ],
      }),
    });

    const res = selectLatestFindings([legacy]);

    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject({ ...original });
    expect(res.findings[0].id).toMatch(/^[0-9a-f]{64}$/);
    expect(res.findings[0].id).not.toBe('forged-id');
    expect(res.bySeverity).toEqual({ critical: 0, warning: 1, info: 0 });
  });

  it('混合快照逐项丢弃 description 非字符串的 finding，保留合法 finding', () => {
    const valid = finding('warning');
    const mixed = job({
      id: 'mixed',
      resultJson: JSON.stringify({
        findings: [valid, { ...valid, description: 42 }],
      }),
    });

    const res = selectLatestFindings([mixed]);

    expect(res.jobId).toBe('mixed');
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0]).toMatchObject(valid);
    expect(res.bySeverity).toEqual({ critical: 0, warning: 1, info: 0 });
  });

  it('兼容缺少语义证据的旧快照，并严格校验新可选字段', () => {
    const valid = {
      ...finding('warning'),
      type: 'missing-crossref',
      targetSlug: 'target',
      evidence: [{ pageSlug: 'p', quote: 'Target' }],
    } as const;
    const mixed = job({
      id: 'semantic-fields',
      resultJson: JSON.stringify({
        findings: [
          valid,
          { ...valid, pageSlug: 'legacy', targetSlug: undefined, evidence: undefined },
          { ...valid, targetSlug: 42 },
          { ...valid, evidence: [{ pageSlug: 'p', quote: 7 }] },
        ],
      }),
    });

    const result = selectLatestFindings([mixed]);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject(valid);
    expect(result.findings[1]?.pageSlug).toBe('legacy');
  });

  it('丢弃缺少必填字段的 finding', () => {
    const invalid = job({
      id: 'missing-required',
      resultJson: JSON.stringify({ findings: [{ description: 'only description' }] }),
    });

    expect(selectLatestFindings([invalid]).findings).toEqual([]);
  });

  it('丢弃 type 或 severity 非法的 finding', () => {
    const valid = finding('info');
    const invalid = job({
      id: 'invalid-enums',
      resultJson: JSON.stringify({
        findings: [
          { ...valid, type: 'unknown-type' },
          { ...valid, severity: 'urgent' },
        ],
      }),
    });

    expect(selectLatestFindings([invalid]).findings).toEqual([]);
  });

  it('丢弃可选来源字段类型非法的 finding', () => {
    const valid = finding('info');
    const invalid = job({
      id: 'invalid-optional',
      resultJson: JSON.stringify({
        findings: [
          { ...valid, sourceId: 1 },
          { ...valid, sourceFilename: false },
          { ...valid, failedJobId: 99 },
        ],
      }),
    });

    expect(selectLatestFindings([invalid]).findings).toEqual([]);
  });

  it('全部 finding 非法时返回空统计并保留 jobId', () => {
    const invalid = job({
      id: 'all-invalid',
      resultJson: JSON.stringify({
        findings: [null, [], { description: 'missing fields' }],
      }),
    });

    const res = selectLatestFindings([invalid]);

    expect(res.jobId).toBe('all-invalid');
    expect(res.findings).toEqual([]);
    expect(res.bySeverity).toEqual({ critical: 0, warning: 0, info: 0 });
  });
});
