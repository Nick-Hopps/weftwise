'use client';

import { Network } from 'lucide-react';

// ── Empty state — teaches the interface rather than just says "nothing" ──────

export function EmptyGraphState() {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <Network
        aria-hidden
        className="h-7 w-7 text-foreground-tertiary/70"
        strokeWidth={1.3}
      />
      <p className="text-xs font-medium text-foreground-secondary">
        No connections yet
      </p>
      <p className="text-[11px] leading-relaxed text-foreground-tertiary max-w-[220px]">
        Add <code className="font-mono text-[10px] px-1 py-[1px] rounded bg-subtle text-foreground-secondary">[[page name]]</code> links in your notes to build this map.
      </p>
    </div>
  );
}
