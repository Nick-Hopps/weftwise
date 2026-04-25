/**
 * Wikilink extraction and resolution utilities.
 * All functions are pure with no side effects.
 *
 * Supported formats:
 *   [[Target]]
 *   [[Target|Alias]]
 *   [[Target#Section]]
 *   [[Target#Section|Alias]]
 *   [[other-subject:Target]]
 *   [[other-subject:Target|Alias]]
 *   [[other-subject:page-slug#Section]]
 *
 * The `subject:` prefix opts a link out of the current page's subject and
 * routes it to a different subject's page. The prefix must be a kebab-case
 * subject slug; otherwise the entire token is treated as a same-subject title.
 */

import { normalizeSlug } from './page-identity';

const SUBJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface ExtractedLink {
  /** The full raw token including brackets, e.g. `[[Page Name|Alias]]` */
  raw: string;
  /** The page-name portion of the inner content, after stripping subject/alias/section. */
  rawTitle: string;
  /** The resolved target slug (page name only, normalized) */
  target: string;
  /**
   * Subject slug the link resolves into. Equals the explicit `subject:` prefix
   * when present; otherwise falls back to the caller-provided
   * `currentSubjectSlug`. May be the empty string when no current subject is
   * supplied — callers should treat that as "use today's subject context".
   */
  targetSubjectSlug: string;
  /** Display alias if present (`[[Target|Alias]]`), otherwise null */
  alias: string | null;
  /** Byte offsets of the `[[…]]` token in the original markdown string */
  position: { start: number; end: number };
}

export type TitleResolver = (title: string) => string | undefined;

export interface ExtractWikiLinksOptions {
  /**
   * The slug of the subject whose markdown is being parsed. Used as the fallback
   * subject for any wikilink without an explicit `subject:` prefix.
   */
  currentSubjectSlug?: string;
  /**
   * Optional resolver from raw page title to slug. Returning `undefined` falls
   * back to `normalizeSlug(title)`.
   */
  titleResolver?: TitleResolver;
}

interface ResolvedTarget {
  targetSubjectSlug: string;
  rawTitle: string;
  pagePart: string;
}

const WIKILINK_RE = /\[\[([^\[\]]+?)\]\]/g;

function maskCodeBlocks(markdown: string): string {
  let masked = markdown.replace(/```[\s\S]*?```/g, (match) =>
    ' '.repeat(match.length)
  );
  masked = masked.replace(/`[^`]*`/g, (match) => ' '.repeat(match.length));
  return masked;
}

function splitOnFirst(input: string, separator: string): [string, string | null] {
  const idx = input.indexOf(separator);
  if (idx === -1) return [input, null];
  return [input.slice(0, idx), input.slice(idx + separator.length)];
}

/**
 * Decompose the inner content of a `[[…]]` token into the subject slug, the
 * raw page title (before normalization), and the alias (if any).
 *
 * `currentSubjectSlug` is the fallback when no explicit `subject:` prefix is
 * present. Pass an empty string when the caller has no notion of "current
 * subject".
 */
function parseLinkInner(
  inner: string,
  currentSubjectSlug: string,
): ResolvedTarget & { alias: string | null } {
  // 1. Split off alias on the first `|`
  const [beforeAlias, aliasRaw] = splitOnFirst(inner, '|');
  const alias = aliasRaw !== null ? aliasRaw.trim() || null : null;

  // 2. Detect `subject:` prefix — only when the prefix is a valid slug
  let targetSubjectSlug = currentSubjectSlug;
  let body = beforeAlias;
  const colonIdx = beforeAlias.indexOf(':');
  if (colonIdx > 0) {
    const candidate = beforeAlias.slice(0, colonIdx).trim();
    if (SUBJECT_SLUG_RE.test(candidate)) {
      targetSubjectSlug = candidate;
      body = beforeAlias.slice(colonIdx + 1);
    }
  }

  // 3. Strip section anchor
  const [pagePart] = splitOnFirst(body, '#');
  const rawTitle = pagePart.trim();

  return { targetSubjectSlug, rawTitle, pagePart, alias };
}

function isExtractWikiLinksOptions(
  arg: TitleResolver | ExtractWikiLinksOptions | undefined,
): arg is ExtractWikiLinksOptions {
  return typeof arg === 'object' && arg !== null;
}

export function extractWikiLinks(markdown: string): ExtractedLink[];
export function extractWikiLinks(
  markdown: string,
  titleResolver: TitleResolver,
): ExtractedLink[];
export function extractWikiLinks(
  markdown: string,
  options: ExtractWikiLinksOptions,
): ExtractedLink[];
export function extractWikiLinks(
  markdown: string,
  arg?: TitleResolver | ExtractWikiLinksOptions,
): ExtractedLink[] {
  let titleResolver: TitleResolver | undefined;
  let currentSubjectSlug = '';

  if (typeof arg === 'function') {
    titleResolver = arg;
  } else if (isExtractWikiLinksOptions(arg)) {
    titleResolver = arg.titleResolver;
    currentSubjectSlug = arg.currentSubjectSlug ?? '';
  }

  const masked = maskCodeBlocks(markdown);
  const links: ExtractedLink[] = [];

  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;

  while ((match = WIKILINK_RE.exec(masked)) !== null) {
    const raw = match[0];
    const inner = match[1];
    const start = match.index;
    const end = start + raw.length;

    const parsed = parseLinkInner(inner, currentSubjectSlug);
    const { rawTitle, alias, targetSubjectSlug } = parsed;

    const target = titleResolver?.(rawTitle) ?? normalizeSlug(rawTitle);
    if (target === '') continue;

    links.push({
      raw,
      rawTitle,
      target,
      targetSubjectSlug,
      alias,
      position: { start, end },
    });
  }

  return links;
}

/**
 * Resolve a raw wikilink text (the inner content of `[[…]]`) to a structured
 * subject + slug pair. Subject prefix is stripped, alias and section are
 * dropped.
 */
export function resolveWikiLinkTarget(
  link: string,
  currentSubjectSlug = '',
): { subjectSlug: string; slug: string } {
  const parsed = parseLinkInner(link, currentSubjectSlug);
  return {
    subjectSlug: parsed.targetSubjectSlug,
    slug: normalizeSlug(parsed.rawTitle),
  };
}

/**
 * Canonicalize a wikilink target text to its normalized page slug.
 * Subject prefix and alias/section are stripped.
 */
export function normalizeWikiLink(raw: string): string {
  return resolveWikiLinkTarget(raw).slug;
}
