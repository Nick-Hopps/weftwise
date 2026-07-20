/**
 * 设置一级入口与组内分区的单一来源。
 * 一级入口按用户任务组织，原有设置模块作为 section 收纳，避免分类粒度漂移。
 */

import { BarChart3, Bot, Brain, Settings2, type LucideIcon } from 'lucide-react';
import type { MessageKey } from '@/lib/i18n/messages';
import type { TranslationFunction } from '@/lib/i18n/translator';

export type CategoryId = 'general' | 'personalization' | 'automation' | 'usage';

export type SettingsSectionId =
  | 'language'
  | 'reading'
  | 'cognitive-lens'
  | 'agents'
  | 'web-search'
  | 'maintenance'
  | 'usage';

export interface SettingsCategory {
  id: CategoryId;
  label: string;
  description: string;
  icon: LucideIcon;
}

interface SettingsCategoryDefinition {
  id: CategoryId;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  icon: LucideIcon;
}

export const APP_VERSION = '0.1.0';

export const SETTINGS_CATEGORY_DEFINITIONS: SettingsCategoryDefinition[] = [
  {
    id: 'general',
    labelKey: 'settings.category.general.label',
    descriptionKey: 'settings.category.general.description',
    icon: Settings2,
  },
  {
    id: 'personalization',
    labelKey: 'settings.category.personalization.label',
    descriptionKey: 'settings.category.personalization.description',
    icon: Brain,
  },
  {
    id: 'automation',
    labelKey: 'settings.category.automation.label',
    descriptionKey: 'settings.category.automation.description',
    icon: Bot,
  },
  {
    id: 'usage',
    labelKey: 'settings.category.usage.label',
    descriptionKey: 'settings.category.usage.description',
    icon: BarChart3,
  },
];

export function getSettingsCategories(t: TranslationFunction): SettingsCategory[] {
  return SETTINGS_CATEGORY_DEFINITIONS.map(({ labelKey, descriptionKey, ...category }) => ({
    ...category,
    label: t(labelKey),
    description: t(descriptionKey),
  }));
}

export const SETTINGS_SECTIONS = {
  general: ['language', 'reading'],
  personalization: ['cognitive-lens'],
  automation: ['agents', 'web-search', 'maintenance'],
  usage: ['usage'],
} satisfies Record<CategoryId, SettingsSectionId[]>;

export const DEFAULT_CATEGORY: CategoryId = 'general';
