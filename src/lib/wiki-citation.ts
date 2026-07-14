import type { WikiCitation } from './contracts';

/** 聊天引用跳转；旧引用无 subjectSlug 时沿用当前页面 Subject。 */
export function citationHref(citation: WikiCitation): string {
  const path = `/wiki/${citation.pageSlug}`;
  return citation.subjectSlug
    ? `${path}?s=${encodeURIComponent(citation.subjectSlug)}`
    : path;
}

/** 保存回答时把跨 Subject 引用序列化为显式 wikilink。 */
export function citationWikiLink(
  citation: WikiCitation,
  activeSubjectSlug: string,
): string {
  const target = citation.subjectSlug && citation.subjectSlug !== activeSubjectSlug
    ? `${citation.subjectSlug}:${citation.pageSlug}`
    : citation.pageSlug;
  return `[[${target}]]`;
}
