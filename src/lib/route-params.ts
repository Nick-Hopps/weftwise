/**
 * Next.js 15 动态路由参数解码。
 *
 * Next.js 15 对动态路由参数的处理在两类入口并不一致：
 * Route Handler（`/api/**`）拿到的是**已 URL 解码**的段，而 Server Component
 * 页面的 `params` 对非 ASCII 段（如中文 slug）保持**百分号编码**原样。
 * 页面 slug / tag 在 SQLite 与 vault 文件系统里都以**解码形态**存储
 * （如 `0-阅读顺序`），若页面直接拿原始参数查表，会对任何非 ASCII slug
 * 命中失败 → `notFound()` → 404。
 *
 * 因此所有动态 Server Component 页面在使用参数前都必须解码到与 Route Handler
 * 一致的形态。对 ASCII 段幂等；遇到非法百分号编码时回退原值（避免 500）。
 */
export function decodeRouteSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * catch-all 段（`string[]`）逐段解码后用 `/` 拼接。
 * 逐段解码而非「先 join 再 decode」：catch-all 的每个路径段是独立编码的，
 * 而归一化后的 slug 段内不含字面 `/`（`/` 仅作层级分隔符），故逐段解码无歧义。
 */
export function decodeRouteSegments(segments: string[]): string {
  return segments.map(decodeRouteSegment).join('/');
}
