import { describe, it, expect } from 'vitest';
import { sortFindings, groupBySeverity, findingHref } from '../lint-findings';
import type { EnrichedLintFinding, LintFinding } from '@/lib/contracts';

function f(over: Partial<EnrichedLintFinding> = {}): EnrichedLintFinding {
  return {
    type: 'broken-link',
    severity: 'warning',
    pageSlug: 'page',
    description: 'd',
    suggestedFix: null,
    subjectId: 's1',
    subjectSlug: 'general',
    ...over,
  };
}

describe('sortFindings', () => {
  it('按 severity critical→warning→info，再按 type，再按 pageSlug', () => {
    const input = [
      f({ severity: 'info', type: 'orphan', pageSlug: 'b' }),
      f({ severity: 'critical', type: 'contradiction', pageSlug: 'z' }),
      f({ severity: 'warning', type: 'orphan', pageSlug: 'a' }),
      f({ severity: 'warning', type: 'orphan', pageSlug: 'b' }),
    ];
    const out = sortFindings(input);
    expect(out.map((x) => [x.severity, x.type, x.pageSlug])).toEqual([
      ['critical', 'contradiction', 'z'],
      ['warning', 'orphan', 'a'],
      ['warning', 'orphan', 'b'],
      ['info', 'orphan', 'b'],
    ]);
  });

  it('不修改原数组', () => {
    const input = [f({ severity: 'info' }), f({ severity: 'critical' })];
    const copy = [...input];
    sortFindings(input);
    expect(input).toEqual(copy);
  });
});

describe('groupBySeverity', () => {
  it('始终返回 critical/warning/info 三组固定顺序', () => {
    const groups = groupBySeverity([f({ severity: 'info' })]);
    expect(groups.map((g) => g.severity)).toEqual(['critical', 'warning', 'info']);
    expect(groups[0].findings).toEqual([]);
    expect(groups[2].findings).toHaveLength(1);
  });

  it('空输入返回三个空组', () => {
    const groups = groupBySeverity([]);
    expect(groups.every((g) => g.findings.length === 0)).toBe(true);
  });
});

describe('findingHref', () => {
  it('普通 finding 返回带 ?s= 的 wiki 深链', () => {
    expect(findingHref(f({ pageSlug: 'foo/bar', subjectSlug: 'general' }))).toBe(
      '/wiki/foo/bar?s=general',
    );
  });

  it('coverage-gap 返回 null（建议的新页不可点击）', () => {
    const cg: LintFinding['type'] = 'coverage-gap';
    expect(findingHref(f({ type: cg }))).toBeNull();
  });
});
