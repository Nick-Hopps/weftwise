import type { AnswerCitation, WebCitation, WikiCitation } from './contracts';

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

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** 判别一条来源条目是网页而非 wiki 页面（判据 = 有非空 `url`）。 */
export function isWebCitation(citation: AnswerCitation): citation is WebCitation {
  return nonEmptyString((citation as WebCitation).url) !== null;
}

/**
 * 把持久化/传输中的混合来源数组拆成 wiki 与 web 两侧，各自保序。
 *
 * 存量 `messages.citations_json` 全是 wiki 条目，因此这个函数同时是「不加迁移」
 * 的兼容层：无法判别身份的条目（两个判别字段都缺、或脏数据）一律丢弃，
 * 不允许半个条目流到渲染层。
 */
export function splitAnswerCitations(
  raw: unknown,
): { wiki: WikiCitation[]; web: WebCitation[] } {
  const wiki: WikiCitation[] = [];
  const web: WebCitation[] = [];
  if (!Array.isArray(raw)) return { wiki, web };

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;

    const url = nonEmptyString(record.url);
    if (url) {
      web.push({ url, title: nonEmptyString(record.title) ?? url });
      continue;
    }

    const pageSlug = nonEmptyString(record.pageSlug);
    if (!pageSlug) continue;
    const subjectSlug = nonEmptyString(record.subjectSlug);
    wiki.push({
      pageSlug,
      excerpt: typeof record.excerpt === 'string' ? record.excerpt : '',
      ...(subjectSlug ? { subjectSlug } : {}),
    });
  }

  return { wiki, web };
}
