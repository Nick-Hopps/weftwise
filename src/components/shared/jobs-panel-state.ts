import type { Job } from '@/lib/contracts';
import type { MessageKey } from '@/lib/i18n/messages';
import { jobResultRequiresUrlAuth } from '@/lib/ingest-auth';

export type TrackedJobStatus = 'idle' | 'streaming' | 'completed' | 'failed';

export interface TrackedJob {
  id: string;
  type: string;
  label: string;
  subjectId: string | null;
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

export function jobTypeVerb(type: string): MessageKey {
  switch (type) {
    case 'ingest': return 'jobs.activity.ingest';
    case 'lint': return 'jobs.activity.lint';
    case 'curate': return 'jobs.activity.curate';
    case 'fix': return 'jobs.activity.fix';
    case 're-enrich': return 'jobs.activity.reenrich';
    case 'embed-index': return 'jobs.activity.embedIndex';
    case 'research': return 'jobs.activity.research';
    case 'research-import': return 'jobs.activity.researchImport';
    case 'image-insert': return 'jobs.activity.imageInsert';
    default: return 'jobs.activity.processing';
  }
}

export function shouldRefreshPageForCompletedJob(
  type: string,
  status: TrackedJobStatus,
): boolean {
  return type === 'image-insert' && status === 'completed';
}

export function isRecoverableUrlAuthJob(
  job: Pick<Job, 'type' | 'status' | 'resultJson'>,
): boolean {
  return job.type === 'ingest'
    && job.status === 'failed'
    && jobResultRequiresUrlAuth(job.resultJson);
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
