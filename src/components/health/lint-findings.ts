import type { EnrichedLintFinding, LintFinding } from '@/lib/contracts';

export const SEVERITY_TONE: Record<LintFinding['severity'], 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  warning: 'warning',
  info: 'neutral',
};

const SEVERITY_ORDER: Record<LintFinding['severity'], number> = {
  critical: 0,
  warning: 1,
  info: 2,
};

const SEVERITIES: LintFinding['severity'][] = ['critical', 'warning', 'info'];

export function sortFindings(findings: EnrichedLintFinding[]): EnrichedLintFinding[] {
  return [...findings].sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    const t = a.type.localeCompare(b.type);
    if (t !== 0) return t;
    return a.pageSlug.localeCompare(b.pageSlug);
  });
}

export function groupBySeverity(
  findings: EnrichedLintFinding[],
): { severity: LintFinding['severity']; findings: EnrichedLintFinding[] }[] {
  const sorted = sortFindings(findings);
  return SEVERITIES.map((severity) => ({
    severity,
    findings: sorted.filter((f) => f.severity === severity),
  }));
}

export function findingHref(f: EnrichedLintFinding): string | null {
  // coverage-gap 指向尚不存在的建议新页；orphan-source 无对应页面 —— 均不可点击
  if (f.type === 'coverage-gap' || f.type === 'orphan-source') return null;
  return `/wiki/${f.pageSlug}?s=${encodeURIComponent(f.subjectSlug)}`;
}
