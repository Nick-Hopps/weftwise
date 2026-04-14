'use client';

import { useCallback } from 'react';
import { useUIStore } from '@/stores/ui-store';
import { Header } from './header';
import { Sidebar } from './sidebar';
import { RightPanel } from './right-panel';

interface ShellProps {
  children: React.ReactNode;
}

export function Shell({ children }: ShellProps) {
  const { sidebarOpen, rightPanelOpen, rightPanelWidth, toggleSidebar, toggleRightPanel, setRightPanelWidth } = useUIStore();
  // Close sidebar drawer on mobile after navigation
  const closeSidebarIfMobile = () => {
    if (window.innerWidth < 1024 && sidebarOpen) {
      toggleSidebar();
    }
  };

  const handleResizeStart = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = useUIStore.getState().rightPanelWidth;

    const onMove = (ev: PointerEvent) => {
      const delta = startX - ev.clientX;
      setRightPanelWidth(startWidth + delta);
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
  }, [setRightPanelWidth]);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-[rgb(var(--background))]">
      {/* Top header — full width */}
      <Header />

      {/* Body: sidebar + workspace + right panel */}
      <div className="flex flex-1 overflow-hidden relative">

        {/* ── Left Sidebar ── */}
        {/* Desktop: inline panel */}
        <div
          className={`
            hidden lg:flex flex-col shrink-0
            transition-all duration-200 ease-in-out overflow-hidden
            ${sidebarOpen ? 'w-[280px]' : 'w-0'}
          `}
        >
          {sidebarOpen && <Sidebar />}
        </div>

        {/* Mobile/Tablet: overlay drawer */}
        {sidebarOpen && (
          <div className="lg:hidden absolute inset-0 z-30 flex">
            {/* Backdrop */}
            <button
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={toggleSidebar}
              aria-label="Close sidebar"
              tabIndex={-1}
            />
            {/* Drawer */}
            <div className="relative z-10 flex flex-col h-full">
              <Sidebar onNavigate={closeSidebarIfMobile} />
            </div>
          </div>
        )}

        {/* ── Center Workspace ── */}
        <main
          className="flex-1 overflow-y-auto bg-[rgb(var(--background))]"
          id="main-content"
        >
          {children}
        </main>

        {/* ── Right Context Panel ── */}
        {/* Desktop: resize handle + inline panel */}
        {rightPanelOpen && (
          <div
            onPointerDown={handleResizeStart}
            className="hidden lg:flex items-center justify-center shrink-0 w-1 cursor-col-resize group hover:bg-indigo-400/30 active:bg-indigo-400/50 transition-colors"
            aria-label="Resize context panel"
          >
            <div className="w-0.5 h-8 rounded-full bg-[rgb(var(--border))] group-hover:bg-indigo-400 group-active:bg-indigo-500 transition-colors" />
          </div>
        )}
        <div
          className={`
            hidden lg:flex flex-col shrink-0
            overflow-hidden
            ${rightPanelOpen ? '' : 'w-0'}
          `}
          style={rightPanelOpen ? { width: rightPanelWidth } : undefined}
        >
          {rightPanelOpen && <RightPanel />}
        </div>

        {/* Mobile/Tablet: overlay drawer from the right */}
        {rightPanelOpen && (
          <div className="lg:hidden absolute inset-0 z-30 flex justify-end">
            {/* Backdrop */}
            <button
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={toggleRightPanel}
              aria-label="Close context panel"
              tabIndex={-1}
            />
            {/* Drawer */}
            <div className="relative z-10 flex flex-col h-full">
              <RightPanel />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
