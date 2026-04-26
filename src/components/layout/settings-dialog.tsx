'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun, X, RotateCcw } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '@/lib/api-fetch';
import { useUIStore, SIDEBAR_WIDTH_DEFAULT } from '@/stores/ui-store';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/cn';
import type { AppSettings } from '@/lib/contracts';

const WIKI_LANGUAGE_PRESETS = [
  { value: 'English', label: 'English' },
  { value: 'Chinese', label: '中文' },
  { value: 'Japanese', label: '日本語' },
  { value: 'Korean', label: '한국어' },
  { value: 'Spanish', label: 'Español' },
  { value: 'French', label: 'Français' },
  { value: 'German', label: 'Deutsch' },
  { value: 'Portuguese', label: 'Português' },
  { value: 'Italian', label: 'Italiano' },
  { value: 'Russian', label: 'Русский' },
] as const;

const APP_VERSION = '0.1.0';

export function SettingsDialog() {
  const isOpen = useUIStore((s) => s.settingsDialogOpen);
  const close = useUIStore((s) => s.closeSettingsDialog);
  const darkMode = useUIStore((s) => s.darkMode);
  const toggleDarkMode = useUIStore((s) => s.toggleDarkMode);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const resetSidebarWidth = useUIStore((s) => s.resetSidebarWidth);

  const queryClient = useQueryClient();

  const settingsQuery = useQuery<AppSettings>({
    queryKey: ['app-settings'],
    queryFn: async () => {
      const res = await apiFetch('/api/settings');
      if (!res.ok) throw new Error(`GET /api/settings → ${res.status}`);
      return (await res.json()) as AppSettings;
    },
    enabled: isOpen,
    staleTime: 30_000,
  });

  const [languageDraft, setLanguageDraft] = useState('');

  useEffect(() => {
    if (settingsQuery.data) {
      setLanguageDraft(settingsQuery.data.wikiLanguage);
    }
  }, [settingsQuery.data]);

  const saveLanguage = useMutation({
    mutationFn: async (value: string) => {
      const res = await apiFetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wikiLanguage: value }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`PUT /api/settings → ${res.status}${text ? `: ${text}` : ''}`);
      }
      return (await res.json()) as AppSettings;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['app-settings'], data);
      setLanguageDraft(data.wikiLanguage);
    },
  });

  const savedLanguage = settingsQuery.data?.wikiLanguage;

  // Build the option list: presets, plus the saved value if it's a custom one.
  const languageOptions = (() => {
    const presetValues = new Set<string>(WIKI_LANGUAGE_PRESETS.map((p) => p.value));
    const opts: { value: string; label: string }[] = WIKI_LANGUAGE_PRESETS.map((p) => ({
      value: p.value,
      label: p.label,
    }));
    if (savedLanguage && !presetValues.has(savedLanguage)) {
      opts.unshift({ value: savedLanguage, label: `${savedLanguage} (custom)` });
    }
    return opts;
  })();

  const canSave =
    languageDraft.length > 0 &&
    languageDraft !== savedLanguage &&
    !saveLanguage.isPending;

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

          <SettingRow
            label="Wiki language"
            description="Language LLM uses for new wiki content (slugs and wikilinks stay verbatim)"
            className="items-start"
          >
            <div className="flex items-center gap-1.5">
              <select
                value={languageDraft}
                onChange={(e) => setLanguageDraft(e.target.value)}
                aria-label="Wiki language"
                disabled={settingsQuery.isLoading}
                className={cn(
                  'h-7 rounded-md border border-input-border bg-input-bg px-2 text-xs text-foreground',
                  'transition-colors duration-fast ease-standard',
                  'hover:border-border-strong',
                  'focus:outline-none focus:border-accent focus:ring-2 focus:ring-focus-ring/30',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                )}
              >
                {languageOptions.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <Button
                intent="outline"
                size="sm"
                onClick={() => saveLanguage.mutate(languageDraft)}
                disabled={!canSave}
              >
                {saveLanguage.isPending ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </SettingRow>

          {saveLanguage.isError && (
            <p role="alert" className="text-xs text-danger -mt-2">
              Failed to save: {(saveLanguage.error as Error).message}
            </p>
          )}

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
