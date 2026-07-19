'use client';

/**
 * Settings 的右侧内容区：四个一级入口按用户任务组织，原有设置模块作为
 * section 组合渲染。
 * query / mutation 由 SettingsDialog 持有并通过 props 注入，
 * 本文件只负责渲染与本地交互。服务端 app_settings 表是唯一真实源，不写 Zustand。
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
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
import { useI18n } from '@/components/i18n-provider';
import type { Locale } from '@/lib/i18n/config';
import type { MessageKey } from '@/lib/i18n/messages';
import type { I18n } from '@/lib/i18n/translator';
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
import {
  APP_VERSION,
  SETTINGS_SECTIONS,
  getSettingsCategories,
  type CategoryId,
  type SettingsSectionId,
} from './settings-categories';

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
  settings: AppSettings | undefined;
  settingsLoading: boolean;
  saveLanguage: SaveLanguageMutation;
  savePartial: SavePartialMutation;
}

export function SettingsContent(props: SettingsContentProps) {
  const { t } = useI18n();
  const category = getSettingsCategories(t).find((c) => c.id === props.active);
  const sections: readonly SettingsSectionId[] = SETTINGS_SECTIONS[props.active];

  return (
    <div className="flex-1 overflow-y-auto">
      <div key={props.active} className="animate-fade-in p-5 md:p-7">
        <header className="mb-7">
          <h3 className="text-base font-semibold text-foreground">{category?.label}</h3>
          <p className="mt-1 text-xs text-foreground-tertiary">{category?.description}</p>
        </header>

        <div className="space-y-7">
          {sections.includes('appearance') && (
            <SettingsSection title={t('settings.section.appearance')}>
              <AppearancePanel />
            </SettingsSection>
          )}

          {sections.includes('language') && (
            <SettingsSection title={t('settings.section.contentLanguage')}>
              <LanguagePanel
                settings={props.settings}
                settingsLoading={props.settingsLoading}
                saveLanguage={props.saveLanguage}
              />
            </SettingsSection>
          )}

          {sections.includes('cognitive-lens') && (
            <SettingsSection title={t('settings.section.cognitiveLens')}>
              <CognitiveLensPanel />
            </SettingsSection>
          )}

          {sections.includes('agents') && (
            <SettingsSection title={t('settings.section.agentBehavior')}>
              <AgentsPanel settings={props.settings} savePartial={props.savePartial} />
            </SettingsSection>
          )}

          {sections.includes('web-search') && (
            <SettingsSection title={t('settings.section.webGrounding')}>
              <WebSearchPanel settings={props.settings} savePartial={props.savePartial} />
            </SettingsSection>
          )}

          {sections.includes('maintenance') && (
            <SettingsSection title={t('settings.section.maintenance')}>
              <MaintenancePanel settings={props.settings} savePartial={props.savePartial} />
            </SettingsSection>
          )}

          {sections.includes('usage') && (
            <SettingsSection title={t('settings.section.usage')}>
              <UsagePanel />
            </SettingsSection>
          )}

          {props.active === 'general' && (
            <div className="flex items-baseline justify-between border-t border-border pt-5 text-xs md:hidden">
              <span className="font-medium text-foreground-secondary">weftwise 织识</span>
              <span className="tabular-nums text-foreground-tertiary">v{APP_VERSION}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-border pt-6 first:border-t-0 first:pt-0">
      <h4 className="mb-4 text-xs font-semibold text-foreground-secondary">{title}</h4>
      {children}
    </section>
  );
}

function AppearancePanel() {
  const { locale, setLocale, isLocalePending, t } = useI18n();
  return (
    <div className="space-y-4">
      <SegmentedRow<Locale>
        label={t('settings.interfaceLanguage.label')}
        description={t('settings.interfaceLanguage.description')}
        value={locale}
        options={[
          { value: 'en', label: t('settings.interfaceLanguage.english') },
          { value: 'zh-CN', label: t('settings.interfaceLanguage.chinese') },
        ]}
        onSave={setLocale}
        save={{ pending: isLocalePending, error: undefined }}
      />
    </div>
  );
}

const LENS_LABEL_KEYS: Record<keyof StylePrefs, MessageKey> = {
  readingLevel: 'settings.lens.readingLevel',
  verbosity: 'settings.lens.verbosity',
  exampleDensity: 'settings.lens.examples',
  formality: 'settings.lens.tone',
};

const LENS_OPTIONS = {
  readingLevel: [
    ['beginner', 'settings.lens.beginner'],
    ['intermediate', 'settings.lens.intermediate'],
    ['advanced', 'settings.lens.advanced'],
  ],
  verbosity: [
    ['terse', 'settings.lens.terse'],
    ['balanced', 'settings.lens.balanced'],
    ['thorough', 'settings.lens.thorough'],
  ],
  exampleDensity: [
    ['few', 'settings.lens.few'],
    ['some', 'settings.lens.some'],
    ['many', 'settings.lens.many'],
  ],
  formality: [
    ['casual', 'settings.lens.casual'],
    ['neutral', 'settings.lens.neutral'],
    ['formal', 'settings.lens.formal'],
  ],
} satisfies Record<keyof StylePrefs, [string, MessageKey][]>;

const LENS_KEYS: (keyof StylePrefs)[] = ['readingLevel', 'verbosity', 'exampleDensity', 'formality'];

// 认知画像设置：走 /api/profile（独立 user_profiles 表，非 app_settings），不写 Zustand。
function CognitiveLensPanel() {
  const { t } = useI18n();
  const { data, isLoading } = useProfile();
  const update = useUpdateProfile();

  if (isLoading || !data) {
    return <p className="text-xs text-foreground-tertiary">{t('common.loading')}</p>;
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
      <p className="text-xs text-foreground-tertiary">{t('settings.lens.description')}</p>

      {LENS_KEYS.map((key) => (
        <SegmentedRow
          key={key}
          label={t(LENS_LABEL_KEYS[key])}
          value={profile.stylePrefs[key]}
          options={LENS_OPTIONS[key].map(([value, labelKey]) => ({
            value: value as StylePrefs[typeof key],
            label: t(labelKey),
          }))}
          onSave={(v) => savePrefs({ [key]: v } as Partial<StylePrefs>)}
          save={save}
        />
      ))}

      <TextareaRow
        label={t('settings.lens.background.label')}
        description={t('settings.lens.background.description')}
        value={profile.backgroundSummary}
        placeholder={t('settings.lens.background.placeholder')}
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
  const { t } = useI18n();
  const savedLanguage = settings?.wikiLanguage ?? '';
  const presetValues = new Set<string>(WIKI_LANGUAGE_PRESETS.map((p) => p.value));
  const languageOptions: { value: string; label: string }[] = WIKI_LANGUAGE_PRESETS.map((p) => ({
    value: p.value,
    label: p.label,
  }));
  if (savedLanguage && !presetValues.has(savedLanguage)) {
    languageOptions.unshift({ value: savedLanguage, label: t('common.custom', { value: savedLanguage }) });
  }
  return (
    <div className="space-y-4">
      <SelectRow
        label={t('settings.wikiLanguage.label')}
        description={t('settings.wikiLanguage.description')}
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
  const { t } = useI18n();
  const save = toSave(savePartial);
  return (
    <div className="space-y-4">
      <NumberRow
        label={t('settings.agent.maxSteps')}
        value={settings?.agentMaxSteps ?? 25}
        min={1}
        max={200}
        onSave={(v) => savePartial.mutate({ agentMaxSteps: v })}
        save={save}
      />
      <NumberRow
        label={t('settings.agent.tokenBudget')}
        description={t('settings.agent.tokenBudgetDescription')}
        value={settings?.agentMaxTokensPerJob ?? 500_000}
        min={10_000}
        max={5_000_000}
        onSave={(v) => savePartial.mutate({ agentMaxTokensPerJob: v })}
        save={save}
      />
      <NumberRow
        label={t('settings.agent.parallel')}
        value={settings?.agentMaxParallelSubAgents ?? 3}
        min={1}
        max={10}
        onSave={(v) => savePartial.mutate({ agentMaxParallelSubAgents: v })}
        save={save}
      />
      <SegmentedRow
        label={t('settings.agent.selectionMode')}
        value={settings?.agentTaskRouterMode ?? 'frontmatter-override'}
        options={[
          { value: 'task-router-only', label: t('settings.agent.taskRouterOnly') },
          { value: 'frontmatter-override', label: t('settings.agent.frontmatterOverride') },
        ]}
        onSave={(v) =>
          savePartial.mutate({
            agentTaskRouterMode: v as 'task-router-only' | 'frontmatter-override',
          })
        }
        save={save}
      />
      <SwitchRow
        label={t('settings.agent.autoCurate')}
        description={t('settings.agent.autoCurateDescription')}
        checked={settings?.agentAutoCurate ?? true}
        onSave={(v) => savePartial.mutate({ agentAutoCurate: v })}
        save={save}
      />
      <NumberRow
        label={t('settings.agent.ingestConcurrency')}
        description={t('settings.agent.ingestConcurrencyDescription')}
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
  const { t } = useI18n();
  const save = toSave(savePartial);
  return (
    <div className="space-y-4">
      <p className="text-xs text-foreground-tertiary">{t('settings.web.description')}</p>
      <SettingRow label={t('settings.web.provider')} description={t('settings.web.providerDescription')}>
        <span className="text-xs text-foreground-secondary">Tavily</span>
      </SettingRow>
      <TextRow
        label={t('settings.web.apiKey')}
        description={t('settings.web.apiKeyDescription')}
        type="password"
        placeholder="tvly-…"
        value={settings?.webSearchApiKey ?? ''}
        onSave={(v) => savePartial.mutate({ webSearchApiKey: v })}
        save={save}
      />
      <NumberRow
        label={t('settings.web.maxResults')}
        value={settings?.webSearchMaxResults ?? 5}
        min={1}
        max={10}
        onSave={(v) => savePartial.mutate({ webSearchMaxResults: v })}
        save={save}
      />
    </div>
  );
}

function formatSweepTime(iso: string | null, i18n: Pick<I18n, 't' | 'formatDate'>): string {
  if (!iso) return i18n.t('common.never');
  const then = new Date(iso).getTime();
  const mins = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (mins < 1) return i18n.t('settings.relative.justNow');
  if (mins < 60) return i18n.t('settings.relative.minutesAgo', { count: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return i18n.t('settings.relative.hoursAgo', { count: hrs });
  return i18n.formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' });
}

function MaintenancePanel({
  settings,
  savePartial,
}: Pick<SettingsContentProps, 'settings' | 'savePartial'>) {
  const i18n = useI18n();
  const { t } = i18n;
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
        label={t('settings.maintenance.enabled')}
        description={t('settings.maintenance.enabledDescription')}
        checked={settings?.maintenanceEnabled ?? false}
        onSave={(v) => savePartial.mutate({ maintenanceEnabled: v })}
        save={save}
      />

      <MultiSelectRow
        label={t('settings.maintenance.scope')}
        description={t('settings.maintenance.scopeDescription')}
        allLabel={t('settings.maintenance.allProjects')}
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

      <SettingRow label={t('settings.maintenance.status')} description={t('settings.maintenance.statusDescription')}>
        <div className="text-xs text-foreground-secondary tabular-nums space-y-0.5 text-right">
          {statusQuery.isError ? (
            <span className="text-danger">{t('common.unavailable')}</span>
          ) : (
            <>
              <div>{t('settings.maintenance.lastSweep', { time: status ? formatSweepTime(status.lastSweepAt, i18n) : '…' })}</div>
              <div>{t('settings.maintenance.pagesDue', { count: status ? status.dueCount : '…' })}</div>
            </>
          )}
        </div>
      </SettingRow>
      <NumberRow
        label={t('settings.maintenance.interval')}
        value={settings?.maintenanceSweepIntervalHours ?? 24}
        min={1}
        max={168}
        onSave={(v) => savePartial.mutate({ maintenanceSweepIntervalHours: v })}
        save={save}
      />
      <NumberRow
        label={t('settings.maintenance.maxPages')}
        description={t('settings.maintenance.maxPagesDescription')}
        value={settings?.maintenanceMaxPagesPerSweep ?? 5}
        min={1}
        max={50}
        onSave={(v) => savePartial.mutate({ maintenanceMaxPagesPerSweep: v })}
        save={save}
      />
    </div>
  );
}

export function usageQueryPath(window: UsageWindow, projectId: 'all' | string): string {
  const base = `/api/usage?window=${window}`;
  return projectId === 'all' ? base : `${base}&subjectId=${encodeURIComponent(projectId)}`;
}

/** Usage 面板：按时间和项目查看 LLM 用量；弹窗打开时取数，无轮询。 */
function UsagePanel() {
  const { t } = useI18n();
  const usageWindowOptions = [
    { value: '7d', label: t('settings.usage.sevenDays') },
    { value: '30d', label: t('settings.usage.thirtyDays') },
    { value: 'all', label: t('settings.usage.allTime') },
  ] satisfies Array<{ value: UsageWindow; label: string }>;
  const [timeWindow, setTimeWindow] = useState<UsageWindow>('30d');
  const [projectId, setProjectId] = useState<'all' | string>('all');
  const subjectsQuery = useQuery<SubjectListEntry[]>({
    queryKey: ['subjects'],
    queryFn: fetchSubjects,
    staleTime: 30_000,
  });
  const { data, isLoading } = useQuery({
    queryKey: ['usage', timeWindow, projectId],
    queryFn: async () => {
      const res = await apiFetch(usageQueryPath(timeWindow, projectId));
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
      <SelectRow
        label={t('settings.usage.project')}
        description={t('settings.usage.projectDescription')}
        value={projectId}
        options={[
          { value: 'all', label: t('settings.usage.allProjects') },
          ...(subjectsQuery.data ?? []).map((subject) => ({
            value: subject.id,
            label: subject.name,
          })),
        ]}
        disabled={subjectsQuery.isLoading}
        onSave={setProjectId}
      />
      <Segmented
        value={timeWindow}
        options={usageWindowOptions}
        onChange={setTimeWindow}
        aria-label={t('settings.usage.windowLabel')}
      />
      {isLoading ? (
        <p className="text-xs text-foreground-tertiary">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-foreground-tertiary">{t('settings.usage.empty')}</p>
      ) : (
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full min-w-[34rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-foreground-tertiary">
                <th className="py-1.5 pr-2 font-medium">{t('settings.usage.task')}</th>
                <th className="py-1.5 pr-2 font-medium">{t('settings.usage.model')}</th>
                <th className="py-1.5 pr-2 text-right font-medium">{t('settings.usage.calls')}</th>
                <th className="py-1.5 pr-2 text-right font-medium">{t('settings.usage.input')}</th>
                <th className="py-1.5 text-right font-medium">{t('settings.usage.output')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.task}:${r.model}`} className="border-b border-border/50">
                  <td className="py-1.5 pr-2 font-mono text-xs">{r.task}</td>
                  <td
                    className="max-w-[10rem] truncate py-1.5 pr-2 text-xs text-foreground-secondary"
                    title={r.model}
                  >
                    {r.model}
                  </td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">{r.calls}</td>
                  <td className="py-1.5 pr-2 text-right tabular-nums">
                    {formatTokenCount(r.inputTokens)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {formatTokenCount(r.outputTokens)}
                  </td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="py-1.5 pr-2 text-xs">{t('settings.usage.total')}</td>
                <td className="py-1.5 pr-2" />
                <td className="py-1.5 pr-2 text-right tabular-nums">{totals.calls}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">
                  {formatTokenCount(totals.inputTokens)}
                </td>
                <td className="py-1.5 text-right tabular-nums">
                  {formatTokenCount(totals.outputTokens)}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-foreground-tertiary">{t('settings.usage.retention')}</p>
    </div>
  );
}
