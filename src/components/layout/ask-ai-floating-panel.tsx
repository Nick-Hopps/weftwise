'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { GripHorizontal, Sparkles, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { ContextPanelChatTab } from './context-panel-chat-tab';
import { useUIStore } from '@/stores/ui-store';
import {
  clampAskAiPosition,
  positionAskAiFromAnchor,
  shouldDismissAskAiSheet,
  type AskAiPoint,
} from '@/lib/ask-ai-floating-panel';
import { cn } from '@/lib/cn';

const MOBILE_QUERY = '(max-width: 1023.98px)';
const DESKTOP_PANEL_SIZE = { width: 440, height: 680 };

function useMatchesMobile(): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mediaQuery = window.matchMedia(MOBILE_QUERY);
    const update = () => setMatches(mediaQuery.matches);
    update();
    mediaQuery.addEventListener('change', update);
    return () => mediaQuery.removeEventListener('change', update);
  }, []);
  return matches;
}

export function AskAiFloatingPanel() {
  const open = useUIStore((state) => state.askAiOpen);
  const anchor = useUIStore((state) => state.askAiAnchor);
  const position = useUIStore((state) => state.askAiPosition);
  const close = useUIStore((state) => state.closeAskAi);
  const setPosition = useUIStore((state) => state.setAskAiPosition);
  const isMobile = useMatchesMobile();
  const panelRef = useRef<HTMLElement>(null);
  const [everMounted, setEverMounted] = useState(false);
  const [sheetOffset, setSheetOffset] = useState(0);
  const [sheetDragging, setSheetDragging] = useState(false);
  const sheetDragRef = useRef<{ startY: number; startedAt: number } | null>(null);

  useEffect(() => {
    if (open) setEverMounted(true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, open]);

  useEffect(() => {
    if (!open || !isMobile) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobile, open]);

  useEffect(() => {
    if (!open || isMobile) return;
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current;
      const panelSize = {
        width: panel?.offsetWidth ?? DESKTOP_PANEL_SIZE.width,
        height: panel?.offsetHeight ?? Math.min(DESKTOP_PANEL_SIZE.height, window.innerHeight - 64),
      };
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const currentPosition = useUIStore.getState().askAiPosition;
      const nextPosition = anchor
        ? positionAskAiFromAnchor(anchor, panelSize, viewport)
        : currentPosition
          ? clampAskAiPosition(currentPosition, panelSize, viewport)
          : clampAskAiPosition(
              { x: viewport.width - panelSize.width - 16, y: 72 },
              panelSize,
              viewport,
            );
      setPosition(nextPosition);
      panel?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [anchor, isMobile, open, setPosition]);

  useEffect(() => {
    if (!open || !isMobile) return;
    setSheetOffset(0);
    const frame = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isMobile, open]);

  useEffect(() => {
    if (!open || isMobile) return;
    const onResize = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const currentPosition = useUIStore.getState().askAiPosition;
      if (!currentPosition) return;
      setPosition(clampAskAiPosition(
        currentPosition,
        { width: panel.offsetWidth, height: panel.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isMobile, open, setPosition]);

  const startDesktopDrag = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (isMobile || event.button !== 0) return;
    if ((event.target as Element).closest('button, a, input, textarea, select')) return;
    event.preventDefault();
    const startPosition = useUIStore.getState().askAiPosition ?? { x: 16, y: 72 };
    const start = { x: event.clientX, y: event.clientY };
    const panel = panelRef.current;
    if (!panel) return;

    const onMove = (moveEvent: PointerEvent) => {
      const candidate: AskAiPoint = {
        x: startPosition.x + moveEvent.clientX - start.x,
        y: startPosition.y + moveEvent.clientY - start.y,
      };
      setPosition(clampAskAiPosition(
        candidate,
        { width: panel.offsetWidth, height: panel.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'grabbing';
  }, [isMobile, setPosition]);

  const startSheetDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isMobile || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    sheetDragRef.current = { startY: event.clientY, startedAt: performance.now() };
    setSheetDragging(true);
  }, [isMobile]);

  const moveSheet = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = sheetDragRef.current;
    if (!drag) return;
    setSheetOffset(Math.max(0, event.clientY - drag.startY));
  }, []);

  const finishSheetDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = sheetDragRef.current;
    if (!drag) return;
    const distance = Math.max(0, event.clientY - drag.startY);
    const elapsed = Math.max(1, performance.now() - drag.startedAt);
    const velocity = distance / elapsed;
    sheetDragRef.current = null;
    setSheetDragging(false);
    if (shouldDismissAskAiSheet(distance, velocity)) {
      close();
      return;
    }
    setSheetOffset(0);
  }, [close]);

  if (!everMounted) return null;

  return (
    <div
      className={cn(
        'pointer-events-none fixed inset-0 z-command',
        !open && 'invisible',
      )}
      aria-hidden={!open}
    >
      <div
        className={cn(
          'absolute inset-0 bg-overlay/40 opacity-0 backdrop-blur-[2px] transition-opacity duration-base lg:hidden',
          open && 'pointer-events-auto opacity-100',
        )}
        aria-hidden
      />

      <section
        ref={panelRef}
        role="dialog"
        aria-modal={isMobile ? 'true' : undefined}
        aria-label="Ask AI"
        style={isMobile
          ? { transform: `translateY(${sheetOffset}px)` }
          : { left: position?.x ?? 16, top: position?.y ?? 72 }}
        className={cn(
          'pointer-events-auto absolute bottom-0 left-0 flex h-[88svh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-surface shadow-lg',
        'lg:bottom-auto lg:h-[min(680px,calc(100vh-64px))] lg:w-[440px] lg:rounded-xl',
          'motion-safe:animate-fade-in',
          !sheetDragging && 'transition-transform duration-base ease-standard',
        )}
      >
        <div
          data-ask-ai-sheet-handle
          className="flex h-7 shrink-0 touch-none cursor-grab items-center justify-center lg:hidden"
          onPointerDown={startSheetDrag}
          onPointerMove={moveSheet}
          onPointerUp={finishSheetDrag}
          onPointerCancel={finishSheetDrag}
          aria-hidden
        >
          <span className="h-1 w-10 rounded-full bg-border-strong" />
        </div>

        <header
          data-ask-ai-drag-handle
          className="flex h-11 shrink-0 cursor-default items-center gap-2 border-b border-border-subtle px-3 lg:cursor-grab lg:active:cursor-grabbing"
          onPointerDown={startDesktopDrag}
        >
          <GripHorizontal className="hidden h-4 w-4 text-foreground-tertiary lg:block" aria-hidden />
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-accent-subtle text-accent">
            <Sparkles className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">Ask AI</p>
            <p className="truncate text-[11px] text-foreground-tertiary">Current subject and page context</p>
          </div>
          <IconButton size="sm" aria-label="Close Ask AI" onClick={close}>
            <X />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1">
          <ContextPanelChatTab />
        </div>
      </section>
    </div>
  );
}
