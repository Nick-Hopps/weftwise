'use client';

import { useState, useEffect, useCallback } from 'react';
import { JobsPanel, type TrackedJob } from './jobs-panel';
import { apiFetch } from '@/lib/api-fetch';
import type { Job } from '@/lib/contracts';
import { JOB_STARTED_EVENT, type JobStartedEventDetail } from '@/lib/job-started-event';

/** 从 job params 提取一行可读摘要（文件名 / URL / slug），兜底 job 类型名。 */
function jobLabel(job: Pick<Job, 'type' | 'paramsJson'>): string {
  const raw = job.paramsJson;
  let p: Record<string, unknown> = {};
  if (typeof raw === 'string') {
    try {
      p = (JSON.parse(raw || '{}') ?? {}) as Record<string, unknown>;
    } catch {
      p = {};
    }
  } else if (raw && typeof raw === 'object') {
    p = raw as Record<string, unknown>;
  }
  const candidate = p.filename ?? p.url ?? p.slug;
  if (typeof candidate === 'string' && candidate) return candidate;
  return job.type;
}

/**
 * Polls for active (running + pending) jobs and shows them in a single
 * aggregated JobsPanel. Mounted once in Providers so progress is visible
 * from any page. Per-row SSE subscription & query invalidation live in
 * JobsPanel rows.
 */
export function GlobalJobTracker() {
  const [jobs, setJobs] = useState<TrackedJob[]>([]);
  // 行级终态后用户/定时器移除的 id：轮询不再重新加回（防已完成 job 复现）。
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const checkActiveJobs = useCallback(async () => {
    try {
      const [runningRes, pendingRes] = await Promise.all([
        apiFetch('/api/jobs?status=running'),
        apiFetch('/api/jobs?status=pending'),
      ]);
      if (!runningRes.ok || !pendingRes.ok) return;
      const running = (await runningRes.json()) as Job[];
      const pending = (await pendingRes.json()) as Job[];
      const active = [
        ...running.map((j) => ({ job: j, queueStatus: 'running' as const })),
        ...pending.map((j) => ({ job: j, queueStatus: 'pending' as const })),
      ];
      setJobs((prev) => {
        const prevById = new Map(prev.map((t) => [t.id, t]));
        const activeIds = new Set(active.map((a) => a.job.id));
        const next: TrackedJob[] = active
          .filter((a) => !dismissed.has(a.job.id))
          .map((a) => ({
            id: a.job.id,
            type: a.job.type,
            // 事件已携带即时 label；轮询拿到权威 params 后保留稳定标签，避免闪变。
            label:
              prevById.get(a.job.id)?.label && prevById.get(a.job.id)!.label !== 'Starting…'
                ? prevById.get(a.job.id)!.label
                : jobLabel(a.job),
            queueStatus: a.queueStatus,
            reconnectKey: prevById.get(a.job.id)?.reconnectKey ?? 0,
          }));
        // 已离开 running/pending 的行仅在曾建过 SSE（running）时保留，终态展示由行内 SSE 驱动、移除走 onRemove；
        // pending 行从未建 SSE，若在两次轮询间隙直接走完 pending→终态，静默丢弃防幽灵行永久残留。
        for (const t of prev) {
          if (!activeIds.has(t.id) && !dismissed.has(t.id) && t.queueStatus === 'running') next.push(t);
        }
        return next;
      });
    } catch {
      // ignore network errors
    }
  }, [dismissed]);

  useEffect(() => {
    checkActiveJobs();
    const interval = setInterval(checkActiveJobs, 5000);
    return () => clearInterval(interval);
  }, [checkActiveJobs]);

  // 组件入队/重试即时补入；事件必须携带真实 job type，禁止消费者猜成 ingest。
  useEffect(() => {
    function onJobStarted(e: CustomEvent<JobStartedEventDetail>) {
      const { jobId, type, label, queueStatus } = e.detail;
      setDismissed((prev) => {
        if (!prev.has(jobId)) return prev;
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
      setJobs((prev) => {
        const existing = prev.find((t) => t.id === jobId);
        if (existing) {
          return prev.map((t) =>
            t.id === jobId
              ? {
                  ...t,
                  type,
                  label,
                  queueStatus,
                  reconnectKey: t.reconnectKey + 1,
                }
              : t,
          );
        }
        return [
          ...prev,
          { id: jobId, type, label, queueStatus, reconnectKey: 0 },
        ];
      });
    }
    window.addEventListener(JOB_STARTED_EVENT, onJobStarted as EventListener);
    return () => window.removeEventListener(JOB_STARTED_EVENT, onJobStarted as EventListener);
  }, []);

  const handleRemove = useCallback((id: string) => {
    setDismissed((prev) => new Set(prev).add(id));
    setJobs((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return <JobsPanel jobs={jobs} onRemove={handleRemove} />;
}
