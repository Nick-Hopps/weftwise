/**
 * Shared slug normalization — identical logic on client and server.
 * Mirrors src/server/wiki/page-identity.ts normalizeSlug().
 */
export function normalizeSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\-/]/g, '')
    .replace(/-{2,}/g, '-')
    .split('/')
    .map((segment) => segment.replace(/^-+|-+$/g, ''))
    .filter((segment) => segment.length > 0)
    .join('/');
}
