'use client';

import { useUIStore } from '@/stores/ui-store';

function SunIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function HamburgerIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

function PanelRightIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
      <line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  );
}

export function Header() {
  const { toggleSidebar, toggleRightPanel, toggleCommandPalette, toggleDarkMode, darkMode } =
    useUIStore();

  return (
    <header
      className="
        flex items-center justify-between
        h-12 px-3
        border-b border-[rgb(var(--border))]
        bg-[rgb(var(--surface))]
        shrink-0
        z-10
      "
    >
      {/* Left: sidebar toggle + title */}
      <div className="flex items-center gap-2">
        <button
          onClick={toggleSidebar}
          aria-label="Toggle sidebar"
          className="
            p-1.5 rounded-md
            text-[rgb(var(--muted))]
            hover:text-[rgb(var(--foreground))]
            hover:bg-[rgb(var(--border))]
            transition-colors
          "
        >
          <HamburgerIcon />
        </button>
        <span className="text-sm font-semibold tracking-tight text-[rgb(var(--foreground))]">
          LLM Wiki
        </span>
      </div>

      {/* Center: search */}
      <button
        onClick={toggleCommandPalette}
        aria-label="Open search (Ctrl+K)"
        className="
          hidden sm:flex items-center gap-2
          px-3 py-1.5 rounded-md
          text-xs text-[rgb(var(--muted))]
          border border-[rgb(var(--border))]
          bg-[rgb(var(--background))]
          hover:border-indigo-400 hover:text-[rgb(var(--foreground))]
          transition-colors
          min-w-[160px]
        "
      >
        <SearchIcon />
        <span className="flex-1 text-left">Search…</span>
        <kbd className="text-[10px] font-mono opacity-60">⌘K</kbd>
      </button>

      {/* Right: icon actions */}
      <div className="flex items-center gap-1">
        <button
          onClick={toggleCommandPalette}
          aria-label="Search"
          className="
            sm:hidden p-1.5 rounded-md
            text-[rgb(var(--muted))]
            hover:text-[rgb(var(--foreground))]
            hover:bg-[rgb(var(--border))]
            transition-colors
          "
        >
          <SearchIcon />
        </button>

        <button
          onClick={toggleDarkMode}
          aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          className="
            p-1.5 rounded-md
            text-[rgb(var(--muted))]
            hover:text-[rgb(var(--foreground))]
            hover:bg-[rgb(var(--border))]
            transition-colors
          "
        >
          {darkMode ? <SunIcon /> : <MoonIcon />}
        </button>

        <button
          onClick={toggleRightPanel}
          aria-label="Toggle context panel"
          className="
            p-1.5 rounded-md
            text-[rgb(var(--muted))]
            hover:text-[rgb(var(--foreground))]
            hover:bg-[rgb(var(--border))]
            transition-colors
          "
        >
          <PanelRightIcon />
        </button>
      </div>
    </header>
  );
}
