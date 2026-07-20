'use client';

/**
 * 全屏图浮层外壳 —— 顶栏、画布宿主、图例与操作提示。
 * cy 实例由 MiniGraphView 持有并通过 fullscreenRef 迁移挂载到这里。
 */

import { Compass, Minimize2, Target } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/cn';
import { useI18n } from '@/components/i18n-provider';

interface FullscreenGraphProps {
  fullscreenRef: React.RefObject<HTMLDivElement | null>;
  stats: { nodes: number; edges: number; orphans: number };
  hasCurrent: boolean;
  onRecenter: () => void;
  onClose: () => void;
}

export function FullscreenGraph({
  fullscreenRef,
  stats,
  hasCurrent,
  onRecenter,
  onClose,
}: FullscreenGraphProps) {
  const { t } = useI18n();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('graph.fullscreen')}
      className="theme-graph fixed inset-0 z-overlay flex flex-col bg-canvas animate-fade-in"
      style={{
        backgroundImage:
          'radial-gradient(1100px 560px at 50% -10%, rgb(var(--color-accent-subtle) / 0.55) 0%, transparent 55%)',
      }}
    >
      {/* Top bar */}
      <header className="relative z-10 flex items-center justify-between gap-4 px-5 h-12 border-b border-border/60 bg-surface/40 backdrop-blur-[1px]">
        <div className="flex items-baseline gap-3 min-w-0">
          <h2 className="text-sm font-semibold text-foreground tracking-tight">
            {t('graph.title')}
          </h2>
          <span className="text-xs text-foreground-tertiary tabular-nums whitespace-nowrap">
            {t('graph.nodes', { count: stats.nodes })}
            <span className="mx-1.5 text-foreground-disabled">·</span>
            {t('graph.links', { count: stats.edges })}
            {stats.orphans > 0 && (
              <>
                <span className="mx-1.5 text-foreground-disabled">·</span>
                <span className="text-foreground-tertiary">{t('graph.orphans', { count: stats.orphans })}</span>
              </>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <IconButton
            size="base"
            onClick={onRecenter}
            aria-label={hasCurrent ? t('graph.centerCurrent') : t('graph.fit')}
            data-tip={hasCurrent ? t('graph.centerCurrent') : t('graph.fitTip')}
            className="tip tip-l"
          >
            {hasCurrent ? <Target /> : <Compass />}
          </IconButton>
          <IconButton
            size="base"
            onClick={onClose}
            aria-label={t('graph.closeFullscreen')}
            data-tip={t('graph.exitFullscreen')}
            className="tip tip-l"
          >
            <Minimize2 />
          </IconButton>
        </div>
      </header>

      {/* Canvas */}
      <div ref={fullscreenRef} className="flex-1 min-w-0 min-h-0 relative" />

      {/* Floating legend — top-right of canvas area (avoids dev overlay + profile badge) */}
      <div className="pointer-events-none absolute top-16 right-5 z-10 flex flex-col gap-1.5 px-3 py-2 rounded-md bg-surface/90 ring-1 ring-border/60 shadow-sm text-[11px]">
        <span className="text-[9px] uppercase tracking-wider font-medium text-foreground-tertiary">{t('graph.legend')}</span>
        <LegendRow color="var(--color-graph-active)" label={hasCurrent ? t('graph.currentPage') : t('graph.active')} ring />
        <LegendRow color="var(--color-graph-node)" label={t('graph.linkedPage')} />
        <LegendRow color="var(--color-graph-orphan)" label={t('graph.orphan')} />
      </div>

      {/* Operation hint — bottom-right */}
      <div className="pointer-events-none absolute bottom-4 right-5 z-10 flex items-center gap-3 text-[11px] text-foreground-tertiary">
        <HintChip>
          <Kbd>Drag</Kbd>
          <span>{t('graph.drag')}</span>
        </HintChip>
        <HintChip>
          <Kbd>Click</Kbd>
          <span>{t('graph.click')}</span>
        </HintChip>
        <HintChip>
          <Kbd>Esc</Kbd>
          <span>{t('graph.close')}</span>
        </HintChip>
      </div>
    </div>
  );
}

function LegendRow({ color, label, ring }: { color: string; label: string; ring?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-foreground-secondary">
      <span
        aria-hidden
        className={cn('h-2.5 w-2.5 rounded-full', ring && 'ring-2 ring-offset-1 ring-offset-surface')}
        style={{ backgroundColor: `rgb(${color})`, boxShadow: ring ? `0 0 0 1.5px rgb(${color})` : undefined }}
      />
      <span>{label}</span>
    </div>
  );
}

function HintChip({ children }: { children: React.ReactNode }) {
  return <span className="inline-flex items-center gap-1.5">{children}</span>;
}
