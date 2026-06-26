import { createHash } from 'node:crypto';

/** 用于缓存失效：canonical 正文（不含 frontmatter）变了，hash 就变。 */
export function computeCanonicalHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex').slice(0, 16);
}
