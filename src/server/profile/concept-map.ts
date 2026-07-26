/**
 * 已知概念地图的三个纯函数（无 IO，可完整单测）。
 *
 * 设计要点见 `docs/specs/2026-07-26-known-concept-map-surfaces.md`：
 * - E1：邻域取自正文本身，不查图；硬上界 `MAX_NEIGHBORHOOD`
 * - E2：三段清单 + 「未列出即不懂」兜底 + `[[slug]]` 书写纪律
 */

import { extractWikiLinks, type TitleResolver } from '@/server/wiki/wikilinks';
import { META_PAGE_SLUGS } from '@/server/wiki/page-identity';
import type { MasteryState, MasteryVerdict } from '@/lib/contracts';

/**
 * 注入邻域的硬上界。
 *
 * 「与 vault 规模无关」不等于「有界」——一张综述性质的页面链出 150 个概念完全可能，
 * 那就是 150 行注入。项目在 T2.1 正是因为「prompt 随规模单调膨胀」把 index/log 整个
 * 改成了确定性渲染；这里先把闸门装上，而不是等它长出来。
 */
export const MAX_NEIGHBORHOOD = 40;

export interface SelectNeighborhoodOptions {
  currentSubjectSlug: string;
  selfSlug: string;
  /**
   * **必传**。正文里的 `[[某某标题]]` 若没有 resolver，`extractWikiLinks` 只能回落
   * `normalizeSlug(title)`——对中文标题未必等于真实 slug，邻域会**静默漏掉概念且不报错**。
   * 由 IO 层用 `pages-repo::getTitleToSlugMap(subjectId)` 供给。
   */
  titleResolver: TitleResolver;
}

export interface Neighborhood {
  slugs: string[];
  /** 被 `MAX_NEIGHBORHOOD` 截掉的数量。>0 时注入段必须明说，**不做静默截断**。 */
  omitted: number;
}

/**
 * 从正文抽本 subject 内的 1 跳 wikilink 目标。
 *
 * 按**首次出现顺序**去重与截断：确定性、零成本，且正文里越早提到的概念通常越核心。
 * 这个顺序同时是 E5 确定性序列化的基础——换成 Map 遍历顺序或按掌握度排序，
 * 同一份地图两次算出的 JSON 就可能不同，`Update available` 会永远消不掉。
 *
 * 返回**带截断计数**的对象而非裸数组：调用方无法从截断后的列表反推被丢了多少，
 * 而 E1 要求截断时在注入段末尾明说——否则模型会把「未列出」误读成「读者不懂」。
 */
export function selectNeighborhood(
  body: string,
  { currentSubjectSlug, selfSlug, titleResolver }: SelectNeighborhoodOptions,
): Neighborhood {
  const links = extractWikiLinks(body, { currentSubjectSlug, titleResolver });
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const link of links) {
    // 跨 subject 目标不计：同 slug 在不同 subject 语义不同，项目本身就这么隔离。
    if (link.targetSubjectSlug !== currentSubjectSlug) continue;
    const slug = link.target;
    if (slug === selfSlug) continue;
    if (META_PAGE_SLUGS.has(slug)) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    ordered.push(slug);
  }

  return {
    slugs: ordered.slice(0, MAX_NEIGHBORHOOD),
    omitted: Math.max(0, ordered.length - MAX_NEIGHBORHOOD),
  };
}

export interface KnownConcept {
  slug: string;
  title: string;
  state: Exclude<MasteryState, 'unknown'>;
}

export interface KnownConcepts {
  mastered: KnownConcept[];
  exposed: KnownConcept[];
  struggling: KnownConcept[];
}

export interface MasteryEntry {
  slug: string;
  title: string;
  verdict: MasteryVerdict;
}

/**
 * 四态 → 三段。`unknown` **完全不出现**——它由兜底句统一覆盖（未列出即不懂）。
 *
 * `confidence === 'low'` 的 `mastered` **降级进 exposed 段**：保守原则，
 * 低置信度的「已掌握」不足以支撑「完全不讲」。
 *
 * 保持输入顺序（= 邻域首次出现顺序），供 E5 的确定性序列化。
 */
export function groupByMastery(entries: readonly MasteryEntry[]): KnownConcepts {
  const result: KnownConcepts = { mastered: [], exposed: [], struggling: [] };

  for (const { slug, title, verdict } of entries) {
    switch (verdict.state) {
      case 'mastered':
        if (verdict.confidence === 'low') result.exposed.push({ slug, title, state: 'exposed' });
        else result.mastered.push({ slug, title, state: 'mastered' });
        break;
      case 'exposed':
        result.exposed.push({ slug, title, state: 'exposed' });
        break;
      case 'struggling':
        result.struggling.push({ slug, title, state: 'struggling' });
        break;
      case 'unknown':
        break;
    }
  }

  return result;
}

const SECTION_HEADINGS = {
  mastered: 'Already solid — reference as [[slug]], do NOT re-explain:',
  exposed: 'Seen before — a one-line recap is enough:',
  struggling: 'Known trouble spot — explain carefully and try a different angle:',
} as const;

export interface RenderKnownConceptsOptions {
  /** 邻域截断掉的概念数；>0 时段末明说，**不做静默截断**。 */
  omittedCount?: number;
}

/**
 * 渲染注入段。**三段全空返回 `null`**（调用方据此整段不注入，
 * 保证零证据时 prompt 与今天逐字节相同）。
 */
export function renderKnownConcepts(
  k: KnownConcepts,
  { omittedCount = 0 }: RenderKnownConceptsOptions = {},
): string | null {
  const sections = (['mastered', 'exposed', 'struggling'] as const).filter((key) => k[key].length);
  if (sections.length === 0) return null;

  const lines: string[] = [
    "=== READER'S KNOWN CONCEPTS (this subject) ===",
    // 这句纪律不是可选的：RESHAPE_PAGE_SYSTEM_PROMPT 通篇没提 wikilink，而 reshape 已被
    // 移出保真护栏，模型可以自由增删链接。不显式要求 `[[slug]]`，它很可能写成纯文本
    // 「如你已知的梯度下降」——而 E3 的纠错入口挂在 wikilink 上，唯一的翻案通道就断了。
    'When you mention any concept listed below, write it as a [[slug]] wikilink',
    'using EXACTLY the slug shown — that link is the reader’s correction handle.',
  ];

  for (const key of sections) {
    lines.push(SECTION_HEADINGS[key]);
    for (const c of k[key]) lines.push(`  [[${c.slug}]] ${c.title}`);
  }

  if (omittedCount > 0) {
    // 静默截断会让模型把「未列出」误读成「读者不懂」，反而多讲一堆。
    lines.push(
      `(${omittedCount} more related concepts on this page were not listed here — ` +
        'no conclusion should be drawn about them.)',
    );
  }

  lines.push('Anything not listed here: assume unfamiliar and explain it normally.');
  return lines.join('\n');
}
