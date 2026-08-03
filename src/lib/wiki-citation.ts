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

/** 常被散文/markdown 粘在 URL 尾部的标点（成对括号另有平衡规则处理）。 */
const TRAILING_PUNCTUATION = /[.,;:!?"'“”‘’…、。，；：！？」』>]+$/u;

function trimUnbalancedCloser(candidate: string): string {
  const pairs: [string, string][] = [['(', ')'], ['[', ']'], ['{', '}']];
  let result = candidate;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of pairs) {
      if (!result.endsWith(close)) continue;
      const opens = result.split(open).length - 1;
      const closes = result.split(close).length - 1;
      // 括号配平时保留（如 …/wiki/Foo_(bar)），多出来的那个才是散文的收尾括号
      if (closes <= opens) continue;
      result = result.slice(0, -1);
      changed = true;
    }
  }
  return result;
}

/**
 * URL 规范化：记录搜索结果与解析答案两侧必须用同一把尺子，否则求交会因
 * 末尾斜杠、host 大小写、fragment 或句末标点这类无意义差异而漏掉真实来源。
 *
 * 只接受 http(s)；协议与 host 小写（`URL` 自带）、去 fragment、去路径末尾单个 `/`。
 * 非字符串、空串、解析失败或非 http(s) 返回 null。
 */
export function normalizeCitationUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let candidate = raw.trim();
  if (!candidate) return null;

  let previous = '';
  while (candidate !== previous) {
    previous = candidate;
    candidate = trimUnbalancedCloser(candidate.replace(TRAILING_PUNCTUATION, ''));
  }
  if (!candidate) return null;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  const normalized = url.href;
  return url.pathname !== '/' && normalized.endsWith('/')
    ? normalized.slice(0, -1)
    : normalized;
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
