'use client';

import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Minus, Plus, RotateCcw, X } from 'lucide-react';
import { IconButton } from '@/components/ui/icon-button';
import { useI18n } from '@/components/i18n-provider';
import { MermaidSvg } from './mermaid-svg';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;

export function clampDiagramZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function stepDiagramZoom(zoom: number, direction: -1 | 1): number {
  return clampDiagramZoom(zoom + direction * ZOOM_STEP);
}

interface DiagramPreviewToolbarProps {
  zoom: number;
  onZoomOut: () => void;
  onReset: () => void;
  onZoomIn: () => void;
  onClose: () => void;
  closeButtonRef?: React.Ref<HTMLButtonElement>;
}

export function DiagramPreviewToolbar({
  zoom,
  onZoomOut,
  onReset,
  onZoomIn,
  onClose,
  closeButtonRef,
}: DiagramPreviewToolbarProps) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1">
      <IconButton
        type="button"
        size="base"
        onClick={onZoomOut}
        disabled={zoom <= MIN_ZOOM}
        aria-label={t('wiki.diagram.zoomOut')}
        data-tip={t('wiki.diagram.zoomOut')}
        className="tip tip-b"
      >
        <Minus aria-hidden />
      </IconButton>
      <button
        type="button"
        onClick={onReset}
        aria-label={t('wiki.diagram.resetZoom')}
        className="h-8 min-w-14 rounded-md px-2 text-xs tabular-nums text-foreground-secondary transition-colors hover:bg-subtle hover:text-foreground focus-ring"
      >
        {Math.round(zoom * 100)}%
      </button>
      <IconButton
        type="button"
        size="base"
        onClick={onZoomIn}
        disabled={zoom >= MAX_ZOOM}
        aria-label={t('wiki.diagram.zoomIn')}
        data-tip={t('wiki.diagram.zoomIn')}
        className="tip tip-b"
      >
        <Plus aria-hidden />
      </IconButton>
      <IconButton
        type="button"
        size="base"
        onClick={onReset}
        aria-label={t('wiki.diagram.resetZoom')}
        data-tip={t('wiki.diagram.resetZoom')}
        className="tip tip-b"
      >
        <RotateCcw aria-hidden />
      </IconButton>
      <span className="mx-1 h-5 border-l border-border" aria-hidden />
      <IconButton
        ref={closeButtonRef}
        type="button"
        size="base"
        onClick={onClose}
        aria-label={t('wiki.diagram.closePreview')}
        data-tip={t('wiki.diagram.closePreview')}
        className="tip tip-l"
      >
        <X aria-hidden />
      </IconButton>
    </div>
  );
}

export function MermaidPreview({
  code,
  open,
  onClose,
}: {
  code: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!open) return;
    setZoom(1);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="fixed inset-0 z-overlay flex flex-col bg-overlay/50 p-3 backdrop-blur-sm animate-fade-in sm:p-5"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-canvas shadow-lg"
      >
        <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface px-3 sm:px-4">
          <h2 id={titleId} className="truncate text-sm font-semibold text-foreground">
            {t('wiki.diagram.previewTitle')}
          </h2>
          <DiagramPreviewToolbar
            zoom={zoom}
            onZoomOut={() => setZoom((value) => stepDiagramZoom(value, -1))}
            onReset={() => setZoom(1)}
            onZoomIn={() => setZoom((value) => stepDiagramZoom(value, 1))}
            onClose={onClose}
            closeButtonRef={closeButtonRef}
          />
        </header>
        <div className="min-h-0 flex-1 overflow-auto bg-subtle/30">
          <div className="flex min-h-full min-w-full items-start justify-center p-6 sm:p-10">
            <MermaidSvg
              code={code}
              ariaLabel={t('wiki.diagram.ariaLabel')}
              naturalSize
              scale={zoom}
              className="mermaid-diagram-preview w-max shrink-0 overflow-visible"
            />
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
