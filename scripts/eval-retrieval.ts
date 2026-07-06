/**
 * 检索评估基线脚本（T2.5）。
 *
 * 用途：在自包含的合成语料上，分别跑「纯 FTS」「纯向量」「混合 RRF」三路检索，
 * 输出 recall@5 / recall@10 / MRR 汇总表，为后续检索改动（如向量缓存、参数调整）
 * 提供可复现的回归基线。
 *
 * 安全性：全程使用临时目录作为 VAULT_PATH / DATABASE_PATH（显式覆盖 env，
 * 运行前后与真实 vault/DB 无任何交集），跑完自动清理临时目录。
 *
 * Usage:
 *   npm run eval:retrieval
 *   npx tsx scripts/eval-retrieval.ts
 */

import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface GoldenPage {
  slug: string;
  title: string;
  tags: string[];
  content: string;
}

interface GoldenQuery {
  query: string;
  expectedSlugs: string[];
}

interface GoldenSet {
  pages: GoldenPage[];
  queries: GoldenQuery[];
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'retrieval-eval-'));
  const prevDbPath = process.env.DATABASE_PATH;
  const prevVaultPath = process.env.VAULT_PATH;
  process.env.DATABASE_PATH = join(dir, 'wiki.db');
  process.env.VAULT_PATH = join(dir, 'vault');

  try {
    // 动态 import：必须等 env 覆盖之后再加载 db client 单例，避免复用真实路径。
    const subjectsRepo = await import('../src/server/db/repos/subjects-repo');
    const pagesRepo = await import('../src/server/db/repos/pages-repo');
    const { semanticSearch } = await import('../src/server/search/semantic-search');
    const { rrfMerge } = await import('../src/server/search/vector-math');
    const { isEmbeddingConfigured, generateEmbeddings } = await import(
      '../src/server/llm/provider-registry'
    );
    const embeddingsRepo = await import('../src/server/db/repos/embeddings-repo');
    const { encodeVector } = await import('../src/server/search/vector-math');
    const { summarizeEval } = await import('../src/server/search/eval-metrics');

    const goldenPath = join(__dirname, 'fixtures', 'retrieval-golden.json');
    const golden = JSON.parse(readFileSync(goldenPath, 'utf-8')) as GoldenSet;

    console.log('');
    console.log('=== T2.5 检索评估基线 ===');
    console.log(`语料页数：${golden.pages.length}  查询数：${golden.queries.length}`);
    console.log(`临时 DB: ${process.env.DATABASE_PATH}`);
    console.log('');

    const subject = subjectsRepo.create({ slug: 'eval-corpus', name: 'Retrieval Eval Corpus' });
    const now = new Date().toISOString();

    for (const page of golden.pages) {
      pagesRepo.upsertPage({
        subjectId: subject.id,
        slug: page.slug,
        title: page.title,
        path: `wiki/${subject.slug}/${page.slug}.md`,
        summary: page.content.slice(0, 80),
        contentHash: `hash-${page.slug}`,
        tags: page.tags,
        createdAt: now,
        updatedAt: now,
      });
      pagesRepo.updateFtsEntry(subject.id, page.slug, page.title, page.content.slice(0, 80), page.content);
    }

    // isEmbeddingConfigured() 在 llm-config.json 完全缺失时会抛错（而非返回 false）——
    // 评估环境未必配置 LLM，这里视同"未配置"优雅降级为跳过向量路径。
    let embeddingAvailable = false;
    try {
      embeddingAvailable = isEmbeddingConfigured();
    } catch {
      embeddingAvailable = false;
    }
    if (embeddingAvailable) {
      console.log('检测到 embedding 配置，将同时评估向量与混合检索路径。');
      const texts = golden.pages.map((p) => `${p.title}\n\n${p.content}`);
      const vectors = await generateEmbeddings(texts);
      const model = (await import('../src/server/llm/provider-registry')).embeddingModelId();
      golden.pages.forEach((page, i) => {
        embeddingsRepo.upsertEmbedding({
          subjectId: subject.id,
          slug: page.slug,
          model,
          contentHash: `hash-${page.slug}`,
          dim: vectors[i].length,
          vector: encodeVector(vectors[i]),
        });
      });
    } else {
      console.log('未检测到 embedding 配置 —— 跳过纯向量路径评估，混合 RRF 将退化为纯 FTS。');
    }
    console.log('');

    const ftsResults: { ranked: string[]; expected: string[] }[] = [];
    const vecResults: { ranked: string[]; expected: string[] }[] = [];
    const hybridResults: { ranked: string[]; expected: string[] }[] = [];

    for (const q of golden.queries) {
      const ftsSlugs = pagesRepo.searchPages(subject.id, q.query).map((r) => r.page.slug);
      ftsResults.push({ ranked: ftsSlugs, expected: q.expectedSlugs });

      if (embeddingAvailable) {
        const [qVec] = await generateEmbeddings([q.query]);
        const vecSlugs = semanticSearch(subject.id, qVec, 10).map((r) => r.slug);
        vecResults.push({ ranked: vecSlugs, expected: q.expectedSlugs });

        const hybridSlugs = rrfMerge(ftsSlugs, vecSlugs, 60, 10);
        hybridResults.push({ ranked: hybridSlugs, expected: q.expectedSlugs });
      } else {
        // 未配置 embedding：混合路径退化为纯 FTS（与 hybrid-retrieval.ts 生产逻辑一致）。
        hybridResults.push({ ranked: ftsSlugs.slice(0, 10), expected: q.expectedSlugs });
      }
    }

    const ftsSummary = summarizeEval(ftsResults);
    const hybridSummary = summarizeEval(hybridResults);
    const vecSummary = embeddingAvailable ? summarizeEval(vecResults) : null;

    const rows: Record<string, { 'recall@5': string; 'recall@10': string; MRR: string; queries: number }> = {
      'FTS（纯关键词）': fmtRow(ftsSummary),
      '向量（语义）': vecSummary ? fmtRow(vecSummary) : ({ 'recall@5': 'N/A', 'recall@10': 'N/A', MRR: 'N/A', queries: 0 } as any),
      '混合 RRF': fmtRow(hybridSummary),
    };

    console.table(rows);
    if (!embeddingAvailable) {
      console.log('说明：向量路径 N/A 因未配置 embedding；混合路径在此环境下与 FTS 数值一致（预期内的退化）。');
    }
    console.log('');
  } finally {
    process.env.DATABASE_PATH = prevDbPath;
    process.env.VAULT_PATH = prevVaultPath;
    rmSync(dir, { recursive: true, force: true });
  }
}

function fmtRow(s: { recallAt5: number; recallAt10: number; mrr: number; queryCount: number }) {
  return {
    'recall@5': s.recallAt5.toFixed(3),
    'recall@10': s.recallAt10.toFixed(3),
    MRR: s.mrr.toFixed(3),
    queries: s.queryCount,
  };
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('评估失败：', err);
    process.exit(1);
  });
