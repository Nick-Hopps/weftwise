import type { LintFinding, LintFindingEvidence } from '@/lib/contracts';
import type { LintResult } from '../llm/prompts/lint-prompt';
import { normalizeSlug } from '../wiki/page-identity';
import { extractWikiLinks } from '../wiki/wikilinks';

export interface SemanticValidationPage {
  slug: string;
  title: string;
  content: string;
}

function buildPageResolver(
  pages: SemanticValidationPage[],
  knownNames?: ReadonlyMap<string, string>,
) {
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const slugByName = new Map<string, string>();

  for (const page of pages) {
    slugByName.set(normalizeSlug(page.slug), page.slug);
    slugByName.set(normalizeSlug(page.title), page.slug);
  }
  for (const [name, slug] of knownNames ?? []) {
    if (bySlug.has(slug)) slugByName.set(normalizeSlug(name), slug);
  }

  const resolve = (value: string): string | undefined => {
    const direct = bySlug.has(value) ? value : undefined;
    return direct ?? slugByName.get(normalizeSlug(value));
  };

  return { bySlug, resolve };
}

function validateEvidence(
  evidence: LintResult['findings'][number]['evidence'],
  pages: Map<string, SemanticValidationPage>,
  resolve: (value: string) => string | undefined,
): LintFindingEvidence[] | null {
  const validated: LintFindingEvidence[] = [];

  for (const item of evidence) {
    const pageSlug = resolve(item.pageSlug);
    const quote = item.quote.trim();
    if (!pageSlug) return null;
    const page = pages.get(pageSlug);
    if (!page || quote.length === 0 || !page.content.includes(quote)) return null;
    validated.push({ pageSlug, quote });
  }

  return validated;
}

/** 只接受能由当前 vault 页面与 wikilink 事实直接证明的语义 finding。 */
export function validateSemanticFindings(
  findings: LintResult['findings'],
  pages: SemanticValidationPage[],
  subjectSlug: string,
  knownNames?: ReadonlyMap<string, string>,
): LintFinding[] {
  const { bySlug, resolve } = buildPageResolver(pages, knownNames);
  const validated: LintFinding[] = [];

  for (const finding of findings) {
    const pageSlug = resolve(finding.pageSlug);
    if (!pageSlug) continue;

    const evidence = validateEvidence(finding.evidence, bySlug, resolve);
    if (!evidence) continue;

    if (finding.type === 'missing-crossref') {
      if (!finding.targetSlug) continue;
      const targetSlug = resolve(finding.targetSlug);
      if (!targetSlug || targetSlug === pageSlug) continue;
      if (!evidence.some((item) => item.pageSlug === pageSlug)) continue;

      const source = bySlug.get(pageSlug);
      if (!source) continue;
      const links = extractWikiLinks(source.content, {
        currentSubjectSlug: subjectSlug,
        titleResolver: (title, targetSubjectSlug) => (
          targetSubjectSlug === subjectSlug ? resolve(title) : undefined
        ),
      });
      if (links.some((link) => (
        link.targetSubjectSlug === subjectSlug && link.target === targetSlug
      ))) continue;

      validated.push({
        ...finding,
        pageSlug,
        targetSlug,
        evidence,
      });
      continue;
    }

    if (finding.type === 'coverage-gap') {
      if (!finding.targetSlug) continue;
      const targetSlug = normalizeSlug(finding.targetSlug);
      if (!targetSlug || resolve(targetSlug)) continue;
      if (new Set(evidence.map((item) => item.pageSlug)).size < 2) continue;

      validated.push({
        ...finding,
        pageSlug,
        targetSlug,
        evidence,
      });
      continue;
    }

    if (new Set(evidence.map((item) => item.pageSlug)).size < 2) continue;
    validated.push({
      ...finding,
      pageSlug,
      targetSlug: undefined,
      evidence,
    });
  }

  return validated;
}
