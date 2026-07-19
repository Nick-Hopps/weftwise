'use client';

import { AUGMENTATION_OPTIONS } from '@/lib/augmentation';
import { useI18n } from '@/components/i18n-provider';
import type { MessageKey } from '@/lib/i18n/messages';

const AUGMENTATION_KEYS: Record<AugmentationLevel, { label: MessageKey; helper: MessageKey }> = {
  off: { label: 'augmentation.off.label', helper: 'augmentation.off.helper' },
  light: { label: 'augmentation.light.label', helper: 'augmentation.light.helper' },
  standard: { label: 'augmentation.standard.label', helper: 'augmentation.standard.helper' },
  deep: { label: 'augmentation.deep.label', helper: 'augmentation.deep.helper' },
};
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
  const { t } = useI18n();
  return (
    <Segmented<AugmentationLevel>
      value={value}
      onChange={onChange}
      disabled={disabled}
      aria-label={t('augmentation.label')}
      columns={2}
      options={AUGMENTATION_OPTIONS.map((o) => ({
        value: o.value,
        label: t(AUGMENTATION_KEYS[o.value].label),
        helper: t(AUGMENTATION_KEYS[o.value].helper),
      }))}
    />
  );
}
