import { describe, expect, it } from 'vitest';
import { renderHtml } from '../../test-report';

describe('test report html', () => {
  it('renders escaped test details and feature metrics', () => {
    const html = renderHtml({
      generatedAt: '2026-07-22T00:00:00.000Z',
      command: 'vitest run --reporter=json',
      runExitCode: 1,
      runOutput: 'failed output',
      features: [{
        name: 'server/services',
        discovered: 1,
        executed: 1,
        passed: 0,
        failed: 1,
        pending: 0,
        passRate: 0,
        caseCoverage: 1,
        codeCoverage: null,
        cases: [{
          id: 'x', feature: 'server/services', file: '/repo/a.ts', relativeFile: 'src/a.ts', title: '<bad>', ancestorTitles: ['suite'], line: 4,
          status: 'failed', durationMs: 1.2, failureMessages: ['<error>'],
        }],
      }],
      totals: { discovered: 1, executed: 1, passed: 0, failed: 1, pending: 0, passRate: 0, caseCoverage: 1, codeCoverage: null },
    });

    expect(html).toContain('server/services');
    expect(html).toContain('&lt;bad&gt;');
    expect(html).toContain('&lt;error&gt;');
    expect(html).toContain('Vitest 退出码为 1');
    expect(html).not.toContain('<bad>');
  });
});
