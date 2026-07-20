import { describe, expect, it } from 'vitest';
import {
  COGNITIVE_LENS_ONBOARDING_COPY,
  COGNITIVE_LENS_ONBOARDING_FIELDS,
} from '../cognitive-lens-onboarding';

describe('Cognitive Lens onboarding 文案', () => {
  it('所有可见文案都保存为消息键', () => {
    expect(COGNITIVE_LENS_ONBOARDING_COPY).toEqual({
      title: 'lens.onboarding.title',
      description: 'lens.onboarding.description',
      backgroundPlaceholder: 'lens.onboarding.backgroundPlaceholder',
      skip: 'lens.onboarding.skip',
      save: 'lens.onboarding.save',
    });
    expect(COGNITIVE_LENS_ONBOARDING_FIELDS).toEqual([
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
    ]);
  });
});
