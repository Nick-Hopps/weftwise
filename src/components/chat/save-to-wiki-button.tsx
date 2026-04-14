'use client';
import { useState, useRef, useEffect } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { normalizeSlug } from '@/lib/slug';
import type { Citation } from './message-list';

interface SaveToWikiButtonProps {
  answer: string;
  citations: Citation[];
  onSaved?: (slug: string) => void;
}

export function SaveToWikiButton({
  answer,
  citations,
  onSaved,
}: SaveToWikiButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [savedJobId, setSavedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  const handleSave = async () => {
    if (!title.trim()) return;

    setIsLoading(true);
    setError(null);

    try {
      const response = await apiFetch('/api/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          saveAsPage: true,
          pageTitle: title.trim(),
          answer,
          citations,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }

      const data = (await response.json()) as { jobId?: string };
      if (data.jobId) {
        setSavedJobId(data.jobId);
        // Dispatch event so GlobalJobTracker picks it up
        window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: data.jobId } }));
        onSaved?.(normalizeSlug(title));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') setIsOpen(false);
  };

  if (savedJobId) {
    return (
      <div className="flex items-center gap-2 mt-2">
        <span className="text-xs text-emerald-600 dark:text-emerald-400 font-medium">
          Saving to wiki...
        </span>
        <span className="text-xs text-zinc-400 font-mono">{savedJobId.slice(0, 8)}</span>
      </div>
    );
  }

  return (
    <div className="relative mt-2">
      {!isOpen ? (
        <button
          onClick={() => setIsOpen(true)}
          className="text-xs px-3 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-600 text-white font-medium transition-colors"
        >
          Save to Wiki
        </button>
      ) : (
        <div className="flex flex-col gap-2 p-3 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 shadow-md w-72">
          <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
            Save as wiki page
          </p>
          <input
            ref={inputRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Page title..."
            className="text-sm px-2 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-600 bg-transparent text-zinc-900 dark:text-slate-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
          />
          {error && (
            <p className="text-xs text-red-500">{error}</p>
          )}
          <div className="flex gap-2">
            <button
              onClick={handleSave}
              disabled={isLoading || !title.trim()}
              className="flex-1 text-xs px-2 py-1.5 rounded-md bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium transition-colors"
            >
              {isLoading ? 'Saving...' : 'Save'}
            </button>
            <button
              onClick={() => setIsOpen(false)}
              className="text-xs px-2 py-1.5 rounded-md border border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
