'use client';

import { WikiGraphView } from '@/components/graph/wiki-graph-view';

export default function GraphPage() {
  return (
    <div className="w-full h-full p-4">
      <div className="mb-4">
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-slate-50">Wiki Graph</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Wiki pages and their wikilink connections.
        </p>
      </div>
      <div className="h-[calc(100vh-10rem)] relative">
        <WikiGraphView />
      </div>
    </div>
  );
}
