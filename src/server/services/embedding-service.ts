import { registerHandler } from '@/server/jobs/worker';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import * as embeddingsRepo from '@/server/db/repos/embeddings-repo';
import { readPageInSubject } from '@/server/wiki/wiki-store';
import {
  isEmbeddingConfigured,
  embeddingModelId,
  generateEmbeddings,
} from '@/server/llm/provider-registry';
import { encodeVector } from '@/server/search/vector-math';

const EMBED_TEXT_MAX_CHARS = 8000;
const EMBED_BATCH = 32;

function embedText(p: { title: string; summary?: string | null; body: string }): string {
  return [p.title, p.summary ?? '', p.body].join('\n\n').slice(0, EMBED_TEXT_MAX_CHARS);
}

/** 回填 subject 内缺/过期向量 + prune 孤儿。未配置 embedding 时 no-op。 */
export async function runEmbedIndex(subjectId: string): Promise<void> {
  if (!isEmbeddingConfigured()) return;
  const subject = subjectsRepo.getById(subjectId);
  if (!subject) return;

  const model = embeddingModelId();
  const pages = pagesRepo.getAllPages(subjectId);
  const existing = new Map(
    embeddingsRepo.listForSubject(subjectId, model).map((r) => [r.slug, r.contentHash])
  );

  const stale = pages.filter((p) => existing.get(p.slug) !== p.contentHash);

  for (let i = 0; i < stale.length; i += EMBED_BATCH) {
    const batch = stale.slice(i, i + EMBED_BATCH);
    const texts: string[] = [];
    const metas: { slug: string; contentHash: string }[] = [];
    for (const p of batch) {
      const doc = readPageInSubject(subject.slug, p.slug);
      if (!doc) continue;
      texts.push(embedText({ title: p.title, summary: p.summary, body: doc.body }));
      metas.push({ slug: p.slug, contentHash: p.contentHash });
    }
    if (texts.length === 0) continue;
    const vectors = await generateEmbeddings(texts);
    vectors.forEach((vec, idx) => {
      const m = metas[idx];
      embeddingsRepo.upsertEmbedding({
        subjectId,
        slug: m.slug,
        model,
        contentHash: m.contentHash,
        dim: vec.length,
        vector: encodeVector(vec),
      });
    });
  }

  embeddingsRepo.pruneOrphans(subjectId, pages.map((p) => p.slug));
}

export { enqueueEmbedIndex } from './embedding-enqueue';

registerHandler('embed-index', async (job) => {
  const params = JSON.parse(job.paramsJson) as { subjectId?: string };
  const subjectId = job.subjectId ?? params.subjectId ?? null;
  if (!subjectId) return {};
  await runEmbedIndex(subjectId);
  return {};
});
