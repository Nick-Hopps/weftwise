'use client';

interface FrontmatterDisplayProps {
  title: string;
  tags: string[];
  sources: string[];
  created: string;
  updated: string;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export default function FrontmatterDisplay({
  title,
  tags,
  sources,
  created,
  updated,
}: FrontmatterDisplayProps) {
  return (
    <div className="pb-6 mb-8 border-b border-slate-200 dark:border-zinc-700">
      {/* Title */}
      <h1 className="text-3xl font-bold font-serif text-zinc-950 dark:text-slate-50 mb-4 leading-tight">
        {title}
      </h1>

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-4">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-block px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Sources */}
      {sources.length > 0 && (
        <div className="mb-4">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-zinc-400 mr-2">
            Sources:
          </span>
          <ul className="inline">
            {sources.map((src, i) => (
              <li key={i} className="inline text-sm text-slate-600 dark:text-zinc-300">
                {src}
                {i < sources.length - 1 ? ', ' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Dates */}
      {(created || updated) && (
        <p className="text-xs text-slate-400 dark:text-zinc-500">
          {created && (
            <span>
              Created: <time dateTime={created}>{formatDate(created)}</time>
            </span>
          )}
          {created && updated && <span className="mx-1.5">·</span>}
          {updated && (
            <span>
              Updated: <time dateTime={updated}>{formatDate(updated)}</time>
            </span>
          )}
        </p>
      )}
    </div>
  );
}
