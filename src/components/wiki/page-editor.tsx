'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useApiFetch } from '@/lib/api-fetch';
import { useCurrentSubject } from '@/hooks/use-current-subject';
import { buildTitleSlugMap } from '@/lib/title-slug-map';
import type { WikiPage } from '@/lib/contracts';
import { Button } from '@/components/ui/button';
import { MdEditor } from './md-editor';
import { EditorPreview } from './editor-preview';
import { useI18n } from '@/components/i18n-provider';

const INVALIDATE_KEYS = ['pages', 'page-detail', 'graph', 'search', 'jobs', 'backlinks', 'context', 'frontmatter'];

export function PageEditor({ slug }: { slug: string }) {
  const { t } = useI18n();
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

  // 拉取本 subject 所有页，构建 wikilink 解析用 titleSlugMap（与阅读页一致）。
  const { data: titleSlugMap } = useQuery({
    queryKey: ['pages', subjectId],
    queryFn: async () => {
      const res = await apiFetch('/api/pages');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const pages = (await res.json()) as WikiPage[];
      return buildTitleSlugMap(pages);
    },
    enabled: !!subjectId,
  });

  // 受控编辑器：value 为 null 表示尚未编辑，回落到首次加载的 raw。
  const initialRaw = data?.raw ?? '';
  const current = value ?? initialRaw;
  const dirty = value !== null && value !== initialRaw;

  const save = useMutation({
    mutationFn: async (): Promise<number> => {
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
      const body = (await res.json().catch(() => ({}))) as { referencesUpdated?: number };
      return body.referencesUpdated ?? 0;
    },
    onSuccess: async (referencesUpdated: number) => {
      await Promise.all(INVALIDATE_KEYS.map((k) => queryClient.invalidateQueries({ queryKey: [k] })));
      if (referencesUpdated > 0) {
        // 跳转前用 sessionStorage 把提示带到阅读页（push 后本组件即卸载）。
        sessionStorage.setItem('wiki:retitle-notice', t('wiki.editor.referencesUpdated', { count: referencesUpdated }));
      }
      router.push(readHref);
      router.refresh();
    },
    onError: (e: Error) => setErrorText(e.message),
  });

  function cancel() {
    if (dirty && typeof window !== 'undefined' && !window.confirm(t('wiki.editor.discard'))) return;
    router.push(readHref);
  }

  if (isLoading) {
    return (
      <div className="flex flex-col h-full">
        <div className="shrink-0 border-b border-border px-6 py-3">
          <div className="h-8 w-40 rounded bg-subtle animate-pulse" />
        </div>
        <div className="flex-1 m-4 rounded bg-subtle animate-pulse" />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col h-full items-start gap-3 px-6 py-8">
        <p className="text-sm text-danger">{t('wiki.editor.loadError')}</p>
        <Button intent="outline" onClick={() => router.push(readHref)}>{t('wiki.editor.back')}</Button>
      </div>
    );
  }

  const canSave = current.trim() !== '' && dirty && !save.isPending;

  return (
    <div className="flex flex-col h-full">
      <header className="shrink-0 flex items-center justify-between gap-3 border-b border-border px-6 py-3">
        <div className="min-w-0">
          <p className="text-xs text-foreground-tertiary">{t('wiki.editor.editing')}</p>
          <h1 className="text-base font-semibold text-foreground truncate">{data?.title ?? slug}</h1>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button intent="ghost" onClick={cancel} disabled={save.isPending}>{t('common.cancel')}</Button>
          <Button
            intent="primary"
            onClick={() => { setErrorText(null); save.mutate(); }}
            loading={save.isPending}
            disabled={!canSave}
          >
            {t('common.save')}
          </Button>
        </div>
      </header>

      {errorText && (
        <div className="shrink-0 border-b border-danger/40 bg-danger-bg px-6 py-2 text-sm text-danger whitespace-pre-wrap">
          {errorText}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        <MdEditor
          value={current}
          onChange={setValue}
          previewRenderer={(source) => (
            <EditorPreview source={source} titleSlugMap={titleSlugMap} slug={slug} />
          )}
        />
      </div>
    </div>
  );
}
