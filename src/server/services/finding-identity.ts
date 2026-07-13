import { createHash } from 'node:crypto';
import type {
  EnrichedLintFinding,
  LintFinding,
  SubjectId,
} from '@/lib/contracts';

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
  const canonicalTuple = [
    'lint-finding:v1',
    finding.subjectId,
    finding.type,
    finding.pageSlug,
    finding.sourceId ?? finding.sourceFilename ?? '',
    normalizeDescription(finding.description),
  ].join('\0');

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
