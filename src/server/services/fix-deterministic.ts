/**
 * Fix service — fix 的纯函数（无 I/O）。
 * - fixMissingFrontmatter() — 确定性补 frontmatter 必填字段。
 * - partitionFindings() / buildFixWorklist() — findings 分桶/合并。
 * - buildSubjectReportLines() — 诊断清单渲染。
 * - createFixGuard() — tool-loop 工具层硬护栏（写次数上限 + 保护页）。
 * 忠实度护栏已收编到 `wiki/rewrite-fidelity.ts::checkRewriteFidelity`（profile 'fix'），
 * 调用点见 `fix-tools.ts`，不在本文件重复实现。
 * broken-link / missing-crossref / contradiction 交给 **fix tool-loop** 修复（非逐页结构化输出）。
 * orphan / stale-source / coverage-gap / orphan-source / thin-page 不修（ignored 桶）。
 */
import { serializeFrontmatter, stampSystemFrontmatter } from '../wiki/frontmatter';
import { META_PAGE_SLUGS } from '../wiki/page-identity';
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

// ── 诊断报告分组（纯函数）────────────────────────────────────────────────────

export const REPORT_DESC_MAX = 200;

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

// ── fix tool-loop 工具层硬护栏 ────────────────────────────────────────────────

export interface FixGuard {
  canWrite(): { ok: boolean; reason?: string };
  canEditPage(slug: string): { ok: boolean; reason?: string };
  record(op: 'update' | 'create'): void;
  totals(): { update: number; create: number; writes: number };
}

/**
 * fix tool-loop 的工具层硬护栏：写次数 cap（runaway backstop）+ 保护页（不可改 index/log）。
 * fix 总是手动触发 → 无 seed 限制。忠实度（checkRewriteFidelity）在 fix-tools wrapper 把守（需现有正文，guard 不读盘）。
 */
export function createFixGuard(opts: { caps: { writes: number } }): FixGuard {
  const { caps } = opts;
  const counts = { update: 0, create: 0 };
  return {
    canWrite() {
      if (counts.update + counts.create >= caps.writes) return { ok: false, reason: `reached the limit of ${caps.writes} edits` };
      return { ok: true };
    },
    canEditPage(slug) {
      if (META_PAGE_SLUGS.has(slug)) return { ok: false, reason: 'cannot edit a protected page (index/log)' };
      return { ok: true };
    },
    record(op) { counts[op] += 1; },
    totals() { return { ...counts, writes: counts.update + counts.create }; },
  };
}
