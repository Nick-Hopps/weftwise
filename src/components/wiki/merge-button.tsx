'use client';

import { useState } from 'react';
import { GitMerge } from 'lucide-react';
import { MergeDialog } from './merge-dialog';

export function MergeButton({ slug, title }: { slug: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Merge another page into this one"
        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-sm font-medium text-foreground-secondary border border-border hover:bg-subtle hover:text-foreground transition-colors focus-ring"
      >
        <GitMerge className="h-3.5 w-3.5" />
        Merge
      </button>
      {open && <MergeDialog targetSlug={slug} targetTitle={title} onClose={() => setOpen(false)} />}
    </>
  );
}
