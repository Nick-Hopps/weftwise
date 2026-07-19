import path from 'path';
import Link from 'next/link';
import { getSource } from '@/server/db/repos/sources-repo';
import { getById as getSubjectById } from '@/server/db/repos/subjects-repo';
import { getRawSourceContent } from '@/server/sources/source-store';
import { analyzeHtmlSafety } from '@/server/sources/html-safety';
import { SourceViewer } from '../../_components/source-viewer';
import { decodeRouteSegment } from '@/lib/route-params';
import type { PageSourceFormat } from '@/lib/contracts';
import { getServerI18n } from '@/lib/i18n/server';

export const runtime = 'nodejs';

function formatFor(filename: string): PageSourceFormat {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  return 'text';
}

export default async function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  const { t } = await getServerI18n();
  const { id: rawId } = await params;
  const id = decodeRouteSegment(rawId);
  const source = getSource(id);
  const subject = source ? getSubjectById(source.subjectId) : null;

  if (!source || !subject) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm font-medium text-foreground">{t('source.notFound')}</p>
        <p className="max-w-sm text-xs text-foreground-secondary">
          {t('source.missingDescription')}
        </p>
        <Link href="/" className="text-xs font-medium text-accent hover:underline">
          {t('source.backDashboard')}
        </Link>
      </div>
    );
  }

  const format = formatFor(source.filename);
  const content =
    format === 'markdown' || format === 'text'
      ? getRawSourceContent(subject.slug, source.filename) ?? undefined
      : undefined;
  const htmlSafety =
    format === 'html'
      ? analyzeHtmlSafety(getRawSourceContent(subject.slug, source.filename) ?? '')
      : undefined;

  return (
    <SourceViewer
      id={source.id}
      filename={source.filename}
      format={format}
      content={content}
      htmlSafety={htmlSafety}
    />
  );
}
