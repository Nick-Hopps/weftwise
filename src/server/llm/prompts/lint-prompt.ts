import { z } from 'zod';

// ── Schema ────────────────────────────────────────────────────────────────────

export const LintResultSchema = z.object({
  findings: z.array(
    z.object({
      type: z
        .enum(['contradiction', 'missing-crossref', 'coverage-gap'])
        .describe(
          'contradiction: two pages state incompatible facts; ' +
          'missing-crossref: a page mentions a concept that has its own page but no wikilink; ' +
          'coverage-gap: an important topic is referenced but has no dedicated page',
        ),
      severity: z.enum(['critical', 'warning', 'info']),
      pageSlug: z
        .string()
        .describe('Slug of the page where the issue was detected'),
      description: z
        .string()
        .describe(
          'Clear, specific description of the issue. For contradictions, ' +
          'quote both conflicting statements and name both pages.',
        ),
      suggestedFix: z
        .string()
        .nullable()
        .describe(
          'Concrete suggestion for how to resolve the issue, or null if no ' +
          'fix is applicable',
        ),
    }),
  ),
});

export type LintResult = z.infer<typeof LintResultSchema>;

// ── System prompt ─────────────────────────────────────────────────────────────

export const LINT_SYSTEM_PROMPT = `You are a senior wiki editor performing a quality audit on a personal knowledge base.

## Your role
Carefully review the provided wiki pages and identify quality issues. Focus on three categories:

### 1. Contradictions (most important — WikiContradict-level scrutiny)
- Read every factual claim across all pages.
- Flag ANY pair of claims that are logically incompatible, even subtly:
  - Different dates for the same event
  - Contradictory technical specifications
  - Conflicting definitions of the same term
  - One page says X is true; another page says X is false
- Severity: critical if the contradiction could mislead the reader; warning for minor discrepancies.
- Always quote BOTH conflicting statements in the description and name both page slugs.

### 2. Missing cross-references
- If a page mentions a concept, person, tool, or topic that has its own wiki page in **the same subject** but does NOT use a [[wikilink]], flag it.
- Do not flag concepts whose dedicated page lives in a different subject — cross-subject linkage is the user's call.
- Severity: warning for important concepts; info for peripheral mentions.

### 3. Coverage gaps
- If multiple pages in the same subject reference a concept that clearly deserves its own page but none exists, flag it.
- Severity: warning for frequently referenced concepts; info for minor ones.

## Subject scoping
- The pages provided in a single batch all belong to the same subject. Compare claims only within this batch.
- Do NOT raise findings about pages or subjects not shown in the batch.

## Output rules
- Be thorough: it is better to flag a false positive than to miss a real issue.
- Contradictions are the highest priority. Spend most effort here.
- Do not flag stylistic preferences (e.g., heading capitalisation) — only semantic issues.
- If there are no issues, return an empty findings array.`;

// ── User prompt builder ───────────────────────────────────────────────────────

export interface SubjectContext {
  slug: string;
  name: string;
  description?: string;
}

export function buildLintUserPrompt(
  pages: { slug: string; title: string; content: string }[],
  subject?: SubjectContext,
): string {
  if (pages.length === 0) {
    return 'No wiki pages provided. Return an empty findings array.';
  }

  const pagesSection = pages
    .map(
      (p) =>
        `### [[${p.title}]] (slug: \`${p.slug}\`)\n${p.content.slice(0, 10_000)}`,
    )
    .join('\n\n---\n\n');

  const subjectSection = subject
    ? `## Active subject (workspace)
- **Name**: ${subject.name}
- **Slug**: \`${subject.slug}\`
${subject.description?.trim() ? `- **Description**: ${subject.description.trim()}\n` : ''}
All pages below belong to this subject. Compare claims only within this set.

`
    : '';

  return `${subjectSection}Please audit the following wiki pages for contradictions, missing cross-references, and coverage gaps.

## Wiki pages under review

${pagesSection}

---

Review each page carefully, comparing claims across all pages. Pay special attention to any statements that might contradict each other. Return your findings.`;
}
