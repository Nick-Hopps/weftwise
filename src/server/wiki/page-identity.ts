/**
 * Page identity and slug management for the wiki.
 * All functions are pure with no side effects.
 */

import { normalizeSlug } from '@/lib/slug';

// Re-export normalizeSlug so existing importers continue to work
export { normalizeSlug };

/**
 * Convert a file path (e.g. `wiki/some-page.md`) to a URL slug (e.g. `some-page`).
 * Strips the leading `wiki/` prefix and the `.md` suffix.
 * Nested paths are preserved with `/` separators (e.g. `wiki/a/b.md` → `a/b`).
 */
export function slugFromWikiPath(path: string): string {
  let slug = path.trim();
  // Remove leading wiki/ prefix
  if (slug.startsWith('wiki/')) {
    slug = slug.slice('wiki/'.length);
  }
  // Remove .md suffix
  if (slug.endsWith('.md')) {
    slug = slug.slice(0, -'.md'.length);
  }
  return slug;
}

/**
 * Convert a URL slug back to a wiki file path.
 * e.g. `some-page` → `wiki/some-page.md`
 */
export function wikiPathFromSlug(slug: string): string {
  return `wiki/${slug.trim()}.md`;
}

/**
 * Convert a human-readable page title to a URL slug.
 * Delegates to `normalizeSlug` after trimming.
 */
export function slugFromTitle(title: string): string {
  return normalizeSlug(title);
}
