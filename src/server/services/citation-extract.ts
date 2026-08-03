/**
 * Ask AI 内联引用的确定性解析（零 LLM）。
 *
 * 模型在回答正文中内联 [[slug]] 标注依据（prompt 纪律），流结束后：
 *   1. extractWikiLinks 解析答案全文（accessed 标题兜底 titleResolver）；
 *   2. 目标 slug ∩ accessed.bodies（真正 read 过的页）——幻觉链接/未读页丢弃；
 *   3. 按 slug 去重（取首次出现的锚点句），excerpt 从页面原文词重叠抽取。
 */
import { extractWikiLinks } from '../wiki/wikilinks';
import { normalizeSlug } from '../wiki/page-identity';
import type { WebCitation, WikiCitation } from '@/lib/contracts';
import { normalizeCitationUrl } from '@/lib/wiki-citation';
import { crossSubjectPageKey, type AccessedPages } from './query-tools';

const EXCERPT_MAX_CHARS = 400;
const EXCERPT_MAX_SENTENCES = 3;

/** 中英通用分词：latin 词 + CJK 相邻双字（bigram）。 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9_]+/g)) tokens.add(m[0]);
  const cjk = text.match(/[一-鿿]/g) ?? [];
  for (let i = 0; i < cjk.length - 1; i++) tokens.add(cjk[i] + cjk[i + 1]);
  return tokens;
}

const EXCLUDED_LINE_RE = /^\s*(#|```|\||>)/;
const SENTENCE_BOUNDARY_RE = /[.!?。！？；;]/;

interface Sentence {
  /** 绝对偏移（相对整个 pageBody），保证按该偏移切片必是 pageBody 的字面子串。 */
  start: number;
  end: number;
}

/**
 * 把正文切成「块」（连续的非排除行，如标题/代码围栏/表格/引用行会打断块），
 * 再在每块内部按句界切分。所有偏移均相对原始 pageBody ——
 * 块本身即 pageBody 的连续字面子串，块内句子偏移天然也是。
 */
function buildSentences(pageBody: string): Sentence[] {
  const sentences: Sentence[] = [];
  let blockStart: number | null = null;
  let offset = 0;

  const closeBlock = (blockEnd: number) => {
    if (blockStart === null) return;
    const block = pageBody.slice(blockStart, blockEnd);
    let sentStart = 0;
    for (let i = 0; i < block.length; i++) {
      if (SENTENCE_BOUNDARY_RE.test(block[i])) {
        sentences.push({ start: blockStart + sentStart, end: blockStart + i + 1 });
        sentStart = i + 1;
      }
    }
    if (sentStart < block.length) {
      sentences.push({ start: blockStart + sentStart, end: blockStart + block.length });
    }
    blockStart = null;
  };

  for (const line of pageBody.split('\n')) {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    if (EXCLUDED_LINE_RE.test(line)) {
      closeBlock(lineStart);
    } else if (blockStart === null) {
      blockStart = lineStart;
    }
    offset = lineEnd + 1; // + 换行符
  }
  closeBlock(pageBody.length);

  return sentences.filter((s) => pageBody.slice(s.start, s.end).trim().length > 0);
}

