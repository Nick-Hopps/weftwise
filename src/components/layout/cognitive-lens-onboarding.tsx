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

const FIELDS: { key: keyof StylePrefs; label: string; options: [string, string][] }[] = [
  {
    key: 'readingLevel',
    label: '阅读难度基线',
    options: [
      ['beginner', '入门'],
      ['intermediate', '进阶'],
      ['advanced', '专家'],
    ],
  },
  {
    key: 'verbosity',
    label: '详尽度',
    options: [
      ['terse', '精简'],
      ['balanced', '适中'],
      ['thorough', '详尽'],
    ],
  },
  {
    key: 'exampleDensity',
    label: '举例/类比密度',
    options: [
      ['few', '少'],
      ['some', '适量'],
      ['many', '多'],
    ],
  },
  {
    key: 'formality',
    label: '语气',
    options: [
      ['casual', '口语'],
      ['neutral', '中性'],
      ['formal', '正式'],
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
        <h2 className="mb-1 text-lg font-semibold text-foreground">让内容更贴合你</h2>
        <p className="mb-4 text-sm text-foreground-tertiary">
          告诉我你的背景与喜好，阅读时会按它调整每页的讲法（随时可在设置里改，也会随你的反馈自动微调）。
        </p>

        <textarea
          value={bg}
          onChange={(e) => setBg(e.target.value)}
          placeholder="例如：后端工程师，懂分布式系统，但机器学习是新手"
          className="mb-4 h-24 w-full rounded-md border border-border bg-canvas p-2 text-sm"
        />

        {FIELDS.map((f) => (
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
            跳过
          </Button>
          <Button
            intent="primary"
            size="sm"
            disabled={update.isPending}
            onClick={() => update.mutate({ backgroundSummary: bg, stylePrefs: prefs, markOnboarded: true })}
          >
            保存并开始
          </Button>
        </div>
      </div>
    </div>
  );
}
