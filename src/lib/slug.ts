/**
 * Shared slug normalization — identical logic on client and server.
 * Mirrors src/server/wiki/page-identity.ts normalizeSlug().
 *
 * Preserves Unicode letters/numbers (e.g. CJK) so non-ASCII titles still
 * produce a stable, non-empty slug. Strips only punctuation and symbols.
 */
export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}\-/]/gu, '')
    .replace(/-{2,}/g, '-')
    .split('/')
    .map((segment) => segment.replace(/^-+|-+$/g, ''))
    .filter((segment) => segment.length > 0)
    .join('/');
}
