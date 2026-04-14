'use client';

import { useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import FrontmatterDisplay from './frontmatter-display';
import { renderMarkdown } from '@/lib/markdown-client';
import { apiFetch } from '@/lib/api-fetch';

const WikiMarkdownEditor = dynamic(() => import('./wiki-markdown-editor'), {
  ssr: false,
  loading: () => (
    <div className="h-[640px] w-full rounded-xl border border-zinc-200 bg-white animate-pulse dark:border-zinc-700 dark:bg-zinc-900" />
  ),
});

interface PageRendererProps {
  content: string;
  rawContent?: string;
  slug: string;
  title?: string;
  tags?: string[];
  sources?: string[];
  created?: string;
  updated?: string;
  titleSlugMap?: Record<string, string>;
}

const hasFrontmatter = (props: PageRendererProps): boolean => {
  return Boolean(props.title);
};

export default function PageRenderer({
  content,
  rawContent = '',
  slug: _slug,
  title,
  tags = [],
  sources = [],
  created = '',
  updated = '',
  titleSlugMap,
}: PageRendererProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [editedContent, setEditedContent] = useState(rawContent || content);
  const [isSaving, setIsSaving] = useState(false);

  const rendered = useMemo(() => renderMarkdown(content, titleSlugMap), [content, titleSlugMap]);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const res = await apiFetch(`/api/pages/${_slug}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: editedContent }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || 'Failed to save');
      }
      await queryClient.invalidateQueries({ queryKey: ['pages'] });
      setIsEditing(false);
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!window.confirm('Are you sure you want to delete this page?')) return;
    try {
      const res = await apiFetch(`/api/pages/${_slug}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || 'Failed to delete');
      }
      await queryClient.invalidateQueries({ queryKey: ['pages'] });
      router.push('/');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const proseClassName = `
    prose-wiki
    text-zinc-800 dark:text-slate-200
    leading-7
    font-sans
    [&>h1]:text-2xl [&>h1]:font-bold [&>h1]:font-serif [&>h1]:text-zinc-950 [&>h1]:dark:text-slate-50 [&>h1]:mt-8 [&>h1]:mb-4 [&>h1]:leading-tight
    [&>h2]:text-xl [&>h2]:font-semibold [&>h2]:font-serif [&>h2]:text-zinc-900 [&>h2]:dark:text-slate-100 [&>h2]:mt-7 [&>h2]:mb-3 [&>h2]:leading-snug
    [&>h3]:text-lg [&>h3]:font-semibold [&>h3]:text-zinc-900 [&>h3]:dark:text-slate-100 [&>h3]:mt-6 [&>h3]:mb-2
    [&>h4]:text-base [&>h4]:font-semibold [&>h4]:text-zinc-800 [&>h4]:dark:text-slate-200 [&>h4]:mt-5 [&>h4]:mb-1.5
    [&>p]:mb-4 [&>p]:leading-7
    [&>ul]:mb-4 [&>ul]:pl-6 [&>ul]:list-disc [&>ul]:space-y-1
    [&>ol]:mb-4 [&>ol]:pl-6 [&>ol]:list-decimal [&>ol]:space-y-1
    [&_li]:leading-7
    [&>blockquote]:border-l-4 [&>blockquote]:border-indigo-300 [&>blockquote]:dark:border-indigo-600 [&>blockquote]:pl-4 [&>blockquote]:py-1 [&>blockquote]:my-4 [&>blockquote]:italic [&>blockquote]:text-slate-600 [&>blockquote]:dark:text-zinc-300
    [&>pre]:bg-slate-100 [&>pre]:dark:bg-zinc-800 [&>pre]:rounded-lg [&>pre]:p-4 [&>pre]:overflow-x-auto [&>pre]:my-4 [&>pre]:text-sm [&>pre]:leading-relaxed
    [&_code]:bg-slate-100 [&_code]:dark:bg-zinc-800 [&_code]:rounded [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-sm [&_code]:font-mono [&_code]:text-indigo-700 [&_code]:dark:text-indigo-300
    [&>pre_code]:bg-transparent [&>pre_code]:p-0 [&>pre_code]:text-slate-800 [&>pre_code]:dark:text-slate-200
    [&>hr]:my-8 [&>hr]:border-slate-200 [&>hr]:dark:border-zinc-700
    [&>table]:w-full [&>table]:border-collapse [&>table]:my-4 [&>table]:text-sm
    [&_th]:border [&_th]:border-slate-200 [&_th]:dark:border-zinc-700 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:bg-slate-50 [&_th]:dark:bg-zinc-800
    [&_td]:border [&_td]:border-slate-200 [&_td]:dark:border-zinc-700 [&_td]:px-3 [&_td]:py-2
    [&>img]:rounded-lg [&>img]:my-4 [&>img]:max-w-full
    [&_strong]:font-semibold [&_strong]:text-zinc-900 [&_strong]:dark:text-slate-100
    [&_em]:italic
    [&_a]:text-indigo-600 [&_a]:dark:text-indigo-400 [&_a]:transition-colors [&_a]:duration-150 [&_a]:hover:text-indigo-700 [&_a]:dark:hover:text-indigo-300 [&_a]:hover:underline
  `;

  return (
    <article className={isEditing ? 'mx-auto px-6 py-8 max-w-6xl' : 'max-w-3xl mx-auto px-6 py-8'}>
      <div className="flex justify-between items-start mb-6">
        <div className="flex-1">
          {!isEditing && hasFrontmatter({ content, slug: _slug, title, tags, sources, created, updated }) && title && (
            <FrontmatterDisplay
              title={title}
              tags={tags}
              sources={sources}
              created={created}
              updated={updated}
            />
          )}
        </div>
        <div className="flex gap-2 shrink-0 ml-4">
          {isEditing ? (
            <>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 transition-colors"
              >
                {isSaving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => { setIsEditing(false); setEditedContent(rawContent || content); }}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors"
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => setIsEditing(true)}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-400 hover:bg-indigo-100 dark:hover:bg-indigo-900/60 transition-colors"
              >
                Edit
              </button>
              <button
                onClick={handleDelete}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-red-50 text-red-700 dark:bg-red-900/40 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/60 transition-colors"
              >
                Delete
              </button>
            </>
          )}
        </div>
      </div>

      {isEditing ? (
        <WikiMarkdownEditor
          value={editedContent}
          onChange={setEditedContent}
          titleSlugMap={titleSlugMap}
          previewClassName={proseClassName}
        />
      ) : (
        <div className={proseClassName}>
          {rendered}
        </div>
      )}
    </article>
  );
}
