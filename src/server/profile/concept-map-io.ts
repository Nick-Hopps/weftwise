import { getPageBySlug, getTitleToSlugMap } from '@/server/db/repos/pages-repo';
import { listForPage, listForSubject } from '@/server/db/repos/evidence-repo';
import { deriveMastery } from '@/server/profile/mastery';
import {
  groupByMastery,
  selectNeighborhood,
  type KnownConcepts,
  type MasteryEntry,
} from '@/server/profile/concept-map';
import type { EvidenceRow } from '@/lib/contracts';

export interface BuildKnownConceptsInput {
  userId: string;
  subject: { id: string; slug: string };
  selfSlug: string;
  body: string;
  /**
   * 可选预取。GET / POST 两条路径都要算一次地图，用**一次** `listForSubject`
   * 供给即可；不传的话这里会自己取一次——但**绝不要**退化成邻域内 N 次 `listForPage`。
   */
  evidenceBySlug?: Map<string, EvidenceRow[]>;
  now?: Date;
}

export interface KnownConceptsResult {
  concepts: KnownConcepts;
  /** 被 `MAX_NEIGHBORHOOD` 截掉的数量，供渲染时明说（不做静默截断）。 */
  omitted: number;
}

/**
 * 组合三个纯函数 + 页面标题解析 + 证据取数，算出一页的已知概念地图。
 *
 * 邻域取自**正文本身**（wikilink 就写在里面，连图查询都不用），因此注入量由页面自身的
 * 引用数决定、与 vault 规模无关——这正是「邻域 scoped 永不全库」那条硬约束的落点。
 */
export function buildKnownConceptsForPage({
  userId,
  subject,
  selfSlug,
  body,
  evidenceBySlug,
  now = new Date(),
}: BuildKnownConceptsInput): KnownConceptsResult {
  const titleMap = getTitleToSlugMap(subject.id);
  const { slugs, omitted } = selectNeighborhood(body, {
    currentSubjectSlug: subject.slug,
    selfSlug,
    // resolver 必传：没有它，正文里的 `[[某某标题]]` 只能回落 normalizeSlug(title)，
    // 邻域会静默漏掉概念且不报错。
    titleResolver: (title) => titleMap.get(title) ?? titleMap.get(title.toLowerCase()),
  });

  const entries: MasteryEntry[] = [];
  for (const slug of slugs) {
    const page = getPageBySlug(subject.id, slug);
    // 页面已删：跳过，不进任何段（坏链在正文里是常态，不该因此报错）。
    if (!page) continue;
    const rows = evidenceBySlug
      ? (evidenceBySlug.get(slug) ?? [])
      : listForPage(userId, subject.id, slug);
    entries.push({ slug, title: page.title, verdict: deriveMastery(rows, now) });
  }

  return { concepts: groupByMastery(entries), omitted };
}

/** GET / POST 共用的一次性证据取数。 */
export function loadSubjectEvidence(userId: string, subjectId: string): Map<string, EvidenceRow[]> {
  return listForSubject(userId, subjectId);
}
