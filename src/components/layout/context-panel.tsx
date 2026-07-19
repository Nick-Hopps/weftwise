'use client';

import { X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useUIStore } from '@/stores/ui-store';
import { IconButton } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';
import { ContextPanelContextTab } from './context-panel-context-tab';
import { useI18n } from '@/components/i18n-provider';

interface ContextPanelProps {
  variant?: 'docked' | 'sheet';
}

/** 页面 Context 保持为检查器；Ask AI 使用独立悬浮工作面。 */
export function ContextPanel({ variant = 'docked' }: ContextPanelProps) {
  const { t } = useI18n();
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const pathname = usePathname();
  const slug = pathname?.match(/^\/wiki\/(.+)$/)?.[1] ?? '';

  return (
    <aside
      className={cn(
        'flex h-full w-full min-w-0 flex-col bg-surface',
        variant === 'docked' && 'border-l border-border',
      )}
      aria-label={t('context.panel')}
    >
      <header className="flex h-header shrink-0 items-center justify-between border-b border-border px-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-foreground-tertiary">
          {t('nav.context')}
        </p>
        <IconButton size="sm" aria-label={t('context.close')} onClick={closeContextPanel}>
          <X />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1">
        <ContextPanelContextTab slug={slug} />
      </div>
    </aside>
  );
}
