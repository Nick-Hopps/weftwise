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

  it('多个 completed job 取 createdAt 最新的一条', () => {
    const older = job({ id: 'old', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = job({
      id: 'new',
      createdAt: '2026-02-01T00:00:00.000Z',
      completedAt: '2026-02-01T00:05:00.000Z',
      resultJson: JSON.stringify({ findings: [finding('critical'), finding('info')] }),
    });
    const res = selectLatestFindings([older, newer]);
    expect(res.jobId).toBe('new');
    expect(res.ranAt).toBe('2026-02-01T00:05:00.000Z');
    expect(res.findings).toHaveLength(2);
    expect(res.bySeverity).toEqual({ critical: 1, warning: 0, info: 1 });
  });

  it('忽略乱序输入，仍按时间取最新', () => {
    const a = job({ id: 'a', createdAt: '2026-03-01T00:00:00.000Z' });
    const b = job({ id: 'b', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(selectLatestFindings([a, b]).jobId).toBe('a');
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
});
