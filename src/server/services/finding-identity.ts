import { createHash } from 'node:crypto';
import type {
  EnrichedLintFinding,
  LintFinding,
  SubjectId,
} from '@/lib/contracts';
import { normalizeSlug } from '../wiki/page-identity';

export type FindingIdentityInput = LintFinding & {
  subjectId: SubjectId;
  subjectSlug: string;
  id?: string;
};

function normalizeDescription(description: string): string {
  return description
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findingId(finding: FindingIdentityInput): string {
  let canonicalTuple: string;

  if (
    (finding.type === 'missing-crossref' || finding.type === 'coverage-gap')
    && typeof finding.targetSlug === 'string'
    && normalizeSlug(finding.targetSlug)
  ) {
    canonicalTuple = [
      'lint-finding:v2',
      finding.subjectId,
      finding.type,
      ...(finding.type === 'missing-crossref' ? [finding.pageSlug] : []),
      normalizeSlug(finding.targetSlug),
    ].join('\0');
  } else if (
    finding.type === 'contradiction'
    && Array.isArray(finding.evidence)
    && finding.evidence.length >= 2
  ) {
    const evidence = finding.evidence
      .map((item) => [item.pageSlug, normalizeDescription(item.quote)].join('\0'))
      .sort();
    canonicalTuple = [
      'lint-finding:v2',
      finding.subjectId,
      finding.type,
      ...evidence,
    ].join('\0');
  } else {
    canonicalTuple = [
      'lint-finding:v1',
      finding.subjectId,
      finding.type,
      finding.pageSlug,
      finding.sourceId ?? finding.sourceFilename ?? '',
      normalizeDescription(finding.description),
    ].join('\0');
  }

  return createHash('sha256').update(canonicalTuple).digest('hex');
}

export function identifyFindings(
  findings: FindingIdentityInput[],
): EnrichedLintFinding[] {
  const identified: EnrichedLintFinding[] = [];
  const seenIds = new Set<string>();

  for (const finding of findings) {
    const id = findingId(finding);
    if (seenIds.has(id)) continue;

    seenIds.add(id);
    identified.push({ ...finding, id });
  }

  return identified;
}
