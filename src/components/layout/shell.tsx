'use client';

import { useCallback, useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useUIStore, CONTEXT_PANEL_WIDTH } from '@/stores/ui-store';
import { Header } from './header';
import { Sidebar } from './sidebar';
import { ContextPanel } from './context-panel';
import { AskAiFloatingPanel } from './ask-ai-floating-panel';

interface ShellProps {
  children: React.ReactNode;
}

export function Shell({ children }: ShellProps) {
  const pathname = usePathname();
  const isWikiRoute = pathname?.startsWith('/wiki/') ?? false;
  const {
    sidebarOpen,
    sidebarWidth,
    setSidebarWidth,
    toggleSidebar,
    contextPanelOpen,
    openAskAi,
  } =
    useUIStore();

  // Apply panel width only post-hydration to avoid SSR/client mismatch.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const closeSidebarIfMobile = () => {
    if (window.innerWidth < 1024 && sidebarOpen) toggleSidebar();
  };

  const handleSidebarResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = useUIStore.getState().sidebarWidth;

      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        setSidebarWidth(startWidth + delta);
      };

      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [setSidebarWidth],
  );

  const handleMainDoubleClick = useCallback((event: React.MouseEvent<HTMLElement>) => {
    if (window.innerWidth < 1024) return;
    const target = event.target as Element | null;
    if (!target) return;
    if (target.closest(
      'a,button,input,textarea,select,label,summary,pre,code,p,span,strong,em,time,dt,dd,h1,h2,h3,h4,h5,h6,li,blockquote,table,td,th,[contenteditable="true"],[data-ask-ai-ignore]',
    )) return;
    window.getSelection()?.removeAllRanges();
    openAskAi({ x: event.clientX, y: event.clientY });
  }, [openAskAi]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-canvas">
      <Header />

      <div className="flex flex-1 overflow-hidden relative">
        {/* Left Sidebar — desktop inline (resizable, always present) */}
        <div
          className="hidden shrink-0 flex-col overflow-hidden lg:flex"
          style={hydrated ? { width: sidebarWidth } : { width: 264 }}
        >
          <Sidebar />
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          onPointerDown={handleSidebarResizeStart}
          onDoubleClick={() => useUIStore.getState().resetSidebarWidth()}
          className="group hidden w-1 shrink-0 cursor-col-resize items-center justify-center transition-colors hover:bg-accent/20 active:bg-accent/40 lg:flex"
        >
          <div className="h-10 w-px rounded-full bg-border group-hover:bg-accent group-active:bg-accent-active" />
        </div>

        {/* Left Sidebar — mobile overlay */}
        {sidebarOpen && (
          <div className="absolute inset-0 z-overlay flex lg:hidden">
            <button
              type="button"
              className="absolute inset-0 bg-overlay/35 backdrop-blur-[2px] motion-safe:animate-fade-in"
              onClick={toggleSidebar}
              aria-label="Close sidebar"
              tabIndex={-1}
            />
            <div className="relative z-10 flex h-full w-[min(86vw,304px)] shadow-lg motion-safe:animate-slide-left">
              <Sidebar onNavigate={closeSidebarIfMobile} />
            </div>
          </div>
        )}

        {/* Center */}
        <main
          id="main-content"
          className="relative flex-1 overflow-y-auto overscroll-contain bg-surface"
          onDoubleClick={handleMainDoubleClick}
        >
          {children}
        </main>

        {/* Context Panel — desktop docked, fixed width */}
        {contextPanelOpen && isWikiRoute && (
          <div
            className="hidden shrink-0 overflow-hidden motion-safe:animate-slide-left lg:flex"
            style={{ width: CONTEXT_PANEL_WIDTH }}
          >
            <ContextPanel variant="docked" />
          </div>
        )}
      </div>

      <AskAiFloatingPanel />
    </div>
  );
}
