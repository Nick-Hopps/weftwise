'use client';

import { AUGMENTATION_OPTIONS } from '@/lib/augmentation';
import type { AugmentationLevel } from '@/lib/contracts';
import { Segmented } from '@/components/ui/segmented';

/** 英文分段增益强度选择控件（2×2 网格），内部复用 ui/Segmented。*/
export function AugmentationField({
  value,
  onChange,
  disabled,
}: {
  value: AugmentationLevel;
  onChange: (next: AugmentationLevel) => void;
  disabled?: boolean;
}) {
  return (
    <Segmented<AugmentationLevel>
      value={value}
      onChange={onChange}
      disabled={disabled}
      aria-label="Augmentation level"
      columns={2}
      options={AUGMENTATION_OPTIONS.map((o) => ({
        value: o.value,
        label: o.label,
        helper: o.helper,
      }))}
    />
  );
}
