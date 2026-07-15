'use client';

/**
 * 两栏式 Settings 的右侧内容区 —— 按选中分类（active）渲染对应 panel：
 * Appearance / Language / Agents / Web search / About。
 * query / mutation 由 SettingsDialog 持有并通过 props 注入，
 * 本文件只负责渲染与本地交互。服务端 app_settings 表是唯一真实源，不写 Zustand。
 */

import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { SIDEBAR_WIDTH_DEFAULT } from '@/stores/ui-store';
import { Button } from '@/components/ui/button';
import { Segmented } from '@/components/ui/segmented';
import { apiFetch } from '@/lib/api-fetch';
import { formatTokenCount } from '@/lib/format';
import type {
  AppSettings,
  MaintenanceScope,
  MaintenanceStatus,
  StylePrefs,
  SubjectListEntry,
  UsageWindow,
  UsageSummaryRow,
} from '@/lib/contracts';
import { fetchSubjects } from '@/components/subjects/subjects-api';
import { useProfile, useUpdateProfile } from '@/hooks/use-profile';
import {
  SettingRow,
  SwitchRow,
  SegmentedRow,
  SelectRow,
  MultiSelectRow,
  NumberRow,
  TextRow,
  TextareaRow,
  type RowSaveState,
} from './settings-rows';
import { SETTINGS_CATEGORIES, type CategoryId } from './settings-categories';

/** mutation → RowSaveState 适配。*/
function toSave(m: { isPending: boolean; isError: boolean; error: unknown }): RowSaveState {
  return { pending: m.isPending, error: m.isError ? m.error : undefined };
}

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

        {props.active === 'usage' && <UsagePanel />}

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
      <SwitchRow
        label="Dark mode"
        description="Toggle between light and dark theme"
        checked={darkMode}
        onSave={() => toggleDarkMode()}
      />
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

const LENS_OPTIONS = {
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
} satisfies Record<keyof StylePrefs, [string, string][]>;

const LENS_KEYS: (keyof StylePrefs)[] = ['readingLevel', 'verbosity', 'exampleDensity', 'formality'];

// 认知画像设置：走 /api/profile（独立 user_profiles 表，非 app_settings），不写 Zustand。
function CognitiveLensPanel() {
  const { data, isLoading } = useProfile();
  const update = useUpdateProfile();

  if (isLoading || !data) {
    return <p className="text-xs text-foreground-tertiary">Loading…</p>;
  }
  const profile = data.profile;
  const save = toSave(update);

  // 只提交本次变更的字段，避免并发编辑用本地 stale profile 覆盖另一路已提交的修改。
  const savePrefs = (patch: Partial<StylePrefs>) =>
    update.mutate({
      stylePrefs: { ...profile.stylePrefs, ...patch },
    });

  return (
    <div className="space-y-4">
      <p className="text-xs text-foreground-tertiary">
        Adapts how each page is explained to your background and preferences (rephrasing only — facts
        never change, and the original is always one click away; it also fine-tunes itself from your
        “too hard / too shallow” feedback).
      </p>

      {LENS_KEYS.map((key) => (
        <SegmentedRow
          key={key}
          label={LENS_LABELS[key]}
          value={profile.stylePrefs[key]}
          options={LENS_OPTIONS[key].map(([value, label]) => ({
            value: value as StylePrefs[typeof key],
            label,
          }))}
          onSave={(v) => savePrefs({ [key]: v } as Partial<StylePrefs>)}
          save={save}
        />
      ))}

      <TextareaRow
        label="Background"
        description="Your background and goals (free text)"
        value={profile.backgroundSummary}
        placeholder="e.g. Backend engineer, comfortable with distributed systems but new to machine learning"
        onSave={(v) => update.mutate({ backgroundSummary: v })}
        save={save}
      />
    </div>
  );
}

