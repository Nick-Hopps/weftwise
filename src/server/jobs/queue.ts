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

export function complete(jobId: string, result: Record<string, unknown>): void {
  jobsRepo.completeJob(jobId, result);
}

export function fail(jobId: string, error: unknown): void {
  jobsRepo.failJob(jobId, error);
}

export function get(jobId: string): Job | null {
  return jobsRepo.getJob(jobId);
}

export function list(filter?: jobsRepo.JobFilter): Job[] {
  return jobsRepo.listJobs(filter);
}

export function requeue(jobId: string): void {
  jobsRepo.requeueJob(jobId);
}

export function reclaimExpired(): number {
  return jobsRepo.reclaimExpiredJobs();
}

export function updateHeartbeat(jobId: string): void {
  jobsRepo.updateHeartbeat(jobId);
}
