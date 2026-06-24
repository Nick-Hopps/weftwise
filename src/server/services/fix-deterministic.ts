/**
 * Fix service — 确定性修复纯函数 + findings 分桶。
 * 无 side effect（不触 DB / fs / LLM），便于单测。
 *   - missing-frontmatter → 确定性补齐必填字段。
 *   - broken-link / missing-crossref / contradiction → 交给 LLM 逐页修复（本文件只做分桶）。
 *   - orphan / stale-source / coverage-gap → 不修（ignored）。
 */
import { serializeFrontmatter, stampSystemFrontmatter } from '../wiki/frontmatter';
import type { LintFinding, WikiDocument, WikiFrontmatter } from '@/lib/contracts';

export const DETERMINISTIC_FIX_TYPES: ReadonlySet<LintFinding['type']> = new Set(['missing-frontmatter']);
export const LLM_FIX_TYPES: ReadonlySet<LintFinding['type']> = new Set([
  'broken-link',
  'missing-crossref',
  'contradiction',
]);

/**
 * 补齐一页缺失/非法的必填 frontmatter 字段。纯函数：now 由调用方传入。
 * title 为空 → 用 slug 兜底；时间戳/数组字段由 stampSystemFrontmatter 主理；正文逐字保留。
 */
export function fixMissingFrontmatter(slug: string, doc: WikiDocument, now: string): string {
  const fm = doc.frontmatter;
  const data: WikiFrontmatter = {
    ...fm,
    title: fm.title.trim() === '' ? slug : fm.title,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
    sources: Array.isArray(fm.sources) ? fm.sources : [],
  };
  return stampSystemFrontmatter(serializeFrontmatter(data, doc.body), {
    now,
    existingCreated: fm.created?.trim() ? fm.created : null,
  });
}

/** 按修复机制把 findings 分入三桶。 */
export function partitionFindings(findings: LintFinding[]): {
  frontmatter: LintFinding[];
  llm: LintFinding[];
  ignored: LintFinding[];
} {
  const frontmatter: LintFinding[] = [];
  const llm: LintFinding[] = [];
  const ignored: LintFinding[] = [];
  for (const finding of findings) {
    if (DETERMINISTIC_FIX_TYPES.has(finding.type)) frontmatter.push(finding);
    else if (LLM_FIX_TYPES.has(finding.type)) llm.push(finding);
    else ignored.push(finding);
  }
  return { frontmatter, llm, ignored };
}

/** 忠实度护栏：修复后正文相对原文塌缩超过阈值（默认 >50%）视为 LLM 丢内容，应拒绝。 */
export function bodyShrankTooMuch(originalBody: string, newBody: string, floor = 0.5): boolean {
  const before = originalBody.trim().length;
  if (before === 0) return false;
  return newBody.trim().length < before * floor;
}

/**
 * 合并工作清单：确定性新鲜重扫结果（missing-frontmatter / broken-link）∪ 快照语义结果
 * （missing-crossref / contradiction）。按 type+pageSlug+description 去重（保留同页多条不同 broken-link）。
 */
export function buildFixWorklist(deterministic: LintFinding[], semantic: LintFinding[]): LintFinding[] {
  const seen = new Set<string>();
  const out: LintFinding[] = [];
  for (const finding of [...deterministic, ...semantic]) {
    const key = `${finding.type}::${finding.pageSlug}::${finding.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finding);
  }
  return out;
}
