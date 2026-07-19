import { createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  LintFinding,
  PostconditionFinding,
  PostconditionScope,
  Subject,
} from '@/lib/contracts';
import * as pagesRepo from '../db/repos/pages-repo';
import { getWikiLanguage } from '../db/repos/settings-repo';
import { generateStructuredOutput } from '../llm/provider-registry';
import { scanWikiPages } from '../wiki/wiki-store';

const SemanticDecisionSchema = z.object({
  decisions: z.array(
    z.object({
      findingId: z.string().length(64),
      status: z.enum(['resolved', 'residual']),
      reason: z.string().max(500),
    }),
  ),
});

type SemanticDecision = z.infer<typeof SemanticDecisionSchema>['decisions'][number];

export const MAX_SEMANTIC_RECHECK_FINDINGS = 40;
export const MAX_SEMANTIC_RECHECK_PAGES = 24;
export const MAX_SEMANTIC_PAGE_CHARS = 8_000;
export const MAX_SEMANTIC_PROMPT_CHARS = 120_000;

const FIX_POSTCONDITION_SYSTEM_PROMPT = `你是 Wiki 修复结果复检器。只判断输入中的原始 finding 在当前页面内容中是否已经解决。
不得提出新 finding，不得执行工具，不得把证据不足判断为 resolved。证据不足时返回 residual。`;

export interface FixSemanticPostconditionResult {
  status: 'clean' | 'residual' | 'failed';
  residualFindings: PostconditionFinding[];
  error: string | null;
}

export function semanticFindingId(
  finding: Pick<LintFinding, 'type' | 'pageSlug' | 'description'>,
): string {
  return createHash('sha256')
    .update(`${finding.type}\0${finding.pageSlug}\0${finding.description}`)
    .digest('hex');
}

function toResidualFinding(
  finding: LintFinding,
  reason?: string,
): PostconditionFinding {
  return {
    type: finding.type as 'contradiction' | 'missing-crossref',
    severity: finding.severity,
    pageSlug: finding.pageSlug,
    description: reason
      ? `${finding.description} 复检结果：${reason}`
      : finding.description,
  };
}

function failedResult(findings: LintFinding[]): FixSemanticPostconditionResult {
  return {
    status: 'failed',
    residualFindings: findings.map((finding) => toResidualFinding(finding)),
    error: 'Fix 语义后置复检未完成。',
  };
}

function buildPrompt(input: {
  subject: Subject;
  findings: LintFinding[];
  scope: PostconditionScope;
}): {
  prompt: string;
  requested: LintFinding[];
} {
  const cappedFindings = input.findings.slice(0, MAX_SEMANTIC_RECHECK_FINDINGS);
  const files = scanWikiPages(input.subject.slug);
  const fileBySlug = new Map(files.map((file) => [file.slug, file]));
  const allPageSlugs = pagesRepo.getAllPages(input.subject.id).map((page) => page.slug);

  const orderedSlugs = new Set<string>();
  for (const finding of cappedFindings) orderedSlugs.add(finding.pageSlug);
  for (const slug of input.scope.touchedSlugs) orderedSlugs.add(slug);
  for (const finding of cappedFindings) {
    for (const slug of allPageSlugs) {
      if (finding.description.includes(slug)) orderedSlugs.add(slug);
    }
  }

  const findingPayload = cappedFindings.map((finding) => ({
    findingId: semanticFindingId(finding),
    type: finding.type,
    severity: finding.severity,
    pageSlug: finding.pageSlug,
    description: finding.description.slice(0, 2_000),
  }));
  const basePayload = {
    language: getWikiLanguage().slice(0, 200),
    subject: {
      slug: input.subject.slug.slice(0, 200),
      name: input.subject.name.slice(0, 500),
      description: input.subject.description.slice(0, 2_000),
    },
    findings: findingPayload,
    pages: [] as Array<{ slug: string; content: string }>,
  };
  let remainingChars = Math.max(
    0,
    MAX_SEMANTIC_PROMPT_CHARS - JSON.stringify(basePayload).length,
  );

  for (const slug of orderedSlugs) {
    if (basePayload.pages.length >= MAX_SEMANTIC_RECHECK_PAGES) break;
    const file = fileBySlug.get(slug);
    if (!file || remainingChars <= 0) continue;
    const content = file.content.slice(
      0,
      Math.min(MAX_SEMANTIC_PAGE_CHARS, remainingChars),
    );
    basePayload.pages.push({ slug, content });
    remainingChars -= content.length;
  }

  const selectedPageSlugs = new Set(basePayload.pages.map((page) => page.slug));
  const requested = cappedFindings.filter((finding) =>
    selectedPageSlugs.has(finding.pageSlug),
  );
  const requestedIds = new Set(requested.map((finding) => semanticFindingId(finding)));
  basePayload.findings = basePayload.findings.filter((finding) =>
    requestedIds.has(finding.findingId),
  );

  let prompt = JSON.stringify(basePayload);
  while (prompt.length > MAX_SEMANTIC_PROMPT_CHARS && basePayload.pages.length > 0) {
    const lastPage = basePayload.pages.at(-1);
    if (!lastPage) break;
    const excess = prompt.length - MAX_SEMANTIC_PROMPT_CHARS;
    if (lastPage.content.length <= excess) {
      basePayload.pages.pop();
    } else {
      lastPage.content = lastPage.content.slice(0, lastPage.content.length - excess);
    }
    prompt = JSON.stringify(basePayload);
  }

  const finalPageSlugs = new Set(basePayload.pages.map((page) => page.slug));
  const finalRequested = requested.filter((finding) =>
    finalPageSlugs.has(finding.pageSlug),
  );
  const finalRequestedIds = new Set(
    finalRequested.map((finding) => semanticFindingId(finding)),
  );
  basePayload.findings = basePayload.findings.filter((finding) =>
    finalRequestedIds.has(finding.findingId),
  );

  return { prompt: JSON.stringify(basePayload), requested: finalRequested };
}

