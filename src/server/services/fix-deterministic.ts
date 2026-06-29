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

// ── 全局上下文：关联页提取 + 诊断报告分组（纯函数）────────────────────────────

export const MAX_RELATED_PAGES = 4;
export const REPORT_DESC_MAX = 200;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 词边界整词匹配（大小写不敏感）；连字符视为词内字符，避免 react-hooks 命中 react-hooks-x */
function mentions(haystack: string, needle: string): boolean {
  const n = needle.trim();
  if (n.length === 0) return false;
  const re = new RegExp(`(?:^|[^\\w-])${escapeRegExp(n)}(?:[^\\w-]|$)`, 'i');
  return re.test(haystack);
}

/**
 * 从本页各 finding 的描述文本里启发式提取"关联页"slug（用于注入对方页正文）。
 * 匹配 roster 中任一页的 slug 或 title（词边界、大小写不敏感），排除自身。
 * contradiction 兜底：本页有 contradiction 却没匹到任何关联页时，纳入 contradictionPageSlugs
 * （service 从整个 worklist 预计算的"带 contradiction finding 的全部页"集合，仍排除自身）。
 * 去重、按出现顺序稳定，最多 MAX_RELATED_PAGES 个。
 */
export function findRelatedPageSlugs(
  pageSlug: string,
  findingsOnPage: { type: string; description: string; suggestedFix: string | null }[],
  roster: { slug: string; title: string }[],
  contradictionPageSlugs?: ReadonlySet<string>,
): string[] {
  const related: string[] = [];
  const seen = new Set<string>();
  const add = (slug: string) => {
    if (slug === pageSlug || seen.has(slug)) return;
    seen.add(slug);
    related.push(slug);
  };

  for (const finding of findingsOnPage) {
    const haystack = `${finding.description} ${finding.suggestedFix ?? ''}`;
    for (const r of roster) {
      if (r.slug === pageSlug) continue;
      if (mentions(haystack, r.slug) || mentions(haystack, r.title)) add(r.slug);
    }
  }

  const hasContradiction = findingsOnPage.some((f) => f.type === 'contradiction');
  if (hasContradiction && related.length === 0 && contradictionPageSlugs) {
    for (const slug of contradictionPageSlugs) add(slug);
  }

  return related.slice(0, MAX_RELATED_PAGES);
}

/**
 * 把整个工作清单按 pageSlug 分组成紧凑诊断报告数据（字符串渲染在 fix-prompt 层）。
 * 按首次出现保序；每条行格式 `<type>: <截断描述>`。
 */
export function buildSubjectReportLines(
  worklist: LintFinding[],
): { slug: string; lines: string[] }[] {
  const byPage = new Map<string, string[]>();
  const order: string[] = [];
  for (const finding of worklist) {
    if (!byPage.has(finding.pageSlug)) {
      byPage.set(finding.pageSlug, []);
      order.push(finding.pageSlug);
    }
    const desc =
      finding.description.length > REPORT_DESC_MAX
        ? `${finding.description.slice(0, REPORT_DESC_MAX)}…`
        : finding.description;
    byPage.get(finding.pageSlug)!.push(`${finding.type}: ${desc}`);
  }
  return order.map((slug) => ({ slug, lines: byPage.get(slug)! }));
}
