/**
 * Page identity and slug management for the wiki.
 *
 * Vault layout (subject-aware):
 *   vault/wiki/<subject-slug>/<page-slug>.md
 *
 * The "slug" component is namespaced by its subject — different subjects may
 * each have a page with the same slug.
 */

import { normalizeSlug } from '@/lib/slug';

export { normalizeSlug };

export const GENERAL_SUBJECT_SLUG = 'general';

const WIKI_DIR_PREFIX = 'wiki/';
const MD_SUFFIX = '.md';

export interface WikiPathParts {
  subjectSlug: string;
  slug: string;
}

/**
 * Strip leading `wiki/` prefix and trailing `.md` suffix from a vault-relative
 * path, returning the raw inner string. Examples:
 *   `wiki/general/foo.md`     → `general/foo`
 *   `wiki/foo.md`             → `foo`
 *   `wiki/programming/a/b.md` → `programming/a/b`
 */
function stripWikiEnvelope(path: string): string {
  let stripped = path.trim();
  if (stripped.startsWith(WIKI_DIR_PREFIX)) {
    stripped = stripped.slice(WIKI_DIR_PREFIX.length);
  }
  if (stripped.endsWith(MD_SUFFIX)) {
    stripped = stripped.slice(0, -MD_SUFFIX.length);
  }
  return stripped;
}

/**
 * Parse a vault-relative wiki path into its `(subjectSlug, slug)` components.
 *
 * Returns `null` when the path is not a valid wiki path (e.g. not under
 * `wiki/`, or empty). Returns `{ subjectSlug: GENERAL_SUBJECT_SLUG, slug }` for
 * legacy flat layouts (`wiki/foo.md`), giving the caller a sensible default.
 */
export function parseWikiPath(path: string): WikiPathParts | null {
  const inner = stripWikiEnvelope(path);
  if (inner === '') return null;

  const firstSlash = inner.indexOf('/');
  if (firstSlash === -1) {
    return { subjectSlug: GENERAL_SUBJECT_SLUG, slug: inner };
  }

  return {
    subjectSlug: inner.slice(0, firstSlash),
    slug: inner.slice(firstSlash + 1),
  };
}

/**
 * Build the canonical vault-relative wiki file path for a given
 * `(subjectSlug, slug)` pair.
 */
export function buildWikiPath(subjectSlug: string, slug: string): string {
  return `${WIKI_DIR_PREFIX}${subjectSlug.trim()}/${slug.trim()}${MD_SUFFIX}`;
}

/**
 * Legacy: convert a vault-relative wiki path to its flat slug (subject prefix
 * preserved as part of the slug). Kept for callers not yet aware of subjects.
 *
 * `wiki/general/foo.md` → `general/foo`
 * `wiki/foo.md`         → `foo`
 */
export function slugFromWikiPath(path: string): string {
  return stripWikiEnvelope(path);
}

/**
 * Legacy: convert a flat slug back to its wiki file path. Kept for callers not
 * yet aware of subjects. Prefer `buildWikiPath(subjectSlug, slug)` for new code.
 */
export function wikiPathFromSlug(slug: string): string {
  return `${WIKI_DIR_PREFIX}${slug.trim()}${MD_SUFFIX}`;
}

/**
 * Convert a human-readable page title to a URL slug.
 */
export function slugFromTitle(title: string): string {
  return normalizeSlug(title);
}
