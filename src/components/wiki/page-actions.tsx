'use client';

import Link from 'next/link';
import { FileStack, Loader2, Pencil, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
 * 阅读页标题行右侧的统一功能动作条：Edit / Sources / Reshape 并排。
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
    <div className="flex items-center gap-2 shrink-0">
      <Link
        href={editHref}
        data-tip="Edit this page"
        className="tip tip-b inline-flex items-center gap-1.5 px-2.5 h-8 rounded-md text-sm font-medium text-foreground-secondary border border-border hover:bg-subtle hover:text-foreground transition-colors focus-ring"
      >
        <Pencil className="h-3.5 w-3.5" />
        Edit
      </Link>

      {sourceCount > 0 && (
        <Button
          intent={splitOn ? 'primary' : 'outline'}
          size="base"
          onClick={onToggleSplit}
          data-tip="Show the documents this page was written from"
          className="tip tip-b"
        >
          <FileStack className="h-3.5 w-3.5" />
          {splitOn ? 'Hide sources' : `Sources (${sourceCount})`}
        </Button>
      )}

      {showReshapeTrigger && (
        <Button
          intent="outline"
          size="base"
          onClick={onRequestReshape}
          data-tip="Rewrite this page to fit your profile"
          className="tip tip-b"
        >
          <Sparkles className="h-3.5 w-3.5" />
          Reshape
        </Button>
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
