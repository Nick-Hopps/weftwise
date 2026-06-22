import path from 'path';
import Link from 'next/link';
import { getSource } from '@/server/db/repos/sources-repo';
import { getById as getSubjectById } from '@/server/db/repos/subjects-repo';
import { getRawSourceContent } from '@/server/sources/source-store';
import { SourceViewer } from '../../_components/source-viewer';
import type { PageSourceFormat } from '@/lib/contracts';

export const runtime = 'nodejs';

function formatFor(filename: string): PageSourceFormat {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.md' || ext === '.mdx') return 'markdown';
  if (ext === '.html' || ext === '.htm') return 'html';
  return 'text';
}

export default async function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const source = getSource(id);
  const subject = source ? getSubjectById(source.subjectId) : null;

  if (!source || !subject) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm font-medium text-foreground">Source not found</p>
        <p className="max-w-sm text-xs text-foreground-secondary">
          This source may have been removed, or it belongs to another subject.
        </p>
        <Link href="/" className="text-xs font-medium text-accent hover:underline">
          Back to dashboard
        </Link>
      </div>
    );
  }

  const format = formatFor(source.filename);
  const content =
    format === 'markdown' || format === 'text'
      ? getRawSourceContent(subject.slug, source.filename) ?? undefined
      : undefined;

  return (
    <SourceViewer id={source.id} filename={source.filename} format={format} content={content} />
  );
}
