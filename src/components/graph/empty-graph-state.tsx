'use client';

import { Network } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';

// ── Empty state — teaches the interface rather than just says "nothing" ──────

export function EmptyGraphState() {
  const { t } = useI18n();
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <Network
        aria-hidden
        className="h-7 w-7 text-foreground-tertiary/70"
        strokeWidth={1.3}
      />
      <p className="text-xs font-medium text-foreground-secondary">
        {t('graph.empty.title')}
      </p>
      <p className="text-[11px] leading-relaxed text-foreground-tertiary max-w-[220px]">
        {t('graph.empty.beforeLink')}{' '}
        <code className="font-mono text-[10px] px-1 py-[1px] rounded bg-subtle text-foreground-secondary">
          {t('graph.empty.linkExample')}
        </code>{' '}
        {t('graph.empty.afterLink')}
      </p>
    </div>
  );
}

export function GraphLoadingState() {
  const { t } = useI18n();
  return (
    <div className="flex h-full w-full items-center justify-center rounded-md border border-border bg-canvas text-xs text-foreground-tertiary">
      {t('context.loadingGraph')}
    </div>
  );
}
