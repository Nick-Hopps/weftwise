'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { useRouter } from 'next/navigation';

export default function ResetButton() {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'confirm' | 'loading' | 'done' | 'error'>('idle');

  const handleClick = () => {
    if (state === 'idle' || state === 'error') {
      setState('confirm');
      return;
    }
    if (state === 'confirm') {
      performReset();
    }
  };

  const handleCancel = (e: React.MouseEvent) => {
    e.stopPropagation();
    setState('idle');
  };

  const performReset = async () => {
    setState('loading');
    try {
      const res = await apiFetch('/api/reset', { method: 'POST' });
      if (!res.ok) throw new Error('Failed to reset');
      setState('done');
      // Refresh page data after a short delay
      setTimeout(() => router.refresh(), 500);
    } catch {
      setState('error');
    }
  };

  if (state === 'confirm') {
    return (
      <div className="flex flex-col gap-2 rounded-xl border-2 border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/30 p-5 text-left w-full">
        <span className="text-sm font-semibold text-red-700 dark:text-red-400">
          Delete all wiki pages, sources, and jobs?
        </span>
        <span className="text-xs text-red-600/70 dark:text-red-400/70">
          This cannot be undone.
        </span>
        <div className="flex gap-2 mt-1">
          <button
            onClick={performReset}
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors"
          >
            Confirm Reset
          </button>
          <button
            onClick={handleCancel}
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-zinc-300 dark:border-zinc-600 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const label =
    state === 'loading'
      ? 'Resetting...'
      : state === 'done'
      ? 'Reset complete'
      : state === 'error'
      ? 'Error — retry'
      : 'Reset Wiki';

  const icon = state === 'done' ? '!' : '×';

  return (
    <button
      onClick={handleClick}
      disabled={state === 'loading'}
      className="flex flex-col gap-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 hover:border-red-400 dark:hover:border-red-500 hover:shadow-md transition-all group text-left disabled:opacity-60 disabled:cursor-not-allowed w-full"
    >
      <span className="text-2xl">{icon}</span>
      <span className={`font-semibold transition-colors ${
        state === 'done'
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-zinc-800 dark:text-slate-200 group-hover:text-red-600 dark:group-hover:text-red-400'
      }`}>
        {label}
      </span>
      <span className="text-xs text-zinc-500 dark:text-zinc-400">
        {state === 'done'
          ? 'All data cleared'
          : 'Clear all pages, sources, and jobs'}
      </span>
    </button>
  );
}
