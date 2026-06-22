import * as checkpointsRepo from '../../db/repos/checkpoints-repo';
import type { ChangesetEntry, CheckpointProgress } from '@/lib/contracts';
import type { IngestCheckpoint, CitedSource } from '../types';

/**
 * 从 DB 载入某 job 的检查点到内存索引，并对外暴露 get/put（put 同步双写内存 + DB）。
 * 一次性 getCheckpoints 载入，避免每次查询命中 DB。
 */
export function loadCheckpoint(jobId: string): IngestCheckpoint {
  const summaries = new Map<string, string>();
  const pages = new Map<string, ChangesetEntry>();
  const enricherPages = new Map<string, ChangesetEntry>();
  const verifierPages = new Map<string, ChangesetEntry>();
  let plan: unknown | undefined;
  let citedSources: CitedSource[] = [];

  for (const row of checkpointsRepo.getCheckpoints(jobId)) {
    if (row.kind === 'chunk-summary') {
      const summary = (row.data as { summary?: string }).summary;
      if (typeof summary === 'string') summaries.set(row.key, summary);
    } else if (row.kind === 'plan') {
      plan = row.data;
    } else if (row.kind === 'writer-page') {
      pages.set(row.key, row.data as ChangesetEntry);
    } else if (row.kind === 'enricher-page') {
      enricherPages.set(row.key, row.data as ChangesetEntry);
    } else if (row.kind === 'verifier-page') {
      verifierPages.set(row.key, row.data as ChangesetEntry);
    } else if (row.kind === 'cited-sources') {
      citedSources = (row.data as { list?: CitedSource[] }).list ?? [];
    }
  }

  function progress(): CheckpointProgress {
    let totalPages: number | null = null;
    if (plan && typeof plan === 'object') {
      const p = (plan as { plan?: { pages?: unknown[] } }).plan;
      if (p?.pages && Array.isArray(p.pages)) totalPages = p.pages.length;
    }
    return {
      plan: plan !== undefined,
      chunkSummaries: summaries.size,
      writerPages: pages.size,
      totalPages,
    };
  }

  return {
    getChunkSummary: (key) => summaries.get(key),
    putChunkSummary: (key, summary) => {
      // DB 优先：落盘成功后再写内存，避免 DB 抛错时留下半提交态。
      checkpointsRepo.putCheckpoint(jobId, 'chunk-summary', key, { summary });
      summaries.set(key, summary);
    },
    getPlan: () => plan,
    putPlan: (output) => {
      // plan 每个 job 仅一份，key 固定空串（getProgress 按 key='' 反查）
      checkpointsRepo.putCheckpoint(jobId, 'plan', '', output);
      plan = output;
    },
    getWriterPage: (slug) => pages.get(slug),
    putWriterPage: (slug, entry) => {
      checkpointsRepo.putCheckpoint(jobId, 'writer-page', slug, entry);
      pages.set(slug, entry);
    },
    getEnricherPage: (slug) => enricherPages.get(slug),
    putEnricherPage: (slug, entry) => {
      checkpointsRepo.putCheckpoint(jobId, 'enricher-page', slug, entry);
      enricherPages.set(slug, entry);
    },
    getVerifierPage: (slug) => verifierPages.get(slug),
    putVerifierPage: (slug, entry) => {
      checkpointsRepo.putCheckpoint(jobId, 'verifier-page', slug, entry);
      verifierPages.set(slug, entry);
    },
    // ⑨ 续传补源：整张去重后列表存为单 blob（kind='cited-sources'，key 固定空串）。
    getCitedSources: () => citedSources,
    putCitedSources: (list) => {
      // DB 优先：落盘成功后再写内存（与其余 put* 一致）。
      checkpointsRepo.putCheckpoint(jobId, 'cited-sources', '', { list });
      citedSources = list;
    },
    hasAny: () => summaries.size > 0 || plan !== undefined || pages.size > 0 || enricherPages.size > 0 || verifierPages.size > 0 || citedSources.length > 0,
    progress,
    clear: () => {
      summaries.clear();
      pages.clear();
      enricherPages.clear();
      verifierPages.clear();
      plan = undefined;
      citedSources = [];
      checkpointsRepo.deleteCheckpoints(jobId);
    },
  };
}
