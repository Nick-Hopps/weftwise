import { Hash } from 'lucide-react';

export function TagsRouteFallback() {
  return (
    <div className="mx-auto w-full max-w-[1080px] space-y-7 px-5 py-8 sm:px-8 sm:py-10">
      <header>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-foreground">
          <Hash className="h-5 w-5 text-foreground-tertiary" aria-hidden />
          Tags
        </h1>
        <div className="mt-2 h-4 w-44 animate-pulse rounded-sm bg-subtle" />
      </header>
      <div className="grid grid-cols-2 gap-px border-y border-border-subtle bg-border-subtle py-3 sm:grid-cols-4">
        {[1, 2, 3, 4].map((item) => (
          <div key={item} className="h-9 animate-pulse bg-canvas px-3 sm:px-5" />
        ))}
      </div>
      <div className="h-8 animate-pulse rounded-md bg-subtle" />
      <div className="divide-y divide-border-subtle border-y border-border-subtle">
        {[1, 2, 3, 4, 5].map((item) => (
          <div key={item} className="h-16 animate-pulse bg-subtle/60" />
        ))}
      </div>
    </div>
  );
}
