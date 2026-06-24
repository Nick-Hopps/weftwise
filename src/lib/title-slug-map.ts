export interface TitleSluggable {
  title: string;
  slug: string;
}

/**
 * 构建 wikilink 解析用的 title→slug 映射，与阅读页服务端逻辑一致：
 * 同时写入原标题与小写标题两个 key（renderMarkdown 的 resolver 两者都查）。
 */
export function buildTitleSlugMap(pages: TitleSluggable[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const p of pages) {
    map[p.title] = p.slug;
    map[p.title.toLowerCase()] = p.slug;
  }
  return map;
}
