'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  FileCode2,
  FileText,
  Globe,
  Link2,
  Loader2,
  NotebookPen,
  Sparkles,
} from 'lucide-react';
import PageRenderer from './page-renderer';
import { HtmlSourceFrame } from './html-source-frame';
import { LensFeedback } from './lens-feedback';
import { PageActions, ReshapeStatus, type ReshapeState } from './page-actions';
import { SelectionAskButton } from './selection-ask-button';
import { ReadingProgress } from './reading-progress';
import { SectionLabel } from '@/components/ui/panel';
import { useApiFetch } from '@/lib/api-fetch';
import { useLens } from '@/hooks/use-lens';
import { renderMarkdown } from '@/lib/markdown-client';
import { cn } from '@/lib/cn';
import type { PageSourceDoc, PageSourceFormat } from '@/lib/contracts';

interface BacklinkItem {
  key: string;
  href: string;
  title: string;
}

interface WikiReadingViewProps {
  content: string;
  rawContent?: string;
  slug: string;
  title: string;
  tags: string[];
  sources: string[];
  created: string;
  updated: string;
  titleSlugMap: Record<string, string>;
  editHref: string;
  subjectSlug: string;
  backlinks: BacklinkItem[];
  /** How many ingested source documents back this page (drives the toggle). */
  sourceCount: number;
}

const SPLIT_KEY = 'wiki:split';

