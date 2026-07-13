'use client';
import { useState, useRef, useEffect } from 'react';
import { Bookmark, Check } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isImeComposing } from '@/lib/keyboard';
import type { Citation } from './message-list';

interface SaveToWikiButtonProps {
  answer: string;
  citations: Citation[];
}

export function SaveToWikiButton({ answer, citations }: SaveToWikiButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [savedJobId, setSavedJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { id: subjectId } = useCurrentSubject();

  useEffect(() => {
    if (isOpen) setTimeout(() => inputRef.current?.focus(), 50);
  }, [isOpen]);

  const handleSave = async () => {
    if (!title.trim()) return;
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
        window.dispatchEvent(new CustomEvent('wiki:job-started', { detail: { jobId: data.jobId } }));
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
      <div className="flex items-center gap-2 text-xs">
        <Check className="h-3 w-3 text-success" />
        <span className="text-success font-medium">Saving to wiki…</span>
        <span className="text-foreground-tertiary font-mono">{savedJobId.slice(0, 8)}</span>
      </div>
    );
  }

  if (!isOpen) {
    return (
      <Button intent="ghost" size="sm" onClick={() => setIsOpen(true)}>
        <Bookmark className="h-3 w-3" />
        Save to Wiki
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3 rounded-md border border-border bg-surface shadow-md w-72">
      <p className="text-xs font-medium text-foreground-secondary">Save as wiki page</p>
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
  );
}
