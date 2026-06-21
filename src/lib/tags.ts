import type { WikiPage } from '@/lib/contracts';

export const META_TAG = 'meta';

const SYSTEM_PAGE_SLUGS = new Set(['index']);

function isSystemPageWithMeta(page: WikiPage): boolean {
  return SYSTEM_PAGE_SLUGS.has(page.slug) && (page.tags ?? []).includes(META_TAG);
}

/**
 * 聚合内容页的标签计数。排除 meta 系统页与 meta 标签本身。
 * 排序：count 降序，同 count 按 tag 字母升序。
 */
export function aggregateTags(pages: WikiPage[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    if (isSystemPageWithMeta(page)) continue;
    for (const tag of page.tags ?? []) {
      if (tag === META_TAG) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** 返回带指定 tag 的内容页（排除带 meta 的系统页）；区分大小写按原样匹配。 */
export function pagesWithTag(pages: WikiPage[], tag: string): WikiPage[] {
  return pages.filter((page) => !isSystemPageWithMeta(page) && (page.tags ?? []).includes(tag));
}
