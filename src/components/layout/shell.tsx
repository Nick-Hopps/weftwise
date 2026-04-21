'use client';

import { useCallback, useEffect, useState } from 'react';
import { useUIStore } from '@/stores/ui-store';
import { Header } from './header';
import { Sidebar } from './sidebar';
import { ContextPanel } from './context-panel';

interface ShellProps {
  children: React.ReactNode;
}

export function Shell({ children }: ShellProps) {
  const {
    sidebarOpen,
    toggleSidebar,
    contextPanelOpen,
    contextPanelWidth,
    setContextPanelWidth,
  } = useUIStore();

  // Apply panel width only post-hydration to avoid SSR/client mismatch.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  const closeSidebarIfMobile = () => {
    if (window.innerWidth < 1024 && sidebarOpen) toggleSidebar();
  };

  const handleResizeStart = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = useUIStore.getState().contextPanelWidth;

      const onMove = (ev: PointerEvent) => {
        const delta = startX - ev.clientX;
        setContextPanelWidth(startWidth + delta);
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
    [setContextPanelWidth],
  );

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-canvas">
      <Header />

      <div className="flex flex-1 overflow-hidden relative">
        {/* Left Sidebar — desktop inline */}
        <div
          className={`hidden lg:flex flex-col shrink-0 overflow-hidden transition-[width] duration-base ease-standard ${
            sidebarOpen ? 'w-sidebar' : 'w-0'
          }`}
        >
          {sidebarOpen && <Sidebar />}
        </div>

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
            <div className="relative z-10 flex h-full">
              <Sidebar onNavigate={closeSidebarIfMobile} />
            </div>
          </div>
        )}

        {/* Center */}
        <main id="main-content" className="flex-1 overflow-y-auto bg-canvas">
          {children}
        </main>

        {/* Context Panel — desktop docked (mobile handled by ContextPanelSheet in providers) */}
        {contextPanelOpen && (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize context panel"
              onPointerDown={handleResizeStart}
              className="hidden lg:flex items-center justify-center shrink-0 w-1 cursor-col-resize group hover:bg-accent/30 active:bg-accent/50 transition-colors"
            >
              <div className="w-0.5 h-8 rounded-full bg-border group-hover:bg-accent group-active:bg-accent-active transition-colors" />
            </div>
            <div
              className="hidden lg:flex shrink-0 overflow-hidden"
              style={hydrated ? { width: contextPanelWidth } : undefined}
            >
              <ContextPanel variant="docked" />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
