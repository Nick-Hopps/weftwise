'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Plus, Trash2 } from 'lucide-react';
import { apiFetch } from '@/lib/api-fetch';
import { normalizeSubjectSlug } from '@/lib/slug';
import type { SubjectListEntry } from '@/lib/contracts';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { Panel, PanelBody, PanelHeader, SectionLabel } from '@/components/ui/panel';
import { IconButton } from '@/components/ui/icon-button';
import { Tag } from '@/components/ui/tag';
import { cn } from '@/lib/cn';

const SUBJECTS_QUERY_KEY = ['subjects'] as const;

async function fetchSubjects(): Promise<SubjectListEntry[]> {
  const res = await apiFetch('/api/subjects');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

interface CreateSubjectPayload {
  slug: string;
  name: string;
  description: string;
}

async function createSubject(payload: CreateSubjectPayload): Promise<SubjectListEntry> {
  const res = await apiFetch('/api/subjects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

interface PatchSubjectPayload {
  id: string;
  name?: string;
  description?: string;
}

async function patchSubject(payload: PatchSubjectPayload): Promise<SubjectListEntry> {
  const { id, ...body } = payload;
  const res = await apiFetch(`/api/subjects/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(errBody.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

async function deleteSubject(id: string): Promise<void> {
  const res = await apiFetch(`/api/subjects/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export default function SubjectsPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-content mx-auto px-6 py-8 w-full">
          <div className="h-8 w-32 rounded bg-subtle animate-pulse" />
        </div>
      }
    >
      <SubjectsPageContent />
    </Suspense>
  );
}

function SubjectsPageContent() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { id: currentSubjectId } = useCurrentSubject();

  const { data: subjects = [], isLoading } = useQuery({
    queryKey: SUBJECTS_QUERY_KEY,
    queryFn: fetchSubjects,
    staleTime: 10_000,
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Honour `?new=1` from SubjectSwitcher's "New subject…" action.
  useEffect(() => {
    if (searchParams.get('new') === '1') setCreateOpen(true);
  }, [searchParams]);

  const sortedSubjects = useMemo(
    () => [...subjects].sort((a, b) => a.name.localeCompare(b.name)),
    [subjects],
  );

  const invalidate = () => queryClient.invalidateQueries({ queryKey: SUBJECTS_QUERY_KEY });

  return (
    <div className="max-w-content mx-auto px-6 py-8 w-full space-y-6">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
            <Layers className="h-5 w-5 text-foreground-tertiary" />
            Subjects
          </h1>
          <p className="mt-1 text-sm text-foreground-secondary">
            Each subject is an isolated workspace with its own pages, sources, and graph.
          </p>
        </div>
        <Button intent="primary" onClick={() => setCreateOpen(true)}>
          <Plus className="h-3.5 w-3.5" />
          New subject
        </Button>
      </header>

      {createOpen && (
        <CreateSubjectForm
          onCancel={() => {
            setCreateOpen(false);
            // Drop ?new=1 so a back-navigation doesn't reopen the form.
            router.replace('/subjects');
          }}
          onCreated={() => {
            setCreateOpen(false);
            router.replace('/subjects');
            invalidate();
          }}
        />
      )}

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-32 rounded-md border border-border bg-subtle animate-pulse" />
          ))}
        </div>
      ) : sortedSubjects.length === 0 ? (
        <p className="text-sm text-foreground-tertiary italic">No subjects yet.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sortedSubjects.map((subject) => (
            <li key={subject.id}>
              <SubjectCard
                subject={subject}
                isActive={subject.id === currentSubjectId}
                isEditing={editingId === subject.id}
                onEdit={() => setEditingId(subject.id)}
                onCloseEdit={() => setEditingId(null)}
                onChanged={invalidate}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateSubjectForm({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: createSubject,
    onSuccess: () => onCreated(),
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    const finalSlug = slug || normalizeSubjectSlug(name);
    if (!finalSlug || !name.trim()) {
      setError('Both name and slug are required.');
      return;
    }
    mutation.mutate({ slug: finalSlug, name: name.trim(), description: description.trim() });
  };

  return (
    <Panel tone="elevated" className="border-accent/30">
      <PanelHeader>
        <h2 className="text-sm font-semibold text-foreground">Create subject</h2>
        <Button intent="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </PanelHeader>
      <PanelBody>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">
              Name
            </label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(normalizeSubjectSlug(e.target.value));
              }}
              placeholder="e.g. Frontend Architecture"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">
              Slug
            </label>
            <Input
              value={slug}
              onChange={(e) => {
                setSlug(normalizeSubjectSlug(e.target.value));
                setSlugTouched(true);
              }}
              placeholder="frontend-architecture"
              className="font-mono text-xs"
            />
            <p className="mt-1 text-[11px] text-foreground-tertiary">
              Used in URLs and wikilink syntax: <code className="font-mono">[[{slug || 'subject'}:page]]</code>
            </p>
          </div>
          <div>
            <label className="block text-xs font-medium text-foreground-secondary mb-1">
              Description (optional)
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button intent="ghost" type="button" onClick={onCancel}>
              Cancel
            </Button>
            <Button intent="primary" type="submit" loading={mutation.isPending}>
              Create
            </Button>
          </div>
        </form>
      </PanelBody>
    </Panel>
  );
}

function SubjectCard({
  subject,
  isActive,
  isEditing,
  onEdit,
  onCloseEdit,
  onChanged,
}: {
  subject: SubjectListEntry;
  isActive: boolean;
  isEditing: boolean;
  onEdit: () => void;
  onCloseEdit: () => void;
  onChanged: () => void;
}) {
  const [name, setName] = useState(subject.name);
  const [description, setDescription] = useState(subject.description ?? '');
  const [error, setError] = useState<string | null>(null);

  // Reset local state when leaving edit mode so re-entry shows latest server data.
  useEffect(() => {
    if (!isEditing) {
      setName(subject.name);
      setDescription(subject.description ?? '');
      setError(null);
    }
  }, [isEditing, subject.name, subject.description]);

  const patchMutation = useMutation({
    mutationFn: patchSubject,
    onSuccess: () => {
      onChanged();
      onCloseEdit();
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSubject,
    onSuccess: () => onChanged(),
    onError: (err: Error) => setError(err.message),
  });

  const canDelete = subject.pageCount === 0 && !isActive;

  return (
    <Panel
      tone={isActive ? 'elevated' : 'plain'}
      className={cn(
        'h-full flex flex-col',
        isActive && 'border-accent/40',
      )}
    >
      <PanelHeader>
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="h-3.5 w-3.5 text-foreground-tertiary shrink-0" />
          <h3 className="text-sm font-semibold text-foreground truncate">{subject.name}</h3>
          {isActive && <Tag tone="accent" size="sm">Active</Tag>}
        </div>
        <span className="text-[11px] text-foreground-tertiary tabular-nums">
          {subject.pageCount} {subject.pageCount === 1 ? 'page' : 'pages'}
        </span>
      </PanelHeader>
      <PanelBody className="flex-1 flex flex-col gap-3">
        {isEditing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              patchMutation.mutate({
                id: subject.id,
                name: name.trim(),
                description: description.trim(),
              });
            }}
            className="space-y-2"
          >
            <Input value={name} onChange={(e) => setName(e.target.value)} aria-label="Name" />
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              aria-label="Description"
            />
            {error && <p className="text-xs text-danger">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button intent="ghost" size="sm" type="button" onClick={onCloseEdit}>
                Cancel
              </Button>
              <Button intent="primary" size="sm" type="submit" loading={patchMutation.isPending}>
                Save
              </Button>
            </div>
          </form>
        ) : (
          <>
            <SectionLabel className="text-[10px]">Slug</SectionLabel>
            <code className="font-mono text-xs text-foreground-secondary">{subject.slug}</code>

            {subject.description && (
              <p className="text-sm text-foreground-secondary line-clamp-3">{subject.description}</p>
            )}

            {error && <p className="text-xs text-danger">{error}</p>}

            <div className="flex items-center justify-between gap-2 mt-auto pt-2">
              <Button intent="ghost" size="sm" onClick={onEdit}>
                Rename
              </Button>
              <IconButton
                size="sm"
                aria-label={
                  canDelete ? 'Delete subject' : 'Cannot delete: subject has pages or is active'
                }
                title={
                  canDelete
                    ? 'Delete subject'
                    : isActive
                      ? 'Switch away before deleting'
                      : `Empty the subject first (${subject.pageCount} pages)`
                }
                disabled={!canDelete || deleteMutation.isPending}
                onClick={() => {
                  if (
                    typeof window !== 'undefined' &&
                    !window.confirm(`Delete subject "${subject.name}"?`)
                  ) {
                    return;
                  }
                  deleteMutation.mutate(subject.id);
                }}
                className={cn(canDelete ? 'text-danger hover:text-danger' : 'opacity-50')}
              >
                <Trash2 />
              </IconButton>
            </div>
          </>
        )}
      </PanelBody>
    </Panel>
  );
}
