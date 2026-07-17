import { describe, expect, it } from 'vitest';
import {
  COGNITIVE_LENS_ONBOARDING_COPY,
  COGNITIVE_LENS_ONBOARDING_FIELDS,
} from '../cognitive-lens-onboarding';

describe('Cognitive Lens onboarding 文案', () => {
  it('使用全局界面约定的英文文案和术语', () => {
    expect(COGNITIVE_LENS_ONBOARDING_COPY).toEqual({
      title: 'Make every page work for you',
      description:
        'Tell us about your background and preferences. Each page will adapt how it explains things, and you can change these settings at any time.',
      backgroundPlaceholder:
        'For example: Backend engineer familiar with distributed systems, but new to machine learning',
      skip: 'Skip',
      save: 'Save and start',
    });
    expect(COGNITIVE_LENS_ONBOARDING_FIELDS).toEqual([
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
    ]);

    const visibleCopy = JSON.stringify({
      copy: COGNITIVE_LENS_ONBOARDING_COPY,
      fields: COGNITIVE_LENS_ONBOARDING_FIELDS,
    });
    expect(visibleCopy).not.toMatch(/[\u3400-\u9fff]/u);
  });
});
