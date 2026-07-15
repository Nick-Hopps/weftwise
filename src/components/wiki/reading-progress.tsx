'use client';

import { useEffect, useState, type RefObject } from 'react';

export function calculateReadingProgress(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
): number {
  const available = scrollHeight - clientHeight;
  if (available <= 0) return 100;
  return Math.min(100, Math.max(0, (scrollTop / available) * 100));
}

interface ReadingProgressProps {
  containerRef: RefObject<HTMLDivElement | null>;
  useContainerScroll?: boolean;
}

export function ReadingProgress({
  containerRef,
  useContainerScroll = false,
}: ReadingProgressProps) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const article = containerRef.current;
    const scroller = useContainerScroll ? article : document.getElementById('main-content');
    if (!article || !scroller) return;

    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setProgress(
          calculateReadingProgress(
            scroller.scrollTop,
            scroller.scrollHeight,
            scroller.clientHeight,
          ),
        );
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
  }, [containerRef, useContainerScroll]);

  return (
    <div className="sticky top-0 z-10 h-0 w-full" data-reading-progress aria-hidden>
      <div className="h-0.5 w-full bg-transparent">
        <div
          className="h-full bg-accent transition-[width] duration-fast ease-standard"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}
