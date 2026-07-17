'use client';
import { useState, useRef, useEffect } from 'react';
import { Bookmark, Check } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Input } from '@/components/ui/input';
import { isImeComposing } from '@/lib/keyboard';
import { dispatchJobStarted } from '@/lib/job-started-event';
import type { Citation } from './message-list';

interface SaveToWikiButtonProps {
  answer: string | null;
  citations: Citation[];
  disabled?: boolean;
}

export function SaveToWikiButton({ answer, citations, disabled = false }: SaveToWikiButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [savedJobId, setSavedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { id: subjectId } = useCurrentSubject();

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    setIsOpen(false);
    setTitle('');
    setSavedJobId(null);
    setError(null);
  }, [answer]);

  const handleSave = async () => {
    if (!title.trim() || !answer) return;
    if (!subjectId) {
      setError('Subject is still loading. Please retry in a moment.');
      return;
    }
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
          subjectId,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }
      const data = (await response.json()) as { jobId?: string };
      if (data.jobId) {
        setSavedJobId(data.jobId);
        setIsOpen(false);
        dispatchJobStarted({
          jobId: data.jobId,
          type: 'save-to-wiki',
          label: title.trim(),
          queueStatus: 'pending',
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(e)) return;
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') setIsOpen(false);
  };

  if (savedJobId) {
    return (
      <IconButton
        size="sm"
        aria-label="Saving last answer to Wiki"
        data-tip={`Saving… ${savedJobId.slice(0, 8)}`}
        className="tip tip-b text-success"
        disabled
      >
        <Check />
      </IconButton>
    );
  }

  return (
    <div className="relative">
      <IconButton
        size="sm"
        aria-label="Save last answer to Wiki"
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        data-tip="Save to Wiki"
        className="tip tip-b"
        disabled={disabled || !answer}
        onClick={() => setIsOpen((current) => !current)}
      >
        <Bookmark />
      </IconButton>

      {isOpen && (
        <>
          <button
            type="button"
            aria-label="Close Save to Wiki form"
            tabIndex={-1}
            className="fixed inset-0 z-overlay cursor-default"
            onClick={() => setIsOpen(false)}
          />
          <div
            role="dialog"
            aria-label="Save last answer to Wiki"
            className="absolute right-0 top-full z-command mt-2 flex w-72 flex-col gap-2 rounded-md border border-border bg-surface p-3 shadow-md"
          >
            <p className="text-xs font-medium text-foreground-secondary">Save last answer as a Wiki page</p>
            <Input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Page title…"
            />
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex gap-2">
              <Button
                intent="primary"
                size="sm"
                onClick={handleSave}
                disabled={isLoading || !title.trim()}
                className="flex-1"
              >
                {isLoading ? 'Saving…' : 'Save'}
              </Button>
              <Button intent="outline" size="sm" onClick={() => setIsOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
