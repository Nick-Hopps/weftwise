import { extractWikiLinks } from '@/server/wiki/wikilinks';

function targetKey(l: { targetSubjectSlug: string; target: string }): string {
  return `${l.targetSubjectSlug}:${l.target}`;
}

/**
 * 保真护栏：重塑后的 wikilink 目标集必须是 canonical 的子集。
 * 出现 canonical 中不存在的目标即判失败（防模型臆造链接）。
 */
export function checkLinkSubset(
  canonicalBody: string,
  reshapedBody: string,
): { ok: boolean; offending: string[] } {
  const allowed = new Set(extractWikiLinks(canonicalBody).map(targetKey));
  const offending: string[] = [];
  for (const l of extractWikiLinks(reshapedBody)) {
    if (!allowed.has(targetKey(l))) offending.push(l.raw);
  }
  return { ok: offending.length === 0, offending };
}
