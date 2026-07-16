'use client';

import Link from 'next/link';
import { FileStack, Loader2, Pencil, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { IconButton, iconButtonVariants } from '@/components/ui/icon-button';
import { cn } from '@/lib/cn';

export type ReshapeState = 'idle' | 'loading' | 'reshaped' | 'unavailable';

interface PageActionsProps {
  editHref: string;
  sourceCount: number;
  splitOn: boolean;
  onToggleSplit: () => void;
  reshapeState: ReshapeState;
  onRequestReshape: () => void;
}

/**
 * 阅读页标题行右侧的统一图标动作条：Edit / Sources / Reshape 并排。
 * Reshape 仅负责触发；触发后的状态与切换交给 <ReshapeStatus> 在正文上方呈现。
 */
export function PageActions({
  editHref,
  sourceCount,
  splitOn,
  onToggleSplit,
  reshapeState,
  onRequestReshape,
}: PageActionsProps) {
  // Reshape 触发按钮仅在「未触发」或「不可用（允许重试）」时出现；
  // 加载中 / 已重塑时由状态行接管，避免动作条与状态行重复。
  const showReshapeTrigger = reshapeState === 'idle' || reshapeState === 'unavailable';

  return (
    <div className="flex shrink-0 items-center gap-1 self-start">
      <Link
        href={editHref}
        data-tip="Edit page"
        aria-label="Edit this page"
        className={cn(iconButtonVariants({ intent: 'outline', size: 'base' }), 'tip tip-b')}
      >
        <Pencil aria-hidden />
      </Link>

      {sourceCount > 0 && (
        <IconButton
          intent={splitOn ? 'primary' : 'outline'}
          size="base"
          onClick={onToggleSplit}
          data-tip={splitOn ? 'Hide sources' : `Show sources (${sourceCount})`}
          aria-label={splitOn ? 'Hide source documents' : `Show ${sourceCount} source documents`}
          className="tip tip-b"
        >
          <FileStack aria-hidden />
        </IconButton>
      )}

      {showReshapeTrigger && (
        <IconButton
          intent="outline"
          size="base"
          onClick={onRequestReshape}
          data-tip="Reshape for your profile"
          aria-label="Reshape this page for your profile"
          className="tip tip-b"
        >
          <Sparkles aria-hidden />
        </IconButton>
      )}
    </div>
  );
}

interface ReshapeStatusProps {
  /** 调用方保证传入时 state !== 'idle'。 */
  state: ReshapeState;
  showOriginal: boolean;
  onToggle: () => void;
}

/** 正文上方的细状态行：加载中 / 已重塑（可切原文）/ 不可用。 */
export function ReshapeStatus({ state, showOriginal, onToggle }: ReshapeStatusProps) {
  return (
    <div className="mb-6 flex items-center gap-2 text-xs text-foreground-tertiary">
      {state === 'loading' ? (
        <span className="inline-flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" /> Reshaping…
        </span>
      ) : state === 'reshaped' ? (
        <>
          {showOriginal ? (
            <span>Viewing original</span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-accent" /> Adapted for you
            </span>
          )}
          <Button intent="outline" size="sm" className="ml-auto" onClick={onToggle}>
            {showOriginal ? 'Show reshaped' : 'Show original'}
          </Button>
        </>
      ) : (
        <span className="inline-flex items-center gap-1.5">
          <Sparkles className="h-3 w-3 opacity-50" /> Couldn&apos;t reshape — showing original
        </span>
      )}
    </div>
  );
}
