/**
 * 改页面标题时，把别处正文里以「旧标题」书写的同-subject wikilink 文本刷成新标题。
 * 纯函数、无副作用。详见 docs/superpowers/specs/2026-06-21-page-retitle-relink-design.md。
 */
import { extractWikiLinks } from './wikilinks';
import { SUBJECT_SLUG_RE } from '@/lib/slug';
import type { TitleResolver } from '@/lib/contracts';

/**
 * 把单个 [[…]] token 里的 target 文本替换为 newTitle，保留 subject 前缀、#锚点、|别名。
 * 按 wikilink 语法（先 | 切别名 → 再 : 切 subject 前缀 → 再 # 切锚点）定位 target 段，
 * 避免「按子串替换首个出现处」在 target 文本恰好也出现在前缀里时（如 [[general:general]]）
 * 误改前缀。
 */
function replaceTargetInToken(raw: string, newTitle: string): string {
  const inner = raw.slice(2, raw.length - 2); // 去掉 [[ ]]

  const pipeIdx = inner.indexOf('|');
  const beforeAlias = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
  const aliasPart = pipeIdx === -1 ? '' : inner.slice(pipeIdx); // 含 '|'

  let prefixPart = '';
  let rest = beforeAlias;
  const colonIdx = beforeAlias.indexOf(':');
  if (colonIdx > 0 && SUBJECT_SLUG_RE.test(beforeAlias.slice(0, colonIdx).trim())) {
    prefixPart = beforeAlias.slice(0, colonIdx + 1); // 含 ':'
    rest = beforeAlias.slice(colonIdx + 1);
  }

  const hashIdx = rest.indexOf('#');
  const sectionPart = hashIdx === -1 ? '' : rest.slice(hashIdx); // 含 '#'

  return `[[${prefixPart}${newTitle}${sectionPart}${aliasPart}]]`;
}

/**
 * 重写整文件 raw markdown 里指向旧标题的同-subject wikilink。
 *
 * 规则：仅当某 [[…]] 的 target 文本（rawTitle，去 subject 前缀 / #锚点 / |别名 后，已 trim）
 * 忽略大小写等于 oldTitle，且该链接指向本 subject（无前缀，或前缀 == subjectSlug）时，
 * 把其 target 文本替换为 newTitle，保留 subject 前缀、#锚点、|别名。slug-form / 跨主题 / 代码块内
 * 的链接一律不动。按 position 从右往左替换以保持偏移正确。无匹配返回原串。
 */
export function rewriteBacklinkText(
  raw: string,
  oldTitle: string,
  newTitle: string,
  subjectSlug: string,
): string {
  const oldKey = oldTitle.trim().toLowerCase();
  if (oldKey === '') return raw;

  const links = extractWikiLinks(raw, { currentSubjectSlug: subjectSlug });
  const matches = links
    .filter(
      (l) =>
        l.rawTitle.trim().toLowerCase() === oldKey &&
        (!l.targetSubjectSlug || l.targetSubjectSlug === subjectSlug),
    )
    // 从右往左替换，避免前面 token 的 position 偏移被破坏
    .sort((a, b) => b.position.start - a.position.start);

  let result = raw;
  for (const link of matches) {
    const newToken = replaceTargetInToken(link.raw, newTitle);
    result =
      result.slice(0, link.position.start) +
      newToken +
      result.slice(link.position.end);
  }
  return result;
}

/**
 * 把整文件 raw 里所有「解析到 fromSlug（本 subject）」的 wikilink 改指向 toTitle。
 * 与 rewriteBacklinkText 的区别：匹配判据是「解析后的 target slug == fromSlug」
 * （用 titleResolver，覆盖 title-form 与 slug-form 两种写法）。用于 merge：源页被删后，
 * 所有指向它的引用（含 [[源-slug]]）都要改指存活页。跨主题链接与代码块内链接不动。
 * 复用 replaceTargetInToken 保前缀/#锚点/|别名；按 position 从右往左替换。无匹配返回原串。
 */
export function repointLinksToPage(
  raw: string,
  fromSlug: string,
  toTitle: string,
  subjectSlug: string,
  titleResolver: TitleResolver,
): string {
  const links = extractWikiLinks(raw, { currentSubjectSlug: subjectSlug, titleResolver });
  const matches = links
    .filter(
      (l) =>
        l.target === fromSlug &&
        (!l.targetSubjectSlug || l.targetSubjectSlug === subjectSlug),
    )
    .sort((a, b) => b.position.start - a.position.start);

  let result = raw;
  for (const link of matches) {
    const newToken = replaceTargetInToken(link.raw, toTitle);
    result =
      result.slice(0, link.position.start) +
      newToken +
      result.slice(link.position.end);
  }
  return result;
}
