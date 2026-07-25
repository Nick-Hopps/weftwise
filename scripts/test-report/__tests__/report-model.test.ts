import { describe, expect, it } from 'vitest';
import { aggregateCodeCoverage, buildReport, scanTestSource } from '../../test-report';

describe('test report model', () => {
  it('scans nested describe names and honors a feature override', () => {
    const tests = scanTestSource(
      '/repo/src/server/foo/__tests__/sample.test.ts',
      `// @feature: 检索功能\ndescribe('outer', () => { describe('inner', () => { it('works', () => {}); }); });`,
      '/repo',
    );

    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({ feature: '检索功能', title: 'works', ancestorTitles: ['outer', 'inner'], line: 2 });
  });

  it('groups execution results and keeps static cases that did not run', () => {
    const inventory = scanTestSource('/repo/src/lib/__tests__/sample.test.ts', `describe('math', () => { it('pass', () => {}); it('missing', () => {}); });`, '/repo');
    const report = buildReport(inventory, {
      testResults: [{
        name: '/repo/src/lib/__tests__/sample.test.ts',
        assertionResults: [{ ancestorTitles: ['math'], title: 'pass', status: 'passed', duration: 3.2 }],
      }],
    }, { rootDir: '/repo', runExitCode: 0 });

    expect(report.features).toHaveLength(1);
    expect(report.features[0]).toMatchObject({ discovered: 2, executed: 1, passed: 1, passRate: 1, caseCoverage: 0.5 });
    expect(Object.fromEntries(report.features[0].cases.map((test) => [test.title, test.status]))).toEqual({ pass: 'passed', missing: 'not-run' });
  });

  it('adds dynamic results and aggregates line coverage by the closest feature', () => {
    const inventory = scanTestSource('/repo/src/server/services/__tests__/sample.test.ts', `it('static', () => {});`, '/repo');
    const report = buildReport(inventory, {
      testResults: [{
        name: '/repo/src/server/services/__tests__/sample.test.ts',
        assertionResults: [
          { title: 'static', status: 'passed' },
          { title: 'dynamic', status: 'failed', failureMessages: ['boom'] },
        ],
      }],
    }, {
      rootDir: '/repo', runExitCode: 1,
      coverage: {
        '/repo/src/server/services/query-service.ts': { lines: { total: 10, covered: 7 } },
      },
    });

    expect(report.features[0].cases.some((test) => test.dynamicallyDiscovered && test.title === 'dynamic')).toBe(true);
    expect(report.features[0].codeCoverage).toMatchObject({ total: 10, covered: 7, percent: 0.7 });
    expect(aggregateCodeCoverage({ total: {}, '/repo/src/lib/a.ts': { lines: { total: 2, covered: 1 } } }, '/repo', ['lib'])).toEqual(
      new Map([['lib', { total: 2, covered: 1, percent: 0.5 }]]),
    );
  });
});
