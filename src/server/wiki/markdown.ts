/**
 * High-level wiki document parsing — combines frontmatter and wikilink extraction.
 * All functions are pure with no side effects.
 */

import { parseFrontmatter, serializeFrontmatter } from './frontmatter';
import type { WikiFrontmatter } from './frontmatter';
import { extractWikiLinks } from './wikilinks';
import type {
  ExtractedLink,
  ExtractWikiLinksOptions,
  TitleResolver,
} from './wikilinks';

export type { WikiFrontmatter, ExtractedLink, TitleResolver };

export interface WikiDocument {
  frontmatter: WikiFrontmatter;
  body: string;
  links: ExtractedLink[];
}

export type ParseWikiDocumentOptions = ExtractWikiLinksOptions;

function isParseOptions(
  arg: TitleResolver | ParseWikiDocumentOptions | undefined,
): arg is ParseWikiDocumentOptions {
  return typeof arg === 'object' && arg !== null;
}

export function parseWikiDocument(rawContent: string): WikiDocument;
export function parseWikiDocument(
  rawContent: string,
  titleResolver: TitleResolver,
): WikiDocument;
export function parseWikiDocument(
  rawContent: string,
  options: ParseWikiDocumentOptions,
): WikiDocument;
export function parseWikiDocument(
  rawContent: string,
  arg?: TitleResolver | ParseWikiDocumentOptions,
): WikiDocument {
  const { data: frontmatter, body } = parseFrontmatter(rawContent);

  let links: ExtractedLink[];
  if (typeof arg === 'function') {
    links = extractWikiLinks(body, arg);
  } else if (isParseOptions(arg)) {
    links = extractWikiLinks(body, arg);
  } else {
    links = extractWikiLinks(body);
  }

  return { frontmatter, body, links };
}

/**
 * Round-trip guarantee: `serializeWikiDocument(parseWikiDocument(content))` ≈ `content`
 * (gray-matter may reorder YAML keys; semantic content is preserved).
 */
export function serializeWikiDocument(doc: WikiDocument): string {
  return serializeFrontmatter(doc.frontmatter, doc.body);
}