/** 从页面正文中抽取与锚点文本词重叠最高的连续 1-3 句作 excerpt（原文字面子串）。 */
export function pickExcerpt(anchorText: string, pageBody: string): string {
  const sentences = buildSentences(pageBody);
  if (sentences.length === 0) return pageBody.trim().slice(0, EXCERPT_MAX_CHARS);

  const anchorTokens = tokenize(anchorText);
  let bestIdx = 0;
  let bestScore = 0;
  sentences.forEach((s, i) => {
    const text = pageBody.slice(s.start, s.end);
    let score = 0;
    for (const t of tokenize(text)) if (anchorTokens.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  });
  // 零重叠回落正文开头
  if (bestScore === 0) bestIdx = 0;

  let endIdx = bestIdx;
  for (
    let i = bestIdx + 1;
    i < Math.min(bestIdx + EXCERPT_MAX_SENTENCES, sentences.length) &&
    sentences[i].start === sentences[i - 1].end && // 仍在同一块内，无跨块断裂
    sentences[i].end - sentences[bestIdx].start <= EXCERPT_MAX_CHARS;
    i++
  ) {
    endIdx = i;
  }

  const excerpt = pageBody.slice(sentences[bestIdx].start, sentences[endIdx].end).trim();
  return excerpt.slice(0, EXCERPT_MAX_CHARS);
}

/** 取答案中 wikilink 所在句作锚点（向两侧扩到句界）。 */
function anchorSentenceAt(answer: string, start: number, end: number): string {
  const boundary = /[.!?。！？\n]/;
  let s = start;
  while (s > 0 && !boundary.test(answer[s - 1])) s--;
  let e = end;
  while (e < answer.length && !boundary.test(answer[e])) e++;
  return answer.slice(s, Math.min(e + 1, answer.length));
}

export function extractCitationsFromAnswer(
  answer: string,
  accessed: AccessedPages,
  subjectSlug: string,
): WikiCitation[] {
  // 标题→slug 兜底解析：模型写 [[Title]] 也能落到 read 过的页
  const titleCandidates = new Map<string, Set<string>>();
  const titleCandidateKey = (candidateSubjectSlug: string, title: string) => (
    `${candidateSubjectSlug}\0${normalizeSlug(title)}`
  );
  const addTitleCandidate = (candidateSubjectSlug: string, title: string, slug: string) => {
    const key = titleCandidateKey(candidateSubjectSlug, title);
    const candidates = titleCandidates.get(key) ?? new Set<string>();
    candidates.add(slug);
    titleCandidates.set(key, candidates);
  };
  for (const [slug, { title }] of accessed.bodies) addTitleCandidate(subjectSlug, title, slug);
  for (const [slug, { title }] of accessed.meta) {
    addTitleCandidate(subjectSlug, title, slug);
  }
  for (const page of accessed.crossBodies.values()) {
    addTitleCandidate(page.subjectSlug, page.title, page.slug);
  }
  for (const page of accessed.crossMeta.values()) {
    addTitleCandidate(page.subjectSlug, page.title, page.slug);
  }

  const links = extractWikiLinks(answer, {
    currentSubjectSlug: subjectSlug,
    titleResolver: (title, targetSubjectSlug = subjectSlug) => {
      const candidates = titleCandidates.get(titleCandidateKey(targetSubjectSlug, title));
      return candidates?.size === 1 ? [...candidates][0] : undefined;
    },
  });

  const out: WikiCitation[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const isCurrentSubject = link.targetSubjectSlug === subjectSlug;
    const identity = isCurrentSubject
      ? link.target
      : crossSubjectPageKey(link.targetSubjectSlug, link.target);
    const page = isCurrentSubject
      ? accessed.bodies.get(link.target)
      : accessed.crossBodies.get(identity);
    if (!page || seen.has(identity)) continue;
    seen.add(identity);
    const anchor = anchorSentenceAt(answer, link.position.start, link.position.end);
    out.push({
      pageSlug: link.target,
      excerpt: pickExcerpt(anchor, page.body),
      ...(isCurrentSubject ? {} : { subjectSlug: link.targetSubjectSlug }),
    });
  }
  return out;
}

/** 答案正文里所有 http(s) URL 出现位置：取到下一个空白为止的最长片段。 */
const URL_OCCURRENCE_RE = /https?:\/\/[^\s<>]+/gi;

/**
 * Ask AI 联网来源的确定性解析（零 LLM）。
 *
 * 与 wiki 引用同构：prompt 纪律要求模型用 `[标题](url)` 内联标注 web 依据，
 * 这里在流末扫描答案里出现的 URL，与本轮 `web.search` 真实返回过的
 * `accessed.webResults` **求交**——凭空写出的 URL 一律不进来源。
 *
 * 不解析 markdown 语法：`[t](url)` 与裸 URL 都会被同一个 URL 扫描命中，
 * 收尾括号/句末标点由 `normalizeCitationUrl` 的平衡规则剥掉，反而比按
 * markdown 结构解析覆盖面更广（`<url>`、括号包裹的裸链接都能命中）。
 *
 * 标题取 `webResults` 里的服务端记录，不取模型写的锚文本（锚文本可与目标页无关）。
 */
export function extractWebCitationsFromAnswer(
  answer: string,
  accessed: AccessedPages,
): WebCitation[] {
  if (accessed.webResults.size === 0) return [];

  /**
   * origin+pathname 索引，用于「搜索结果带跟踪参数、答案写干净 URL」这一类真实错配
   * （实测 Tavily 会返回 `…/a/20260720A09YMY00?uid[0]=…`，模型抄的是无参版本）。
   * 只在**答案侧无 query 且该路径只有唯一候选**时回退，多义一律不猜——
   * 否则 `?id=1` 与 `?id=2` 会被错认成同一篇。
   */
  const byPath = new Map<string, WebCitation[]>();
  for (const citation of accessed.webResults.values()) {
    const key = urlPathKey(citation.url);
    if (!key) continue;
    const bucket = byPath.get(key);
    if (bucket) bucket.push(citation);
    else byPath.set(key, [citation]);
  }

  const out: WebCitation[] = [];
  const seen = new Set<string>();
  for (const match of answer.matchAll(URL_OCCURRENCE_RE)) {
    const url = normalizeCitationUrl(match[0]);
    if (!url) continue;
    const searched = accessed.webResults.get(url) ?? resolveByPath(url, byPath);
    // 去重按最终命中的服务端 URL，避免同一来源的两种写法各占一行
    if (!searched || seen.has(searched.url)) continue;
    seen.add(searched.url);
    out.push(searched);
  }
  return out;
}

/** `origin + pathname`（已由 normalizeCitationUrl 统一大小写与末尾斜杠）。 */
function urlPathKey(normalizedUrl: string): string | null {
  try {
    const url = new URL(normalizedUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function resolveByPath(
  normalizedUrl: string,
  byPath: Map<string, WebCitation[]>,
): WebCitation | undefined {
  let url: URL;
  try {
    url = new URL(normalizedUrl);
  } catch {
    return undefined;
  }
  // 答案自带 query 时它是可辨识身份的一部分，只接受精确匹配
  if (url.search) return undefined;
  const bucket = byPath.get(`${url.origin}${url.pathname}`);
  return bucket?.length === 1 ? bucket[0] : undefined;
}
