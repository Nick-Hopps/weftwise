'use client';

/**
 * 两栏式 Settings 的右侧内容区 —— 按选中分类（active）渲染对应 panel：
 * Appearance / Language / Agents / Web search / About。
 * query / mutation 由 SettingsDialog 持有并通过 props 注入，
 * 本文件只负责渲染与本地交互。服务端 app_settings 表是唯一真实源，不写 Zustand。
 */

import { useEffect, useState } from 'react';
import { Moon, Sun, RotateCcw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { SIDEBAR_WIDTH_DEFAULT } from '@/stores/ui-store';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { apiFetch } from '@/lib/api-fetch';
import type { AppSettings, MaintenanceStatus, StylePrefs } from '@/lib/contracts';
import { useProfile, useUpdateProfile } from '@/hooks/use-profile';
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

        {props.active === 'cognitive-lens' && <CognitiveLensPanel />}

        {props.active === 'agents' && (
          <AgentsPanel settings={props.settings} savePartial={props.savePartial} />
        )}

        {props.active === 'web-search' && (
          <WebSearchPanel settings={props.settings} savePartial={props.savePartial} />
        )}

        {props.active === 'maintenance' && (
          <MaintenancePanel settings={props.settings} savePartial={props.savePartial} />
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

const LENS_LABELS: Record<keyof StylePrefs, string> = {
  readingLevel: 'Reading level',
  verbosity: 'Verbosity',
  exampleDensity: 'Examples & analogies',
  formality: 'Tone',
};

const LENS_OPTIONS: Record<keyof StylePrefs, [string, string][]> = {
  readingLevel: [
    ['beginner', 'Beginner'],
    ['intermediate', 'Intermediate'],
    ['advanced', 'Advanced'],
  ],
  verbosity: [
    ['terse', 'Terse'],
    ['balanced', 'Balanced'],
    ['thorough', 'Thorough'],
  ],
  exampleDensity: [
    ['few', 'Few'],
    ['some', 'Some'],
    ['many', 'Many'],
  ],
  formality: [
    ['casual', 'Casual'],
    ['neutral', 'Neutral'],
    ['formal', 'Formal'],
  ],
};

const LENS_KEYS: (keyof StylePrefs)[] = ['readingLevel', 'verbosity', 'exampleDensity', 'formality'];

// 认知画像设置：走 /api/profile（独立 user_profiles 表，非 app_settings），不写 Zustand。
function CognitiveLensPanel() {
  const { data, isLoading } = useProfile();
  const update = useUpdateProfile();
  const [bg, setBg] = useState('');
  const [prefs, setPrefs] = useState<StylePrefs | null>(null);

  useEffect(() => {
    if (data && prefs === null) {
      setPrefs(data.profile.stylePrefs);
      setBg(data.profile.backgroundSummary);
    }
  }, [data, prefs]);

  if (isLoading || !data || prefs === null) {
    return <p className="text-xs text-foreground-tertiary">Loading…</p>;
  }
  const current = prefs;

  const dirty =
    bg !== data.profile.backgroundSummary ||
    JSON.stringify(current) !== JSON.stringify(data.profile.stylePrefs);

  return (
    <div className="space-y-4">
      <p className="text-xs text-foreground-tertiary">
        Adapts how each page is explained to your background and preferences (rephrasing only — facts
        never change, and the original is always one click away; it also fine-tunes itself from your
        “too hard / too shallow” feedback).
      </p>

      {LENS_KEYS.map((key) => (
        <SettingRow key={key} label={LENS_LABELS[key]}>
          <select
            value={current[key]}
            onChange={(e) =>
              setPrefs((p) => (p ? ({ ...p, [key]: e.target.value } as StylePrefs) : p))
            }
            aria-label={LENS_LABELS[key]}
            className="rounded-md border border-border bg-canvas px-2 py-1 text-sm"
          >
            {LENS_OPTIONS[key].map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </SettingRow>
      ))}

      <SettingRow
        label="Background"
        description="Your background and goals (free text)"
        className="items-start"
      >
        <textarea
          value={bg}
          onChange={(e) => setBg(e.target.value)}
          rows={3}
          placeholder="e.g. Backend engineer, comfortable with distributed systems but new to machine learning"
          className="w-60 rounded-md border border-border bg-canvas p-2 text-sm"
        />
      </SettingRow>

      <div className="flex items-center justify-end gap-2">
        {update.isError && (
          <span role="alert" className="mr-auto text-xs text-danger">
            Failed to save
          </span>
        )}
        <Button
          intent="outline"
          size="sm"
          disabled={!dirty || update.isPending}
          onClick={() => update.mutate({ backgroundSummary: bg, stylePrefs: current })}
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
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
        label="Auto-curate after ingest"
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

function formatSweepTime(iso: string | null): string {
  if (!iso) return 'Never';
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(iso).toLocaleString();
}

function MaintenancePanel({
  settings,
  savePartial,
}: Pick<SettingsContentProps, 'settings' | 'savePartial'>) {
  // 只读运行态：上次 sweep + 当前到期页数（与设置分离，走 /api/maintenance/status）。
  const statusQuery = useQuery<MaintenanceStatus>({
    queryKey: ['maintenance-status'],
    queryFn: async () => {
      const res = await apiFetch('/api/maintenance/status');
      if (!res.ok) throw new Error(`GET /api/maintenance/status → ${res.status}`);
      return (await res.json()) as MaintenanceStatus;
    },
    staleTime: 10_000,
  });
  const status = statusQuery.data;

  return (
    <div className="space-y-4">
      <SelectSettingRow
        label="Periodic maintenance"
        value={settings?.maintenanceEnabled ? 'on' : 'off'}
        options={[
          { value: 'off', label: 'off (default)' },
          { value: 'on', label: 'on — revisit & deepen pages over time' },
        ]}
        onChange={(v) => savePartial.mutate({ maintenanceEnabled: v === 'on' })}
        pending={savePartial.isPending}
      />

      <SettingRow label="Status" description="Read-only — refreshes when this panel opens">
        <div className="text-xs text-foreground-secondary tabular-nums space-y-0.5 text-right">
          {statusQuery.isError ? (
            <span className="text-danger">unavailable</span>
          ) : (
            <>
              <div>Last sweep: {status ? formatSweepTime(status.lastSweepAt) : '…'}</div>
              <div>Pages due now: {status ? status.dueCount : '…'}</div>
            </>
          )}
        </div>
      </SettingRow>
      <NumberSettingRow
        label="Sweep interval (hours)"
        value={settings?.maintenanceSweepIntervalHours ?? 24}
        min={1}
        max={168}
        onSave={(v) => savePartial.mutate({ maintenanceSweepIntervalHours: v })}
        pending={savePartial.isPending}
      />
      <NumberSettingRow
        label="Max pages per sweep"
        description="Caps re-enrich jobs enqueued each cycle (cost guardrail)"
        value={settings?.maintenanceMaxPagesPerSweep ?? 5}
        min={1}
        max={50}
        onSave={(v) => savePartial.mutate({ maintenanceMaxPagesPerSweep: v })}
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
