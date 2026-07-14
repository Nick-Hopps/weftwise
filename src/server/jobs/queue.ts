import * as jobsRepo from '../db/repos/jobs-repo';
import type { Job, SubjectId } from '@/lib/contracts';

export function enqueue(
  type: Job['type'],
  params?: Record<string, unknown>,
  subjectId: SubjectId | null = null
): Job {
  return jobsRepo.enqueueJob(type, params ?? {}, subjectId);
}

export function claim(type?: Job['type']): Job | null {
  return jobsRepo.claimNextJob(type);
}

export function complete(
  jobId: string,
  result: Record<string, unknown>,
  expectedAttempt: number,
): boolean {
  return jobsRepo.completeJob(jobId, result, expectedAttempt);
}

export function fail(jobId: string, error: unknown, expectedAttempt: number): boolean {
  return jobsRepo.failJob(jobId, error, expectedAttempt);
}

export function get(jobId: string): Job | null {
  return jobsRepo.getJob(jobId);
}

export function list(filter?: jobsRepo.JobFilter): Job[] {
  return jobsRepo.listJobs(filter);
}

export function listRecent(
  filter: jobsRepo.JobFilter | undefined,
  limit: number,
): Job[] {
  return jobsRepo.listRecentJobs(filter, limit);
}

export function listLatestCompletedLint(subjectId: SubjectId | null): Job | null {
  return jobsRepo.listLatestCompletedLint(subjectId);
}

export function requeue(jobId: string, expectedAttempt?: number): boolean {
  return jobsRepo.requeueJob(jobId, expectedAttempt);
}

export function requeueJobWithParams(
  jobId: string,
  patch: Record<string, unknown>
): Job | null {
  return jobsRepo.requeueJobWithParams(jobId, patch);
}

export function getOrCreateJobAtomic(
  input: jobsRepo.AtomicJobCreateInput,
): jobsRepo.AtomicJobCreateResult {
  return jobsRepo.getOrCreateJobAtomic(input);
}

export function reingestSourceAtomic(
  input: jobsRepo.AtomicSourceReingestInput,
): jobsRepo.AtomicSourceReingestResult {
  return jobsRepo.reingestSourceAtomic(input);
}

export function reclaimExpired(): number {
  return jobsRepo.reclaimExpiredJobs();
}

export function requestCancel(jobId: string): jobsRepo.CancelResult {
  return jobsRepo.requestCancel(jobId);
}

export function isCancelRequested(jobId: string): boolean {
  return jobsRepo.isCancelRequested(jobId);
}

export function updateHeartbeat(jobId: string, expectedAttempt: number): boolean {
  return jobsRepo.updateHeartbeat(jobId, expectedAttempt);
}

/** 清扫早于 cutoff 的 job_events，返回删除行数。 */
export function pruneEvents(cutoffIso: string): number {
  return jobsRepo.pruneJobEvents(cutoffIso);
}
