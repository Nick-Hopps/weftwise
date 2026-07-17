'use client';

import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layers, Plus, Settings, Upload } from 'lucide-react';
import type { SubjectListEntry } from '@/lib/contracts';
import { useUIStore } from '@/stores/ui-store';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useSwitchSubject } from '@/hooks/use-switch-subject';
import {
  fetchSubjects,
  importSubject,
  ImportSubjectError,
} from '@/components/subjects/subjects-api';
import { augmentationLabel } from '@/lib/augmentation';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Tag } from '@/components/ui/tag';
import { cn } from '@/lib/cn';

const SUBJECTS_QUERY_KEY = ['subjects'] as const;

export default function SubjectsPage() {
  const { id: currentSubjectId } = useCurrentSubject();
  const openSubjectDialog = useUIStore((s) => s.openSubjectDialog);
  const switchSubject = useSwitchSubject();

  const { data: subjects = [], isLoading } = useQuery({
    queryKey: SUBJECTS_QUERY_KEY,
    queryFn: fetchSubjects,
    staleTime: 10_000,
  });

  const sortedSubjects = useMemo(
    () => [...subjects].sort((a, b) => a.name.localeCompare(b.name)),
    [subjects],
  );

  return (
    <div className="max-w-4xl mx-auto w-full space-y-6 px-6 py-8">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
            <Layers className="h-5 w-5 text-foreground-tertiary" />
            Subjects
          </h1>
          <p className="mt-1 text-sm text-foreground-secondary">
            Each subject is an isolated workspace with its own pages, sources, and graph.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ImportSubjectButton />
          <Button intent="primary" onClick={() => openSubjectDialog({ mode: 'create' })}>
            <Plus className="h-3.5 w-3.5" />
            New subject
          </Button>
        </div>
      </header>

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-28 animate-pulse rounded-md border border-border bg-subtle" />
          ))}
        </div>
      ) : sortedSubjects.length === 0 ? (
        <EmptyState onCreate={() => openSubjectDialog({ mode: 'create' })} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sortedSubjects.map((subject) => (
            <li key={subject.id}>
              <SubjectCard
                subject={subject}
                isActive={subject.id === currentSubjectId}
                onOpen={() =>
                  switchSubject({ id: subject.id, slug: subject.slug }, { navigateTo: '/' })
                }
                onSettings={() => openSubjectDialog({ mode: 'edit', subjectId: subject.id })}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 导入归档 zip：选文件 → POST /api/subjects/import。
 * slug 冲突（409 slug-conflict）时用 prompt 请求新 slug 重试一次。
 */
function ImportSubjectButton() {
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({ file, slug }: { file: File; slug?: string }) => importSubject(file, slug),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: SUBJECTS_QUERY_KEY });
    },
    onError: (err: Error, { file }) => {
      if (err instanceof ImportSubjectError && err.code === 'slug-conflict') {
        const slug = window.prompt(
          'A subject with this slug already exists. Import under a different slug:',
        );
        if (slug?.trim()) {
          mutation.mutate({ file, slug: slug.trim() });
          return;
        }
      }
      setError(err.message);
    },
  });

  return (
    <div className="flex items-center gap-2">
      {error && <p className="max-w-60 truncate text-xs text-danger" title={error}>{error}</p>}
      <input
        ref={inputRef}
        type="file"
        accept=".zip,application/zip"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) {
            setError(null);
            mutation.mutate({ file });
          }
        }}
      />
      <Button intent="outline" loading={mutation.isPending} onClick={() => inputRef.current?.click()}>
        <Upload className="h-3.5 w-3.5" />
        Import
      </Button>
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-surface px-6 py-14 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-subtle">
        <Layers className="h-6 w-6 text-foreground-tertiary" />
      </div>
      <h2 className="text-sm font-semibold text-foreground">No subjects yet</h2>
      <p className="mt-1 max-w-sm text-sm text-foreground-secondary">
        A subject is an isolated workspace for one area of knowledge. Create your first one to start
        adding content.
      </p>
      <Button intent="primary" className="mt-4" onClick={onCreate}>
        <Plus className="h-3.5 w-3.5" />
        Create your first subject
      </Button>
    </div>
  );
}

function SubjectCard({
  subject,
  isActive,
  onOpen,
  onSettings,
}: {
  subject: SubjectListEntry;
  isActive: boolean;
  onOpen: () => void;
  onSettings: () => void;
}) {
  return (
    <div
      className={cn(
        'group relative h-full rounded-md border transition-colors',
        isActive
          ? 'border-accent/40 bg-accent-subtle/30'
          : 'border-border bg-surface hover:border-border-strong hover:bg-subtle',
      )}
    >
      {/* gear：编辑入口，浮于卡片之上，阻止冒泡到主体按钮。*/}
      <IconButton
        size="sm"
        aria-label={`Settings for ${subject.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onSettings();
        }}
        className="absolute right-2 top-2 z-10 text-foreground-tertiary"
      >
        <Settings />
      </IconButton>

      {/* 主体可点：切换并进入该工作区。*/}
      <button
        type="button"
        onClick={onOpen}
        className="flex h-full w-full flex-col gap-2 rounded-md p-4 pr-10 text-left focus-ring"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Layers className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary" />
          <span className="truncate text-sm font-semibold text-foreground">{subject.name}</span>
          {isActive && (
            <Tag tone="accent" size="sm">
              Active
            </Tag>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-[11px] text-foreground-tertiary">
          <span className="tabular-nums">
            {subject.pageCount} {subject.pageCount === 1 ? 'page' : 'pages'}
          </span>
          <span>·</span>
          <span>{augmentationLabel(subject.augmentationLevel)}</span>
        </div>

        <code className="truncate font-mono text-xs text-foreground-secondary">{subject.slug}</code>

        {subject.description && (
          <p className="line-clamp-2 text-sm text-foreground-secondary">{subject.description}</p>
        )}
      </button>
    </div>
  );
}
