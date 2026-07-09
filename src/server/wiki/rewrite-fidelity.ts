/**
 * 统一保真护栏（T1.4）。
 * 四条"LLM 改写既有正文"路径（ingest merge-update / fix / reshape / re-enrich supplement）
 * 共用同一套确定性检查体，阈值集中在 FIDELITY_PROFILES，避免各路径各写一份、标准漂移。
 *
 * 检查项（每项由 profile 开关控制）：
 * - 长度：剥离 frontmatter 后的正文字符数，revised/original 不得低于 minLengthRatio。
 * - 链接：wikilink 目标集合（复用 wikilinks.ts::extractWikiLinks 单一真实源）。
 *   - 'preserve'：original 的目标集合 ⊆ revised（改写不得丢链接）。
 *   - 'subset'：revised 的目标集合 ⊆ original（改写不得臆造链接）。
 *   - 'none'：不检查。
 * - heading：original 的 `#{1,6} ` 标题文本集合 ⊆ revised（允许新增，不允许丢失）。
 * - frontmatter：解析后的对象深度相等（key 顺序无关）。
 */
import { extractWikiLinks } from './wikilinks';
import { parseFrontmatter } from './frontmatter';

export interface FidelityProfile {
  /** revised/original 正文长度下限（剥离 frontmatter 后）。 */
  minLengthRatio: number;
  /** 'preserve'：original 链接 ⊆ revised；'subset'：revised 链接 ⊆ original；'none'：不检查。 */
  linkRule: 'preserve' | 'subset' | 'none';
  /** true：original 的 heading 文本集合必须 ⊆ revised（允许新增，不允许丢失）。 */
  preserveHeadings: boolean;
  /** true：frontmatter 解析后的对象须深度相等。 */
  preserveFrontmatter: boolean;
}

export const FIDELITY_PROFILES = {
  supplement: { minLengthRatio: 0.95, linkRule: 'preserve', preserveHeadings: true, preserveFrontmatter: true },
  'merge-update': { minLengthRatio: 0.85, linkRule: 'preserve', preserveHeadings: true, preserveFrontmatter: false },
  fix: { minLengthRatio: 0.8, linkRule: 'preserve', preserveHeadings: false, preserveFrontmatter: false },
  reshape: { minLengthRatio: 0.8, linkRule: 'subset', preserveHeadings: false, preserveFrontmatter: true },
} as const satisfies Record<string, FidelityProfile>;

export type FidelityProfileName = keyof typeof FIDELITY_PROFILES;

export interface RewriteFidelityOptions {
  /**
   * 'preserve' 规则的例外集合：这些 targetKey（`${targetSubjectSlug}:${targetSlug}`，
   * 由 collectMissingLinkTargets 用同一套 key 派生）允许被改写丢弃——调用方须先确认
   * 它们确实是断链（目标页不存在）。活链保护不受影响。
   */
  allowedDroppedTargets?: ReadonlySet<string>;
}

const HEADING_RE = /^#{1,6}\s+.*$/gm;

function targetKey(l: { targetSubjectSlug: string; target: string }): string {
  return `${l.targetSubjectSlug}:${l.target}`;
}

function linkTargets(body: string): Set<string> {
  return new Set(extractWikiLinks(body).map(targetKey));
}

function headingsOf(body: string): string[] {
  return (body.match(HEADING_RE) ?? []).map((h) => h.trim());
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)),
        )
      : val,
  );
}

/**
 * 校验一次"改写"是否保真。original/revised 允许是纯正文，也允许是带 frontmatter 的完整内容——
 * 两者都先经 parseFrontmatter 剥离，长度/链接/heading 一律在 body 上比较。
 */
/**
 * 收集正文中"目标页不存在"的 wikilink targetKey 集合（与 preserve 检查同一 key 派生），
 * 供作 checkRewriteFidelity 的 allowedDroppedTargets——存在性判定经 pageExists 注入，
 * 本函数保持纯函数。
 */
export function collectMissingLinkTargets(
  body: string,
  pageExists: (targetSubjectSlug: string, targetSlug: string) => boolean,
): Set<string> {
  const missing = new Set<string>();
  for (const link of extractWikiLinks(body)) {
    if (!pageExists(link.targetSubjectSlug, link.target)) missing.add(targetKey(link));
  }
  return missing;
}

export function checkRewriteFidelity(
  original: string,
  revised: string,
  profile: FidelityProfile,
  options?: RewriteFidelityOptions,
): { ok: boolean; violations: string[] } {
  const origParsed = parseFrontmatter(original);
  const revParsed = parseFrontmatter(revised);
  const origBody = origParsed.body;
  const revBody = revParsed.body;
  const violations: string[] = [];

  const before = origBody.trim().length;
  if (before > 0 && revBody.trim().length < before * profile.minLengthRatio) {
    violations.push(
      `body shrank below ${profile.minLengthRatio} of original length (${revBody.trim().length}/${before})`,
    );
  }

  if (profile.linkRule === 'preserve') {
    const origLinks = linkTargets(origBody);
    const revLinks = linkTargets(revBody);
    const allowed = options?.allowedDroppedTargets;
    const missing = [...origLinks].filter((t) => !revLinks.has(t) && !allowed?.has(t));
    if (missing.length > 0) {
      violations.push(`dropped existing wikilink target(s): ${missing.join(', ')}`);
    }
  } else if (profile.linkRule === 'subset') {
    const origLinks = linkTargets(origBody);
    const revLinks = linkTargets(revBody);
    const invented = [...revLinks].filter((t) => !origLinks.has(t));
    if (invented.length > 0) {
      violations.push(`invented new wikilink target(s): ${invented.join(', ')}`);
    }
  }

  if (profile.preserveHeadings) {
    const origHeadings = headingsOf(origBody);
    const revHeadings = new Set(headingsOf(revBody));
    const missing = origHeadings.filter((h) => !revHeadings.has(h));
    if (missing.length > 0) {
      violations.push(`removed or altered section heading(s): ${missing.join(', ')}`);
    }
  }

  if (profile.preserveFrontmatter) {
    if (stableStringify(origParsed.data) !== stableStringify(revParsed.data)) {
      violations.push('frontmatter changed');
    }
  }

  return { ok: violations.length === 0, violations };
}