function mapDecisions(
  findings: LintFinding[],
  requested: LintFinding[],
  decisions: SemanticDecision[],
): PostconditionFinding[] {
  const requestedIds = new Set(requested.map((finding) => semanticFindingId(finding)));
  const decisionsById = new Map<string, SemanticDecision[]>();
  for (const decision of decisions) {
    if (!requestedIds.has(decision.findingId)) continue;
    const current = decisionsById.get(decision.findingId) ?? [];
    current.push(decision);
    decisionsById.set(decision.findingId, current);
  }

  const residual: PostconditionFinding[] = [];
  for (const finding of findings) {
    const id = semanticFindingId(finding);
    if (!requestedIds.has(id)) {
      residual.push(toResidualFinding(finding));
      continue;
    }
    const matches = decisionsById.get(id) ?? [];
    if (matches.length !== 1) {
      residual.push(toResidualFinding(finding));
      continue;
    }
    if (matches[0].status === 'residual') {
      residual.push(toResidualFinding(finding, matches[0].reason));
    }
  }
  return residual;
}

/** Fix 写后仅复检原语义 finding；任何不确定性都保守保留为 residual。 */
export async function recheckFixSemanticPostconditions(input: {
  subject: Subject;
  scope: PostconditionScope;
  findings: LintFinding[];
  shouldCancel: () => boolean;
}): Promise<FixSemanticPostconditionResult> {
  const semanticFindings = input.findings.filter(
    (finding) =>
      finding.type === 'contradiction' || finding.type === 'missing-crossref',
  );
  if (semanticFindings.length === 0 || input.scope.operationIds.length === 0) {
    return { status: 'clean', residualFindings: [], error: null };
  }
  if (input.shouldCancel()) return failedResult(semanticFindings);

  try {
    const { prompt, requested } = buildPrompt({
      subject: input.subject,
      findings: semanticFindings,
      scope: input.scope,
    });
    if (requested.length === 0) {
      return {
        status: 'residual',
        residualFindings: semanticFindings.map((finding) =>
          toResidualFinding(finding),
        ),
        error: null,
      };
    }

    const result = await generateStructuredOutput(
      'lint',
      SemanticDecisionSchema,
      FIX_POSTCONDITION_SYSTEM_PROMPT,
      prompt,
      {},
      { usageSubjectId: input.subject.id },
    );
    if (input.shouldCancel()) return failedResult(semanticFindings);

    const residualFindings = mapDecisions(
      semanticFindings,
      requested,
      result.decisions,
    );
    return {
      status: residualFindings.length === 0 ? 'clean' : 'residual',
      residualFindings,
      error: null,
    };
  } catch (error) {
    console.warn('[fix-postcondition] 语义复检失败', error);
    return failedResult(semanticFindings);
  }
}
