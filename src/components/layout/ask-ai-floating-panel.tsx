'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { GripHorizontal, Sparkles, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { ContextPanelChatTab } from './context-panel-chat-tab';
import { useI18n } from '@/components/i18n-provider';
import { useUIStore } from '@/stores/ui-store';
import {
  centerAskAiPosition,
  clampAskAiPosition,
  fitAskAiRectToViewport,
  positionAskAiAtTrigger,
  positionAskAiFromAnchor,
  resizeAskAiSize,
  shouldDismissAskAiSheet,
  type AskAiPoint,
  type AskAiSize,
} from '@/lib/ask-ai-floating-panel';
import { cn } from '@/lib/cn';

const MOBILE_QUERY = '(max-width: 1023.98px)';
const DESKTOP_PANEL_SIZE = { width: 440, height: 680 };
type ResizeAxis = 'width' | 'height' | 'both';
type AskAiPanelStyle = React.CSSProperties & {
  '--ask-ai-width': string;
  '--ask-ai-height': string;
};

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
  const { t } = useI18n();
  const open = useUIStore((state) => state.askAiOpen);
  const anchor = useUIStore((state) => state.askAiAnchor);
  const anchorMode = useUIStore((state) => state.askAiAnchorMode);
  const position = useUIStore((state) => state.askAiPosition);
  const invocationId = useUIStore((state) => state.askAiInvocationId);
  const close = useUIStore((state) => state.closeAskAi);
  const setPosition = useUIStore((state) => state.setAskAiPosition);
  const isMobile = useMatchesMobile();
  const panelRef = useRef<HTMLElement>(null);
  const panelSizeRef = useRef<AskAiSize>(DESKTOP_PANEL_SIZE);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const sizeInitializedRef = useRef(false);
  const [everMounted, setEverMounted] = useState(false);
  const [panelSize, setPanelSize] = useState<AskAiSize>(DESKTOP_PANEL_SIZE);
  const [sheetOffset, setSheetOffset] = useState(0);
  const [sheetDragging, setSheetDragging] = useState(false);
  const sheetDragRef = useRef<{ startY: number; startedAt: number } | null>(null);

  useEffect(() => {
    if (open) setEverMounted(true);
  }, [open]);

  useEffect(() => {
    panelSizeRef.current = panelSize;
  }, [panelSize]);

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
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const requestedSize = sizeInitializedRef.current
        ? panelSizeRef.current
        : {
            width: DESKTOP_PANEL_SIZE.width,
            height: Math.min(DESKTOP_PANEL_SIZE.height, window.innerHeight - 64),
          };
      sizeInitializedRef.current = true;
      const currentPosition = useUIStore.getState().askAiPosition;
      const requestedPosition = anchor
        ? anchorMode === 'selection'
          ? positionAskAiFromAnchor(anchor, requestedSize, viewport)
          : positionAskAiAtTrigger(anchor, requestedSize, viewport)
        : currentPosition
          ? clampAskAiPosition(currentPosition, requestedSize, viewport)
          : centerAskAiPosition(requestedSize, viewport);
      const fitted = fitAskAiRectToViewport(
        { position: requestedPosition, size: requestedSize },
        viewport,
      );
      setPanelSize(fitted.size);
      setPosition(fitted.position);
      panelRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [anchor, anchorMode, isMobile, open, setPosition]);

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
      const currentPosition = useUIStore.getState().askAiPosition;
      if (!currentPosition) return;
      const fitted = fitAskAiRectToViewport(
        { position: currentPosition, size: panelSizeRef.current },
        { width: window.innerWidth, height: window.innerHeight },
      );
      setPanelSize(fitted.size);
      setPosition(fitted.position);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isMobile, open, setPosition]);

  useEffect(() => () => resizeCleanupRef.current?.(), []);

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

  const startDesktopResize = useCallback((
    event: React.PointerEvent<HTMLDivElement>,
    axis: ResizeAxis,
  ) => {
    if (isMobile || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    resizeCleanupRef.current?.();

    const start = { x: event.clientX, y: event.clientY };
    const startSize = panelSizeRef.current;
    const position = useUIStore.getState().askAiPosition ?? { x: 16, y: 72 };
    const cursor = axis === 'width' ? 'ew-resize' : axis === 'height' ? 'ns-resize' : 'nwse-resize';

    const onMove = (moveEvent: PointerEvent) => {
      const delta = {
        width: axis === 'height' ? 0 : moveEvent.clientX - start.x,
        height: axis === 'width' ? 0 : moveEvent.clientY - start.y,
      };
      setPanelSize(resizeAskAiSize(
        startSize,
        delta,
        position,
        { width: window.innerWidth, height: window.innerHeight },
      ));
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', cleanup);
      window.removeEventListener('pointercancel', cleanup);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      resizeCleanupRef.current = null;
    };

    resizeCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', cleanup);
    window.addEventListener('pointercancel', cleanup);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = cursor;
  }, [isMobile]);

  const resizeWithKeyboard = useCallback((
    event: React.KeyboardEvent<HTMLDivElement>,
    axis: ResizeAxis,
  ) => {
    if (isMobile) return;
    const step = event.shiftKey ? 32 : 16;
    let width = 0;
    let height = 0;
    if (axis !== 'height' && event.key === 'ArrowLeft') width = -step;
    if (axis !== 'height' && event.key === 'ArrowRight') width = step;
    if (axis !== 'width' && event.key === 'ArrowUp') height = -step;
    if (axis !== 'width' && event.key === 'ArrowDown') height = step;
    if (width === 0 && height === 0) return;
    event.preventDefault();
    const position = useUIStore.getState().askAiPosition ?? { x: 16, y: 72 };
    setPanelSize((current) => resizeAskAiSize(
      current,
      { width, height },
      position,
      { width: window.innerWidth, height: window.innerHeight },
    ));
  }, [isMobile]);

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
        aria-label={t('chat.askAI')}
        style={{
          '--ask-ai-width': `${panelSize.width}px`,
          '--ask-ai-height': `${panelSize.height}px`,
          ...(isMobile
            ? { transform: `translateY(${sheetOffset}px)` }
            : {
              left: position?.x ?? 16,
              top: position?.y ?? 72,
            }),
        } as AskAiPanelStyle}
        className={cn(
          'pointer-events-auto absolute bottom-0 left-0 flex h-[88svh] w-full flex-col overflow-hidden rounded-t-xl border border-border bg-surface shadow-lg',
          'lg:bottom-auto lg:h-[var(--ask-ai-height)] lg:w-[var(--ask-ai-width)] lg:rounded-xl',
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
            <p className="text-sm font-semibold text-foreground">{t('chat.askAI')}</p>
            <p className="truncate text-[11px] text-foreground-tertiary">{t('chat.currentContext')}</p>
          </div>
          <IconButton size="sm" aria-label={t('chat.closeAI')} onClick={close}>
            <X />
          </IconButton>
        </header>

        <div className="min-h-0 flex-1">
          <ContextPanelChatTab key={invocationId} />
        </div>

        <div
          role="separator"
          aria-label={t('chat.resizeWidth')}
          aria-orientation="vertical"
          tabIndex={0}
          data-ask-ai-resize-handle="width"
          className="absolute bottom-3 right-0 top-12 z-20 hidden w-2 cursor-ew-resize focus-ring lg:block"
          onPointerDown={(event) => startDesktopResize(event, 'width')}
          onKeyDown={(event) => resizeWithKeyboard(event, 'width')}
        />
        <div
          role="separator"
          aria-label={t('chat.resizeHeight')}
          aria-orientation="horizontal"
          tabIndex={0}
          data-ask-ai-resize-handle="height"
          className="absolute bottom-0 left-3 right-3 z-20 hidden h-2 cursor-ns-resize focus-ring lg:block"
          onPointerDown={(event) => startDesktopResize(event, 'height')}
          onKeyDown={(event) => resizeWithKeyboard(event, 'height')}
        />
        <div
          role="separator"
          aria-label={t('chat.resizeBoth')}
          tabIndex={0}
          data-ask-ai-resize-handle="both"
          className="group absolute bottom-0 right-0 z-30 hidden h-4 w-4 cursor-nwse-resize rounded-br-xl focus-ring lg:block"
          onPointerDown={(event) => startDesktopResize(event, 'both')}
          onKeyDown={(event) => resizeWithKeyboard(event, 'both')}
        >
          <span className="absolute bottom-1 right-1 h-1.5 w-1.5 border-b border-r border-foreground-tertiary/60 transition-colors group-hover:border-accent" />
        </div>
      </section>
    </div>
  );
}
