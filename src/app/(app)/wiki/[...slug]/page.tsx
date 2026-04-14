import { notFound } from 'next/navigation';
import Link from 'next/link';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { readPageBySlug } from '@/server/wiki/wiki-store';
import { serializeWikiDocument } from '@/server/wiki/markdown';
import PageRenderer from '@/components/wiki/page-renderer';

interface WikiPageProps {
  params: Promise<{ slug: string[] }>;
}

export async function generateMetadata({ params }: WikiPageProps) {
  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');
  const page = pagesRepo.getPageBySlug(slug);

  if (!page) {
    return { title: 'Page Not Found — Agentic Wiki' };
  }

  return {
    title: `${page.title} — Agentic Wiki`,
    description: page.summary || undefined,
  };
}

export default async function WikiPage({ params }: WikiPageProps) {
  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');

  // Fetch page metadata from DB
  const page = pagesRepo.getPageBySlug(slug);
  if (!page) {
    notFound();
  }

  // Read full markdown content from filesystem
  const doc = readPageBySlug(slug);
  if (!doc) {
    notFound();
  }

  // Build title→slug map for wikilink resolution
  const allPages = pagesRepo.getAllPages();
  const titleSlugMap: Record<string, string> = {};
  for (const p of allPages) {
    titleSlugMap[p.title] = p.slug;
    titleSlugMap[p.title.toLowerCase()] = p.slug;
  }

  // Fetch backlinks
  const backlinks = pagesRepo.getBacklinks(slug);

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
      />

      {backlinks.length > 0 && (
        <div className="max-w-3xl mx-auto px-6 pb-10">
          <div className="border-t border-[rgb(var(--border))] pt-6">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--muted))] mb-3 flex items-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="opacity-60">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              Linked from
            </h2>
            <ul className="flex flex-wrap gap-2">
              {backlinks.map((bl) => (
                <li key={bl.slug}>
                  <Link
                    href={`/wiki/${bl.slug}`}
                    className="
                      inline-flex items-center gap-1.5
                      px-3 py-1.5 rounded-lg
                      text-sm font-medium
                      text-indigo-700 dark:text-indigo-300
                      bg-indigo-50 dark:bg-indigo-950/40
                      border border-indigo-200 dark:border-indigo-800
                      hover:bg-indigo-100 dark:hover:bg-indigo-900/60
                      hover:border-indigo-300 dark:hover:border-indigo-700
                      transition-colors
                    "
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 opacity-50">
                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                      <polyline points="15 3 21 3 21 9" />
                      <line x1="10" y1="14" x2="21" y2="3" />
                    </svg>
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
