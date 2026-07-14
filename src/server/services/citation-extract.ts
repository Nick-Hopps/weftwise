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
import type { WikiCitation } from '@/lib/contracts';
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
  const addTitleCandidate = (title: string, slug: string) => {
    const normalized = normalizeSlug(title);
    const candidates = titleCandidates.get(normalized) ?? new Set<string>();
    candidates.add(slug);
    titleCandidates.set(normalized, candidates);
  };
  for (const [slug, { title }] of accessed.bodies) addTitleCandidate(title, slug);
  for (const [slug, { title }] of accessed.meta) {
    addTitleCandidate(title, slug);
  }
  for (const page of accessed.crossBodies.values()) addTitleCandidate(page.title, page.slug);
  for (const page of accessed.crossMeta.values()) addTitleCandidate(page.title, page.slug);

  const links = extractWikiLinks(answer, {
    currentSubjectSlug: subjectSlug,
    titleResolver: (title) => {
      const candidates = titleCandidates.get(normalizeSlug(title));
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
