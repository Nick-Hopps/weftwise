'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useProfile, useUpdateProfile } from '@/hooks/use-profile';
import type { StylePrefs } from '@/lib/contracts';

const DEFAULTS: StylePrefs = {
  readingLevel: 'intermediate',
  verbosity: 'balanced',
  exampleDensity: 'some',
  formality: 'neutral',
};

export const COGNITIVE_LENS_ONBOARDING_COPY = {
  title: 'Make every page work for you',
  description:
    'Tell us about your background and preferences. Each page will adapt how it explains things, and you can change these settings at any time.',
  backgroundPlaceholder:
    'For example: Backend engineer familiar with distributed systems, but new to machine learning',
  skip: 'Skip',
  save: 'Save and start',
} as const;

export const COGNITIVE_LENS_ONBOARDING_FIELDS: {
  key: keyof StylePrefs;
  label: string;
  options: [string, string][];
}[] = [
  {
    key: 'readingLevel',
    label: 'Reading level',
    options: [
      ['beginner', 'Beginner'],
      ['intermediate', 'Intermediate'],
      ['advanced', 'Advanced'],
    ],
  },
  {
    key: 'verbosity',
    label: 'Verbosity',
    options: [
      ['terse', 'Terse'],
      ['balanced', 'Balanced'],
      ['thorough', 'Thorough'],
    ],
  },
  {
    key: 'exampleDensity',
    label: 'Examples & analogies',
    options: [
      ['few', 'Few'],
      ['some', 'Some'],
      ['many', 'Many'],
    ],
  },
  {
    key: 'formality',
    label: 'Tone',
    options: [
      ['casual', 'Casual'],
      ['neutral', 'Neutral'],
      ['formal', 'Formal'],
    ],
  },
];

/** 首次使用（画像未 onboarded）弹出的轻量画像向导。 */
export function CognitiveLensOnboarding() {
  const { data } = useProfile();
  const update = useUpdateProfile();
  const [bg, setBg] = useState('');
  const [prefs, setPrefs] = useState<StylePrefs>(DEFAULTS);

  if (!data || data.onboarded) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-lg rounded-lg border border-border bg-surface p-6 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold text-foreground">
          {COGNITIVE_LENS_ONBOARDING_COPY.title}
        </h2>
        <p className="mb-4 text-sm text-foreground-tertiary">
          {COGNITIVE_LENS_ONBOARDING_COPY.description}
        </p>

        <textarea
          value={bg}
          onChange={(e) => setBg(e.target.value)}
          placeholder={COGNITIVE_LENS_ONBOARDING_COPY.backgroundPlaceholder}
          className="mb-4 h-24 w-full rounded-md border border-border bg-canvas p-2 text-sm"
        />

        {COGNITIVE_LENS_ONBOARDING_FIELDS.map((f) => (
          <label key={f.key} className="mb-2 flex items-center justify-between gap-3 text-sm">
            <span className="text-foreground-secondary">{f.label}</span>
            <select
              value={prefs[f.key]}
              onChange={(e) => setPrefs((p) => ({ ...p, [f.key]: e.target.value }) as StylePrefs)}
              aria-label={f.label}
              className="rounded-md border border-border bg-canvas px-2 py-1 text-sm"
            >
              {f.options.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
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
            {COGNITIVE_LENS_ONBOARDING_COPY.skip}
          </Button>
          <Button
            intent="primary"
            size="sm"
            disabled={update.isPending}
            onClick={() => update.mutate({ backgroundSummary: bg, stylePrefs: prefs, markOnboarded: true })}
          >
            {COGNITIVE_LENS_ONBOARDING_COPY.save}
          </Button>
        </div>
      </div>
    </div>
  );
}
