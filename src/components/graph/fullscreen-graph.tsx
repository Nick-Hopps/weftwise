'use client';

/**
 * 全屏图浮层外壳 —— 顶栏、画布宿主、图例与操作提示。
 * cy 实例由 MiniGraphView 持有并通过 fullscreenRef 迁移挂载到这里。
 */

import { Compass, Minimize2, Target } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { Kbd } from '@/components/ui/kbd';
import { cn } from '@/lib/cn';

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
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Wiki graph fullscreen"
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
            Wiki Graph
          </h2>
          <span className="text-xs text-foreground-tertiary tabular-nums whitespace-nowrap">
            {stats.nodes} nodes
            <span className="mx-1.5 text-foreground-disabled">·</span>
            {stats.edges} relationships
            {stats.orphans > 0 && (
              <>
                <span className="mx-1.5 text-foreground-disabled">·</span>
                <span className="text-foreground-tertiary">{stats.orphans} orphan{stats.orphans === 1 ? '' : 's'}</span>
              </>
            )}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <IconButton
            size="base"
            onClick={onRecenter}
            aria-label={hasCurrent ? 'Center on current page' : 'Fit graph to view'}
            data-tip={hasCurrent ? 'Center on current page' : 'Fit to view'}
            className="tip tip-l"
          >
            {hasCurrent ? <Target /> : <Compass />}
          </IconButton>
          <IconButton
            size="base"
            onClick={onClose}
            aria-label="Close fullscreen (Esc)"
            data-tip="Exit fullscreen"
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
        <span className="text-[9px] uppercase tracking-wider font-medium text-foreground-tertiary">Legend</span>
        <LegendRow color="var(--color-graph-active)" label={hasCurrent ? 'Current page' : 'Active'} ring />
        <LegendRow color="var(--color-graph-node)" label="Linked page" />
        <LegendRow color="var(--color-graph-orphan)" label="Orphan (no links)" />
      </div>

      {/* Operation hint — bottom-right */}
      <div className="pointer-events-none absolute bottom-4 right-5 z-10 flex items-center gap-3 text-[11px] text-foreground-tertiary">
        <HintChip>
          <Kbd>Drag</Kbd>
          <span>rearrange</span>
        </HintChip>
        <HintChip>
          <Kbd>Click</Kbd>
          <span>open page</span>
        </HintChip>
        <HintChip>
          <Kbd>Esc</Kbd>
          <span>close</span>
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
