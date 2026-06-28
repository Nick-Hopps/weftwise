import { describe, it, expect } from 'vitest';
import { AugmentationLevelSchema } from '@/lib/contracts';
import { AUGMENTATION_OPTIONS, augmentationLabel } from '@/lib/augmentation';

describe('AUGMENTATION_OPTIONS', () => {
  it('覆盖契约里全部增益档位且不多不少', () => {
    const optionValues = [...AUGMENTATION_OPTIONS.map((o) => o.value)].sort();
    const schemaValues = [...AugmentationLevelSchema.options].sort();
    expect(optionValues).toEqual(schemaValues);
  });

  it('每档都有非空 label 与 helper', () => {
    for (const o of AUGMENTATION_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.helper.length).toBeGreaterThan(0);
    }
  });

  it('augmentationLabel 返回对应 label', () => {
    expect(augmentationLabel('standard')).toBe('Standard');
    expect(augmentationLabel('off')).toBe('Off');
  });
});
