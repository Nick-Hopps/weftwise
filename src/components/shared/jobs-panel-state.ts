export type TrackedJobStatus = 'idle' | 'streaming' | 'completed' | 'failed';

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
