import Link from 'next/link';
import { cookies } from 'next/headers';
import dynamic from 'next/dynamic';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import * as subjectsRepo from '@/server/db/repos/subjects-repo';
import { GENERAL_SUBJECT_SLUG } from '@/server/wiki/page-identity';
import { getDb } from '@/server/db/client';
import { sources } from '@/server/db/schema';
import { eq } from 'drizzle-orm';
import { DashboardHero } from './_components/dashboard-hero';
import { DashboardIngestPanel } from './_components/dashboard-ingest-panel';
import { SectionLabel } from '@/components/ui/panel';
import { TagLink } from '@/components/wiki/tag-link';
import type { Subject } from '@/lib/contracts';

const SUBJECT_COOKIE = 'wiki_subject';

const MiniGraphView = dynamic(
  () => import('@/components/graph/mini-graph-view').then((m) => ({ default: m.MiniGraphView })),
  {
    loading: () => (
      <div className="w-full h-full rounded-md border border-border bg-canvas flex items-center justify-center text-xs text-foreground-tertiary">
        Loading graph…
      </div>
    ),
  },
);

async function resolveActiveSubject(): Promise<Subject> {
  const store = await cookies();
  const slug = store.get(SUBJECT_COOKIE)?.value ?? GENERAL_SUBJECT_SLUG;
  return (
    subjectsRepo.getBySlug(slug) ??
    subjectsRepo.getBySlugOrThrow(GENERAL_SUBJECT_SLUG)
  );
}

function countSources(subjectId: string): number {
  try {
    const db = getDb();
    const rows = db.select().from(sources).where(eq(sources.subjectId, subjectId)).all();
    return rows.length;
  } catch {
    return 0;
  }
}

function getRecentPages(subjectId: string, limit = 10) {
  try {
    const all = pagesRepo.getAllPages(subjectId);
    return all
      .filter((p) => !(p.tags ?? []).includes('meta'))
      .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function getStats(subjectId: string) {
  try {
    const pages = pagesRepo.getAllPages(subjectId).filter((p) => !(p.tags ?? []).includes('meta'));
    const links = pagesRepo.getAllLinks(subjectId);
    return {
      pageCount: pages.length,
      linkCount: links.length,
      sourceCount: countSources(subjectId),
    };
  } catch {
    return { pageCount: 0, linkCount: 0, sourceCount: 0 };
  }
}

export default async function DashboardPage() {
  const subject = await resolveActiveSubject();
  const stats = getStats(subject.id);
  const recentPages = getRecentPages(subject.id);
  const isEmpty = stats.pageCount === 0;

  if (isEmpty) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-10 sm:py-16 space-y-8">
        <DashboardHero pageCount={0} />
        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-foreground">
              Start with your first source in <span className="font-mono text-accent-strong">{subject.slug}</span>
            </h2>
            <p className="text-sm text-foreground-secondary">
              Upload a document or paste text — the agent will create the pages for you.
            </p>
          </div>
          <DashboardIngestPanel />
        </section>
      </div>
    );
  }

  return (
    <div className="max-w-[1200px] mx-auto w-full px-6 py-6 space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-end lg:justify-between gap-4">
        <DashboardHero pageCount={stats.pageCount} compact />
        <div className="grid grid-cols-3 gap-2 lg:w-auto lg:min-w-[380px]">
          <StatCard label="Pages" value={stats.pageCount} />
          <StatCard label="Links" value={stats.linkCount} />
          <StatCard label="Sources" value={stats.sourceCount} />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <section aria-labelledby="recent-pages-heading" className="lg:col-span-8">
          <div className="flex items-center justify-between mb-2">
            <SectionLabel id="recent-pages-heading">
              Recent Pages — <span className="font-mono">{subject.slug}</span>
            </SectionLabel>
            <span className="text-xs text-foreground-tertiary font-mono">
              {recentPages.length}
            </span>
          </div>
          <ul className="rounded-md border border-border bg-surface divide-y divide-border">
            {recentPages.map((page) => (
              <li key={`${page.subjectId}:${page.slug}`}>
                <Link
                  href={`/wiki/${page.slug}`}
                  className="group flex items-center gap-3 h-11 px-3 hover:bg-subtle transition-colors focus-ring rounded-md"
                >
                  <span className="text-foreground-tertiary text-xs font-mono w-4 shrink-0">≡</span>
                  <span className="flex-1 min-w-0 flex items-center gap-3">
                    <span className="text-sm font-medium text-foreground group-hover:text-accent-strong transition-colors truncate">
                      {page.title}
                    </span>
                    {page.summary && (
                      <span className="hidden md:inline text-xs text-foreground-tertiary truncate">
                        {page.summary}
                      </span>
                    )}
                  </span>
                  {page.tags && page.tags.filter((t) => t !== 'meta').length > 0 && (
                    <span className="hidden lg:flex gap-1 shrink-0">
                      {page.tags.filter((t) => t !== 'meta').slice(0, 2).map((t) => (
                        <TagLink key={t} tag={t} subjectSlug={subject.slug} />
                      ))}
                    </span>
                  )}
                  <time className="text-xs font-mono text-foreground-tertiary shrink-0">
                    {formatDate(page.updatedAt)}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        </section>

        <aside className="lg:col-span-4 space-y-4">
          <section aria-labelledby="add-knowledge-heading" className="space-y-2">
            <SectionLabel id="add-knowledge-heading">Add Knowledge</SectionLabel>
            <DashboardIngestPanel compact />
          </section>

          <section aria-labelledby="wiki-graph-heading" className="space-y-2">
            <SectionLabel id="wiki-graph-heading">Wiki Graph — {subject.slug}</SectionLabel>
            <div className="h-60">
              <MiniGraphView key={subject.id} fill />
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3 flex flex-col gap-0.5">
      <span className="text-xl font-semibold text-foreground tabular-nums leading-none">
        {value}
      </span>
      <span className="text-xs text-foreground-secondary font-medium">
        {label}
      </span>
    </div>
  );
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}
