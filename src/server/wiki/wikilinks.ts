/**
 * Wikilink extraction and resolution utilities.
 * All functions are pure with no side effects.
 *
 * Supported formats:
 *   [[Target]]
 *   [[Target|Alias]]
 *   [[Target#Section]]
 *   [[Target#Section|Alias]]
 */

import { normalizeSlug } from './page-identity';

/**
 * A single extracted wikilink with its position in the source text.
 */
export interface ExtractedLink {
  /** The full raw token including brackets, e.g. `[[Page Name|Alias]]` */
  raw: string;
  /** The resolved target slug (page name part, no section, normalized) */
  target: string;
  /** Display alias if present (`[[Target|Alias]]`), otherwise null */
  alias: string | null;
  /** Byte offsets of the `[[…]]` token in the original markdown string */
  position: { start: number; end: number };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip all fenced code blocks (``` … ```) and inline code (` … `) from the
 * markdown string, replacing them with whitespace of the same length so that
 * all other character positions remain valid.
 */
function maskCodeBlocks(markdown: string): string {
  // Replace fenced code blocks first (greedy match across lines)
  let masked = markdown.replace(/```[\s\S]*?```/g, (match) =>
    ' '.repeat(match.length)
  );
  // Replace inline code spans
  masked = masked.replace(/`[^`]*`/g, (match) => ' '.repeat(match.length));
  return masked;
}

// Regex that matches [[...]] tokens (non-greedy inner content, no nested brackets)
const WIKILINK_RE = /\[\[([^\[\]]+?)\]\]/g;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * A function that resolves a raw page title to a slug.
 * Returns the slug if the title matches a known page, or undefined to fall
 * back to normalizeSlug().
 */
export type TitleResolver = (title: string) => string | undefined;

/**
 * Extract all wikilinks from a markdown string.
 * Links that appear inside fenced or inline code blocks are ignored.
 *
 * When a `titleResolver` is provided, it is called first with the raw page
 * title from the brackets (e.g. "JavaScript 闭包原理与应用").  If it returns
 * a slug, that slug is used; otherwise the title falls through to
 * `normalizeSlug()`.
 *
 * Each returned `ExtractedLink` has:
 * - `raw`      — the full `[[…]]` token
 * - `target`   — normalized slug for the target page (section stripped)
 * - `alias`    — display text if the link uses a pipe, otherwise null
 * - `position` — `{ start, end }` character offsets in the original string
 */
export function extractWikiLinks(markdown: string, titleResolver?: TitleResolver): ExtractedLink[] {
  const masked = maskCodeBlocks(markdown);
  const links: ExtractedLink[] = [];

  let match: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;

  while ((match = WIKILINK_RE.exec(masked)) !== null) {
    const raw = match[0]; // e.g. [[Page Name|Alias]]
    const inner = match[1]; // e.g. Page Name|Alias
    const start = match.index;
    const end = start + raw.length;

    // Split on pipe to detect alias
    const pipeIdx = inner.indexOf('|');
    const targetPart = pipeIdx === -1 ? inner : inner.slice(0, pipeIdx);
    const aliasPart = pipeIdx === -1 ? null : inner.slice(pipeIdx + 1).trim();

    // Strip section anchor from target
    const hashIdx = targetPart.indexOf('#');
    const pagePart = hashIdx === -1 ? targetPart : targetPart.slice(0, hashIdx);

    const rawTitle = pagePart.trim();
    const target = titleResolver?.(rawTitle) ?? normalizeSlug(rawTitle);

    // Skip completely empty targets (e.g. [[#Section]])
    if (target === '') continue;

    links.push({
      raw,
      target,
      alias: aliasPart !== null && aliasPart !== '' ? aliasPart : null,
      position: { start, end },
    });
  }

  return links;
}

/**
 * Resolve a raw wikilink text (the inner content of `[[…]]`) to its target slug.
 *
 * Handles:
 * - `Page Name`           → normalized slug
 * - `Page Name|Alias`     → normalized slug of Page Name
 * - `Page Name#Section`   → normalized slug of Page Name (section ignored)
 * - `Page Name#Section|Alias` → normalized slug of Page Name
 *
 * @param link        Raw inner link text (without surrounding brackets)
 * @param currentSlug Unused currently; reserved for future relative-link resolution
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function resolveWikiLinkTarget(
  link: string,
  currentSlug?: string
): string {
  // Strip alias
  const pipeIdx = link.indexOf('|');
  const targetPart = pipeIdx === -1 ? link : link.slice(0, pipeIdx);

  // Strip section anchor
  const hashIdx = targetPart.indexOf('#');
  const pagePart = hashIdx === -1 ? targetPart : targetPart.slice(0, hashIdx);

  return normalizeSlug(pagePart.trim());
}

/**
 * Canonicalize a wikilink target text to its normalized form.
 * Accepts the inner bracket content (e.g. `"Page Name#Section|Alias"`)
 * and returns just the page slug.
 */
export function normalizeWikiLink(raw: string): string {
  return resolveWikiLinkTarget(raw);
}
