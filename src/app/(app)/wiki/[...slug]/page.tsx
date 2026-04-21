import { notFound } from 'next/navigation';
import Link from 'next/link';
import { Link2 } from 'lucide-react';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { readPageBySlug } from '@/server/wiki/wiki-store';
import { serializeWikiDocument } from '@/server/wiki/markdown';
import PageRenderer from '@/components/wiki/page-renderer';
import { SectionLabel } from '@/components/ui/panel';

interface WikiPageProps {
  params: Promise<{ slug: string[] }>;
}

export async function generateMetadata({ params }: WikiPageProps) {
  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');
  const page = pagesRepo.getPageBySlug(slug);

  if (!page) return { title: 'Page Not Found — Agentic Wiki' };

  return {
    title: `${page.title} — Agentic Wiki`,
    description: page.summary || undefined,
  };
}

export default async function WikiPage({ params }: WikiPageProps) {
  const { slug: slugParts } = await params;
  const slug = slugParts.join('/');

  const page = pagesRepo.getPageBySlug(slug);
  if (!page) notFound();

  const doc = readPageBySlug(slug);
  if (!doc) notFound();

  const allPages = pagesRepo.getAllPages();
  const titleSlugMap: Record<string, string> = {};
  for (const p of allPages) {
    titleSlugMap[p.title] = p.slug;
    titleSlugMap[p.title.toLowerCase()] = p.slug;
  }

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
        <div className="max-w-content mx-auto px-6 pb-12 w-full">
          <div className="border-t border-border pt-6">
            <SectionLabel className="mb-3 flex items-center gap-1.5">
              <Link2 className="h-3 w-3" />
              Linked from
            </SectionLabel>
            <ul className="flex flex-wrap gap-2">
              {backlinks.map((bl) => (
                <li key={bl.slug}>
                  <Link
                    href={`/wiki/${bl.slug}`}
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
