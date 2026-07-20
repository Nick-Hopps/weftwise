'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/components/i18n-provider';
import { useProfile, useUpdateProfile } from '@/hooks/use-profile';
import type { StylePrefs } from '@/lib/contracts';
import type { MessageKey } from '@/lib/i18n/messages';

const DEFAULTS: StylePrefs = {
  readingLevel: 'intermediate',
  verbosity: 'balanced',
  exampleDensity: 'some',
  formality: 'neutral',
};

export const COGNITIVE_LENS_ONBOARDING_COPY = {
  title: 'lens.onboarding.title',
  description: 'lens.onboarding.description',
  backgroundPlaceholder: 'lens.onboarding.backgroundPlaceholder',
  skip: 'lens.onboarding.skip',
  save: 'lens.onboarding.save',
} as const satisfies Record<string, MessageKey>;

export const COGNITIVE_LENS_ONBOARDING_FIELDS: {
  key: keyof StylePrefs;
  labelKey: MessageKey;
  options: [string, MessageKey][];
}[] = [
  {
    key: 'readingLevel',
    labelKey: 'settings.lens.readingLevel',
    options: [
      ['beginner', 'settings.lens.beginner'],
      ['intermediate', 'settings.lens.intermediate'],
      ['advanced', 'settings.lens.advanced'],
    ],
  },
  {
    key: 'verbosity',
    labelKey: 'settings.lens.verbosity',
    options: [
      ['terse', 'settings.lens.terse'],
      ['balanced', 'settings.lens.balanced'],
      ['thorough', 'settings.lens.thorough'],
    ],
  },
  {
    key: 'exampleDensity',
    labelKey: 'settings.lens.examples',
    options: [
      ['few', 'settings.lens.few'],
      ['some', 'settings.lens.some'],
      ['many', 'settings.lens.many'],
    ],
  },
  {
    key: 'formality',
    labelKey: 'settings.lens.tone',
    options: [
      ['casual', 'settings.lens.casual'],
      ['neutral', 'settings.lens.neutral'],
      ['formal', 'settings.lens.formal'],
    ],
  },
];

/** 首次使用（画像未 onboarded）弹出的轻量画像向导。 */
export function CognitiveLensOnboarding() {
  const { t } = useI18n();
  const { data } = useProfile();
  const update = useUpdateProfile();
  const [bg, setBg] = useState('');
  const [prefs, setPrefs] = useState<StylePrefs>(DEFAULTS);

  if (!data || data.onboarded) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-6 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          {t(COGNITIVE_LENS_ONBOARDING_COPY.title)}
        </h2>
        <p className="mb-4 text-sm text-foreground-tertiary">
          {t(COGNITIVE_LENS_ONBOARDING_COPY.description)}
        </p>

        <textarea
          value={bg}
          onChange={(e) => setBg(e.target.value)}
          placeholder={t(COGNITIVE_LENS_ONBOARDING_COPY.backgroundPlaceholder)}
          className="mb-4 h-24 w-full rounded-md border border-border bg-canvas p-2 text-sm"
        />

        {COGNITIVE_LENS_ONBOARDING_FIELDS.map((f) => (
          <label key={f.key} className="mb-2 flex items-center justify-between gap-3 text-sm">
            <span className="text-foreground-secondary">{t(f.labelKey)}</span>
            <select
              value={prefs[f.key]}
              onChange={(e) => setPrefs((p) => ({ ...p, [f.key]: e.target.value }) as StylePrefs)}
              aria-label={t(f.labelKey)}
              className="rounded-md border border-border bg-canvas px-2 py-1 text-sm"
            >
              {f.options.map(([v, labelKey]) => (
                <option key={v} value={v}>
                  {t(labelKey)}
                </option>
              ))}
            </select>
          </label>
        ))}

        <div className="mt-5 flex justify-end gap-2">
          <Button
            intent="ghost"
            size="sm"
            disabled={update.isPending}
            onClick={() => update.mutate({ markOnboarded: true })}
          >
            {t(COGNITIVE_LENS_ONBOARDING_COPY.skip)}
          </Button>
          <Button
            intent="primary"
            size="sm"
            disabled={update.isPending}
            onClick={() => update.mutate({ backgroundSummary: bg, stylePrefs: prefs, markOnboarded: true })}
          >
            {t(COGNITIVE_LENS_ONBOARDING_COPY.save)}
          </Button>
        </div>
      </div>
    </div>
  );
}
