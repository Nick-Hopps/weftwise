export default function PageSkeleton() {
  return (
    <div className="animate-pulse px-6 py-8 max-w-3xl mx-auto">
      {/* Title skeleton */}
      <div className="h-9 bg-slate-200 dark:bg-zinc-700 rounded-md w-3/4 mb-5" />

      {/* Tags row skeleton */}
      <div className="flex gap-2 mb-5">
        <div className="h-5 bg-slate-200 dark:bg-zinc-700 rounded-full w-16" />
        <div className="h-5 bg-slate-200 dark:bg-zinc-700 rounded-full w-20" />
        <div className="h-5 bg-slate-200 dark:bg-zinc-700 rounded-full w-14" />
      </div>

      {/* Date skeleton */}
      <div className="h-3.5 bg-slate-200 dark:bg-zinc-700 rounded w-48 mb-8" />

      {/* Divider */}
      <div className="h-px bg-slate-200 dark:bg-zinc-700 mb-8" />

      {/* Content paragraph skeletons */}
      <div className="space-y-6">
        {/* Paragraph 1 */}
        <div className="space-y-2">
          <div className="h-4 bg-slate-200 dark:bg-zinc-700 rounded w-full" />
          <div className="h-4 bg-slate-200 dark:bg-zinc-700 rounded w-11/12" />
          <div className="h-4 bg-slate-200 dark:bg-zinc-700 rounded w-4/5" />
        </div>

        {/* Heading skeleton */}
        <div className="h-6 bg-slate-200 dark:bg-zinc-700 rounded w-2/5 mt-2" />

        {/* Paragraph 2 */}
        <div className="space-y-2">
          <div className="h-4 bg-slate-200 dark:bg-zinc-700 rounded w-full" />
          <div className="h-4 bg-slate-200 dark:bg-zinc-700 rounded w-10/12" />
          <div className="h-4 bg-slate-200 dark:bg-zinc-700 rounded w-full" />
          <div className="h-4 bg-slate-200 dark:bg-zinc-700 rounded w-3/4" />
        </div>

        {/* List skeleton */}
        <div className="space-y-2 pl-4">
          <div className="h-4 bg-slate-200 dark:bg-zinc-700 rounded w-5/6" />
          <div className="h-4 bg-slate-200 dark:bg-zinc-700 rounded w-4/6" />
          <div className="h-4 bg-slate-200 dark:bg-zinc-700 rounded w-3/4" />
        </div>

        {/* Paragraph 3 */}
        <div className="space-y-2">
          <div className="h-4 bg-slate-200 dark:bg-zinc-700 rounded w-full" />
          <div className="h-4 bg-slate-200 dark:bg-zinc-700 rounded w-9/12" />
        </div>
      </div>
    </div>
  );
}
