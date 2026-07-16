'use client';

import { type RefObject } from 'react';
import { Sparkles } from 'lucide-react';
import { useTextSelection } from '@/hooks/use-text-selection';
import { useUIStore } from '@/stores/ui-store';

/** 选区上方按钮与选区之间的间距（px）。 */
const OFFSET = 8;
/** 选区距视口顶部小于此值时，按钮翻到选区下方，避免溢出视口。 */
const FLIP_THRESHOLD = 48;

export function SelectionAskButton({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const selection = useTextSelection(containerRef);
  const askAboutSelection = useUIStore((s) => s.askAboutSelection);

  if (!selection) return null;

  const anchor = selection.endRect;
  const flipBelow = anchor.top < FLIP_THRESHOLD;
  const top = flipBelow ? anchor.top + anchor.height + OFFSET : anchor.top - OFFSET;
  const left = anchor.left + anchor.width / 2;

  return (
    <button
      type="button"
      // 阻止默认避免点击清掉原生选区（文本已在 hook state 里捕获，双保险）。
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => askAboutSelection(
        { section: selection.section, text: selection.text },
        { x: anchor.left + anchor.width, y: anchor.top + anchor.height },
      )}
      style={{
        position: 'fixed',
        top,
        left,
        transform: `translate(-50%, ${flipBelow ? '0' : '-100%'})`,
      }}
      className="z-overlay inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 h-8 text-xs font-medium text-foreground shadow-md transition-colors hover:bg-subtle focus-ring animate-fade-in"
    >
      <Sparkles className="h-3.5 w-3.5 text-accent" />
      Ask AI
    </button>
  );
}