export default function WikiReadingView(props: WikiReadingViewProps) {
  const { backlinks, sourceCount, editHref, ...rendererProps } = props;
  const { slug } = rendererProps;
  const apiFetch = useApiFetch();
  const articleRef = useRef<HTMLDivElement>(null);

  const [split, setSplit] = useState(false);
  const [docs, setDocs] = useState<PageSourceDoc[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showOriginal, setShowOriginal] = useState(false);

  const canSplit = sourceCount > 0;
  const showSplit = split && canSplit;

  // Restore the reader's split preference after hydration (avoids SSR mismatch).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setSplit(window.localStorage.getItem(SPLIT_KEY) === '1');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(SPLIT_KEY, split ? '1' : '0');
  }, [split]);

  // Reset the toggle when navigating to a page with no sources.
  useEffect(() => {
    if (!canSplit) setSplit(false);
  }, [canSplit]);

  // Drop cached sources when navigating to a different page.
  // 同时把透镜重置回"未触发/原文"——换页后默认仍显示 canonical，需重新点按钮。
  useEffect(() => {
    setDocs(null);
    setError(null);
    setShowOriginal(false);
  }, [slug]);

  // Fetch source documents lazily, the first time the panel is opened.
  // Deps are intentionally minimal: including `loading`/`apiFetch` here would
  // cancel the in-flight request on the next render and deadlock the spinner.
  useEffect(() => {
    if (!showSplit || docs !== null) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await apiFetch(`/api/sources?slug=${encodeURIComponent(slug)}`);
        if (!res.ok) throw new Error(`Failed to load sources (${res.status})`);
        const data = (await res.json()) as { sources: PageSourceDoc[] };
        if (!cancelled) setDocs(data.sources ?? []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showSplit, docs, slug]);

  const lens = useLens(props.subjectSlug, slug);
  const reshaped = lens.data?.renderedMd;
  const reshapeUsable = reshaped != null && lens.data?.source !== 'canonical';
  const usingReshaped = reshapeUsable && !showOriginal;
  const displayContent = usingReshaped ? reshaped : props.content;

  const reshapeState: ReshapeState = lens.state === 'ready'
    ? 'reshaped'
    : lens.state;

  const actions = (
    <PageActions
      editHref={editHref}
      sourceCount={sourceCount}
      splitOn={showSplit}
      onToggleSplit={() => setSplit((s) => !s)}
      reshapeState={reshapeState}
      onRequestReshape={() => {
        setShowOriginal(false);
        void lens.request();
      }}
    />
  );

  const headerExtra =
    reshapeState === 'idle' ? null : (
      <ReshapeStatus
        state={reshapeState}
        showOriginal={showOriginal}
        onToggle={() => setShowOriginal((v) => !v)}
        onRefresh={() => void lens.refresh()}
        onCancel={lens.cancel}
      />
    );

  const article = (
    <>
      <PageRenderer
        {...rendererProps}
        content={displayContent}
        actions={actions}
        headerExtra={headerExtra}
      />
      <Backlinks backlinks={backlinks} />
      <LensFeedback slug={slug} />
    </>
  );

  if (showSplit) {
    return (
      <div className="flex flex-col lg:h-[calc(100vh-var(--header-height))]">
        <div className="grid grid-cols-1 lg:grid-cols-2 lg:flex-1 lg:min-h-0">
          <div ref={articleRef} className="min-w-0 lg:overflow-y-auto">
            <ReadingProgress containerRef={articleRef} useContainerScroll />
            {article}
            <SelectionAskButton containerRef={articleRef} />
          </div>
          <div className="min-w-0 border-t border-border bg-canvas lg:border-l lg:border-t-0 lg:min-h-0 lg:overflow-hidden">
            <SourcesPane docs={docs} loading={loading} error={error} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={articleRef} className="flex min-h-full flex-col">
      <ReadingProgress containerRef={articleRef} />
      {article}
      <SelectionAskButton containerRef={articleRef} />
    </div>
  );
}

function Backlinks({ backlinks }: { backlinks: BacklinkItem[] }) {
  if (backlinks.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-[var(--reading-max-width)] px-5 pb-14 sm:px-8">
      <div className="border-t border-border-subtle pt-7">
        <SectionLabel className="mb-2 flex items-center gap-1.5">
          <Link2 className="h-3 w-3" />
          Linked from
        </SectionLabel>
        <ul className="divide-y divide-border-subtle border-y border-border-subtle">
          {backlinks.map((bl) => (
            <li key={bl.key}>
              <Link
                href={bl.href}
                className="flex min-h-10 w-full items-center gap-2 px-1 py-2 text-sm font-medium text-foreground-secondary transition-colors hover:bg-subtle hover:px-2 hover:text-accent-strong focus-ring"
              >
                <Link2 className="h-3.5 w-3.5 text-foreground-tertiary" aria-hidden />
                {bl.title}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── Sources pane ──────────────────────────────────────────────────────────────

const FORMAT_ICON: Record<PageSourceFormat, typeof FileText> = {
  pdf: FileText,
  markdown: FileCode2,
  html: Globe,
  text: NotebookPen,
};

function SourcesPane({
  docs,
  loading,
  error,
}: {
  docs: PageSourceDoc[] | null;
  loading: boolean;
  error: string | null;
}) {
  const [active, setActive] = useState(0);

  if (loading || docs === null) {
    return (
      <div className="flex h-full items-center justify-center gap-2 p-8 text-sm text-foreground-tertiary">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading sources…
      </div>
    );
  }
  if (error) {
    return <div className="p-8 text-sm text-danger">{error}</div>;
  }
  if (docs.length === 0) {
    return (
      <div className="p-8 text-sm text-foreground-tertiary">
        No source documents were recorded for this page.
      </div>
    );
  }

  const i = Math.min(active, docs.length - 1);
  const src = docs[i];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* file tab strip — 横向可滚动，但隐藏滚动条且不允许纵向溢出（保证 tab 全高） */}
      <div className="flex shrink-0 items-stretch overflow-x-auto overflow-y-hidden scrollbar-none border-b border-border bg-surface">
        {docs.map((s, idx) => {
          const on = idx === i;
          const Icon = FORMAT_ICON[s.format];
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setActive(idx)}
              title={s.name}
              className={cn(
                '-mb-px inline-flex h-[38px] items-center gap-1.5 whitespace-nowrap border-r border-border px-3.5 font-mono text-xs transition-colors',
                on
                  ? 'border-b-2 border-b-accent bg-canvas font-medium text-foreground'
                  : 'border-b-2 border-b-transparent text-foreground-tertiary hover:text-foreground-secondary',
              )}
            >
              <Icon className={cn('h-3.5 w-3.5 shrink-0', on ? 'opacity-100' : 'opacity-70')} />
              {s.name}
            </button>
          );
        })}
      </div>

      {/* source meta line */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle bg-surface px-4 py-[7px] text-[11.5px] text-foreground-tertiary">
        <span className="font-semibold uppercase tracking-wide text-foreground-secondary">
          {src.meta ?? src.format}
        </span>
        {src.truncated && (
          <>
            <span className="opacity-50">·</span>
            <span>preview truncated</span>
          </>
        )}
        {src.added && (
          <span className="ml-auto inline-flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 text-accent" />
            Ingested {src.added}
          </span>
        )}
      </div>

      {/* document body */}
      <div className={cn('min-h-0 flex-1 lg:overflow-y-auto', src.format === 'pdf' ? 'bg-canvas' : 'bg-surface')}>
        <SourceBody key={src.id} source={src} />
      </div>
    </div>
  );
}

function SourceBody({ source }: { source: PageSourceDoc }) {
  // PDF/HTML 与首页一致：直接由浏览器加载完整原始文件（PDF 原生阅读器 / 沙箱 iframe）。
  const rawUrl = `/api/sources/${source.id}/raw`;

  if (source.format === 'pdf') {
    return (
      <iframe src={rawUrl} title={source.name} className="h-[80vh] w-full border-0 lg:h-full" />
    );
  }

  if (source.format === 'markdown') {
    return (
      <div className="mx-auto max-w-[62ch] px-7 pb-[72px] pt-7">
        <div className="font-prose text-md text-prose-body [&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-prose-quote [&_blockquote]:pl-4 [&_code]:rounded-sm [&_code]:bg-prose-code-bg [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.875em] [&_h1]:mb-3 [&_h1]:mt-6 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-prose-heading [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-prose-heading [&_li]:mb-1 [&_ol]:mb-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:mb-4 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-prose-code-bg [&_pre]:p-3 [&_pre]:font-mono [&_pre]:text-sm [&_strong]:font-semibold [&_strong]:text-prose-heading [&_ul]:mb-4 [&_ul]:list-disc [&_ul]:pl-6">
          {renderMarkdown(source.text ?? '')}
        </div>
      </div>
    );
  }

  if (source.format === 'html') {
    return (
      <HtmlSourceFrame
        src={rawUrl}
        title={source.name}
        safety={source.htmlSafety}
        className="h-[80vh] lg:h-full"
      />
    );
  }

  // text
  return (
    <pre className="m-0 max-w-[78ch] whitespace-pre-wrap break-words px-7 pb-[72px] pt-7 font-mono text-[13px] leading-[21px] text-prose-body">
      {source.text}
    </pre>
  );
}
