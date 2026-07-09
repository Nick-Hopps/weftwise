import { describe, it, expect, vi } from 'vitest';

vi.mock('../../jobs/worker', () => ({ registerHandler: vi.fn() }));

import { summarizeFindings } from '../lint-service';

describe('summarizeFindings', () => {
  it('按 severity 与 type 聚合并生成单行文案', () => {
    const res = summarizeFindings([
      { severity: 'critical', type: 'broken-link' },
      { severity: 'warning', type: 'broken-link' },
      { severity: 'warning', type: 'contradiction' },
    ] as never);
    expect(res.bySeverity).toEqual({ critical: 1, warning: 2 });
    expect(res.byType).toEqual({ 'broken-link': 2, contradiction: 1 });
    expect(res.text).toBe('1 critical, 2 warning; broken-link×2, contradiction×1');
  });

  it('空 findings 返回空文案', () => {
    const res = summarizeFindings([]);
    expect(res.bySeverity).toEqual({});
    expect(res.byType).toEqual({});
    expect(res.text).toBe('');
  });
});
