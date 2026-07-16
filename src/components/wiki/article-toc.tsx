'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type RefObject,
} from 'react';
import { ChevronDown, ListTree } from 'lucide-react';
import { cn } from '@/lib/cn';
import type { ArticleTocHeading } from '@/lib/article-toc';

interface HeadingPosition {
  id: string;
  top: number;
}

export function getActiveHeadingId(
  positions: HeadingPosition[],
  threshold: number,
): string | null {
  if (positions.length === 0) return null;
  let activeId = positions[0].id;
  for (const position of positions) {
    if (position.top > threshold) break;
    activeId = position.id;
  }
  return activeId;
}

interface ArticleTocProps {
  headings: ArticleTocHeading[];
  containerRef: RefObject<HTMLDivElement | null>;
  useContainerScroll?: boolean;
}

export function ArticleToc({
  headings,
  containerRef,
  useContainerScroll = false,
}: ArticleTocProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [activeId, setActiveId] = useState(headings[0]?.id ?? '');

  useEffect(() => {
    setActiveId(headings[0]?.id ?? '');
    setOpen(false);
  }, [headings]);

  useEffect(() => {
    if (headings.length < 2) return;
    const article = containerRef.current;
    const scroller = useContainerScroll ? article : document.getElementById('main-content');
    if (!article || !scroller) return;

    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        // 比 80px 滚动留白多留少量容差，避免亚像素布局让刚跳转的标题仍被判为未到达。
        const threshold = scroller.getBoundingClientRect().top + 88;
        const positions = headings.flatMap((heading) => {
          const element = document.getElementById(heading.id);
          return element ? [{ id: heading.id, top: element.getBoundingClientRect().top }] : [];
        });
        const next = getActiveHeadingId(positions, threshold);
        if (next) setActiveId(next);
      });
    };

    update();
    scroller.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(article);

    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      observer?.disconnect();
    };
  }, [containerRef, headings, useContainerScroll]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (headings.length < 2 || !window.location.hash) return;
    const hash = decodeURIComponent(window.location.hash.slice(1));
    if (!headings.some((heading) => heading.id === hash)) return;
    requestAnimationFrame(() => document.getElementById(hash)?.scrollIntoView({ block: 'start' }));
  }, [headings]);

  if (headings.length < 2) return null;

  const activeHeading = headings.find((heading) => heading.id === activeId) ?? headings[0];

  const navigate = (event: MouseEvent<HTMLAnchorElement>, heading: ArticleTocHeading) => {
    event.preventDefault();
    const target = document.getElementById(heading.id);
    if (!target) return;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    const url = new URL(window.location.href);
    url.hash = heading.id;
    if (decodeURIComponent(window.location.hash.slice(1)) !== heading.id) {
      window.history.pushState(null, '', url);
    }
    setActiveId(heading.id);
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <>
      <div
        ref={rootRef}
        className="wiki-article-toc-compact sticky top-0 z-[9] border-b border-border-subtle bg-surface/95 px-5 py-2 backdrop-blur-md sm:px-8"
        onKeyDown={handleKeyDown}
      >
        <div className="relative mx-auto max-w-[var(--reading-max-width)]">
          <button
            ref={triggerRef}
            type="button"
            className="focus-ring flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm text-foreground-secondary transition-colors hover:bg-subtle hover:text-foreground"
            aria-expanded={open}
            aria-controls={menuId}
            onClick={() => setOpen((value) => !value)}
          >
            <ListTree className="h-4 w-4 shrink-0 text-foreground-tertiary" aria-hidden />
            <span className="shrink-0 font-medium text-foreground">On this page</span>
            <span className="min-w-0 flex-1 truncate text-foreground-tertiary">
              {activeHeading.text}
            </span>
            <ChevronDown
              className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')}
              aria-hidden
            />
          </button>

          {open && (
            <nav
              id={menuId}
              aria-label="Table of contents"
              className="absolute inset-x-0 top-full mt-1 max-h-[min(55vh,420px)] overflow-y-auto rounded-md border border-border bg-elevated py-2 shadow-md animate-fade-in"
            >
              <TocLinks headings={headings} activeId={activeId} onNavigate={navigate} />
            </nav>
          )}
        </div>
      </div>

      <aside className="wiki-article-toc-rail min-w-0" aria-label="Page outline">
        <nav aria-label="Table of contents" className="sticky top-7 max-h-[calc(100vh-7rem)] overflow-y-auto pr-2">
          <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-foreground-tertiary">
            <ListTree className="h-3.5 w-3.5" aria-hidden />
            On this page
          </div>
          <TocLinks headings={headings} activeId={activeId} onNavigate={navigate} />
        </nav>
      </aside>
    </>
  );
}

function TocLinks({
  headings,
  activeId,
  onNavigate,
}: {
  headings: ArticleTocHeading[];
  activeId: string;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, heading: ArticleTocHeading) => void;
}) {
  return (
    <ol className="border-l border-border-subtle">
      {headings.map((heading) => {
        const active = heading.id === activeId;
        return (
          <li key={heading.id}>
            <a
              href={`#${encodeURIComponent(heading.id)}`}
              title={heading.text}
              aria-current={active ? 'location' : undefined}
              onClick={(event) => onNavigate(event, heading)}
              className={cn(
                '-ml-px block border-l-2 py-1.5 pr-2 text-[13px] leading-5 transition-colors focus-ring',
                heading.depth === 2 ? 'pl-3' : heading.depth === 3 ? 'pl-6' : 'pl-9',
                active
                  ? 'border-accent text-foreground font-medium'
                  : 'border-transparent text-foreground-tertiary hover:border-border-strong hover:text-foreground-secondary',
              )}
            >
              <span className="line-clamp-2">{heading.text}</span>
            </a>
          </li>
        );
      })}
    </ol>
  );
}
