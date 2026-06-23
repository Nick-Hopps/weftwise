'use client';

import { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { ReenrichDialog } from './reenrich-dialog';

export function ReenrichButton({ slug, title }: { slug: string; title: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-tip="Re-enrich this page (re-run augmentation)"
        className="tip tip-b shrink-0 inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-sm font-medium text-foreground-secondary border border-border hover:bg-subtle hover:text-foreground transition-colors focus-ring"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Re-enrich
      </button>
      {open && <ReenrichDialog slug={slug} title={title} onClose={() => setOpen(false)} />}
    </>
  );
}
