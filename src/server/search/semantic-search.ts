import * as embeddingsRepo from '@/server/db/repos/embeddings-repo';
import { embeddingModelId } from '@/server/llm/provider-registry';
import { decodeVector, cosineSimilarity } from './vector-math';

/** 当前模型向量 → cosine vs queryVector → 降序 topK。 */
export function semanticSearch(
  subjectId: string,
  queryVector: number[],
  k: number
): { slug: string; score: number }[] {
  const model = embeddingModelId();
  const rows = embeddingsRepo.listForSubject(subjectId, model);
  const scored = rows.map((r) => ({
    slug: r.slug,
    score: cosineSimilarity(queryVector, decodeVector(r.vector)),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}
