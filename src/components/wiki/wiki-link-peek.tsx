import { cn } from '@/lib/cn';

export interface WikiLinkPeekPreview {
  title: string;
  summary: string;
}

interface WikiLinkPeekProps {
  loading: boolean;
  preview: WikiLinkPeekPreview | null;
  noPreviewLabel: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}

/**
 * 正文 wikilink 一定挂在段落里（callout 内的正文同样是 `<p>`），而 `<p>` 只接受
 * phrasing content——所以这张悬浮卡**只能用 `<span>`**，靠 `block` / `line-clamp`
 * 拿回块级排版。用 `<div>` / `<p>` 会被浏览器就地截断段落并触发 hydration 报错。
 */
export default function WikiLinkPeek({
  loading,
  preview,
  noPreviewLabel,
  onMouseEnter,
  onMouseLeave,
}: WikiLinkPeekProps) {
  return (
    <span
      className="block absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 z-tooltip pointer-events-none"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <span className={cn(
        'block pointer-events-auto rounded-lg border border-border',
        'bg-surface shadow-md p-3 animate-slide-down',
      )}>
        {loading ? (
          <span className="block h-4 w-3/4 rounded bg-subtle animate-pulse" />
        ) : preview ? (
          <>
            <span className="block text-sm font-semibold text-foreground truncate">
              {preview.title}
            </span>
            {preview.summary && (
              <span className="text-xs text-foreground-secondary mt-1 line-clamp-3">
                {preview.summary}
              </span>
            )}
          </>
        ) : (
          <span className="block text-xs text-foreground-tertiary italic">{noPreviewLabel}</span>
        )}
      </span>
    </span>
  );
}
