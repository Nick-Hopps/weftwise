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
import { DashboardIngestHero } from './_components/dashboard-ingest-hero';
import { SectionLabel } from '@/components/ui/panel';
import { Tag } from '@/components/ui/tag';
import type { Subject } from '@/lib/contracts';
import { ArrowUpRight, BookOpenText, Database, Link2 } from 'lucide-react';
import { getServerI18n } from '@/lib/i18n/server';

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
  const { t } = await getServerI18n();
  const subject = await resolveActiveSubject();
  const stats = getStats(subject.id);
  const recentPages = getRecentPages(subject.id);
  const isEmpty = stats.pageCount === 0;

  if (isEmpty) {
    return (
      <div className="mx-auto max-w-[780px] space-y-8 px-5 py-10 sm:px-8 sm:py-16">
        <DashboardHero pageCount={0} />
        <DashboardIngestHero />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-[1180px] space-y-10 px-5 py-8 sm:px-8 sm:py-10">
      {/* greeting + stats */}
      <div className="flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between">
        <DashboardHero pageCount={stats.pageCount} compact />
        <dl className="grid grid-cols-3 divide-x divide-border-subtle border-y border-border-subtle py-3 lg:min-w-[410px] lg:border-y-0 lg:py-0">
          <DashboardStat icon={BookOpenText} label={t('dashboard.pages')} value={stats.pageCount} />
          <DashboardStat icon={Link2} label={t('dashboard.links')} value={stats.linkCount} />
          <DashboardStat icon={Database} label={t('dashboard.sources')} value={stats.sourceCount} />
        </dl>
      </div>

      {/* ingest hero — the dashboard's primary feature */}
      <DashboardIngestHero />

      {/* recent pages */}
      <section aria-labelledby="recent-pages-heading">
        <div className="mb-3 flex items-center justify-between">
          <SectionLabel id="recent-pages-heading">
            {t('dashboard.recentPages')} — <span className="font-mono normal-case">{subject.slug}</span>
          </SectionLabel>
          <span className="text-xs text-foreground-tertiary font-mono">{recentPages.length}</span>
        </div>
        <ul className="divide-y divide-border-subtle border-y border-border-subtle">
          {recentPages.map((page) => {
            const tags = (page.tags ?? []).filter((t) => t !== 'meta').slice(0, 2);
            return (
              <li key={`${page.subjectId}:${page.slug}`}>
                <Link
                  href={`/wiki/${page.slug}`}
                  className="group flex min-h-12 items-center gap-3 px-2 py-2 transition-colors hover:bg-subtle focus-ring sm:px-3"
                >
                  <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-foreground-tertiary transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />
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
                  {tags.length > 0 && (
                    <span className="hidden lg:flex gap-1 shrink-0">
                      {tags.map((t) => (
                        <Tag key={t} tone="neutral">
                          {t}
                        </Tag>
                      ))}
                    </span>
                  )}
                  <time className="text-xs font-mono text-foreground-tertiary shrink-0">
                    {formatDate(page.updatedAt)}
                  </time>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {/* knowledge graph — kept from the live app (the design relocates it to the context panel) */}
      <section aria-labelledby="wiki-graph-heading">
        <div className="flex items-center justify-between mb-2">
          <SectionLabel id="wiki-graph-heading">
            Wiki Graph — <span className="font-mono normal-case">{subject.slug}</span>
          </SectionLabel>
        </div>
        <div className="h-[28rem] overflow-hidden rounded-md border border-border bg-canvas shadow-xs md:h-[32rem] lg:h-[36rem]">
          <MiniGraphView key={subject.id} fill />
        </div>
      </section>
    </div>
  );
}

function DashboardStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof BookOpenText;
  label: string;
  value: number;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4 first:pl-0 last:pr-0 lg:first:pl-4">
      <dt className="flex items-center gap-1.5 text-xs font-medium text-foreground-tertiary">
        <Icon className="h-3.5 w-3.5" aria-hidden />
        {label}
      </dt>
      <dd className="text-2xl font-semibold leading-none text-foreground tabular-nums">
        {value}
      </dd>
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
