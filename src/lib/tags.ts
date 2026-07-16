import type { WikiPage } from '@/lib/contracts';

export const META_TAG = 'meta';

export type TagSort = 'count' | 'name' | 'recent';
export type TagMatchMode = 'and' | 'or';

export interface TagSummary {
  tag: string;
  count: number;
  coverage: number;
  updatedAt: string | null;
  pages: WikiPage[];
}

export interface TagStats {
  pageCount: number;
  taggedPageCount: number;
  tagCount: number;
  singletonCount: number;
  duplicateGroups: string[][];
}

export interface RelatedTag {
  tag: string;
  count: number;
}

export interface TagVariantReviewGroup {
  canonical: TagSummary;
  variants: TagSummary[];
}

export interface TagReviewQueue {
  variantGroups: TagVariantReviewGroup[];
  singletonTags: TagSummary[];
  untaggedPages: WikiPage[];
  issueCount: number;
}

function isMetaPage(page: WikiPage): boolean {
  return (page.tags ?? []).includes(META_TAG);
}

export function contentPages(pages: WikiPage[]): WikiPage[] {
  return pages.filter((page) => !isMetaPage(page));
}

/** 构建标签目录所需的计数、覆盖率、更新时间与关联页面。 */
export function summarizeTags(pages: WikiPage[]): TagSummary[] {
  const visiblePages = contentPages(pages);
  const byTag = new Map<string, WikiPage[]>();

  for (const page of visiblePages) {
    for (const tag of page.tags ?? []) {
      if (tag === META_TAG) continue;
      const taggedPages = byTag.get(tag) ?? [];
      taggedPages.push(page);
      byTag.set(tag, taggedPages);
    }
  }

  return [...byTag.entries()]
    .map(([tag, taggedPages]) => ({
      tag,
      count: taggedPages.length,
      coverage: visiblePages.length === 0 ? 0 : taggedPages.length / visiblePages.length,
      updatedAt: taggedPages.reduce<string | null>(
        (latest, page) => (!latest || page.updatedAt > latest ? page.updatedAt : latest),
        null,
      ),
      pages: taggedPages,
    }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** 只用于治理提示：忽略大小写，并统一空格、下划线和连字符。 */
export function normalizeTagForComparison(tag: string): string {
  return tag
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_-]+/g, '-');
}

export function findPotentialDuplicateGroups(tags: Array<Pick<TagSummary, 'tag'>>): string[][] {
  const groups = new Map<string, string[]>();
  for (const { tag } of tags) {
    const key = normalizeTagForComparison(tag);
    const variants = groups.get(key) ?? [];
    if (!variants.includes(tag)) variants.push(tag);
    groups.set(key, variants);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => group.sort((a, b) => a.localeCompare(b)))
    .sort((a, b) => a[0].localeCompare(b[0]));
}

export function tagStats(pages: WikiPage[], summaries = summarizeTags(pages)): TagStats {
  const visiblePages = contentPages(pages);
  return {
    pageCount: visiblePages.length,
    taggedPageCount: visiblePages.filter((page) =>
      (page.tags ?? []).some((tag) => tag !== META_TAG),
    ).length,
    tagCount: summaries.length,
    singletonCount: summaries.filter((summary) => summary.count === 1).length,
    duplicateGroups: findPotentialDuplicateGroups(summaries),
  };
}

function compareCanonicalCandidate(a: TagSummary, b: TagSummary): number {
  const countOrder = b.count - a.count;
  if (countOrder !== 0) return countOrder;

  const aIsCanonical = a.tag === normalizeTagForComparison(a.tag);
  const bIsCanonical = b.tag === normalizeTagForComparison(b.tag);
  if (aIsCanonical !== bIsCanonical) return aIsCanonical ? -1 : 1;
  return a.tag.localeCompare(b.tag);
}

function pageMatchesQuery(page: WikiPage, query: string): boolean {
  return page.title.toLocaleLowerCase().includes(query)
    || page.slug.toLocaleLowerCase().includes(query)
    || (page.summary ?? '').toLocaleLowerCase().includes(query);
}

/** 把即时标签统计投影为无需持久化状态的清理队列。 */
export function buildTagReviewQueue(
  pages: WikiPage[],
  summaries = summarizeTags(pages),
): TagReviewQueue {
  const summariesByTag = new Map(summaries.map((summary) => [summary.tag, summary]));
  const variantTags = new Set<string>();
  const variantGroups = findPotentialDuplicateGroups(summaries).map((group) => {
    const candidates = group
      .map((tag) => summariesByTag.get(tag))
      .filter((summary): summary is TagSummary => Boolean(summary))
      .sort(compareCanonicalCandidate);
    const canonical = candidates[0];
    for (const candidate of candidates) variantTags.add(candidate.tag);
    return {
      canonical,
      variants: candidates.slice(1).sort((a, b) => a.tag.localeCompare(b.tag)),
    };
  }).filter((group): group is TagVariantReviewGroup => Boolean(group.canonical));

  const singletonTags = summaries
    .filter((summary) => summary.count === 1 && !variantTags.has(summary.tag))
    .sort((a, b) => a.tag.localeCompare(b.tag));
  const untaggedPages = contentPages(pages)
    .filter((page) => (page.tags ?? []).filter((tag) => tag !== META_TAG).length === 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
  const issueCount = variantGroups.reduce((count, group) => count + group.variants.length, 0)
    + singletonTags.length
    + untaggedPages.length;

  return { variantGroups, singletonTags, untaggedPages, issueCount };
}

/** 搜索三个 Review 分区；命中任一格式变体时保留完整分组上下文。 */
export function filterTagReviewQueue(queue: TagReviewQueue, query: string): TagReviewQueue {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return queue;

  const variantGroups = queue.variantGroups.filter((group) =>
    [group.canonical, ...group.variants].some((summary) =>
      summary.tag.toLocaleLowerCase().includes(normalizedQuery)
      || summary.pages.some((page) => pageMatchesQuery(page, normalizedQuery)),
    ),
  );
  const singletonTags = queue.singletonTags.filter((summary) =>
    summary.tag.toLocaleLowerCase().includes(normalizedQuery)
    || summary.pages.some((page) => pageMatchesQuery(page, normalizedQuery)),
  );
  const untaggedPages = queue.untaggedPages.filter((page) =>
    pageMatchesQuery(page, normalizedQuery),
  );
  const issueCount = variantGroups.reduce((count, group) => count + group.variants.length, 0)
    + singletonTags.length
    + untaggedPages.length;

  return { variantGroups, singletonTags, untaggedPages, issueCount };
}

export function filterTagSummaries(summaries: TagSummary[], query: string): TagSummary[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return summaries;
  return summaries.filter((summary) =>
    summary.tag.toLocaleLowerCase().includes(normalizedQuery)
    || summary.pages.some((page) =>
      page.title.toLocaleLowerCase().includes(normalizedQuery)
      || page.slug.toLocaleLowerCase().includes(normalizedQuery)
      || (page.summary ?? '').toLocaleLowerCase().includes(normalizedQuery),
    ),
  );
}

export function sortTagSummaries(summaries: TagSummary[], sort: TagSort): TagSummary[] {
  return [...summaries].sort((a, b) => {
    if (sort === 'name') return a.tag.localeCompare(b.tag);
    if (sort === 'recent') {
      return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.tag.localeCompare(b.tag);
    }
    return b.count - a.count || a.tag.localeCompare(b.tag);
  });
}

/** 返回同时或任意带指定标签的内容页，并支持页面文本过滤与排序。 */
export function filterPagesByTags(
  pages: WikiPage[],
  tags: string[],
  mode: TagMatchMode = 'and',
  query = '',
  sort: 'recent' | 'title' = 'recent',
): WikiPage[] {
  const uniqueTags = [...new Set(tags)];
  const normalizedQuery = query.trim().toLocaleLowerCase();

  return contentPages(pages)
    .filter((page) => {
      const pageTags = page.tags ?? [];
      if (uniqueTags.length > 0) {
        const matches = mode === 'and'
          ? uniqueTags.every((tag) => pageTags.includes(tag))
          : uniqueTags.some((tag) => pageTags.includes(tag));
        if (!matches) return false;
      }
      return !normalizedQuery
        || page.title.toLocaleLowerCase().includes(normalizedQuery)
        || page.slug.toLocaleLowerCase().includes(normalizedQuery)
        || (page.summary ?? '').toLocaleLowerCase().includes(normalizedQuery);
    })
    .sort((a, b) => sort === 'title'
      ? a.title.localeCompare(b.title)
      : b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title));
}

/** 在当前结果集内按共现页面数计算可继续收窄的标签。 */
export function relatedTags(
  pages: WikiPage[],
  selectedTags: string[],
  mode: TagMatchMode = 'and',
): RelatedTag[] {
  const selected = new Set(selectedTags);
  const matches = filterPagesByTags(pages, selectedTags, mode);
  const counts = new Map<string, number>();

  for (const page of matches) {
    for (const tag of page.tags ?? []) {
      if (tag === META_TAG || selected.has(tag)) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
