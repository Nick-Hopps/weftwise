import { notFound } from 'next/navigation';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { Link2 } from 'lucide-react';
import type { Metadata } from 'next';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import { GENERAL_SUBJECT_SLUG } from '@/server/wiki/page-identity';
import { readPageInSubject } from '@/server/wiki/wiki-store';
import { serializeWikiDocument } from '@/server/wiki/markdown';
import PageRenderer from '@/components/wiki/page-renderer';
import { SectionLabel } from '@/components/ui/panel';
import type { Subject } from '@/lib/contracts';

const SUBJECT_COOKIE = 'wiki_subject';

interface WikiPageProps {
  params: Promise<{ slug: string[] }>;
  searchParams?: Promise<{ s?: string }>;
}

async function resolveActiveSubject(searchSubjectSlug?: string): Promise<Subject> {
  if (searchSubjectSlug) {
    const fromQuery = subjectsRepo.getBySlug(searchSubjectSlug);
    if (fromQuery) return fromQuery;
  }
  const store = await cookies();
  const slug = store.get(SUBJECT_COOKIE)?.value ?? GENERAL_SUBJECT_SLUG;
  return (
    subjectsRepo.getBySlug(slug) ??
    subjectsRepo.getBySlugOrThrow(GENERAL_SUBJECT_SLUG)
  );
}

export async function generateMetadata({ params, searchParams }: WikiPageProps): Promise<Metadata> {
  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');
  const sp = (await searchParams) ?? {};
  const subject = await resolveActiveSubject(sp.s);
  const page = pagesRepo.getPageBySlug(subject.id, slug);

  if (!page) return { title: 'Page Not Found — Agentic Wiki' };

  return {
    title: `${page.title} — ${subject.name}`,
    description: page.summary || undefined,
  };
}

export default async function WikiPage({ params, searchParams }: WikiPageProps) {
  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');
  const sp = (await searchParams) ?? {};
  const subject = await resolveActiveSubject(sp.s);

  const page = pagesRepo.getPageBySlug(subject.id, slug);
  if (!page) {
    const elsewhere = pagesRepo
      .findPageBySlugAcrossSubjects(slug)
      .filter((p) => p.subjectId !== subject.id);
    if (elsewhere.length > 0) {
      const hints = elsewhere
        .map((p) => {
          const owning = subjectsRepo.getById(p.subjectId);
          return owning
            ? { subject: owning, page: p }
            : null;
        })
        .filter((h): h is { subject: Subject; page: typeof elsewhere[number] } => h !== null);

      return <WikiPageElsewhere slug={slug} hints={hints} activeSubjectName={subject.name} />;
    }
    notFound();
  }

  const doc = readPageInSubject(subject.slug, slug);
  if (!doc) notFound();

  const allPages = pagesRepo.getAllPages(subject.id);
  const titleSlugMap: Record<string, string> = {};
  for (const p of allPages) {
    titleSlugMap[p.title] = p.slug;
    titleSlugMap[p.title.toLowerCase()] = p.slug;
  }

  const backlinks = pagesRepo.getBacklinks(subject.id, slug);

  return (
    <div className="flex flex-col min-h-full">
      <PageRenderer
        content={doc.body}
        rawContent={serializeWikiDocument(doc)}
        slug={slug}
        title={doc.frontmatter.title ?? page.title}
        tags={doc.frontmatter.tags ?? page.tags}
        sources={doc.frontmatter.sources ?? []}
        created={doc.frontmatter.created ?? page.createdAt}
        updated={doc.frontmatter.updated ?? page.updatedAt}
        titleSlugMap={titleSlugMap}
        editHref={`/wiki/edit/${slug}?s=${encodeURIComponent(subject.slug)}`}
        subjectSlug={subject.slug}
      />

      {backlinks.length > 0 && (
        <div className="max-w-content mx-auto px-6 pb-12 w-full">
          <div className="border-t border-border pt-6">
            <SectionLabel className="mb-3 flex items-center gap-1.5">
              <Link2 className="h-3 w-3" />
              Linked from
            </SectionLabel>
            <ul className="flex flex-wrap gap-2">
              {backlinks.map((bl) => (
                <li key={`${bl.subjectId}:${bl.slug}`}>
                  <Link
                    href={
                      bl.subjectId === subject.id
                        ? `/wiki/${bl.slug}`
                        : `/wiki/${bl.slug}?s=${encodeURIComponent(
                            subjectsRepo.getById(bl.subjectId)?.slug ?? '',
                          )}`
                    }
                    className="inline-flex items-center gap-1.5 px-3 h-8 rounded-md text-sm font-medium text-accent-strong bg-accent-subtle border border-accent/20 hover:bg-accent/15 hover:border-accent/40 transition-colors focus-ring"
                  >
                    {bl.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

interface ElsewhereHint {
  subject: Subject;
  page: { slug: string; title: string; subjectId: string };
}

function WikiPageElsewhere({
  slug,
  hints,
  activeSubjectName,
}: {
  slug: string;
  hints: ElsewhereHint[];
  activeSubjectName: string;
}) {
  return (
    <div className="max-w-content mx-auto px-6 py-12 w-full">
      <h1 className="text-xl font-semibold text-foreground">Page not found</h1>
      <p className="mt-2 text-sm text-foreground-secondary">
        <code className="font-mono text-xs px-1.5 py-0.5 rounded bg-subtle">{slug}</code>{' '}
        does not exist in <span className="font-medium">{activeSubjectName}</span>, but it
        lives in {hints.length === 1 ? 'another subject' : `${hints.length} other subjects`}:
      </p>
      <ul className="mt-4 space-y-2">
        {hints.map(({ subject: owning, page }) => (
          <li key={owning.id}>
            <Link
              href={`/wiki/${page.slug}?s=${encodeURIComponent(owning.slug)}`}
              className="inline-flex items-center gap-2 px-3 h-9 rounded-md text-sm font-medium text-accent-strong bg-accent-subtle border border-accent/20 hover:bg-accent/15 hover:border-accent/40 transition-colors focus-ring"
            >
              <span>{page.title}</span>
              <span className="text-xs text-foreground-tertiary">in {owning.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
