/**
 * High-level wiki document parsing — combines frontmatter and wikilink extraction.
 * All functions are pure with no side effects.
 */

import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import type { WikiFrontmatter } from './frontmatter';
import { extractWikiLinks } from './wikilinks';
import type { ExtractedLink, TitleResolver } from './wikilinks';

// Re-export so callers can import from a single entry point if needed
export type { WikiFrontmatter, ExtractedLink, TitleResolver };

/**
 * A fully parsed wiki page document.
 */
export interface WikiDocument {
  /** Typed YAML frontmatter */
  frontmatter: WikiFrontmatter;
  /** Raw markdown body (without the frontmatter block) */
  body: string;
  /** All wikilinks found in the body */
  links: ExtractedLink[];
}

/**
 * Parse a raw markdown file (with YAML frontmatter) into a structured WikiDocument.
 *
 * Steps:
 * 1. Extract YAML frontmatter and body via gray-matter
 * 2. Extract all wikilinks from the body
 */
export function parseWikiDocument(rawContent: string, titleResolver?: TitleResolver): WikiDocument {
  const { data: frontmatter, body } = parseFrontmatter(rawContent);
  const links = extractWikiLinks(body, titleResolver);

  return { frontmatter, body, links };
}

/**
 * Reconstruct a raw markdown string from a WikiDocument.
 *
 * The body already contains the wikilink tokens in their original form, so
 * links do not need to be re-inserted — they are part of `doc.body`.
 *
 * Round-trip guarantee:
 *   `serializeWikiDocument(parseWikiDocument(content))` ≈ `content`
 * (Whitespace and key ordering in the YAML block may differ slightly due to
 *  gray-matter's serializer, but all semantic content is preserved.)
 */
export function serializeWikiDocument(doc: WikiDocument): string {
  return serializeFrontmatter(doc.frontmatter, doc.body);
}
