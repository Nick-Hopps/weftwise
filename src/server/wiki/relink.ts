/**
 * 改页面标题时，把别处正文里以「旧标题」书写的同-subject wikilink 文本刷成新标题。
 * 纯函数、无副作用。详见 docs/superpowers/specs/2026-06-21-page-retitle-relink-design.md。
 */
import { extractWikiLinks } from './wikilinks';

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
    // 替换首个 target 文本出现处；前缀/锚点/别名都在其后，天然保留。
    const newToken = link.raw.replace(link.rawTitle, () => newTitle);
    result =
      result.slice(0, link.position.start) +
      newToken +
      result.slice(link.position.end);
  }
  return result;
}
