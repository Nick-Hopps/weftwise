'use client';

import { useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ProgressToast } from './progress-toast';
import { useJobStream } from '@/hooks/use-job-stream';
import { apiFetch } from '@/lib/api-fetch';

/**
 * Polls for active jobs and shows a global ProgressToast.
 * Mounted once in Providers so progress is visible from any page.
 * Invalidates relevant queries when jobs complete.
 */
export function GlobalJobTracker() {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  // Bumped to force a re-subscribe when a job we already track restarts (e.g. a
  // manual retry keeps the same id, so activeJobId alone wouldn't change and the
  // stream would stay frozen on the failed snapshot).
  const [reconnectKey, setReconnectKey] = useState(0);
  const queryClient = useQueryClient();
  const { status } = useJobStream(activeJobId, reconnectKey);

  // Invalidate pages query when a job completes so sidebar/dashboard refresh
  useEffect(() => {
    if (status === 'completed') {
      queryClient.invalidateQueries({ queryKey: ['pages'] });
      queryClient.invalidateQueries({ queryKey: ['page-detail'] });
    }
  }, [status, queryClient]);

  const checkActiveJobs = useCallback(async () => {
    try {
      const res = await apiFetch('/api/jobs?status=running');
      if (!res.ok) return;
      const jobs = await res.json();
      if (Array.isArray(jobs) && jobs.length > 0) {
        setActiveJobId(jobs[0].id);
      }
    } catch {
      // ignore network errors
    }
  }, []);

  useEffect(() => {
    checkActiveJobs();
    const interval = setInterval(checkActiveJobs, 5000);
    return () => clearInterval(interval);
  }, [checkActiveJobs]);

  // Listen for custom events dispatched by components that start (or retry) jobs.
  // Bump reconnectKey unconditionally so a retry of the already-tracked job
  // (same id) still re-subscribes instead of staying stuck on the failed stream.
  useEffect(() => {
    function onJobStarted(e: CustomEvent<{ jobId: string }>) {
      setActiveJobId(e.detail.jobId);
      setReconnectKey((k) => k + 1);
    }
    window.addEventListener('wiki:job-started', onJobStarted as EventListener);
    return () => window.removeEventListener('wiki:job-started', onJobStarted as EventListener);
  }, []);

  return (
    <ProgressToast
      jobId={activeJobId}
      onClose={() => setActiveJobId(null)}
    />
  );
}
