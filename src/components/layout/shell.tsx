'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUIStore, CONTEXT_PANEL_WIDTH } from '@/stores/ui-store';
import { Header } from './header';
import { Sidebar } from './sidebar';
import { ContextPanel } from './context-panel';

interface ShellProps {
  children: React.ReactNode;
}

export function Shell({ children }: ShellProps) {
  const { sidebarOpen, sidebarWidth, setSidebarWidth, toggleSidebar, contextPanelOpen } =
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
        >
          {children}
        </main>

        {/* Context Panel — desktop docked, fixed width */}
        {contextPanelOpen && (
          <div
            className="hidden shrink-0 overflow-hidden motion-safe:animate-slide-left lg:flex"
            style={{ width: CONTEXT_PANEL_WIDTH }}
          >
            <ContextPanel variant="docked" />
          </div>
        )}
      </div>
    </div>
  );
}
