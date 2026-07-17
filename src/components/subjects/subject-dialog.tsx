'use client';

/**
 * SubjectDialog —— 创建/编辑 subject 的统一弹窗（含删除）。
 * 由 ui-store 的瞬态 subjectDialog 状态驱动，全局挂载一次（providers.tsx）。
 * 任何入口（切换器/管理页/空态）经 openSubjectDialog 唤起，已删掉 ?new=1 跳转。
 */

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Trash2, ChevronRight, Download } from 'lucide-react';
import { normalizeSubjectSlug, sanitizeSubjectSlugInput } from '@/lib/slug';
import { DEFAULT_AUGMENTATION_LEVEL, type AugmentationLevel, type SubjectListEntry } from '@/lib/contracts';
import { useUIStore } from '@/stores/ui-store';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { useSwitchSubject } from '@/hooks/use-switch-subject';
import {
  fetchSubjects,
  createSubject,
  patchSubject,
  deleteSubject,
  subjectExportUrl,
} from '@/components/subjects/subjects-api';
import { AugmentationField } from '@/components/subjects/augmentation-field';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { IconButton } from '@/components/ui/icon-button';
import { blockImeEnterSubmit } from '@/lib/keyboard';

const SUBJECTS_QUERY_KEY = ['subjects'] as const;

export function SubjectDialog() {
  const dialog = useUIStore((s) => s.subjectDialog);
  const close = useUIStore((s) => s.closeSubjectDialog);

  useEffect(() => {
    if (!dialog.open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog.open, close]);

  if (!dialog.open) return null;

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="fixed inset-0 z-command flex items-start justify-center pt-[12vh] bg-overlay/40 backdrop-blur-sm animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="subject-dialog-title"
        className="w-full max-w-md mx-4 flex flex-col bg-surface rounded-lg shadow-lg border border-border overflow-hidden animate-slide-down"
      >
        {dialog.mode === 'create' ? (
          <CreateSubjectBody onClose={close} />
        ) : (
          <EditSubjectBody subjectId={dialog.subjectId} onClose={close} />
        )}
      </div>
    </div>
  );
}

function DialogHeader({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between h-12 shrink-0 px-4 border-b border-border">
      <h2 id="subject-dialog-title" className="text-sm font-semibold text-foreground">
        {title}
      </h2>
      <IconButton size="sm" onClick={onClose} aria-label="Close">
        <X />
      </IconButton>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-foreground-secondary mb-1">
        {label}
        {hint && <span className="ml-1 font-normal text-foreground-tertiary">({hint})</span>}
      </label>
      {children}
    </div>
  );
}

function CreateSubjectBody({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const switchSubject = useSwitchSubject();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [augmentation, setAugmentation] = useState<AugmentationLevel>(DEFAULT_AUGMENTATION_LEVEL);
  const [error, setError] = useState<string | null>(null);

  // 提交/预览口径：把宽松输入态（可能带末尾连字符）收口为最终规范 slug。
  const effectiveSlug = normalizeSubjectSlug(slug || name);

  const mutation = useMutation({
    mutationFn: createSubject,
    onSuccess: (subject) => {
      // 乐观写入 ['subjects'] 缓存：确保切到新 subject 时 SubjectsBootstrap 能在列表里找到它，
      // 否则后台 refetch 未回来前 bootstrap 会把它当"悬空选择"强制重置回 general。
      queryClient.setQueryData<SubjectListEntry[]>(SUBJECTS_QUERY_KEY, (old) => {
        const list = old ?? [];
        return list.some((s) => s.id === subject.id)
          ? list
          : [...list, { ...subject, pageCount: 0 }];
      });
      queryClient.invalidateQueries({ queryKey: SUBJECTS_QUERY_KEY });
      onClose();
      // 创建后自动切入新 subject 并落到仪表盘（空态 ingest hero 引导加内容）。
      switchSubject({ id: subject.id, slug: subject.slug }, { navigateTo: '/' });
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!effectiveSlug) {
      setError('Could not derive a URL slug from the name — customize it below.');
      setCustomizeOpen(true);
      return;
    }
    mutation.mutate({
      slug: effectiveSlug,
      name: name.trim(),
      description: description.trim(),
      augmentationLevel: augmentation,
    });
  };

  return (
    <>
      <DialogHeader title="New subject" onClose={onClose} />
      <form onSubmit={handleSubmit} onKeyDown={blockImeEnterSubmit} className="p-4 space-y-4">
        <Field label="Name">
          <Input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugTouched) setSlug(normalizeSubjectSlug(e.target.value));
            }}
            placeholder="e.g. Frontend Architecture"
          />
        </Field>

        <div>
          <p className="text-xs text-foreground-secondary">
            URL: <code className="font-mono text-foreground">{effectiveSlug || 'subject'}</code>
          </p>
          {!customizeOpen ? (
            <button
              type="button"
              onClick={() => setCustomizeOpen(true)}
              className="mt-1 inline-flex items-center gap-1 rounded text-[11px] text-foreground-tertiary hover:text-foreground focus-ring"
            >
              <ChevronRight className="h-3 w-3" />
              Customize slug
            </button>
          ) : (
            <div className="mt-2">
              <Input
                value={slug}
                onChange={(e) => {
                  // 宽松规范化保留末尾连字符，用户才能继续输入下一段（横杠可正常输入）。
                  setSlug(sanitizeSubjectSlugInput(e.target.value));
                  setSlugTouched(true);
                }}
                placeholder="frontend-architecture"
                className="font-mono text-xs"
                aria-label="Slug"
              />
              <p className="mt-1 text-[11px] text-foreground-tertiary">
                Used in URLs and cross-subject links:{' '}
                <code className="font-mono">[[{effectiveSlug || 'subject'}:page]]</code>
              </p>
            </div>
          )}
        </div>

        <Field label="Description" hint="optional">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>

        <Field label="Augmentation">
          <AugmentationField
            value={augmentation}
            onChange={setAugmentation}
            disabled={mutation.isPending}
          />
        </Field>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button intent="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button intent="primary" type="submit" loading={mutation.isPending}>
            Create
          </Button>
        </div>
      </form>
    </>
  );
}