function LanguagePanel({
  settings,
  settingsLoading,
  saveLanguage,
}: Pick<SettingsContentProps, 'settings' | 'settingsLoading' | 'saveLanguage'>) {
  const savedLanguage = settings?.wikiLanguage ?? '';
  const presetValues = new Set<string>(WIKI_LANGUAGE_PRESETS.map((p) => p.value));
  const languageOptions: { value: string; label: string }[] = WIKI_LANGUAGE_PRESETS.map((p) => ({
    value: p.value,
    label: p.label,
  }));
  if (savedLanguage && !presetValues.has(savedLanguage)) {
    languageOptions.unshift({ value: savedLanguage, label: `${savedLanguage} (custom)` });
  }
  return (
    <div className="space-y-4">
      <SelectRow
        label="Wiki language"
        description="Language LLM uses for new wiki content (slugs and wikilinks stay verbatim)"
        value={savedLanguage}
        options={languageOptions}
        disabled={settingsLoading}
        onSave={(v) => saveLanguage.mutate(v)}
        save={toSave(saveLanguage)}
      />
    </div>
  );
}

function AgentsPanel({
  settings,
  savePartial,
}: Pick<SettingsContentProps, 'settings' | 'savePartial'>) {
  const save = toSave(savePartial);
  return (
    <div className="space-y-4">
      <NumberRow
        label="Max steps per agent"
        value={settings?.agentMaxSteps ?? 25}
        min={1}
        max={200}
        onSave={(v) => savePartial.mutate({ agentMaxSteps: v })}
        save={save}
      />
      <NumberRow
        label="Total token budget per task"
        description="Default 500k handles sources up to ~200k tokens; raise to 1-1.5M for book-sized files"
        value={settings?.agentMaxTokensPerJob ?? 500_000}
        min={10_000}
        max={5_000_000}
        onSave={(v) => savePartial.mutate({ agentMaxTokensPerJob: v })}
        save={save}
      />
      <NumberRow
        label="Parallel sub-agents"
        value={settings?.agentMaxParallelSubAgents ?? 3}
        min={1}
        max={10}
        onSave={(v) => savePartial.mutate({ agentMaxParallelSubAgents: v })}
        save={save}
      />
      <SegmentedRow
        label="LLM selection mode"
        value={settings?.agentTaskRouterMode ?? 'frontmatter-override'}
        options={[
          { value: 'task-router-only', label: 'Task router only' },
          { value: 'frontmatter-override', label: 'Frontmatter override' },
        ]}
        onSave={(v) =>
          savePartial.mutate({
            agentTaskRouterMode: v as 'task-router-only' | 'frontmatter-override',
          })
        }
        save={save}
      />
      <SwitchRow
        label="Auto-curate after ingest"
        description="Automatically tidy touched pages after each ingest"
        checked={settings?.agentAutoCurate ?? true}
        onSave={(v) => savePartial.mutate({ agentAutoCurate: v })}
        save={save}
      />
      <NumberRow
        label="Ingest concurrency"
        description="How many ingest jobs run at once; other job types always run alone"
        value={settings?.ingestConcurrency ?? 2}
        min={1}
        max={4}
        onSave={(v) => savePartial.mutate({ ingestConcurrency: v })}
        save={save}
      />
    </div>
  );
}

