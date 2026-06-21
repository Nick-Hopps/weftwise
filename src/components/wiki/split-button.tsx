'use client';

import { useState } from 'react';
import { Scissors } from 'lucide-react';
import { SplitDialog } from './split-dialog';

export function SplitButton({ slug, title }: { slug: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="Split this page into multiple pages"
        className="shrink-0 inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-sm font-medium text-foreground-secondary border border-border hover:bg-subtle hover:text-foreground transition-colors focus-ring"
      >
        <Scissors className="h-3.5 w-3.5" />
        Split
      </button>
      {open && <SplitDialog sourceSlug={slug} sourceTitle={title} onClose={() => setOpen(false)} />}
    </>
  );
}
