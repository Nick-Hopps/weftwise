'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { ArrowLeft, ExternalLink, FileText } from 'lucide-react';
import { renderMarkdown } from '@/lib/markdown-client';
import { Tag } from '@/components/ui/tag';
import { cn } from '@/lib/cn';
import { HtmlSourceFrame } from '@/components/wiki/html-source-frame';
import { UrlSourcePreview } from '@/components/wiki/url-source-preview';
import type { PageSourceFormat, HtmlSafety } from '@/lib/contracts';
import { useI18n } from '@/components/i18n-provider';
import type { MessageKey } from '@/lib/i18n/messages';

const PROSE_CLASS = cn(
  'text-[15px] leading-7 text-prose-body',
  '[&>h1]:text-2xl [&>h1]:font-semibold [&>h1]:text-prose-heading [&>h1]:tracking-tight [&>h1]:mt-8 [&>h1]:mb-4',
  '[&>h2]:text-lg [&>h2]:font-semibold [&>h2]:text-prose-heading [&>h2]:mt-6 [&>h2]:mb-3',
  '[&>h3]:text-base [&>h3]:font-semibold [&>h3]:text-prose-heading [&>h3]:mt-5 [&>h3]:mb-2',
  '[&>p]:my-3',
  '[&>ul]:my-3 [&>ul]:ml-5 [&>ul]:list-disc [&>ol]:my-3 [&>ol]:ml-5 [&>ol]:list-decimal [&_li]:my-1',
  '[&>blockquote]:border-l-2 [&>blockquote]:border-prose-quote [&>blockquote]:pl-4 [&>blockquote]:my-4 [&>blockquote]:italic [&>blockquote]:text-prose-muted',
  '[&>pre]:bg-prose-code-bg [&>pre]:text-prose-code [&>pre]:rounded-md [&>pre]:p-4 [&>pre]:my-4 [&>pre]:overflow-x-auto [&>pre]:text-sm [&>pre]:font-mono',
  '[&_code]:bg-prose-code-bg [&_code]:text-prose-code [&_code]:rounded-sm [&_code]:px-1 [&_code]:text-[0.875em] [&_code]:font-mono [&>pre_code]:bg-transparent [&>pre_code]:p-0',
  '[&_a]:text-accent [&_a]:underline [&_a]:decoration-accent/40 [&_a]:underline-offset-4',
  '[&_strong]:font-semibold [&_strong]:text-prose-heading',
  '[&_table]:w-full [&_table]:my-4 [&_table]:text-sm [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
);

interface SourceViewerProps {
  id: string;
  filename: string;
  format: PageSourceFormat;
  /** Raw text for markdown/text sources (read server-side). */
  content?: string;
  /** 仅 html：服务端启发式扫描结论。 */
  htmlSafety?: HtmlSafety;
  /** URL Source：直接在沙箱 iframe 中加载原站。 */
  sourceUrl?: string;
  /** URL Source：摄入时保存的本地 Markdown 阅读正文。 */
  readerText?: string;
  readerTextTruncated?: boolean;
}

const FORMAT_LABEL: Record<PageSourceFormat, MessageKey> = {
  pdf: 'source.format.pdf',
  markdown: 'source.format.markdown',
  html: 'source.format.html',
  text: 'source.format.text',
};

export function SourceViewer({
  id,
  filename,
  format,
  content,
  htmlSafety,
  sourceUrl,
  readerText,
  readerTextTruncated,
}: SourceViewerProps) {
  const { t } = useI18n();
  const rawUrl = `/api/sources/${id}/raw`;
  const viewUrl = sourceUrl ?? rawUrl;
  const rendered = useMemo(
    () => (format === 'markdown' && content ? renderMarkdown(content) : null),
    [format, content],
  );

  return (
    <div className="flex h-full flex-col bg-canvas">
      {/* header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3 sm:px-6">
        <Link
          href="/"
          aria-label={t('source.back')}
          data-tip={t('source.back')}
          className="tip tip-b inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground-secondary hover:bg-subtle hover:text-foreground transition-colors focus-ring"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent">
          <FileText className="h-4 w-4" aria-hidden />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-mono text-sm font-semibold text-foreground">{filename}</span>
          <Tag tone="neutral">{sourceUrl ? t('source.web') : t(FORMAT_LABEL[format])}</Tag>
        </div>
        <a
          href={viewUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-foreground-secondary hover:bg-subtle transition-colors focus-ring"
        >
          <ExternalLink className="h-3.5 w-3.5" />
          {sourceUrl ? t('source.openOriginal') : t('source.openRaw')}
        </a>
      </div>

      {/* body */}
      {format === 'pdf' ? (
        <iframe src={rawUrl} title={filename} className="min-h-0 flex-1 border-0 bg-canvas" />
      ) : format === 'html' && sourceUrl ? (
        <UrlSourcePreview
          src={sourceUrl}
          title={filename}
          readerText={readerText}
          readerTextTruncated={readerTextTruncated}
          className="min-h-0 flex-1"
        />
      ) : format === 'html' ? (
        <HtmlSourceFrame
          src={viewUrl}
          title={filename}
          safety={htmlSafety}
          remote={Boolean(sourceUrl)}
          className="min-h-0 flex-1"
        />
      ) : format === 'markdown' ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <article className={cn(PROSE_CLASS, 'mx-auto max-w-[760px] px-6 py-8')}>{rendered}</article>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <pre className="mx-auto max-w-[860px] whitespace-pre-wrap px-6 py-8 font-mono text-[13px] leading-6 text-foreground">
            {content ?? t('source.noContent')}
          </pre>
        </div>
      )}
    </div>
  );
}