function WebSearchPanel({
  settings,
  savePartial,
}: Pick<SettingsContentProps, 'settings' | 'savePartial'>) {
  const save = toSave(savePartial);
  return (
    <div className="space-y-4">
      <p className="text-xs text-foreground-tertiary">
        Used by the ingest verifier to fact-check augmentation callouts and import cited pages as
        sources. Leave the API key empty to disable (verifier falls back to self-check).
      </p>
      <SettingRow label="Provider" description="Only Tavily is supported for now">
        <span className="text-xs text-foreground-secondary">Tavily</span>
      </SettingRow>
      <TextRow
        label="API key"
        description="Stored in app settings; empty disables web grounding"
        type="password"
        placeholder="tvly-…"
        value={settings?.webSearchApiKey ?? ''}
        onSave={(v) => savePartial.mutate({ webSearchApiKey: v })}
        save={save}
      />
      <NumberRow
        label="Max results per query"
        value={settings?.webSearchMaxResults ?? 5}
        min={1}
        max={10}
        onSave={(v) => savePartial.mutate({ webSearchMaxResults: v })}
        save={save}
      />
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
  const subjectsQuery = useQuery<SubjectListEntry[]>({
    queryKey: ['subjects'],
    queryFn: fetchSubjects,
    staleTime: 30_000,
  });
  const save = toSave(savePartial);
  const scope = settings?.maintenanceScope ?? { mode: 'all' };

  return (
    <div className="space-y-4">
      <SwitchRow
        label="Periodic maintenance"
        description="Revisit & deepen pages over time (off by default)"
        checked={settings?.maintenanceEnabled ?? false}
        onSave={(v) => savePartial.mutate({ maintenanceEnabled: v })}
        save={save}
      />

      <MultiSelectRow
        label="Maintenance scope"
        description="Projects eligible for periodic maintenance"
        allLabel="All projects"
        value={scope.mode === 'all' ? 'all' : scope.subjectIds}
        options={(subjectsQuery.data ?? []).map((subject) => ({
          value: subject.id,
          label: subject.name,
          description: subject.slug,
        }))}
        loading={subjectsQuery.isLoading}
        onSave={(value) => {
          const maintenanceScope: MaintenanceScope = value === 'all'
            ? { mode: 'all' }
            : { mode: 'subjects', subjectIds: value };
          savePartial.mutate({ maintenanceScope });
        }}
        save={save}
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
      <NumberRow
        label="Sweep interval (hours)"
        value={settings?.maintenanceSweepIntervalHours ?? 24}
        min={1}
        max={168}
        onSave={(v) => savePartial.mutate({ maintenanceSweepIntervalHours: v })}
        save={save}
      />
      <NumberRow
        label="Max pages per sweep"
        description="Caps re-enrich jobs enqueued each cycle (cost guardrail)"
        value={settings?.maintenanceMaxPagesPerSweep ?? 5}
        min={1}
        max={50}
        onSave={(v) => savePartial.mutate({ maintenanceMaxPagesPerSweep: v })}
        save={save}
      />
    </div>
  );
}

const USAGE_WINDOW_OPTIONS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'all', label: 'All time' },
] as const;

/** Usage 面板：LLM 用量统计（app 级，不随 subject；弹窗打开时取数，无轮询）。 */
function UsagePanel() {
  const [timeWindow, setTimeWindow] = useState<UsageWindow>('30d');
  const { data, isLoading } = useQuery({
    queryKey: ['usage', timeWindow],
    queryFn: async () => {
      const res = await apiFetch(`/api/usage?window=${timeWindow}`);
      if (!res.ok) throw new Error('Failed to load usage');
      return (await res.json()) as { window: UsageWindow; rows: UsageSummaryRow[] };
    },
    staleTime: 30_000,
  });

  const rows = data?.rows ?? [];
  const totals = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      inputTokens: acc.inputTokens + r.inputTokens,
      outputTokens: acc.outputTokens + r.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  );

  return (
    <div className="space-y-4">
      <Segmented
        value={timeWindow}
        options={[...USAGE_WINDOW_OPTIONS]}
        onChange={setTimeWindow}
        aria-label="Usage time window"
      />
      {isLoading ? (
        <p className="text-xs text-foreground-tertiary">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-foreground-tertiary">No usage recorded yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-foreground-tertiary">
              <th className="py-1.5 pr-2 font-medium">Task</th>
              <th className="py-1.5 pr-2 font-medium">Model</th>
              <th className="py-1.5 pr-2 text-right font-medium">Calls</th>
              <th className="py-1.5 pr-2 text-right font-medium">Input</th>
              <th className="py-1.5 text-right font-medium">Output</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.task}:${r.model}`} className="border-b border-border/50">
                <td className="py-1.5 pr-2 font-mono text-xs">{r.task}</td>
                <td className="py-1.5 pr-2 truncate max-w-[10rem] text-xs text-foreground-secondary" title={r.model}>
                  {r.model}
                </td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{r.calls}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{formatTokenCount(r.inputTokens)}</td>
                <td className="py-1.5 text-right tabular-nums">{formatTokenCount(r.outputTokens)}</td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className="py-1.5 pr-2 text-xs">Total</td>
              <td className="py-1.5 pr-2" />
              <td className="py-1.5 pr-2 text-right tabular-nums">{totals.calls}</td>
              <td className="py-1.5 pr-2 text-right tabular-nums">{formatTokenCount(totals.inputTokens)}</td>
              <td className="py-1.5 text-right tabular-nums">{formatTokenCount(totals.outputTokens)}</td>
            </tr>
          </tbody>
        </table>
      )}
      <p className="text-xs text-foreground-tertiary">Usage data is retained for 90 days.</p>
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
