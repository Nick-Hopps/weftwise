'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { Button } from '@/components/ui/button';
import { MdEditor } from './md-editor';

const INVALIDATE_KEYS = ['pages', 'page-detail', 'graph', 'search', 'jobs', 'backlinks', 'context', 'frontmatter'];

export function PageEditor({ slug }: { slug: string }) {
  const apiFetch = useApiFetch();
  const queryClient = useQueryClient();
  const router = useRouter();
  const { id: subjectId, slug: subjectSlug } = useCurrentSubject();

  const readHref = `/wiki/${slug}?s=${encodeURIComponent(subjectSlug)}`;

  const [value, setValue] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['page-detail', subjectId, slug],
    queryFn: async () => {
      const res = await apiFetch(`/api/pages/${slug}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { raw: string; title: string };
    },
    enabled: !!subjectId,
  });

  // 受控编辑器：value 为 null 表示尚未编辑，回落到首次加载的 raw。
  const initialRaw = data?.raw ?? '';
  const current = value ?? initialRaw;
  const dirty = value !== null && value !== initialRaw;

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiFetch(`/api/pages/${slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: current, subjectId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; details?: unknown };
        const detail = body.details ? `\n${JSON.stringify(body.details, null, 2)}` : '';
        throw new Error((body.error ?? `HTTP ${res.status}`) + detail);
      }
    },
    onSuccess: async () => {
      await Promise.all(INVALIDATE_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      router.push(readHref);
      router.refresh();
    },
    onError: (e: Error) => setErrorText(e.message),
  });

  function cancel() {
    if (dirty && typeof window !== 'undefined' && !window.confirm('Discard unsaved changes?')) return;
    router.push(readHref);
  }

  if (isLoading) {
    return (
      <div className="max-w-content mx-auto px-6 py-8 w-full">
        <div className="h-8 w-40 rounded bg-subtle animate-pulse" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="max-w-content mx-auto px-6 py-8 w-full space-y-3">
        <p className="text-sm text-danger">Failed to load page for editing.</p>
        <Button intent="outline" onClick={() => router.push(readHref)}>Back to page</Button>
      </div>
    );
  }

  const canSave = current.trim() !== '' && dirty && !save.isPending;

  return (
    <div className="max-w-content mx-auto px-6 py-6 w-full space-y-4">
      <header className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs text-foreground-tertiary">Editing</p>
          <h1 className="text-lg font-semibold text-foreground truncate">{data?.title ?? slug}</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button intent="ghost" onClick={cancel} disabled={save.isPending}>Cancel</Button>
          <Button
            intent="primary"
            onClick={() => { setErrorText(null); save.mutate(); }}
            loading={save.isPending}
            disabled={!canSave}
          >
            Save
          </Button>
        </div>
      </header>

      {errorText && (
        <div className="rounded-md border border-danger/40 bg-danger-bg px-3 py-2 text-sm text-danger whitespace-pre-wrap">
          {errorText}
        </div>
      )}

      <MdEditor value={current} onChange={(next) => setValue(next)} />
    </div>
  );
}
