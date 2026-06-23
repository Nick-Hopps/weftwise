'use client';

/**
 * 两栏式 Settings 的右侧内容区 —— 按选中分类（active）渲染对应 panel：
 * Appearance / Language / Agents / Web search / About。
 * query / mutation 由 SettingsDialog 持有并通过 props 注入，
 * 本文件只负责渲染与本地交互。服务端 app_settings 表是唯一真实源，不写 Zustand。
 */

import { Moon, Sun, RotateCcw } from 'lucide-react';
import { SIDEBAR_WIDTH_DEFAULT } from '@/stores/ui-store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import type { AppSettings } from '@/lib/contracts';
import { SettingRow, NumberSettingRow, SelectSettingRow, TextSettingRow } from './settings-rows';
import { SETTINGS_CATEGORIES, type CategoryId } from './settings-categories';

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

interface SaveLanguageMutation {
  mutate: (v: string) => void;
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

interface SavePartialMutation {
  mutate: (patch: Partial<AppSettings>) => void;
  isPending: boolean;
  isError: boolean;
  error: unknown;
}

interface SettingsContentProps {
  active: CategoryId;
  darkMode: boolean;
  toggleDarkMode: () => void;
  sidebarWidth: number;
  resetSidebarWidth: () => void;
  settings: AppSettings | undefined;
  settingsLoading: boolean;
  languageDraft: string;
  setLanguageDraft: (v: string) => void;
  saveLanguage: SaveLanguageMutation;
  savePartial: SavePartialMutation;
}

export function SettingsContent(props: SettingsContentProps) {
  const category = SETTINGS_CATEGORIES.find((c) => c.id === props.active);

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="space-y-5 p-5">
        <h3 className="text-sm font-semibold text-foreground">{category?.label}</h3>

        {props.active === 'appearance' && (
          <AppearancePanel
            darkMode={props.darkMode}
            toggleDarkMode={props.toggleDarkMode}
            sidebarWidth={props.sidebarWidth}
            resetSidebarWidth={props.resetSidebarWidth}
          />
        )}

        {props.active === 'language' && (
          <LanguagePanel
            settings={props.settings}
            settingsLoading={props.settingsLoading}
            languageDraft={props.languageDraft}
            setLanguageDraft={props.setLanguageDraft}
            saveLanguage={props.saveLanguage}
          />
        )}

        {props.active === 'agents' && (
          <AgentsPanel settings={props.settings} savePartial={props.savePartial} />
        )}

        {props.active === 'web-search' && (
          <WebSearchPanel settings={props.settings} savePartial={props.savePartial} />
        )}

        {props.active === 'about' && <AboutPanel />}
      </div>
    </div>
  );
}

function AppearancePanel({
  darkMode,
  toggleDarkMode,
  sidebarWidth,
  resetSidebarWidth,
}: Pick<
  SettingsContentProps,
  'darkMode' | 'toggleDarkMode' | 'sidebarWidth' | 'resetSidebarWidth'
>) {
  return (
    <div className="space-y-4">
      <SettingRow label="Appearance" description={darkMode ? 'Dark mode' : 'Light mode'}>
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
    </div>
  );
}

function LanguagePanel({
  settings,
  settingsLoading,
  languageDraft,
  setLanguageDraft,
  saveLanguage,
}: Pick<
  SettingsContentProps,
  'settings' | 'settingsLoading' | 'languageDraft' | 'setLanguageDraft' | 'saveLanguage'
>) {
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
    languageDraft.length > 0 && languageDraft !== savedLanguage && !saveLanguage.isPending;

  return (
    <div className="space-y-4">
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
        <p role="alert" className="text-xs text-danger">
          Failed to save: {(saveLanguage.error as Error).message}
        </p>
      )}
    </div>
  );
}

function AgentsPanel({
  settings,
  savePartial,
}: Pick<SettingsContentProps, 'settings' | 'savePartial'>) {
  return (
    <div className="space-y-4">
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
      <SelectSettingRow
        label="Auto-curate after ingest（摄入后自动整理结构）"
        value={(settings?.agentAutoCurate ?? true) ? 'on' : 'off'}
        options={[
          { value: 'on', label: 'On' },
          { value: 'off', label: 'Off' },
        ]}
        onChange={(v) => savePartial.mutate({ agentAutoCurate: v === 'on' })}
        pending={savePartial.isPending}
      />

      {savePartial.isError && (
        <p role="alert" className="text-xs text-danger">
          Failed to save: {(savePartial.error as Error).message}
        </p>
      )}
    </div>
  );
}

function WebSearchPanel({
  settings,
  savePartial,
}: Pick<SettingsContentProps, 'settings' | 'savePartial'>) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-foreground-tertiary">
        Used by the ingest verifier to fact-check augmentation callouts and import cited pages as
        sources. Leave the API key empty to disable (verifier falls back to self-check).
      </p>

      <SelectSettingRow
        label="Provider"
        value={settings?.webSearchProvider ?? 'tavily'}
        options={[{ value: 'tavily', label: 'Tavily' }]}
        onChange={(v) => savePartial.mutate({ webSearchProvider: v as 'tavily' })}
        pending={savePartial.isPending}
      />
      <TextSettingRow
        label="API key"
        description="Stored in app settings; empty disables web grounding"
        type="password"
        placeholder="tvly-…"
        value={settings?.webSearchApiKey ?? ''}
        onSave={(v) => savePartial.mutate({ webSearchApiKey: v })}
        pending={savePartial.isPending}
      />
      <NumberSettingRow
        label="Max results per query"
        value={settings?.webSearchMaxResults ?? 5}
        min={1}
        max={10}
        onSave={(v) => savePartial.mutate({ webSearchMaxResults: v })}
        pending={savePartial.isPending}
      />

      {savePartial.isError && (
        <p role="alert" className="text-xs text-danger">
          Failed to save: {(savePartial.error as Error).message}
        </p>
      )}
    </div>
  );
}

function AboutPanel() {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm text-foreground">
        <span>Agentic Wiki</span>
        <span className="tabular-nums text-foreground-tertiary">v{APP_VERSION}</span>
      </div>
      <p className="text-xs text-foreground-tertiary">
        Personal knowledge base, incrementally built and maintained by LLM agents.
      </p>
    </div>
  );
}
