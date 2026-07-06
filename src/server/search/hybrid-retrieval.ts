import * as pagesRepo from '@/server/db/repos/pages-repo';
import { isEmbeddingConfigured, generateEmbeddings } from '@/server/llm/provider-registry';
import { semanticSearch } from './semantic-search';
import { rrfMerge } from './vector-math';

export const RRF_K = 60;
export const VEC_K = 10;

/** FTS + 向量两路 RRF 合并的排名 slug 列表；未配置/嵌入失败 → 纯 FTS top-N。 */
export async function hybridRankSlugs(
  subjectId: string,
  question: string,
  topN: number
): Promise<string[]> {
  const ftsSlugs = pagesRepo.searchPages(subjectId, question).map((r) => r.page.slug);
  if (!isEmbeddingConfigured()) return ftsSlugs.slice(0, topN);
  try {
    const [qVec] = await generateEmbeddings([question]);
    const vecSlugs = semanticSearch(subjectId, qVec, VEC_K).map((r) => r.slug);
    return rrfMerge(ftsSlugs, vecSlugs, RRF_K, topN);
  } catch {
    return ftsSlugs.slice(0, topN);
  }
}
