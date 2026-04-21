'use client';

import { useEffect } from 'react';
import { Moon, Sun, X, RotateCcw } from 'lucide-react';
import { useUIStore, SIDEBAR_WIDTH_DEFAULT } from '@/stores/ui-store';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/cn';

const APP_VERSION = '0.1.0';

export function SettingsDialog() {
  const isOpen = useUIStore((s) => s.settingsDialogOpen);
  const close = useUIStore((s) => s.closeSettingsDialog);
  const darkMode = useUIStore((s) => s.darkMode);
  const toggleDarkMode = useUIStore((s) => s.toggleDarkMode);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const resetSidebarWidth = useUIStore((s) => s.resetSidebarWidth);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  if (!isOpen) return null;

  return (
    <div
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="fixed inset-0 z-command flex items-start justify-center pt-[15vh] bg-overlay/40 backdrop-blur-sm animate-fade-in"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-dialog-title"
        className="w-full max-w-md mx-4 bg-surface rounded-lg shadow-lg border border-border overflow-hidden animate-slide-down"
      >
        <div className="flex items-center justify-between h-12 px-4 border-b border-border">
          <h2 id="settings-dialog-title" className="text-sm font-semibold text-foreground">
            Settings
          </h2>
          <IconButton size="sm" onClick={close} aria-label="Close settings">
            <X />
          </IconButton>
        </div>

        <div className="p-4 space-y-4">
          <SettingRow
            label="Appearance"
            description={darkMode ? 'Dark mode' : 'Light mode'}
          >
            <Button
              intent="outline"
              size="sm"
              onClick={toggleDarkMode}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
              className="gap-1.5"
            >
              {darkMode ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              {darkMode ? 'Light' : 'Dark'}
            </Button>
          </SettingRow>

          <Separator />

          <SettingRow
            label="Sidebar width"
            description={`${Math.round(sidebarWidth)}px (default ${SIDEBAR_WIDTH_DEFAULT}px)`}
          >
            <Button
              intent="outline"
              size="sm"
              onClick={resetSidebarWidth}
              disabled={Math.round(sidebarWidth) === SIDEBAR_WIDTH_DEFAULT}
              className="gap-1.5"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </Button>
          </SettingRow>

          <Separator />

          <div className="flex items-center justify-between text-xs text-foreground-tertiary">
            <span>Agentic Wiki</span>
            <span className="tabular-nums">v{APP_VERSION}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

interface SettingRowProps {
  label: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}

function SettingRow({ label, description, children, className }: SettingRowProps) {
  return (
    <div className={cn('flex items-center justify-between gap-4', className)}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {description && (
          <div className="text-xs text-foreground-tertiary mt-0.5 truncate">{description}</div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
