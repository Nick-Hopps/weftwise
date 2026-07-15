import type { Job, PendingActionView } from './contracts';

export const JOB_STARTED_EVENT = 'wiki:job-started';

export interface JobStartedEventDetail {
  jobId: string;
  type: Job['type'];
  label: string;
  queueStatus: 'pending' | 'running';
}

export function dispatchJobStarted(detail: JobStartedEventDetail): void {
  window.dispatchEvent(new CustomEvent(JOB_STARTED_EVENT, { detail }));
}

/** 把已批准的 workflow action 转成全局任务追踪事件；页面同步写入没有后台 job。 */
export function jobStartedDetailForAction(
  action: PendingActionView,
): JobStartedEventDetail | null {
  if (!action.jobId) return null;
  if (action.operation === 'workflow-reenrich-start' || action.operation === 'reenrich') {
    return {
      jobId: action.jobId,
      type: 're-enrich',
      label: action.affectedPages[0]?.slug ?? 'page',
      queueStatus: 'pending',
    };
  }
  if (action.operation === 'workflow-research-start') {
    return {
      jobId: action.jobId,
      type: 'research',
      label: action.summary,
      queueStatus: 'pending',
    };
  }
  return null;
}

export function isIngestJobStarted(
  detail: JobStartedEventDetail | null | undefined,
): detail is JobStartedEventDetail & { type: 'ingest' } {
  return detail?.type === 'ingest';
}
