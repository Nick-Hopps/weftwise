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
    <div className="flex flex-col h-screen overflow-hidden bg-canvas">
      <Header />

      <div className="flex flex-1 overflow-hidden relative">
        {/* Left Sidebar — desktop inline (resizable) */}
        {sidebarOpen && (
          <>
            <div
              className="hidden lg:flex flex-col shrink-0 overflow-hidden"
              style={hydrated ? { width: sidebarWidth } : { width: 240 }}
            >
              <Sidebar />
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize sidebar"
              onPointerDown={handleSidebarResizeStart}
              onDoubleClick={() => useUIStore.getState().resetSidebarWidth()}
              className="hidden lg:flex items-center justify-center shrink-0 w-1 cursor-col-resize group hover:bg-accent/30 active:bg-accent/50 transition-colors"
            >
              <div className="w-0.5 h-8 rounded-full bg-border group-hover:bg-accent group-active:bg-accent-active transition-colors" />
            </div>
          </>
        )}

        {/* Left Sidebar — mobile overlay */}
        {sidebarOpen && (
          <div className="lg:hidden absolute inset-0 z-overlay flex">
            <button
              type="button"
              className="absolute inset-0 bg-overlay/40 backdrop-blur-sm"
              onClick={toggleSidebar}
              aria-label="Close sidebar"
              tabIndex={-1}
            />
            <div className="relative z-10 flex h-full w-sidebar">
              <Sidebar onNavigate={closeSidebarIfMobile} />
            </div>
          </div>
        )}

        {/* Center */}
        <main id="main-content" className="flex-1 overflow-y-auto bg-canvas">
          {children}
        </main>

        {/* Context Panel — desktop docked, fixed width */}
        {contextPanelOpen && (
          <div
            className="hidden lg:flex shrink-0 overflow-hidden"
            style={{ width: CONTEXT_PANEL_WIDTH }}
          >
            <ContextPanel variant="docked" />
          </div>
        )}
      </div>
    </div>
  );
}
