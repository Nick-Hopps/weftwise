import Link from 'next/link';
import * as pagesRepo from '@/server/db/repos/pages-repo';
import { getDb } from '@/server/db/client';
import { sources } from '@/server/db/schema';
import LintButton from './_components/lint-button';
import ResetButton from './_components/reset-button';

function countSources(): number {
  try {
    const db = getDb();
    const rows = db.select().from(sources).all();
    return rows.length;
  } catch {
    return 0;
  }
}

function getRecentPages(limit = 5) {
  try {
    const all = pagesRepo.getAllPages();
    return all
      .sort((a, b) => (b.updatedAt > a.updatedAt ? 1 : -1))
      .slice(0, limit);
  } catch {
    return [];
  }
}

function getStats() {
  try {
    const pages = pagesRepo.getAllPages();
    const links = pagesRepo.getAllLinks();
    const sourceCount = countSources();
    return {
      pageCount: pages.length,
      linkCount: links.length,
      sourceCount,
    };
  } catch {
    return { pageCount: 0, linkCount: 0, sourceCount: 0 };
  }
}

export default function DashboardPage() {
  const stats = getStats();
  const recentPages = getRecentPages();

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-8">
      {/* Page title */}
      <div>
        <h1 className="text-3xl font-bold text-zinc-900 dark:text-slate-50">Dashboard</h1>
        <p className="text-zinc-500 dark:text-zinc-400 mt-1">
          Overview of your knowledge base
        </p>
      </div>

      {/* Stats grid */}
      <section>
        <h2 className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-3">
          Wiki Stats
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <StatCard label="Pages" value={stats.pageCount} />
          <StatCard label="Links" value={stats.linkCount} />
          <StatCard label="Sources" value={stats.sourceCount} />
        </div>
      </section>

      {/* Recent pages */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest">
            Recent Pages
          </h2>
          <Link
            href="/graph"
            className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
          >
            View graph
          </Link>
        </div>

        {recentPages.length === 0 ? (
          <p className="text-sm text-zinc-400 dark:text-zinc-500 italic">
            No pages yet. Ingest a source to get started.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800 rounded-xl border border-zinc-100 dark:border-zinc-800 overflow-hidden">
            {recentPages.map((page) => (
              <li key={page.slug}>
                <Link
                  href={`/wiki/${page.slug}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/60 transition-colors group"
                >
                  <span className="text-sm font-medium text-zinc-800 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                    {page.title}
                  </span>
                  <span className="text-xs text-zinc-400 dark:text-zinc-500 shrink-0 ml-4">
                    {formatDate(page.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Quick actions */}
      <section>
        <h2 className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-widest mb-3">
          Quick Actions
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Ingest Source */}
          <Link
            href="/ingest"
            className="flex flex-col gap-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-md transition-all group"
          >
            <span className="text-2xl">+</span>
            <span className="font-semibold text-zinc-800 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
              Ingest Source
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Import documents, PDFs, or text files into your wiki
            </span>
          </Link>

          {/* Ask Wiki — opens command palette */}
          <Link
            href="/?cmd=1"
            className="flex flex-col gap-2 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 p-5 hover:border-indigo-400 dark:hover:border-indigo-500 hover:shadow-md transition-all group"
          >
            <span className="text-2xl">?</span>
            <span className="font-semibold text-zinc-800 dark:text-slate-200 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
              Ask Wiki
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Ask a question and get answers from your knowledge base
            </span>
          </Link>

          {/* Run Lint — client action */}
          <LintButton />

          {/* Reset Wiki — danger action */}
          <ResetButton />
        </div>
      </section>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-5 py-4 flex flex-col gap-1">
      <span className="text-3xl font-bold text-zinc-900 dark:text-slate-50 tabular-nums">
        {value}
      </span>
      <span className="text-xs text-zinc-500 dark:text-zinc-400 uppercase tracking-wide font-medium">
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
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}
