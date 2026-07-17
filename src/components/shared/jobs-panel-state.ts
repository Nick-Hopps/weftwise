export type TrackedJobStatus = 'idle' | 'streaming' | 'completed' | 'failed';

export interface TrackedJob {
  id: string;
  type: string;
  label: string;
  queueStatus: 'running' | 'pending';
  reconnectKey: number;
}

interface JobStatusInput {
  id: string;
  queueStatus: 'running' | 'pending';
}

export interface JobsPanelSummary {
  runningCount: number;
  pendingCount: number;
  completedCount: number;
  failedCount: number;
  finishedJobIds: string[];
  collapsedStatus: 'processing' | 'completed' | 'failed';
}

export function jobTypeVerb(type: string): string {
  switch (type) {
    case 'ingest': return 'Ingesting';
    case 'lint': return 'Linting';
    case 'curate': return 'Curating';
    case 'fix': return 'Fixing';
    case 're-enrich': return 'Enriching';
    case 'embed-index': return 'Indexing';
    case 'research': return 'Researching';
    case 'research-import': return 'Importing research';
    case 'image-insert': return 'Illustrating';
    default: return 'Processing';
  }
}

export function shouldRefreshPageForCompletedJob(
  type: string,
  status: TrackedJobStatus,
): boolean {
  return type === 'image-insert' && status === 'completed';
}

export function summarizeJobsPanel(
  jobs: JobStatusInput[],
  statuses: Readonly<Partial<Record<string, TrackedJobStatus>>>,
): JobsPanelSummary {
  let runningCount = 0;
  let pendingCount = 0;
  let completedCount = 0;
  let failedCount = 0;
  const finishedJobIds: string[] = [];

  for (const job of jobs) {
    const status = statuses[job.id];
    if (status === 'completed') {
      completedCount += 1;
      finishedJobIds.push(job.id);
    } else if (status === 'failed') {
      failedCount += 1;
      finishedJobIds.push(job.id);
    } else if (job.queueStatus === 'running') {
      runningCount += 1;
    } else {
      pendingCount += 1;
    }
  }

  const hasActiveJobs = runningCount + pendingCount > 0;
  return {
    runningCount,
    pendingCount,
    completedCount,
    failedCount,
    finishedJobIds,
    collapsedStatus: hasActiveJobs
      ? 'processing'
      : failedCount > 0
        ? 'failed'
        : 'completed',
  };
}

export function recoverUnlistedTrackedJobs(
  previous: readonly TrackedJob[],
  activeIds: ReadonlySet<string>,
  dismissed: ReadonlySet<string>,
): TrackedJob[] {
  return previous.flatMap((job) => {
    if (activeIds.has(job.id) || dismissed.has(job.id)) return [];
    if (job.queueStatus === 'running') return [job];
    return [{ ...job, queueStatus: 'running' as const }];
  });
}
