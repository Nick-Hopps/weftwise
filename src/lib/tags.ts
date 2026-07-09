import type { WikiPage } from '@/lib/contracts';

export const META_TAG = 'meta';

function isMetaPage(page: WikiPage): boolean {
  return (page.tags ?? []).includes(META_TAG);
}

/**
 * 聚合内容页的标签计数。排除 meta 系统页与 meta 标签本身。
 * 排序：count 降序，同 count 按 tag 字母升序。
 */
export function aggregateTags(pages: WikiPage[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    if (isMetaPage(page)) continue;
    for (const tag of page.tags ?? []) {
      if (tag === META_TAG) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * 词云权重：对 count 取 log 平滑后 min-max 归一化到 [0,1]。
 * 单 tag 或全部同 count 时统一取 0.5，避免除零。
 */
export function tagCloudWeights(
  tags: { tag: string; count: number }[],
): { tag: string; count: number; weight: number }[] {
  if (tags.length === 0) return [];
  const logs = tags.map((t) => Math.log(t.count));
  const min = Math.min(...logs);
  const max = Math.max(...logs);
  const span = max - min;
  return tags.map((t, i) => ({
    ...t,
    weight: span === 0 ? 0.5 : (logs[i] - min) / span,
  }));
}

/** djb2 字符串哈希（无符号 32 位） */
function djb2(str: string): number {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h;
}

/**
 * 确定性打散：按 tag 名哈希排序，SSR/CSR 结果一致（不用 Math.random 防 hydration 抖动）。
 * 返回新数组，不修改输入。
 */
export function shuffleTagsDeterministic<T extends { tag: string }>(tags: T[]): T[] {
  return [...tags].sort((a, b) => djb2(a.tag) - djb2(b.tag) || a.tag.localeCompare(b.tag));
}

/** 返回带指定 tag 的内容页（排除带 meta 的系统页）；区分大小写按原样匹配。 */
export function pagesWithTag(pages: WikiPage[], tag: string): WikiPage[] {
  return pages.filter((page) => !isMetaPage(page) && (page.tags ?? []).includes(tag));
}
