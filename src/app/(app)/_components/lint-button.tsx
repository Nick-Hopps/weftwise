'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';

export default function LintButton() {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [jobId, setJobId] = useState<string | null>(null);

  const handleLint = async () => {
    setState('loading');
    try {
      const res = await apiFetch('/api/lint', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to start lint');
      const data = (await res.json()) as { jobId?: string };
      setJobId(data.jobId ?? null);
      if (data.jobId) {
        window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: data.jobId } }));
      }
      setState('done');
    } catch {
      setState('error');
    }
  };

  const label =
    state === 'loading'
      ? 'Starting...'
      : state === 'done'
      ? 'Lint started!'
      : state === 'error'
      ? 'Error — retry'
      : 'Run Lint';

  return (
    <button
      onClick={handleLint}
      disabled={state === 'loading'}
      className="flex flex-col gap-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-md transition-all group text-left disabled:opacity-60 disabled:cursor-not-allowed w-full"
    >
      <span className="text-2xl">✓</span>
      <span className="font-semibold text-zinc-800 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
        {label}
      </span>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        {state === 'done' && jobId
          ? `Job ${jobId.slice(0, 8)}... queued`
          : 'Check for broken links and missing content'}
      </span>
    </button>
  );
}
