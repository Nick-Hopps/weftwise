import * as checkpointsRepo from '../../db/repos/checkpoints-repo';
import type { ChangesetEntry, CheckpointProgress } from '@/lib/contracts';
import type { IngestCheckpoint } from '../types';

/**
 * 从 DB 载入某 job 的检查点到内存索引，并对外暴露 get/put（put 同步双写内存 + DB）。
 * 一次性 getCheckpoints 载入，避免每次查询命中 DB。
 */
export function loadCheckpoint(jobId: string): IngestCheckpoint {
  const summaries = new Map<string, string>();
  const pages = new Map<string, ChangesetEntry>();
  let plan: unknown | undefined;

  for (const row of checkpointsRepo.getCheckpoints(jobId)) {
    if (row.kind === 'chunk-summary') {
      const summary = (row.data as { summary?: string }).summary;
      if (typeof summary === 'string') summaries.set(row.key, summary);
    } else if (row.kind === 'plan') {
      plan = row.data;
    } else if (row.kind === 'writer-page') {
      pages.set(row.key, row.data as ChangesetEntry);
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
    hasAny: () => summaries.size > 0 || plan !== undefined || pages.size > 0,
    progress,
    clear: () => {
      summaries.clear();
      pages.clear();
      plan = undefined;
      checkpointsRepo.deleteCheckpoints(jobId);
    },
  };
}