function EditSubjectBody({
  subjectId,
  onClose,
}: {
  subjectId: string | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { id: currentSubjectId } = useCurrentSubject();

  const { data: subjects = [] } = useQuery({
    queryKey: SUBJECTS_QUERY_KEY,
    queryFn: fetchSubjects,
    staleTime: 10_000,
  });
  const subject = useMemo(
    () => subjects.find((s) => s.id === subjectId),
    [subjects, subjectId],
  );

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [augmentation, setAugmentation] = useState<AugmentationLevel>(DEFAULT_AUGMENTATION_LEVEL);
  const [error, setError] = useState<string | null>(null);
  const [confirmArmed, setConfirmArmed] = useState(false);

  // 载入/切换目标 subject 时回填表单。
  useEffect(() => {
    if (subject) {
      setName(subject.name);
      setDescription(subject.description ?? '');
      setAugmentation(subject.augmentationLevel);
      setError(null);
      setConfirmArmed(false);
    }
  }, [subject?.id, subject?.name, subject?.description, subject?.augmentationLevel]);

  const patchMutation = useMutation({
    mutationFn: patchSubject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SUBJECTS_QUERY_KEY });
      if (subjectId === currentSubjectId) router.refresh();
      onClose();
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteSubject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: SUBJECTS_QUERY_KEY });
      onClose();
    },
    onError: (err: Error) => {
      setError(err.message);
      setConfirmArmed(false);
    },
  });

  if (!subject) {
    return (
      <>
        <DialogHeader title="Subject settings" onClose={onClose} />
        <div className="p-4 text-sm text-foreground-tertiary">Loading…</div>
      </>
    );
  }

  const isActive = subject.id === currentSubjectId;
  // 允许删除非空 subject（级联清理由后端处理）；仅 active 与 general 仍禁删。
  const canDelete = !isActive && subject.slug !== 'general';

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    patchMutation.mutate({
      id: subject.id,
      name: name.trim(),
      description: description.trim(),
      augmentationLevel: augmentation,
    });
  };

  return (
    <>
      <DialogHeader title="Subject settings" onClose={onClose} />
      <form onSubmit={handleSubmit} onKeyDown={blockImeEnterSubmit} className="p-4 space-y-4">
        <Field label="Name">
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label="Slug">
          <code className="block rounded-md bg-subtle px-2 py-1.5 font-mono text-xs text-foreground-secondary">
            {subject.slug}
          </code>
          <p className="mt-1 text-[11px] text-foreground-tertiary">
            The slug can&apos;t be changed after creation.
          </p>
        </Field>

        <Field label="Description" hint="optional">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </Field>

        <Field label="Augmentation">
          <AugmentationField
            value={augmentation}
            onChange={setAugmentation}
            disabled={patchMutation.isPending}
          />
        </Field>

        {error && <p className="text-xs text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button intent="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button intent="primary" type="submit" loading={patchMutation.isPending}>
            Save
          </Button>
        </div>
      </form>

      <div className="border-t border-border px-4 py-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-foreground-tertiary">
          Export
        </p>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-foreground-tertiary">
            Download this subject&apos;s pages, sources and assets as a zip archive. It can be
            imported on the Subjects page.
          </p>
          {/* cookie 鉴权下浏览器直接下载；不用 fetch，避免手动组装 Blob。 */}
          <Button
            intent="outline"
            size="sm"
            type="button"
            onClick={() => window.location.assign(subjectExportUrl(subject.id))}
          >
            <Download className="h-3.5 w-3.5" />
            Export
          </Button>
        </div>
      </div>

      <div className="border-t border-border bg-subtle/40 px-4 py-3">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-foreground-tertiary">
          Danger zone
        </p>
        {canDelete ? (
          <>
            {confirmArmed && (
              <p className="mb-2 text-xs text-danger">
                This permanently deletes &ldquo;{subject.name}&rdquo; and its {subject.pageCount}{' '}
                {subject.pageCount === 1 ? 'page' : 'pages'} and all sources. This can&apos;t be undone.
              </p>
            )}
            <Button
              intent={confirmArmed ? 'danger' : 'outline'}
              size="sm"
              type="button"
              loading={deleteMutation.isPending}
              onClick={() => {
                if (!confirmArmed) {
                  setConfirmArmed(true);
                  return;
                }
                deleteMutation.mutate(subject.id);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {confirmArmed ? 'Click again to confirm' : 'Delete subject'}
            </Button>
          </>
        ) : (
          <p className="text-xs text-foreground-tertiary">
            {subject.slug === 'general'
              ? "The general subject can't be deleted."
              : 'This subject is currently active. Switch to another subject before deleting.'}
          </p>
        )}
      </div>
    </>
  );
}
