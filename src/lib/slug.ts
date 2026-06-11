/**
 * Shared slug normalization — identical logic on client and server.
 * Mirrors src/server/wiki/page-identity.ts normalizeSlug().
 *
 * Preserves Unicode letters/numbers (e.g. CJK) so non-ASCII titles still
 * produce a stable, non-empty slug. Strips only punctuation and symbols.
 */
/**
 * Subject slug 必须保持 ASCII（`[[subject:page]]` 跨主题前缀语法依赖此正则
 * 判别冒号前缀是否为 subject）。全应用唯一定义，不得在其他模块复刻。
 */
export const SUBJECT_SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

export const MAX_SUBJECT_SLUG_LENGTH = 60;

/**
 * 将 subject 名称规范化为 ASCII slug。与 normalizeSlug 不同：subject slug
 * 不保留 Unicode 字符（见 SUBJECT_SLUG_RE）。CJK 等非 ASCII 名称会得到空串，
 * 调用方应要求用户手动填写 slug。
 */
export function normalizeSubjectSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SUBJECT_SLUG_LENGTH);
}

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
