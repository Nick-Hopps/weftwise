'use client';

import { useEffect, useRef, useState } from 'react';
import { Pencil, Trash2, ChevronDown } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useUIStore } from '@/stores/ui-store';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { cn } from '@/lib/cn';
import type { Conversation } from '@/lib/contracts';

export function ConversationSwitcher() {
  const apiFetchClient = useApiFetch();
  const queryClient = useQueryClient();
  const { id: subjectId } = useCurrentSubject();
  const currentId = useUIStore((s) => s.currentConversationId);
  const setCurrent = useUIStore((s) => s.setCurrentConversation);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations', subjectId],
    queryFn: async () => {
      const res = await apiFetchClient('/api/conversations');
      if (!res.ok) return [] as Conversation[];
      return (await res.json()) as Conversation[];
    },
    enabled: !!subjectId,
    staleTime: 10_000,
  });

  const current = conversations.find((c) => c.id === currentId) ?? null;

  const rename = useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      await apiFetchClient(`/api/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, subjectId }),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['conversations', subjectId] }),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await apiFetchClient(`/api/conversations/${id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subjectId }),
      });
    },
    onSuccess: (_d, id) => {
      queryClient.invalidateQueries({ queryKey: ['conversations', subjectId] });
      if (id === currentId) setCurrent(null);
    },
  });

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-7 w-full min-w-0 items-center gap-1 rounded-md px-2 text-left text-xs text-foreground hover:bg-subtle focus-ring"
      >
        <span className="truncate">{current?.title ?? 'New conversation'}</span>
        <ChevronDown className={cn(
          'h-3.5 w-3.5 shrink-0 text-foreground-tertiary transition-transform',
          open && 'rotate-180',
        )} />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-command mt-1 max-h-72 w-[min(320px,calc(100vw-32px))] overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-lg"
        >
          {conversations.length === 0 ? (
            <p className="px-3 py-2 text-xs italic text-foreground-tertiary">No past conversations</p>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={cn(
                  'flex items-center gap-1 rounded-sm px-2 py-1.5 text-sm hover:bg-subtle',
                  c.id === currentId && 'bg-subtle',
                )}
              >
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => { setCurrent(c.id); setOpen(false); }}
                  className="min-w-0 flex-1 truncate text-left text-foreground"
                >
                  {c.title}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label="Rename"
                  data-tip="Rename"
                  onClick={() => {
                    const next = window.prompt('Rename conversation', c.title);
                    if (next && next.trim()) rename.mutate({ id: c.id, title: next.trim() });
                  }}
                  className="tip tip-l rounded p-1 text-foreground-tertiary hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  role="menuitem"
                  aria-label="Delete"
                  data-tip="Delete"
                  onClick={() => { if (window.confirm('Delete this conversation?')) remove.mutate(c.id); }}
                  className="tip tip-l rounded p-1 text-foreground-tertiary hover:text-red-600 dark:hover:text-red-400"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
