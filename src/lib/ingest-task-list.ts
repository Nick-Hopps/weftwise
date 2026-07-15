import type { CheckpointProgress, Job } from '@/lib/contracts';

export interface IngestTask {
  id: string;
  sourceName: string;
  queueStatus: Job['status'];
  createdAt: string;
  checkpointProgress: CheckpointProgress | null;
}

type IngestJobWithProgress = Job & {
  checkpointProgress?: CheckpointProgress | null;
};

function sourceNameFromParams(job: Pick<Job, 'id' | 'paramsJson'>): string {
  try {
    const params = JSON.parse(job.paramsJson || '{}') as Record<string, unknown>;
    const candidate = params.filename ?? params.url ?? params.slug;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  } catch {
    // JSON 损坏时退回到稳定的任务 ID 标签。
  }
  return `Ingest ${job.id.slice(0, 8)}`;
}

export function ingestTaskFromJob(job: IngestJobWithProgress): IngestTask {
  return {
    id: job.id,
    sourceName: sourceNameFromParams(job),
    queueStatus: job.status,
    createdAt: job.createdAt,
    checkpointProgress: job.checkpointProgress ?? null,
  };
}

export function mergeIngestTasks(
  current: readonly IngestTask[],
  incoming: readonly IngestTask[],
): IngestTask[] {
  const byId = new Map(current.map((task) => [task.id, task]));
  for (const task of incoming) {
    const existing = byId.get(task.id);
    byId.set(task.id, {
      ...existing,
      ...task,
      sourceName: existing?.sourceName || task.sourceName,
    });
  }
  return [...byId.values()].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
}

export function pickInitialIngestTaskId(tasks: readonly IngestTask[]): string | null {
  for (const status of ['running', 'pending', 'failed'] as const) {
    const matching = tasks.filter((task) => task.queueStatus === status);
    if (matching.length > 0) return matching[matching.length - 1].id;
  }
  return tasks.at(-1)?.id ?? null;
}
