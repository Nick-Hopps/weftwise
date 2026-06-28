import type { AugmentationLevel } from '@/lib/contracts';

export interface AugmentationOption {
  value: AugmentationLevel;
  label: string;
  helper: string;
}

/** 增益强度档位的英文展示元数据（UI 单一来源）。顺序即 UI 呈现顺序。*/
export const AUGMENTATION_OPTIONS: AugmentationOption[] = [
  { value: 'off', label: 'Off', helper: 'Faithful only' },
  { value: 'light', label: 'Light', helper: 'Light touch' },
  { value: 'standard', label: 'Standard', helper: 'Balanced (default)' },
  { value: 'deep', label: 'Deep', helper: 'Rich elaboration' },
];

const LABEL_BY_VALUE: Record<AugmentationLevel, string> = AUGMENTATION_OPTIONS.reduce(
  (acc, o) => {
    acc[o.value] = o.label;
    return acc;
  },
  {} as Record<AugmentationLevel, string>,
);

/** 取某档位的英文短标签（管理页卡片元信息行用）。*/
export function augmentationLabel(level: AugmentationLevel): string {
  return LABEL_BY_VALUE[level] ?? level;
}
