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

/**
 * 输入态宽松规范化：用于 slug 输入框 onChange。
 * 与 normalizeSubjectSlug 的关键区别——**保留末尾连字符**，否则用户每打一个
 * `-` 都会被立刻剥掉，无法输入 `frontend-architecture` 这类带横杠的 slug。
 * 仍即时转小写、把非法字符换成连字符、剥前导连字符（满足 `^[a-z0-9]`）、限长；
 * 提交时再走 normalizeSubjectSlug 收口为最终规范形态。
 */
export function sanitizeSubjectSlugInput(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+/, '')
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
