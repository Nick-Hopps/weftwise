'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useUIStore } from '@/stores/ui-store';
import { ContextPanel } from './context-panel';
import { useI18n } from '@/components/i18n-provider';

const MOBILE_QUERY = '(max-width: 1023.98px)';

function useMatchesMobile(): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(MOBILE_QUERY);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);
  return matches;
}

/**
 * Mobile/tablet right-slide sheet wrapper around `<ContextPanel>`. Desktop
 * uses the inline docked form via `Shell` and this component no-ops.
 *
 * Handles:
 *  - Body scroll lock while open (mobile only)
 *  - Escape to close (bound inside ContextPanel)
 *  - Backdrop click to close
 *  - Initial focus on first interactive child
 */
export function ContextPanelSheet() {
  const { t } = useI18n();
  const open = useUIStore((s) => s.contextPanelOpen);
  const close = useUIStore((s) => s.closeContextPanel);
  const isMobile = useMatchesMobile();
  const pathname = usePathname();
  const sheetRef = useRef<HTMLDivElement>(null);

  const active = open && isMobile && pathname?.startsWith('/wiki/') === true;

  // Body scroll lock — only when the sheet is actually visible.
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [active]);

  // Focus first interactive element when opened.
  useEffect(() => {
    if (!active || !sheetRef.current) return;
    const focusable = sheetRef.current.querySelector<HTMLElement>(
      'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
  }, [active]);

  if (!active) return null;

  return (
    <div
      className="lg:hidden fixed inset-0 z-sheet flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={t('context.panel')}
    >
      <button
        type="button"
        aria-label={t('context.close')}
        className="absolute inset-0 bg-overlay/40 backdrop-blur-sm"
        onClick={close}
        tabIndex={-1}
      />
      <div
        ref={sheetRef}
        className="relative z-10 flex h-full w-full sm:w-[420px] max-w-full shadow-lg animate-slide-in-right"
      >
        <ContextPanel variant="sheet" />
      </div>
    </div>
  );
}
