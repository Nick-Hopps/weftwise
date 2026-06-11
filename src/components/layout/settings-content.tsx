'use client';

/**
 * 设置对话框的内容区 —— 外观 / 侧边栏 / Wiki 语言 / Agents 各分组。
 * query / mutation 由 SettingsDialog 持有并通过 props 注入，
 * 本文件只负责渲染与本地交互。
 */

import { Moon, Sun, RotateCcw } from 'lucide-react';
import { SIDEBAR_WIDTH_DEFAULT } from '@/stores/ui-store';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/cn';
import type { AppSettings } from '@/lib/contracts';
import { SettingRow, NumberSettingRow, SelectSettingRow } from './settings-rows';

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

interface SettingsContentProps {
  darkMode: boolean;
  toggleDarkMode: () => void;
  sidebarWidth: number;
  resetSidebarWidth: () => void;
  settings: AppSettings | undefined;
  settingsLoading: boolean;
  languageDraft: string;
  setLanguageDraft: (v: string) => void;
  saveLanguage: {
    mutate: (v: string) => void;
    isPending: boolean;
    isError: boolean;
    error: unknown;
  };
  savePartial: {
    mutate: (patch: Partial<AppSettings>) => void;
    isPending: boolean;
    isError: boolean;
    error: unknown;
  };
}

export function SettingsContent({
  darkMode,
  toggleDarkMode,
  sidebarWidth,
  resetSidebarWidth,
  settings,
  settingsLoading,
  languageDraft,
  setLanguageDraft,
  saveLanguage,
  savePartial,
}: SettingsContentProps) {
  const savedLanguage = settings?.wikiLanguage;

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

  return (
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
            disabled={settingsLoading}
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

      <div className="space-y-4">
        <div className="text-sm font-semibold text-foreground">Agents</div>

        <NumberSettingRow
          label="Max steps per agent"
          value={settings?.agentMaxSteps ?? 25}
          min={1}
          max={200}
          onSave={(v) => savePartial.mutate({ agentMaxSteps: v })}
          pending={savePartial.isPending}
        />
        <NumberSettingRow
          label="Total token budget per task"
          description="Default 500k handles sources up to ~200k tokens; raise to 1-1.5M for book-sized files"
          value={settings?.agentMaxTokensPerJob ?? 500_000}
          min={10_000}
          max={5_000_000}
          onSave={(v) => savePartial.mutate({ agentMaxTokensPerJob: v })}
          pending={savePartial.isPending}
        />
        <NumberSettingRow
          label="Parallel sub-agents"
          value={settings?.agentMaxParallelSubAgents ?? 3}
          min={1}
          max={10}
          onSave={(v) => savePartial.mutate({ agentMaxParallelSubAgents: v })}
          pending={savePartial.isPending}
        />
        <SelectSettingRow
          label="MCP connection mode"
          value={settings?.agentMcpLifecycle ?? 'lazy'}
          options={[
            { value: 'eager', label: 'eager (connect at boot)' },
            { value: 'lazy', label: 'lazy (connect on first use)' },
            { value: 'per-job', label: 'per-job (connect per job)' },
          ]}
          onChange={(v) =>
            savePartial.mutate({
              agentMcpLifecycle: v as 'eager' | 'lazy' | 'per-job',
            })
          }
          pending={savePartial.isPending}
        />
        <SelectSettingRow
          label="LLM selection mode"
          value={settings?.agentTaskRouterMode ?? 'frontmatter-override'}
          options={[
            { value: 'task-router-only', label: 'task-router only' },
            { value: 'frontmatter-override', label: 'frontmatter override' },
          ]}
          onChange={(v) =>
            savePartial.mutate({
              agentTaskRouterMode: v as 'task-router-only' | 'frontmatter-override',
            })
          }
          pending={savePartial.isPending}
        />

        {savePartial.isError && (
          <p role="alert" className="text-xs text-danger">
            Failed to save: {(savePartial.error as Error).message}
          </p>
        )}
      </div>

      <Separator />

      <div className="flex items-center justify-between text-xs text-foreground-tertiary">
        <span>Agentic Wiki</span>
        <span className="tabular-nums">v{APP_VERSION}</span>
      </div>
    </div>
  );
}
