/**
 * re-enrich supplement 阶段的确定性忠实度护栏（纯函数，易单测）。
 * 因允许「插入 + 局部改写」，无法逐字保证不动原文，改用软性组合护栏：
 *   不大幅缩水 + 章节标题不减 + 不臆造 wikilink 目标 + frontmatter 不变。
 */
import { bodyShrankTooMuch } from '@/server/services/fix-deterministic';
import { checkLinkSubset } from '@/server/profile/fidelity';
import { parseFrontmatter } from '@/server/wiki/frontmatter';

export const SUPPLEMENT_SHRINK_FLOOR = 0.95;

const HEADING_RE = /^#{1,6}\s+.*$/gm;

/** 原文的每一行标题（含级别与文字）都必须在候选正文中原样出现。 */
export function headingsPreserved(originalBody: string, candidateBody: string): boolean {
  const orig = originalBody.match(HEADING_RE) ?? [];
  const cand = new Set((candidateBody.match(HEADING_RE) ?? []).map((h) => h.trim()));
  return orig.every((h) => cand.has(h.trim()));
}

/** frontmatter 数据对象深度相等（JSON 规范序列化比对，key 顺序无关）。 */
export function frontmatterUnchanged(originalContent: string, candidateContent: string): boolean {
  const a = parseFrontmatter(originalContent).data;
  const b = parseFrontmatter(candidateContent).data;
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
      : val,
  );
}

/**
 * 组合护栏：返回是否通过 + 违规项列表（供 runPageSupplement 重写反馈）。
 * body 从 frontmatter 之后取，链接/缩水/标题都在 body 上判定。
 */
export function checkSupplementFidelity(
  originalContent: string,
  candidateContent: string,
): { ok: boolean; violations: string[] } {
  const origBody = parseFrontmatter(originalContent).body;
  const candBody = parseFrontmatter(candidateContent).body;
  const violations: string[] = [];

  if (bodyShrankTooMuch(origBody, candBody, SUPPLEMENT_SHRINK_FLOOR)) {
    violations.push(`body shrank below ${SUPPLEMENT_SHRINK_FLOOR} of original — you deleted prose; only insert or minimally rewrite`);
  }
  const link = checkLinkSubset(origBody, candBody);
  if (!link.ok) {
    violations.push(`invented new wikilink target(s): ${link.offending.join(', ')} — do not add new links (leave cross-links to the enricher)`);
  }
  if (!headingsPreserved(origBody, candBody)) {
    violations.push('a section heading was removed or altered — keep all original headings verbatim');
  }
  if (!frontmatterUnchanged(originalContent, candidateContent)) {
    violations.push('frontmatter changed — never touch frontmatter');
  }
  return { ok: violations.length === 0, violations };
}
