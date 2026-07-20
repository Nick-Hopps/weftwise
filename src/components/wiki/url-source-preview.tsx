'use client';

import { useMemo, useState } from 'react';
import { BookOpenText, Globe2 } from 'lucide-react';
import { HtmlSourceFrame } from './html-source-frame';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { renderMarkdown } from '@/lib/markdown-client';
import { cn } from '@/lib/cn';
import { useI18n } from '@/components/i18n-provider';

interface UrlSourcePreviewProps {
  src: string;
  title: string;
  readerText?: string;
  readerTextTruncated?: boolean;
  className?: string;
}

const READER_PROSE_CLASS = cn(
  'font-prose text-[15px] leading-7 text-prose-body',
  '[&_h1]:mb-4 [&_h1]:mt-8 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:text-prose-heading',
  '[&_h2]:mb-3 [&_h2]:mt-6 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-prose-heading',
  '[&_h3]:mb-2 [&_h3]:mt-5 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-prose-heading',
  '[&_p]:my-3 [&_ul]:my-3 [&_ul]:ml-5 [&_ul]:list-disc [&_ol]:my-3 [&_ol]:ml-5 [&_ol]:list-decimal [&_li]:my-1',
  '[&_blockquote]:my-4 [&_blockquote]:border-l-2 [&_blockquote]:border-prose-quote [&_blockquote]:pl-4 [&_blockquote]:italic [&_blockquote]:text-prose-muted',
  '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-prose-code-bg [&_pre]:p-4 [&_pre]:font-mono [&_pre]:text-sm [&_pre]:text-prose-code',
  '[&_code]:rounded-sm [&_code]:bg-prose-code-bg [&_code]:px-1 [&_code]:font-mono [&_code]:text-[0.875em] [&_code]:text-prose-code',
  '[&_a]:text-accent [&_a]:underline [&_a]:decoration-accent/40 [&_a]:underline-offset-4',
  '[&_strong]:font-semibold [&_strong]:text-prose-heading',
  '[&_table]:my-4 [&_table]:w-full [&_table]:text-sm [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1',
);

/** URL Source 的实时网页与本地阅读正文共用预览。 */
export function UrlSourcePreview({
  src,
  title,
  readerText,
  readerTextTruncated = false,
  className,
}: UrlSourcePreviewProps) {
  const { t } = useI18n();
  const [mode, setMode] = useState<'live' | 'reader'>('live');
  const rendered = useMemo(
    () => (readerText ? renderMarkdown(readerText) : null),
    [readerText],
  );

  return (
    <Tabs
      value={mode}
      onValueChange={(value) => setMode(value as 'live' | 'reader')}
      className={cn('flex min-h-0 flex-col bg-surface', className)}
    >
      <div className="flex min-h-10 shrink-0 items-center gap-3 border-b border-border-subtle bg-surface px-3 py-1">
        <TabsList aria-label={t('source.preview.mode')} className="h-7">
          <TabsTrigger value="live" className="h-6 gap-1.5 px-2 text-xs">
            <Globe2 className="h-3.5 w-3.5" aria-hidden />
            {t('source.preview.live')}
          </TabsTrigger>
          <TabsTrigger value="reader" className="h-6 gap-1.5 px-2 text-xs">
            <BookOpenText className="h-3.5 w-3.5" aria-hidden />
            {t('source.preview.reader')}
          </TabsTrigger>
        </TabsList>
        {mode === 'reader' && readerTextTruncated && (
          <span className="ml-auto text-[11px] text-foreground-tertiary">
            {t('source.readerTruncated')}
          </span>
        )}
      </div>

      <TabsContent value="live" className="min-h-0 flex-1">
        <HtmlSourceFrame src={src} title={title} remote className="h-full" />
      </TabsContent>
      <TabsContent value="reader" className="min-h-0 flex-1 overflow-y-auto bg-surface">
        {rendered ? (
          <article className={cn(READER_PROSE_CLASS, 'mx-auto max-w-[760px] px-6 pb-20 pt-7')}>
            {rendered}
          </article>
        ) : (
          <div className="flex min-h-48 items-center justify-center px-6 text-center text-sm text-foreground-tertiary">
            {t('source.readerUnavailable')}
          </div>
        )}
      </TabsContent>
    </Tabs>
  );
}
